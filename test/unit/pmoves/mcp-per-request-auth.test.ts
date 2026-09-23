/* eslint-disable @typescript-eslint/no-explicit-any */
import type {AddressInfo} from 'node:net'

import {expect} from 'chai'
import express from 'express'
import http from 'node:http'

import type {MemoryManager} from '../../../src/agent/infra/memory/memory-manager.js'
import type {PmovesNatsEmitter} from '../../../src/pmoves/nats-emitter.js'

import {AdvisoryLog, buildMcpServer, createMcpSseRouter} from '../../../src/pmoves/mcp-sse.js'
// Side-effect import: brings in the Express.Request agentId/scopes augmentation.
import '../../../src/pmoves/auth.js'

// Identity on the MCP path must be derived PER REQUEST from what the auth
// middleware resolved (req.agentId / req.scopes), and bound to the SSE session
// so POST /mcp/messages for that session carries the same identity.
//
// Before this fix, rest-server.ts mounted createMcpSseRouter(memoryManager, nats)
// with no auth argument, so the router saw `{}` for every caller and the
// agentId check never fired: any valid bearer could read/write as any agent.
//
// These tests deliberately use ONLY the pre-fix public surface
// (createMcpSseRouter(mm, nats) + env vars + stderr) so that, run against the
// pre-fix commit, they fail for BEHAVIOURAL reasons rather than compile errors.
//
// Enforcement flag: CIPHER_MCP_ENFORCE (default off = advisory).

const ENFORCE_ENV = 'CIPHER_MCP_ENFORCE'
const FULL_SCOPES = ['memory:read', 'memory:write', 'reasoning:read', 'reasoning:write', 'session:read', 'session:write']

// ─── Mocks ──────────────────────────────────────────────────────────────────

function makeMockNats(): PmovesNatsEmitter {
  return {
    emitReasoningStored() {},
    emitSearched() {},
    emitStored() {},
  } as unknown as PmovesNatsEmitter
}

function makeMockMemoryManager(): MemoryManager {
  const memories: any[] = []
  let seq = 0
  return {
    async create(args: any) {
      seq += 1
      const m = {content: args.content, createdAt: Date.now(), id: `mem-${seq}`, metadata: args.metadata ?? {}, tags: args.tags ?? [], updatedAt: Date.now()}
      memories.push(m)
      return m
    },
    async delete() {},
    async get(id: string) {
      const m = memories.find((x) => x.id === id)
      if (!m) throw new Error(`Memory ${id} not found`)
      return m
    },
    async list() {
      return [...memories]
    },
  } as unknown as MemoryManager
}

// Simulates the real auth middleware PER REQUEST. The test chooses the
// "token identity" with headers so two callers can hit the SAME router with
// DIFFERENT identities — which a constant-at-mount fix cannot satisfy.
function perRequestAuth(req: express.Request, _res: express.Response, next: express.NextFunction): void {
  const agent = req.headers['x-test-agent']
  if (typeof agent === 'string' && agent.length > 0) {
    req.agentId = agent
    const scopes = req.headers['x-test-scopes']
    req.scopes = typeof scopes === 'string' ? scopes.split(',').filter(Boolean) : FULL_SCOPES
  } else {
    req.agentId = undefined // dev-skip mode
  }

  next()
}

async function startApp(): Promise<{baseUrl: string; server: http.Server}> {
  const app = express()
  app.use(perRequestAuth)
  // Production order: /mcp is mounted BEFORE express.json() (the SSE transport
  // reads the raw body stream itself).
  app.use('/mcp', createMcpSseRouter(makeMockMemoryManager(), makeMockNats()))
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const {port} = server.address() as AddressInfo
      resolve({baseUrl: `http://localhost:${port}`, server})
    })
  })
}

interface Identity {agent?: string; scopes?: string[]}

function identityHeaders(id: Identity): Record<string, string> {
  const h: Record<string, string> = {}
  if (id.agent) h['x-test-agent'] = id.agent
  if (id.scopes) h['x-test-scopes'] = id.scopes.join(',')
  return h
}

let rpcId = 0
function toolCall(name: string, args: Record<string, unknown>): Record<string, unknown> {
  rpcId += 1
  return {id: rpcId, jsonrpc: '2.0', method: 'tools/call', params: {arguments: args, name}}
}

