import {NextFunction, Request, Response} from 'express'

const TOKEN_ENV = 'CIPHER_API_TOKEN'

// Read per lookup, not at import, so a missing key is reported the moment it
// matters and each branch below is testable without re-importing the module.
function supabaseRestUrl(): string {
  return process.env.SUPABASE_REST_URL ?? 'http://supabase-kong:8000/rest/v1'
}

function supabaseServiceKey(): string {
  return process.env.SUPABASE_SERVICE_KEY ?? process.env.SERVICE_ROLE_KEY ?? ''
}

// Augment Express.Request with agentId + scopes
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      agentId?: string
      scopes?: string[]
    }
  }
}

export interface PmovesAuthOptions {
  /** Skip auth when token is unset (dev mode). Default: true */
  skipIfUnset?: boolean
}

// ─── Token cache ────────────────────────────────────────────────────────────
// In-memory cache: token → {agentId, scopes, expires}
// TTL: 60s — short enough to pick up revocations quickly, long enough to
// avoid a PostgREST round-trip on every request.
const TOKEN_CACHE_TTL_MS = 60_000
const tokenCache = new Map<string, {agentId: string; scopes: string[]; expires: number}>()

interface TokenRecord {
  token_uuid: string
  agent_id: string
  scopes: string[]
  revoked_at: string | null
}

// Three outcomes, not two. `rejected` means the lookup SUCCEEDED and found no
// active row: the token is unknown or revoked, and 401 is the truth.
// `unavailable` means the lookup could not be performed (service key missing or
// refused, PostgREST error, timeout): the token's validity is unknown. Folding
// the second into the first is what made a refused service key read as
// "invalid or revoked token" for every agent on a node at once.
export type TokenResolution =
  | {agentId: string; kind: 'resolved'; scopes: string[]}
  | {kind: 'rejected'}
  | {kind: 'unavailable'; reason: string}

const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

// Outcome of the most recent per-agent lookup, for /health. Passive: recorded
// as a side effect of real requests, so /health never calls PostgREST itself.
let lastLookup: undefined | {at: number; ok: boolean; reason?: string}

function recordLookup(ok: boolean, reason?: string): void {
  lastLookup = {at: Date.now(), ok, reason}
}

export interface PerAgentAuthHealth {
  at?: string
  reason?: string
  state: 'ok' | 'unavailable' | 'unknown'
}

export function perAgentAuthHealth(): PerAgentAuthHealth {
  if (!supabaseServiceKey()) return {reason: 'SUPABASE_SERVICE_KEY not set', state: 'unavailable'}
  if (!lastLookup) return {state: 'unknown'}
  const at = new Date(lastLookup.at).toISOString()
  return lastLookup.ok ? {at, state: 'ok'} : {at, reason: lastLookup.reason, state: 'unavailable'}
}

/** Test hook: forget cached tokens and the last lookup outcome. */
export function resetPerAgentAuthState(): void {
  tokenCache.clear()
  lastLookup = undefined
}

