/* eslint-disable @typescript-eslint/no-explicit-any, n/no-unsupported-features/node-builtins */
import type {AddressInfo} from 'node:net'

import {expect} from 'chai'
import express from 'express'
import http from 'node:http'

import {createPmovesAuthMiddleware, resetPerAgentAuthState} from '../../../src/pmoves/auth.js'
import {createHealthRouter} from '../../../src/pmoves/health.js'

// /health reports per-agent auth passively, from the outcome of the last real
// lookup, so it never calls PostgREST itself. It stays HTTP 200 when degraded:
// the container healthcheck and `make cipher-health` read the status code, and
// a restart cannot fix a refused service key.

const realFetch = globalThis.fetch
const TOKEN = 'cipher_0123456789abcdef0123456789abcdef'

let server: http.Server
let baseUrl: string
let savedKey: string | undefined

function getJson(path: string): Promise<{body: any; status: number}> {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}${path}`, (res) => {
      let data = ''
      res.on('data', (c) => {
        data += c
      })
      res.on('end', () => resolve({body: JSON.parse(data), status: res.statusCode ?? 0}))
    }).on('error', reject)
  })
}

async function lookupWith(status: number, body: unknown): Promise<void> {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), {status})) as typeof fetch
  const res: any = {json: () => res, status: () => res}
  await createPmovesAuthMiddleware()({headers: {authorization: `Bearer ${TOKEN}`}} as any, res, () => {})
}

describe('pmoves /health: per-agent auth state', () => {
  before(async () => {
    savedKey = process.env.SUPABASE_SERVICE_KEY
    const app = express()
    app.use(createHealthRouter())
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => {
      server.once('listening', () => resolve())
    })
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  beforeEach(() => {
    process.env.SUPABASE_SERVICE_KEY = 'test-service-key'
    resetPerAgentAuthState()
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  after(() => {
    server.close()
    if (savedKey === undefined) delete process.env.SUPABASE_SERVICE_KEY
    else process.env.SUPABASE_SERVICE_KEY = savedKey
  })

  it('is healthy with state "unknown" before any per-agent lookup', async () => {
    const {body, status} = await getJson('/health')
    expect(status).to.equal(200)
    expect(body.status).to.equal('healthy')
    expect(body.per_agent_auth.state).to.equal('unknown')
  })

  it('is degraded (still 200) after a lookup that Kong refused', async () => {
    await lookupWith(401, {})
    const {body, status} = await getJson('/health')
    expect(status).to.equal(200)
    expect(body.status).to.equal('degraded')
    expect(body.per_agent_auth.state).to.equal('unavailable')
    expect(body.per_agent_auth.reason).to.match(/HTTP 401/)
  })

  it('recovers to healthy after a lookup that succeeded, even with no row', async () => {
    await lookupWith(401, {})
    await lookupWith(200, [])
    const {body} = await getJson('/health')
    expect(body.status).to.equal('healthy')
    expect(body.per_agent_auth.state).to.equal('ok')
  })

  it('is degraded when SUPABASE_SERVICE_KEY is missing, with no lookup needed', async () => {
    delete process.env.SUPABASE_SERVICE_KEY
    const savedRole = process.env.SERVICE_ROLE_KEY
    delete process.env.SERVICE_ROLE_KEY
    try {
      const {body, status} = await getJson('/health')
      expect(status).to.equal(200)
      expect(body.status).to.equal('degraded')
      expect(body.per_agent_auth.reason).to.match(/SUPABASE_SERVICE_KEY not set/)
    } finally {
      if (savedRole !== undefined) process.env.SERVICE_ROLE_KEY = savedRole
    }
  })
})
