/* eslint-disable @typescript-eslint/no-explicit-any */
import type {AddressInfo} from 'node:net'

import {expect} from 'chai'
import http from 'node:http'

import type {MemoryManager} from '../../../src/agent/infra/memory/memory-manager.js'
import type {PmovesNatsEmitter} from '../../../src/pmoves/nats-emitter.js'

import {createPmovesApp} from '../../../src/pmoves/app.js'

// F6: drive the REAL app (createPmovesApp, used by rest-server.ts) through the
// REAL auth middleware in single-token mode. The per-request logic is covered
// in mcp-per-request-auth.test.ts with a simulated middleware; this file pins
// the WIRING: if /mcp were mounted before auth, or stopped receiving
// req.agentId, the unauthenticated and identity-dependent cases below fail.
// The token is a test value set only for this file, never a real credential.

const TEST_TOKEN = 'wiring-test-bootstrap-token'
const ENFORCE_ENV = 'CIPHER_MCP_ENFORCE'

function makeMockNats(): PmovesNatsEmitter {
  return {emitReasoningStored() {}, emitSearched() {}, emitStored() {}} as unknown as PmovesNatsEmitter
}

function makeMockMemoryManager(): MemoryManager {
  const memories: any[] = []
  return {
    async create(args: any) {
      const m = {content: args.content, createdAt: Date.now(), id: `mem-${memories.length + 1}`, metadata: args.metadata ?? {}, tags: args.tags ?? [], updatedAt: Date.now()}
      memories.push(m)
      return m
    },
    async delete() {},
    async get(id: string) {
      const m = memories.find((x) => x.id === id)
      if (!m) throw new Error(`Memory ${id} not found`)
      return m
    },
    async list() { return [...memories] },
  } as unknown as MemoryManager
}

function request(baseUrl: string, method: string, path: string, opts: {bearer?: string; body?: unknown} = {}): Promise<{body: any; status: number}> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? undefined : JSON.stringify(opts.body)
    const req = http.request(`${baseUrl}${path}`, {
      headers: {
        Accept: 'application/json, text/event-stream',
        ...(data ? {'Content-Length': Buffer.byteLength(data), 'Content-Type': 'application/json'} : {}),
        ...(opts.bearer ? {Authorization: `Bearer ${opts.bearer}`} : {}),
      },
      method,
    }, (res) => {
      let buf = ''
      res.on('data', (c) => { buf += c })
      res.on('end', () => {
        try { resolve({body: JSON.parse(buf), status: res.statusCode ?? 0}) } catch { resolve({body: buf, status: res.statusCode ?? 0}) }
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

let rpcId = 0
function toolCall(name: string, args: Record<string, unknown>): Record<string, unknown> {
  rpcId += 1
  return {id: rpcId, jsonrpc: '2.0', method: 'tools/call', params: {arguments: args, name}}
}

describe('F6: rest-server wiring with the real auth middleware', () => {
  let server: http.Server
  let baseUrl: string
  const saved: Record<string, string | undefined> = {}

  beforeEach(async () => {
    for (const k of ['CIPHER_API_TOKEN', ENFORCE_ENV]) saved[k] = process.env[k]
    process.env.CIPHER_API_TOKEN = TEST_TOKEN
    delete process.env[ENFORCE_ENV]
    const app = createPmovesApp(makeMockMemoryManager(), makeMockNats())
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`
        resolve()
      })
    })
  })

  afterEach((done) => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }

    server.closeAllConnections()
    server.close(() => done())
  })

  it('/health is served without a bearer', async () => {
    expect((await request(baseUrl, 'GET', '/health')).status).to.equal(200)
  })

  it('POST /mcp without a bearer is 401 — auth runs before the MCP mount', async () => {
    const r = await request(baseUrl, 'POST', '/mcp', {body: toolCall('pmoves_cipher_store', {agentId: 'bootstrap', content: 'x'})})
    expect(r.status).to.equal(401)
  })

  it('GET /mcp/sse without a bearer is 401', async () => {
    expect((await request(baseUrl, 'GET', '/mcp/sse')).status).to.equal(401)
  })

  it('a valid bearer declaring its own agent (bootstrap) is served', async () => {
    const r = await request(baseUrl, 'POST', '/mcp', {bearer: TEST_TOKEN, body: toolCall('pmoves_cipher_store', {agentId: 'bootstrap', content: 'x'})})
    expect(r.status).to.equal(200)
    expect(r.body.result, JSON.stringify(r.body)).to.not.equal(undefined)
  })

  it('the MCP router sees the token identity: omitted agentId is refused (-32003) through real wiring', async () => {
    const r = await request(baseUrl, 'POST', '/mcp', {bearer: TEST_TOKEN, body: toolCall('pmoves_cipher_session_recall', {query: 'q'})})
    expect(r.body.error?.code, JSON.stringify(r.body)).to.equal(-32_003)
  })

  it('enforce: a declared agent other than the token agent is refused (-32003) through real wiring', async () => {
    process.env[ENFORCE_ENV] = 'true'
    const r = await request(baseUrl, 'POST', '/mcp', {bearer: TEST_TOKEN, body: toolCall('pmoves_cipher_store', {agentId: 'z890-claude', content: 'x'})})
    expect(r.body.error?.code, JSON.stringify(r.body)).to.equal(-32_003)
    expect(String(r.body.error?.message)).to.include("token belongs to agent 'bootstrap'")
  })

  it('advisory: the same call is served (memory stays available)', async () => {
    const r = await request(baseUrl, 'POST', '/mcp', {bearer: TEST_TOKEN, body: toolCall('pmoves_cipher_store', {agentId: 'z890-claude', content: 'x'})})
    expect(r.body.result, JSON.stringify(r.body)).to.not.equal(undefined)
  })

  it('REST keeps refusing the mismatch unconditionally (403), as before', async () => {
    const r = await request(baseUrl, 'POST', '/api/memory', {bearer: TEST_TOKEN, body: {agentId: 'z890-claude', content: 'x'}})
    expect(r.status).to.equal(403)
  })
})
