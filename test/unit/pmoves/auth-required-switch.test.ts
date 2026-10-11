/* eslint-disable @typescript-eslint/no-explicit-any, camelcase, n/no-unsupported-features/node-builtins */
import {expect} from 'chai'
import {randomUUID} from 'node:crypto'

import {authRequired, createPmovesAuthMiddleware} from '../../../src/pmoves/auth.js'

// Dev mode is chosen by an absence: with no CIPHER_API_TOKEN in the container,
// a request with no Bearer passes with no identity. CIPHER_AUTH_REQUIRED makes
// that absence a refusal, so a node whose token never arrived fails closed
// instead of serving everyone.

type Middleware = (req: any, res: any, next: () => void) => Promise<void>

interface Outcome {
  body?: {error?: string}
  nextCalled: boolean
  req: any
  status?: number
}

const realFetch = globalThis.fetch
const SAVED_ENV = ['CIPHER_API_TOKEN', 'CIPHER_AUTH_REQUIRED', 'SUPABASE_REST_URL', 'SUPABASE_SERVICE_KEY']
const saved: Record<string, string | undefined> = {}

async function call(middleware: Middleware, token?: string): Promise<Outcome> {
  const headers = token === undefined ? {} : {authorization: `Bearer ${token}`}
  const out: Outcome = {nextCalled: false, req: {headers}}
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

describe('pmoves auth: CIPHER_AUTH_REQUIRED closes dev mode', () => {
  beforeEach(() => {
    for (const k of SAVED_ENV) saved[k] = process.env[k]
    delete process.env.CIPHER_API_TOKEN
    delete process.env.CIPHER_AUTH_REQUIRED
    process.env.SUPABASE_SERVICE_KEY = 'test-service-key'
    process.env.SUPABASE_REST_URL = 'http://kong.test/rest/v1'
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    for (const k of SAVED_ENV) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('unset: no token and no CIPHER_API_TOKEN still passes (dev mode unchanged)', async () => {
    const out = await call(createPmovesAuthMiddleware() as unknown as Middleware)
    expect(out.nextCalled).to.equal(true)
    expect(out.req.agentId).to.equal(undefined)
  })

  for (const value of ['1', 'true', 'TRUE', 'yes', 'on', 'ture']) {
    it(`CIPHER_AUTH_REQUIRED=${value}: no token is refused with 401`, async () => {
      process.env.CIPHER_AUTH_REQUIRED = value
      const out = await call(createPmovesAuthMiddleware() as unknown as Middleware)
      expect(out.nextCalled).to.equal(false)
      expect(out.status).to.equal(401)
      expect(out.body?.error).to.match(/Bearer token required/)
    })
  }

  for (const value of ['', '0', 'false', 'no', 'off', ' Off ']) {
    it(`CIPHER_AUTH_REQUIRED=${JSON.stringify(value)} is off`, () => {
      process.env.CIPHER_AUTH_REQUIRED = value
      expect(authRequired()).to.equal(false)
    })
  }

  it('is read per request, not at construction', async () => {
    const middleware = createPmovesAuthMiddleware() as unknown as Middleware
    expect((await call(middleware)).nextCalled).to.equal(true)
    process.env.CIPHER_AUTH_REQUIRED = 'true'
    expect((await call(middleware)).status).to.equal(401)
  })

  it('the option overrides the env in both directions', async () => {
    process.env.CIPHER_AUTH_REQUIRED = 'true'
    expect((await call(createPmovesAuthMiddleware({required: false}) as unknown as Middleware)).nextCalled).to.equal(true)
    delete process.env.CIPHER_AUTH_REQUIRED
    expect((await call(createPmovesAuthMiddleware({required: true}) as unknown as Middleware)).status).to.equal(401)
  })

  it('required wins over skipIfUnset', async () => {
    process.env.CIPHER_AUTH_REQUIRED = 'true'
    const out = await call(createPmovesAuthMiddleware({skipIfUnset: true}) as unknown as Middleware)
    expect(out.status).to.equal(401)
  })

  it('required: a valid per-agent token still resolves', async () => {
    process.env.CIPHER_AUTH_REQUIRED = 'true'
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([{agent_id: 'spark-claude', scopes: ['memory:read']}]), {
        headers: {'Content-Type': 'application/json'},
        status: 200,
      })) as typeof fetch
    const out = await call(createPmovesAuthMiddleware() as unknown as Middleware, `cipher_${randomUUID().replaceAll('-', '')}`)
    expect(out.nextCalled).to.equal(true)
    expect(out.req.agentId).to.equal('spark-claude')
  })

  it('required: a wrong token is still 401 "invalid or revoked"', async () => {
    process.env.CIPHER_AUTH_REQUIRED = 'true'
    globalThis.fetch = (async () =>
      new Response('[]', {headers: {'Content-Type': 'application/json'}, status: 200})) as typeof fetch
    const out = await call(createPmovesAuthMiddleware() as unknown as Middleware, `cipher_${randomUUID().replaceAll('-', '')}`)
    expect(out.status).to.equal(401)
    expect(out.body?.error).to.match(/invalid or revoked/)
  })

  it('required with the bootstrap token set: no token is 401, the bootstrap token passes', async () => {
    process.env.CIPHER_AUTH_REQUIRED = 'true'
    process.env.CIPHER_API_TOKEN = 'bootstrap-token-for-tests'
    const middleware = createPmovesAuthMiddleware() as unknown as Middleware
    expect((await call(middleware)).status).to.equal(401)
    const ok = await call(middleware, 'bootstrap-token-for-tests')
    expect(ok.nextCalled).to.equal(true)
    expect(ok.req.agentId).to.equal('bootstrap')
  })
})