export async function resolveToken(token: string): Promise<TokenResolution> {
  // Check cache first. Only successful resolutions are cached; a failed lookup
  // must be retried on the next request, not replayed for 60s.
  const cached = tokenCache.get(token)
  if (cached && cached.expires > Date.now()) {
    return {agentId: cached.agentId, kind: 'resolved', scopes: cached.scopes}
  }

  // Single-token mode: CIPHER_API_TOKEN env var (legacy / bootstrap).
  // No Supabase lookup — the token maps to agentId "bootstrap".
  if (!token.startsWith('cipher_')) {
    const expected = process.env[TOKEN_ENV] ?? ''
    if (token === expected && expected) {
      return {agentId: 'bootstrap', kind: 'resolved', scopes: ['memory:read', 'memory:write', 'reasoning:read', 'reasoning:write', 'session:read', 'session:write']}
    }

    return {kind: 'rejected'}
  }

  // Per-agent token mode: strip cipher_ prefix, parse as UUID, query Supabase.
  const uuidHex = token.slice(7) // strip "cipher_"
  // Format hex as UUID (8-4-4-4-12)
  const uuid = uuidHex.length === 32
    ? `${uuidHex.slice(0,8)}-${uuidHex.slice(8,12)}-${uuidHex.slice(12,16)}-${uuidHex.slice(16,20)}-${uuidHex.slice(20)}`
    : uuidHex // already has dashes
  // A malformed token cannot name any row. Reject it here: sent to PostgREST it
  // earns a 400, which would otherwise be reported as a backend fault.
  if (!UUID_RE.test(uuid)) return {kind: 'rejected'}

  const serviceKey = supabaseServiceKey()
  if (!serviceKey) {
    const reason = 'SUPABASE_SERVICE_KEY not set'
    process.stderr.write(`pmoves-auth: ${reason} — cannot resolve per-agent tokens\n`)
    recordLookup(false, reason)
    return {kind: 'unavailable', reason}
  }

  try {
    const resp = await fetch(
      `${supabaseRestUrl()}/cipher_agent_tokens?token_uuid=eq.${uuid}&revoked_at=is.null&select=agent_id,scopes`,
      {
        // cipher_agent_tokens lives in pmoves_core, not the default public
        // profile — without this header PostgREST 404s the lookup and every
        // per-agent token fails as "invalid".
        headers: {apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Accept-Profile': 'pmoves_core'},
        signal: AbortSignal.timeout(3000),
      },
    )
    if (!resp.ok) {
      // 401/403 here is Kong/PostgREST refusing the SHIM's service key, not the
      // caller's token.
      const reason = `token lookup returned HTTP ${resp.status}`
      process.stderr.write(`pmoves-auth: Supabase ${reason}\n`)
      recordLookup(false, reason)
      return {kind: 'unavailable', reason}
    }

    const records = await resp.json() as Array<{agent_id: string; scopes: string[]}>
    if (!Array.isArray(records)) {
      const reason = 'token lookup returned a non-array body'
      process.stderr.write(`pmoves-auth: Supabase ${reason}\n`)
      recordLookup(false, reason)
      return {kind: 'unavailable', reason}
    }

    if (records.length === 0) {
      recordLookup(true)
      return {kind: 'rejected'}
    }

    const record = records[0]
    // A row with no agent_id would resolve to a falsy req.agentId, which the
    // MCP identity check treats as advisory (dev-skip). Fail closed instead.
    if (typeof record.agent_id !== 'string' || record.agent_id.trim() === '') {
      const reason = 'token lookup returned a row with no agent_id'
      process.stderr.write(`pmoves-auth: Supabase ${reason}\n`)
      recordLookup(false, reason)
      return {kind: 'unavailable', reason}
    }

    recordLookup(true)
    const result = {agentId: record.agent_id, scopes: record.scopes ?? []}
    tokenCache.set(token, {...result, expires: Date.now() + TOKEN_CACHE_TTL_MS})
    return {...result, kind: 'resolved'}
  } catch (error) {
    process.stderr.write(`pmoves-auth: token resolution failed — ${error}\n`)
    // The error name only (TimeoutError, TypeError, ...): the message can carry
    // the internal URL, and this reason is surfaced on the public /health.
    const reason = `token lookup failed (${error instanceof Error ? error.name : 'error'})`
    recordLookup(false, reason)
    return {kind: 'unavailable', reason}
  }
}

export function createPmovesAuthMiddleware(options: PmovesAuthOptions = {}) {
  const {skipIfUnset = true} = options

  return async function pmovesAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    const header = req.headers.authorization ?? ''
    const match = /^Bearer\s+(.+)$/.exec(header)
    const token = match?.[1] ?? ''

    // No token provided
    if (!token) {
      // Check if legacy CIPHER_API_TOKEN env is set (bootstrap mode)
      const legacyToken = process.env[TOKEN_ENV] ?? ''
      if (!legacyToken && skipIfUnset) {
        // Dev mode: no token, no enforcement. Advisory agentId from tool args.
        req.agentId = undefined
        return next()
      }
      if (!legacyToken) {
        res.status(500).json({error: 'CIPHER_API_TOKEN not set and no Bearer token provided'})
        return
      }
      res.status(401).json({error: 'Unauthorized — Bearer token required'})
      return
    }

    // Token provided — resolve it
    const resolved = await resolveToken(token)
    if (resolved.kind === 'unavailable') {
      // The token was never judged. Say so: a 401 here sends the operator to
      // re-mint a credential that is fine while the real fault is the backend.
      res.status(503).json({error: `Service Unavailable — per-agent token lookup failed: ${resolved.reason}. Token validity could not be determined; this is not a token rejection.`})
      return
    }

    if (resolved.kind === 'rejected') {
      res.status(401).json({error: 'Unauthorized — invalid or revoked token'})
      return
    }

    // Attach resolved identity to the request
    req.agentId = resolved.agentId
    req.scopes = resolved.scopes
    return next()
  }
}

export const PUBLIC_PATHS = new Set(['/health', '/healthz', '/.well-known/'])
