import {NextFunction, Request, Response} from 'express'

const TOKEN_ENV = 'CIPHER_API_TOKEN'
const SUPABASE_REST_URL = process.env.SUPABASE_REST_URL ?? 'http://supabase-kong:8000/rest/v1'
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? process.env.SERVICE_ROLE_KEY ?? ''

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

async function resolveToken(token: string): Promise<{agentId: string; scopes: string[]} | null> {
  // Check cache first
  const cached = tokenCache.get(token)
  if (cached && cached.expires > Date.now()) {
    return {agentId: cached.agentId, scopes: cached.scopes}
  }

  // Single-token mode: CIPHER_API_TOKEN env var (legacy / bootstrap).
  // No Supabase lookup — the token maps to agentId "bootstrap".
  if (!token.startsWith('cipher_')) {
    const expected = process.env[TOKEN_ENV] ?? ''
    if (token === expected && expected) {
      return {agentId: 'bootstrap', scopes: ['memory:read', 'memory:write', 'reasoning:read', 'reasoning:write', 'session:read', 'session:write']}
    }
    return null
  }

  // Per-agent token mode: strip cipher_ prefix, parse as UUID, query Supabase.
  if (!SUPABASE_SERVICE_KEY) {
    process.stderr.write('pmoves-auth: SUPABASE_SERVICE_KEY not set — cannot resolve per-agent tokens\n')
    return null
  }

  const uuidHex = token.slice(7) // strip "cipher_"
  // Format hex as UUID (8-4-4-4-12)
  const uuid = uuidHex.length === 32
    ? `${uuidHex.slice(0,8)}-${uuidHex.slice(8,12)}-${uuidHex.slice(12,16)}-${uuidHex.slice(16,20)}-${uuidHex.slice(20)}`
    : uuidHex // already has dashes

  try {
    const resp = await fetch(
      `${SUPABASE_REST_URL}/cipher_agent_tokens?token_uuid=eq.${uuid}&revoked_at=is.null&select=agent_id,scopes`,
      {
        headers: {apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`},
        signal: AbortSignal.timeout(3000),
      },
    )
    if (!resp.ok) {
      process.stderr.write(`pmoves-auth: Supabase token lookup returned ${resp.status}\n`)
      return null
    }
    const records = await resp.json() as Array<{agent_id: string; scopes: string[]}>
    if (records.length === 0) return null

    const record = records[0]
    const result = {agentId: record.agent_id, scopes: record.scopes ?? []}
    tokenCache.set(token, {...result, expires: Date.now() + TOKEN_CACHE_TTL_MS})
    return result
  } catch (e) {
    process.stderr.write(`pmoves-auth: token resolution failed — ${e}\n`)
    return null
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
    if (!resolved) {
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
