import type {AddressInfo} from 'node:net'

import {expect} from 'chai'
import express from 'express'
import http from 'node:http'

import type {Memory} from '../../../src/agent/core/domain/memory/types.js'
import type {MemoryManager} from '../../../src/agent/infra/memory/memory-manager.js'
import type {PmovesNatsEmitter} from '../../../src/pmoves/nats-emitter.js'

import {createMemoryRoutes} from '../../../src/pmoves/memory-routes.js'

// ─── Mock helpers ───────────────────────────────────────────────────────────

interface MockMemory extends Memory {
  content: string
  createdAt: number
  id: string
  metadata: Record<string, unknown>
  tags: string[]
  updatedAt: number
}

function makeMockMemory(id: string, content: string, agentId: string, category: string = 'context'): MockMemory {
  return {
    content,
    createdAt: Date.now(),
    id,
    metadata: {agentId, category},
    tags: [category],
    updatedAt: Date.now(),
  }
}

function makeMockMemoryManager(memories: MockMemory[]): Partial<MemoryManager> {
  return {
    async create({content, metadata, tags}) {
      const m = makeMockMemory(`test-${Date.now()}`, content, (metadata as Record<string, string>).agentId ?? 'unknown', (metadata as Record<string, string>).category)
      m.tags = tags ?? [m.metadata.category as string]
      m.metadata = metadata ?? {}
      memories.push(m)
      return m
    },
    async delete(id: string) {
      const idx = memories.findIndex((x) => x.id === id)
      if (idx === -1) throw new Error(`Memory ${id} not found`)
      memories.splice(idx, 1)
    },
    async get(id: string) {
      const m = memories.find((x) => x.id === id)
      if (!m) throw new Error(`Memory ${id} not found`)
      return m
    },
    async list(opts?: {limit?: number; tags?: string[]}) {
      let result = [...memories]
      if (opts?.tags && opts.tags.length > 0) {
        result = result.filter((m) => opts.tags!.some((t) => m.tags?.includes(t)))
      }

      if (opts?.limit) result = result.slice(0, opts.limit)
      return result
    },
  }
}

function makeMockNats(): PmovesNatsEmitter {
  return {
    emitReasoningStored() {},
    emitSearched() {},
    emitStored() {},
  } as unknown as PmovesNatsEmitter
}

async function startTestApp(memories: MockMemory[]): Promise<{baseUrl: string; server: http.Server;}> {
  const app = express()
  app.use(express.json())
  const mm = makeMockMemoryManager(memories) as MemoryManager
  const router = createMemoryRoutes(mm, makeMockNats())
  app.use('/api', router)
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const {port} = server.address() as AddressInfo
      resolve({baseUrl: `http://localhost:${port}`, server})
    })
  })
}