// Stateless streamable-http: POST /mcp, JSON response.
function streamablePost(baseUrl: string, id: Identity, body: Record<string, unknown>): Promise<{body: any; status: number}> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(`${baseUrl}/mcp`, {
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(data),
        'Content-Type': 'application/json',
        ...identityHeaders(id),
      },
      method: 'POST',
    }, (res) => {
      let buf = ''
      res.on('data', (c) => { buf += c })
      res.on('end', () => {
        try { resolve({body: JSON.parse(buf), status: res.statusCode ?? 0}) } catch { resolve({body: buf, status: res.statusCode ?? 0}) }
      })
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

// Legacy SSE: GET /mcp/sse opens a session; POST /mcp/messages?sessionId=...
// sends a request; the JSON-RPC response arrives on the SSE stream.
interface SseSession {
  close(): void
  next(id: number): Promise<any>
  post(id: Identity, body: Record<string, unknown>): Promise<{body: string; status: number}>
}

function openSse(baseUrl: string, id: Identity): Promise<SseSession> {
  return new Promise((resolve, reject) => {
    const messages: any[] = []
    const waiters: Array<{id: number; resolve: (m: any) => void}> = []
    let endpoint = ''
    let buf = ''
    const req = http.request(`${baseUrl}/mcp/sse`, {headers: {Accept: 'text/event-stream', ...identityHeaders(id)}, method: 'GET'}, (res) => {
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        buf += chunk
        let idx = buf.indexOf('\n\n')
        while (idx !== -1) {
          const frame = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          const event = /^event: (.*)$/m.exec(frame)?.[1]
          const dataLine = /^data: (.*)$/m.exec(frame)?.[1] ?? ''
          if (event === 'endpoint' && !endpoint) {
            endpoint = dataLine
            resolve(session)
          } else if (event === 'message') {
            const msg = JSON.parse(dataLine)
            const w = waiters.findIndex((x) => x.id === msg.id)
            if (w === -1) messages.push(msg)
            else waiters.splice(w, 1)[0].resolve(msg)
          }

          idx = buf.indexOf('\n\n')
        }
      })
    })
    req.on('error', (error) => { if (!endpoint) reject(error) })
    req.end()

    const session: SseSession = {
      close() { req.destroy() },
      next(msgId: number) {
        const found = messages.findIndex((m) => m.id === msgId)
        if (found !== -1) return Promise.resolve(messages.splice(found, 1)[0])
        return new Promise((res2, rej2) => {
          const t = setTimeout(() => rej2(new Error(`no SSE response for id ${msgId}`)), 3000)
          waiters.push({id: msgId, resolve(m) { clearTimeout(t); res2(m) }})
        })
      },
      post(pid: Identity, body: Record<string, unknown>) {
        return new Promise((res2, rej2) => {
          const data = JSON.stringify(body)
          const p = http.request(`${baseUrl}${endpoint}`, {
            headers: {'Content-Length': Buffer.byteLength(data), 'Content-Type': 'application/json', ...identityHeaders(pid)},
            method: 'POST',
          }, (r) => {
            let b = ''
            r.on('data', (c) => { b += c })
            r.on('end', () => res2({body: b, status: r.statusCode ?? 0}))
          })
          p.on('error', rej2)
          p.write(data)
          p.end()
        })
      },
    }
  })
}

// Capture stderr so the advisory line is observable.
function captureStderr(): {lines: string[]; restore(): void} {
  const lines: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  ;(process.stderr as any).write = (chunk: any, ...rest: any[]) => {
    lines.push(String(chunk))
    return original(chunk, ...rest)
  }

  return {lines, restore() { (process.stderr as any).write = original }}
}

function isForbidden(msg: any): boolean {
  return Boolean(msg?.error) && /Forbidden/.test(String(msg.error.message))
}

function isResult(msg: any): boolean {
  return Boolean(msg?.result) && !msg.result.isError && !msg.error
}

