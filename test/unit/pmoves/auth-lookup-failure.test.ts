/* eslint-disable @typescript-eslint/no-explicit-any, camelcase, n/no-unsupported-features/node-builtins */
import {expect} from 'chai'
import {randomUUID} from 'node:crypto'

// A per-agent token has three possible verdicts, and only one of them is a
// rejection. When the lookup itself cannot be performed — the shim's service
// key is missing or refused by Kong, PostgREST errors, the request times out —
// the token was never judged, and answering 401 "invalid or revoked token"
// sends the operator to re-mint a credential that is fine.
//
// These tests use ONLY the pre-fix public surface (createPmovesAuthMiddleware +
// env + global fetch) so that, run against the pre-fix commit, they fail for
// BEHAVIOURAL reasons (401 where 503 is expected) rather than compile errors.

type Middleware = (req: any, res: any, next: () => void) => Promise<void>

interface Outcome {
  body?: {error?: string}
  nextCalled: boolean
  req: any
  status?: number
}

const realFetch = globalThis.fetch
const SAVED_ENV = ['CIPHER_API_TOKEN', 'SERVICE_ROLE_KEY', 'SUPABASE_REST_URL', 'SUPABASE_SERVICE_KEY']
const saved: Record<string, string | undefined> = {}

let middleware: Middleware
let fetchCalls: string[]

// A fresh token per test: successful resolutions are cached for 60s, so reusing
// one would let an earlier test's success answer a later test's lookup.
function freshToken(): string {
  return `cipher_${randomUUID().replaceAll('-', '')}`
}

function stubFetch(impl: (url: string) => Promise<Response>): void {
  globalThis.fetch = (async (input: any) => {
    const url = String(input)
    fetchCalls.push(url)
    return impl(url)
  }) as typeof fetch
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {headers: {'Content-Type': 'application/json'}, status})
}

async function call(token: string): Promise<Outcome> {
  const out: Outcome = {nextCalled: false, req: {headers: {authorization: `Bearer ${token}`}}}
  const res = {
    json(b: any) {
      out.body = b
      return res
    },
    status(code: number) {
      out.status = code
      return res
    },
  }
  await middleware(out.req, res, () => {
    out.nextCalled = true
  })
  return out
}

describe('pmoves auth: a failed token lookup is not a revocation', () => {
  before(async () => {
    for (const k of SAVED_ENV) saved[k] = process.env[k]
    // Set BEFORE import: the pre-fix module captured these at import time.
    process.env.SUPABASE_SERVICE_KEY = 'test-service-key'
    process.env.SUPABASE_REST_URL = 'http://kong.test/rest/v1'
    process.env.CIPHER_API_TOKEN = 'bootstrap-token-for-tests'
    const mod = await import('../../../src/pmoves/auth.js')
    middleware = mod.createPmovesAuthMiddleware() as unknown as Middleware
  })

  beforeEach(() => {
    fetchCalls = []
    process.env.SUPABASE_SERVICE_KEY = 'test-service-key'
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  after(() => {
    for (const k of SAVED_ENV) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('resolves an active row and attaches its identity', async () => {
    stubFetch(async () => jsonResponse(200, [{agent_id: 'b850-claude', scopes: ['memory:read']}]))
    const out = await call(freshToken())
    expect(out.nextCalled).to.equal(true)
    expect(out.req.agentId).to.equal('b850-claude')
    expect(out.req.scopes).to.deep.equal(['memory:read'])
  })

  it('answers 401 "invalid or revoked" only when the lookup succeeded and found no active row', async () => {
    stubFetch(async () => jsonResponse(200, []))
    const out = await call(freshToken())
    expect(out.status).to.equal(401)
    expect(out.body?.error).to.match(/invalid or revoked token/)
    expect(out.nextCalled).to.equal(false)
  })

  it('answers 503, not 401, when Kong refuses the shim service key (lookup 401)', async () => {
    stubFetch(async () => jsonResponse(401, {message: 'Invalid authentication credentials'}))
    const out = await call(freshToken())
    expect(out.status).to.equal(503)
    expect(out.body?.error).to.not.match(/revoked/i)
    expect(out.body?.error).to.match(/HTTP 401/)
    expect(out.nextCalled).to.equal(false)
  })

  it('answers 503 when the lookup returns a server error', async () => {
    stubFetch(async () => jsonResponse(500, {message: 'boom'}))
    const out = await call(freshToken())
    expect(out.status).to.equal(503)
    expect(out.body?.error).to.match(/HTTP 500/)
    expect(out.body?.error).to.not.match(/revoked/i)
  })

  it('answers 503 when the lookup times out or throws', async () => {
    stubFetch(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    })
    const out = await call(freshToken())
    expect(out.status).to.equal(503)
    expect(out.body?.error).to.match(/TimeoutError/)
    expect(out.body?.error).to.not.match(/revoked/i)
  })

  it('answers 503 when the lookup body is not an array', async () => {
    stubFetch(async () => jsonResponse(200, {unexpected: true}))
    const out = await call(freshToken())
    expect(out.status).to.equal(503)
    expect(out.body?.error).to.not.match(/revoked/i)
  })

  it('answers 503 without calling PostgREST when SUPABASE_SERVICE_KEY is missing', async () => {
    delete process.env.SUPABASE_SERVICE_KEY
    const savedRole = process.env.SERVICE_ROLE_KEY
    delete process.env.SERVICE_ROLE_KEY
    try {
      stubFetch(async () => jsonResponse(200, [{agent_id: 'should-not-be-reached', scopes: []}]))
      const out = await call(freshToken())
      expect(out.status).to.equal(503)
      expect(out.body?.error).to.match(/SUPABASE_SERVICE_KEY not set/)
      expect(fetchCalls).to.have.length(0)
    } finally {
      if (savedRole !== undefined) process.env.SERVICE_ROLE_KEY = savedRole
    }
  })

  it('does not cache a failed lookup: the next request retries and can succeed', async () => {
    const token = freshToken()
    stubFetch(async () => jsonResponse(401, {}))
    expect((await call(token)).status).to.equal(503)
    stubFetch(async () => jsonResponse(200, [{agent_id: 'b850-claude', scopes: []}]))
    const second = await call(token)
    expect(second.nextCalled).to.equal(true)
    expect(second.req.agentId).to.equal('b850-claude')
    expect(fetchCalls).to.have.length(2)
  })

  it('rejects a malformed cipher_ token with 401 without a lookup', async () => {
    stubFetch(async () => jsonResponse(400, {code: '22P02'}))
    const out = await call('cipher_not-a-uuid')
    expect(out.status).to.equal(401)
    expect(fetchCalls).to.have.length(0)
  })

  it('still accepts the bootstrap token and rejects a wrong one with 401', async () => {
    stubFetch(async () => jsonResponse(500, {}))
    const ok = await call('bootstrap-token-for-tests')
    expect(ok.nextCalled).to.equal(true)
    expect(ok.req.agentId).to.equal('bootstrap')
    const bad = await call('some-other-token')
    expect(bad.status).to.equal(401)
    expect(fetchCalls).to.have.length(0)
  })
})