function httpRequest(baseUrl: string, method: string, path: string, body?: Record<string, unknown>): Promise<{body: unknown; status: number;}> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined
    const req = http.request(`${baseUrl}${path}`, {
      headers: {'Content-Type': 'application/json', ...(data ? {'Content-Length': data.length} : {})},
      method,
    }, (res) => {
      let buf = ''
      res.on('data', (c) => {
        buf += c
      })
      res.on('end', () => {
        try { resolve({body: JSON.parse(buf), status: res.statusCode ?? 0}) } catch { resolve({body: buf, status: res.statusCode ?? 0}) }
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('pmoves per-agent isolation (PR #11 regression tests)', () => {
  let server: http.Server
  let baseUrl: string
  let memories: MockMemory[]

  beforeEach(async () => {
    memories = []
    const app = await startTestApp(memories)
    server = app.server
    baseUrl = app.baseUrl
  })

  afterEach((done) => {
    server.close(done)
  })

  describe('POST /api/memory — store with agentId', () => {
    it('rejects store without agentId', async () => {
      const r = await httpRequest(baseUrl, 'POST', '/api/memory', {content: 'test'})
      expect(r.status).to.equal(400)
      expect((r.body as {error: string}).error).to.include('agentId is required')
    })

    it('stores with agentId', async () => {
      const r = await httpRequest(baseUrl, 'POST', '/api/memory', {agentId: 'crush-spark', content: 'my memory'})
      expect(r.status).to.equal(201)
      expect((r.body as {agentId: string}).agentId).to.equal('crush-spark')
    })

    it('prevents metadata.agentId from overriding top-level agentId (Codex P2)', async () => {
      const r = await httpRequest(baseUrl, 'POST', '/api/memory', {
        agentId: 'crush-spark',
        content: 'sneaky',
        metadata: {agentId: 'claude-4090'},  // attempt to override
      })
      expect(r.status).to.equal(201)
      expect((r.body as {agentId: string}).agentId).to.equal('crush-spark')
      // Verify the stored memory's metadata has the correct agentId
      const stored = memories.find((m) => m.content === 'sneaky')
      expect(stored?.metadata.agentId).to.equal('crush-spark')
    })
  })

  describe('GET /api/memory/search — agent-scoped search', () => {
    it('returns only memories matching agentId', async () => {
      memories.push(
        makeMockMemory('a1', 'alpha memory', 'crush-spark'),
        makeMockMemory('b2', 'beta memory', 'claude-4090'),
        makeMockMemory('a3', 'gamma memory', 'crush-spark'),
      )

      const r = await httpRequest(baseUrl, 'GET', '/api/memory/search?q=memory&agentId=crush-spark')
      expect(r.status).to.equal(200)
      const {results} = (r.body as {results: Array<{agentId: string; id: string;}>})
      expect(results).to.have.length(2)
      expect(results.every((m) => m.agentId === 'crush-spark')).to.be.true
    })

    it('lexical fallback finds older memories when newer ones belong to other agents (Codex P1)', async () => {
      // Create 5 memories for claude-4090 (newest)
      for (let i = 0; i < 5; i++) {
        memories.push(makeMockMemory(`new-${i}`, `new claude ${i}`, 'claude-4090'))
      }

      // One older memory for crush-spark
      memories.push(makeMockMemory('old-1', 'old crush memory', 'crush-spark'))

      const r = await httpRequest(baseUrl, 'GET', '/api/memory/search?q=memory&agentId=crush-spark&limit=5')
      expect(r.status).to.equal(200)
      const {results} = (r.body as {results: Array<{agentId: string; id: string;}>})
      // Before the fix, the limit=5 loaded only the 5 newest (all claude),
      // then filtered → empty. After the fix, it loads all, filters, then slices.
      expect(results).to.have.length(1)
      expect(results[0].agentId).to.equal('crush-spark')
    })

    it('wildcard agentId="*" returns cross-agent results', async () => {
      memories.push(
        makeMockMemory('a1', 'alpha', 'crush-spark'),
        makeMockMemory('b2', 'beta', 'claude-4090'),
      )

      const r = await httpRequest(baseUrl, 'GET', '/api/memory/search?q=alpha+beta&agentId=*')
      expect(r.status).to.equal(200)
      // Lexical fallback with no scope returns all matching
      const {results} = (r.body as {results: MockMemory[]})
      expect(results.length).to.be.greaterThan(0)
    })
  })

  describe('DELETE /api/memory/:id — ownership enforcement', () => {
    it('rejects delete by wrong agent (Codex P1)', async () => {
      memories.push(makeMockMemory('target', 'secret', 'crush-spark'))

      const r = await httpRequest(baseUrl, 'DELETE', '/api/memory/target?agentId=claude-4090')
      expect(r.status).to.equal(403)
      // Verify memory still exists
      expect(memories.find((m) => m.id === 'target')).to.exist
    })

    it('allows delete by owner', async () => {
      memories.push(makeMockMemory('target', 'mine', 'crush-spark'))

      const r = await httpRequest(baseUrl, 'DELETE', '/api/memory/target?agentId=crush-spark')
      expect(r.status).to.equal(204)
      expect(memories.find((m) => m.id === 'target')).to.not.exist
    })

    it('returns 404 for missing memory', async () => {
      const r = await httpRequest(baseUrl, 'DELETE', '/api/memory/nonexistent?agentId=crush-spark')
      expect(r.status).to.equal(404)
    })
  })
})