const STORE = 'pmoves_cipher_store'
const SEARCH = 'pmoves_cipher_search'

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('pmoves MCP per-request identity (CIPHER_MCP_ENFORCE)', () => {
  let server: http.Server
  let baseUrl: string
  let savedEnv: string | undefined
  let stderr: ReturnType<typeof captureStderr>

  beforeEach(async () => {
    savedEnv = process.env[ENFORCE_ENV]
    delete process.env[ENFORCE_ENV]
    stderr = captureStderr()
    const app = await startApp()
    server = app.server
    baseUrl = app.baseUrl
  })

  afterEach((done) => {
    stderr.restore()
    if (savedEnv === undefined) delete process.env[ENFORCE_ENV]
    else process.env[ENFORCE_ENV] = savedEnv
    server.closeAllConnections()
    server.close(() => done())
  })

  describe('advisory mode (flag unset = default)', () => {
    it('accepts a mismatched agentId but surfaces token-agent vs declared-agent', async () => {
      const r = await streamablePost(baseUrl, {agent: 'crush-spark'}, toolCall(STORE, {agentId: 'claude-4090', content: 'x'}))
      expect(r.status).to.equal(200)
      expect(isResult(r.body), JSON.stringify(r.body)).to.equal(true)
      const line = stderr.lines.find((l) => l.includes('crush-spark') && l.includes('claude-4090'))
      expect(line, `advisory line not surfaced; stderr=${JSON.stringify(stderr.lines)}`).to.be.a('string')
      expect(line).to.match(/advisory/i)
    })

    it('does not emit an advisory line when the declared agentId matches the token', async () => {
      const r = await streamablePost(baseUrl, {agent: 'crush-spark'}, toolCall(STORE, {agentId: 'crush-spark', content: 'x'}))
      expect(isResult(r.body)).to.equal(true)
      expect(stderr.lines.filter((l) => /advisory/i.test(l))).to.have.length(0)
    })

    // F3 (review of #27): advisory tolerates ONLY a declared-name mismatch.
    // An omitted agentId or "*" with a token is refused in every mode, as on
    // REST — otherwise session_recall / hybrid_search / graph_expand reach
    // sidecar.search(agentId=undefined), an unscoped cross-agent read.
    it('F3: refuses an OMITTED agentId with a token even in advisory mode', async () => {
      for (const tool of ['pmoves_cipher_session_recall', 'pmoves_cipher_hybrid_search', 'pmoves_cipher_graph_expand', SEARCH]) {
        // eslint-disable-next-line no-await-in-loop
        const r = await streamablePost(baseUrl, {agent: 'crush-spark'}, toolCall(tool, {memoryId: 'm', query: 'q'}))
        expect(isForbidden(r.body), `${tool}: ${JSON.stringify(r.body)}`).to.equal(true)
        expect(r.body.error.code, tool).to.equal(-32_003)
      }
    })

    it('F3: refuses agentId "*" with a token even in advisory mode', async () => {
      for (const tool of [SEARCH, 'pmoves_cipher_reasoning_patterns', 'pmoves_cipher_session_recall']) {
        // eslint-disable-next-line no-await-in-loop
        const r = await streamablePost(baseUrl, {agent: 'crush-spark'}, toolCall(tool, {agentId: '*', query: 'q'}))
        expect(isForbidden(r.body), `${tool}: ${JSON.stringify(r.body)}`).to.equal(true)
      }
    })

    it('F3: omitted agentId WITHOUT a token (dev-skip) is still not refused by identity', async () => {
      const r = await streamablePost(baseUrl, {}, toolCall('pmoves_cipher_mcp_list', {}))
      expect(isResult(r.body), JSON.stringify(r.body)).to.equal(true)
    })

    it('F1: a caller-controlled agentId cannot forge a second audit line', async () => {
      const forged = "x'\npmoves-mcp-auth: ADVISORY forged-line token-agent='admin'\r\n"
      const r = await streamablePost(baseUrl, {agent: 'crush-spark'}, toolCall(STORE, {agentId: forged, content: 'x'}))
      expect(isResult(r.body), JSON.stringify(r.body)).to.equal(true)
      const auditChunks = stderr.lines.filter((l) => l.includes('pmoves-mcp-auth'))
      expect(auditChunks, JSON.stringify(auditChunks)).to.have.length(1)
      // exactly one physical line, terminated once
      expect(auditChunks[0].replace(/\n$/, '')).to.not.match(/[\r\n]/)
      const json = JSON.parse(auditChunks[0].slice(auditChunks[0].indexOf('{')))
      expect(json.declaredAgent).to.equal(forged)
      expect(json.tokenAgent).to.equal('crush-spark')
    })

    it('F7: repeats of the same (token-agent, declared-agent) pair are deduped within the interval', async () => {
      for (let i = 0; i < 3; i++) {
        // eslint-disable-next-line no-await-in-loop
        await streamablePost(baseUrl, {agent: 'crush-spark'}, toolCall(STORE, {agentId: 'claude-4090', content: `x${i}`}))
      }

      await streamablePost(baseUrl, {agent: 'crush-spark'}, toolCall(STORE, {agentId: 'hermes', content: 'y'}))
      const lines = stderr.lines.filter((l) => l.includes('pmoves-mcp-auth: ADVISORY'))
      expect(lines.filter((l) => l.includes('claude-4090')), JSON.stringify(lines)).to.have.length(1)
      expect(lines.filter((l) => l.includes('hermes')), JSON.stringify(lines)).to.have.length(1)
    })

    it('F7: the next line after the interval reports how many were suppressed', () => {
      const realNow = Date.now
      let t = 1_000_000
      Date.now = () => t
      try {
        const log = new AdvisoryLog(1000)
        const ev = {declaredAgent: 'b', kind: 'mismatch', tokenAgent: 'a'}
        log.emit(ev)
        t += 10; log.emit(ev)
        t += 10; log.emit(ev)
        t += 5000; log.emit(ev)
      } finally { Date.now = realNow }

      const lines = stderr.lines.filter((l) => l.includes('pmoves-mcp-auth: ADVISORY'))
      expect(lines, JSON.stringify(lines)).to.have.length(2)
      const last = JSON.parse(lines[1].slice(lines[1].indexOf('{')))
      expect(last.suppressedSinceLast).to.equal(2)
    })

    it('treats CIPHER_MCP_ENFORCE=false as advisory', async () => {
      process.env[ENFORCE_ENV] = 'false'
      const r = await streamablePost(baseUrl, {agent: 'crush-spark'}, toolCall(STORE, {agentId: 'claude-4090', content: 'x'}))
      expect(isResult(r.body)).to.equal(true)
    })
  })

  describe('enforce mode (CIPHER_MCP_ENFORCE=true)', () => {
    beforeEach(() => { process.env[ENFORCE_ENV] = 'true' })

    it('refuses a mismatched agentId with a Forbidden MCP error', async () => {
      const r = await streamablePost(baseUrl, {agent: 'crush-spark'}, toolCall(STORE, {agentId: 'claude-4090', content: 'x'}))
      expect(isForbidden(r.body), JSON.stringify(r.body)).to.equal(true)
      expect(r.body.error.data?.httpStatus).to.equal(403)
      expect(r.body.error.code).to.equal(-32_003)
    })

    it('accepts a matching agentId', async () => {
      const r = await streamablePost(baseUrl, {agent: 'crush-spark'}, toolCall(STORE, {agentId: 'crush-spark', content: 'x'}))
      expect(isResult(r.body), JSON.stringify(r.body)).to.equal(true)
    })

    it('derives identity per request — two callers on one router each get their own', async () => {
      const a = await streamablePost(baseUrl, {agent: 'agent-a'}, toolCall(STORE, {agentId: 'agent-a', content: 'x'}))
      const b = await streamablePost(baseUrl, {agent: 'agent-b'}, toolCall(STORE, {agentId: 'agent-b', content: 'y'}))
      const bAsA = await streamablePost(baseUrl, {agent: 'agent-b'}, toolCall(STORE, {agentId: 'agent-a', content: 'z'}))
      expect(isResult(a.body), JSON.stringify(a.body)).to.equal(true)
      expect(isResult(b.body), JSON.stringify(b.body)).to.equal(true)
      expect(isForbidden(bAsA.body), JSON.stringify(bAsA.body)).to.equal(true)
    })

    it('refuses a token-bearing call that declares no agentId (REST parity)', async () => {
      const r = await streamablePost(baseUrl, {agent: 'crush-spark'}, toolCall('pmoves_cipher_mcp_list', {}))
      expect(r.body.error, JSON.stringify(r.body)).to.not.equal(undefined)
      expect(String(r.body.error.message)).to.match(/agentId is required|Forbidden/)
    })

    it('refuses cross-agent wildcard search with a token (REST parity)', async () => {
      const r = await streamablePost(baseUrl, {agent: 'crush-spark'}, toolCall(SEARCH, {agentId: '*', query: 'q'}))
      expect(isForbidden(r.body), JSON.stringify(r.body)).to.equal(true)
    })

    it('fires the scope check: memory:write missing → store refused', async () => {
      const r = await streamablePost(baseUrl, {agent: 'crush-spark', scopes: ['memory:read']}, toolCall(STORE, {agentId: 'crush-spark', content: 'x'}))
      expect(isForbidden(r.body), JSON.stringify(r.body)).to.equal(true)
      expect(String(r.body.error.message)).to.include('memory:write')
    })

    it('scope check passes when the scope is held (read-only token can search)', async () => {
      const r = await streamablePost(baseUrl, {agent: 'crush-spark', scopes: ['memory:read']}, toolCall(SEARCH, {agentId: 'crush-spark', query: 'q'}))
      expect(isResult(r.body), JSON.stringify(r.body)).to.equal(true)
    })

    it('admin scope satisfies any required scope', async () => {
      const r = await streamablePost(baseUrl, {agent: 'crush-spark', scopes: ['admin']}, toolCall(STORE, {agentId: 'crush-spark', content: 'x'}))
      expect(isResult(r.body), JSON.stringify(r.body)).to.equal(true)
    })

    it('dev-skip (no token identity) still works in enforce mode', async () => {
      const r = await streamablePost(baseUrl, {}, toolCall(STORE, {agentId: 'anyone', content: 'x'}))
      expect(isResult(r.body), JSON.stringify(r.body)).to.equal(true)
    })
  })

  describe('legacy SSE session binding', () => {
    it('binds the SSE session identity: a mismatched agentId over /messages is refused (enforce)', async () => {
      process.env[ENFORCE_ENV] = 'true'
      const s = await openSse(baseUrl, {agent: 'crush-spark'})
      try {
        const call = toolCall(STORE, {agentId: 'claude-4090', content: 'x'})
        await s.post({agent: 'crush-spark'}, call)
        const msg = await s.next(call.id as number)
        expect(isForbidden(msg), JSON.stringify(msg)).to.equal(true)
      } finally { s.close() }
    })

    it('a matching agentId over the SSE session succeeds (enforce)', async () => {
      process.env[ENFORCE_ENV] = 'true'
      const s = await openSse(baseUrl, {agent: 'crush-spark'})
      try {
        const call = toolCall(STORE, {agentId: 'crush-spark', content: 'x'})
        const p = await s.post({agent: 'crush-spark'}, call)
        expect(p.status).to.equal(202)
        const msg = await s.next(call.id as number)
        expect(isResult(msg), JSON.stringify(msg)).to.equal(true)
      } finally { s.close() }
    })

    it('refuses a POST /messages whose token identity differs from the session owner (enforce → 403)', async () => {
      process.env[ENFORCE_ENV] = 'true'
      const s = await openSse(baseUrl, {agent: 'crush-spark'})
      try {
        const p = await s.post({agent: 'intruder'}, toolCall(STORE, {agentId: 'intruder', content: 'x'}))
        expect(p.status).to.equal(403)
      } finally { s.close() }
    })

    it('advisory: a POST /messages from a different token identity is accepted but surfaced', async () => {
      const s = await openSse(baseUrl, {agent: 'crush-spark'})
      try {
        const call = toolCall(STORE, {agentId: 'crush-spark', content: 'x'})
        const p = await s.post({agent: 'intruder'}, call)
        expect(p.status).to.equal(202)
        const line = stderr.lines.find((l) => l.includes('crush-spark') && l.includes('intruder'))
        expect(line, `session mismatch not surfaced; stderr=${JSON.stringify(stderr.lines)}`).to.be.a('string')
      } finally { s.close() }
    })

    it('dev-skip SSE session (no token) works', async () => {
      const s = await openSse(baseUrl, {})
      try {
        const call = toolCall(STORE, {agentId: 'anyone', content: 'x'})
        await s.post({}, call)
        const msg = await s.next(call.id as number)
        expect(isResult(msg), JSON.stringify(msg)).to.equal(true)
      } finally { s.close() }
    })
  })

  describe('F5: buildMcpServer requires an explicit identity', () => {
    it('omitting auth is a compile error (no silent dev-skip default)', () => {
      // @ts-expect-error -- auth is required; a default {} would reintroduce the constant-identity defect
      expect(() => buildMcpServer(makeMockMemoryManager(), makeMockNats())).to.be.a('function')
    })
  })
})
