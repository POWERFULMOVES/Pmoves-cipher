/* eslint-disable @typescript-eslint/no-explicit-any, no-return-assign, no-promise-executor-return, prefer-destructuring, unicorn/no-useless-undefined */
import {expect} from 'chai'
import express from 'express'
import http from 'node:http'
import type {AddressInfo} from 'node:net'

import type {MemoryManager} from '../../../src/agent/infra/memory/memory-manager.js'
import type {PmovesNatsEmitter} from '../../../src/pmoves/nats-emitter.js'
import {createMemoryRoutes} from '../../../src/pmoves/memory-routes.js'

// ─── Mocks ──────────────────────────────────────────────────────────────────

function makeMockNats(): PmovesNatsEmitter {
  return {
    emitStored: () => {},
    emitSearched: () => {},
    emitReasoningStored: () => {},
  } as unknown as PmovesNatsEmitter
}

function makeMockMemoryManager(): MemoryManager {
  const memories: any[] = []
  return {
    create: async (args: any) => {
      const m = {id: `test-${Date.now()}`, content: args.content, tags: args.tags ?? [], metadata: args.metadata ?? {}}
      memories.push(m)
      return m
    },
    get: async (id: string) => {
      const m = memories.find((x) => x.id === id)
      if (!m) throw new Error(`Memory ${id} not found`)
      return m
    },
    list: async (opts?: any) => {
      let result = [...memories]
      if (opts?.limit) result = result.slice(0, opts.limit)
      return result
    },
    delete: async (id: string) => {
      const idx = memories.findIndex((x) => x.id === id)
      if (idx === -1) throw new Error(`Memory ${id} not found`)
      memories.splice(idx, 1)
    },
  } as unknown as MemoryManager
}

function simulatedAuthMiddleware(agentId: string | undefined, scopes: string[] = []) {
  return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.agentId = agentId
    req.scopes = scopes
    next()
  }
}

// The MemoryManager is returned so a test can seed a record owned by a
// DIFFERENT agent than the one the token authenticates. Cross-agent reads
// cannot be set up through the HTTP surface alone: the simulated auth
// middleware fixes one agentId for the lifetime of the app, so every request
// to a given instance speaks as the same agent.
async function startTestApp(authAgentId: string | undefined): Promise<{server: http.Server; baseUrl: string; mm: MemoryManager}> {
  const app = express()
  app.use(express.json())
  app.use(simulatedAuthMiddleware(authAgentId, ['memory:read', 'memory:write']))
  const mm = makeMockMemoryManager()
  app.use('/api', createMemoryRoutes(mm, makeMockNats()))
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const {port} = server.address() as AddressInfo
      resolve({server, baseUrl: `http://localhost:${port}`, mm})
    })
  })
}

/** Seed a memory owned by `ownerAgentId`, bypassing the HTTP layer. */
async function seedMemory(mm: MemoryManager, ownerAgentId: string, content: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const created = await (mm as any).create({content, metadata: {agentId: ownerAgentId, category: 'context'}, tags: []})
  // The mock's create() omits createdAt, but GET /memory/:id calls
  // new Date(memory.createdAt).toISOString(), which throws RangeError on
  // undefined and surfaces as a 500. That no existing test tripped this is
  // itself evidence the route was never exercised: the suite covered POST and
  // search, the two routes that already enforced identity.
  created.createdAt = Date.now()
  return created.id as string
}

function httpRequest(baseUrl: string, method: string, path: string, body?: any): Promise<{status: number; body: any}> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined
    const req = http.request(`${baseUrl}${path}`, {
      method,
      headers: {'Content-Type': 'application/json', ...(data ? {'Content-Length': data.length} : {})},
    }, (res) => {
      let buf = ''
      res.on('data', (c) => { buf += c })
      res.on('end', () => {
        try { resolve({status: res.statusCode ?? 0, body: JSON.parse(buf)}) } catch { resolve({status: res.statusCode ?? 0, body: buf}) }
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('pmoves per-agent token enforcement (Phase B PR 2)', () => {
  describe('POST /api/memory — token enforcement', () => {
    it('rejects store when args.agentId does not match token agentId (403)', async () => {
      const {server, baseUrl} = await startTestApp('crush-spark')
      try {
        const r = await httpRequest(baseUrl, 'POST', '/api/memory', {content: 'sneaky', agentId: 'claude-4090'})
        expect(r.status).to.equal(403)
        expect(r.body.error).to.include('Forbidden')
      } finally {
        await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      }
    })

    it('allows store when args.agentId matches token agentId', async () => {
      const {server, baseUrl} = await startTestApp('crush-spark')
      try {
        const r = await httpRequest(baseUrl, 'POST', '/api/memory', {content: 'legit', agentId: 'crush-spark'})
        expect(r.status).to.equal(201)
      } finally {
        await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      }
    })

    it('rejects store without agentId when token is present (400)', async () => {
      const {server, baseUrl} = await startTestApp('crush-spark')
      try {
        const r = await httpRequest(baseUrl, 'POST', '/api/memory', {content: 'no agent'})
        expect(r.status).to.equal(400)
      } finally {
        await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      }
    })

    it('advisory mode (no token) allows self-declared agentId', async () => {
      const {server, baseUrl} = await startTestApp(undefined)
      try {
        const r = await httpRequest(baseUrl, 'POST', '/api/memory', {content: 'advisory', agentId: 'kimi-spark'})
        expect(r.status).to.equal(201)
      } finally {
        await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      }
    })
  })

  describe('GET /api/memory/search — token enforcement', () => {
    it('rejects wildcard agentId=* in token enforcement mode', async () => {
      const {server, baseUrl} = await startTestApp('crush-spark')
      try {
        const r = await httpRequest(baseUrl, 'GET', '/api/memory/search?q=test&agentId=*')
        expect(r.status).to.equal(403)
        expect(r.body.error).to.include('wildcard')
      } finally {
        await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      }
    })

    it('rejects search when args.agentId mismatches token', async () => {
      const {server, baseUrl} = await startTestApp('crush-spark')
      try {
        const r = await httpRequest(baseUrl, 'GET', '/api/memory/search?q=test&agentId=claude-4090')
        expect(r.status).to.equal(403)
      } finally {
        await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      }
    })

    it('advisory mode allows wildcard cross-agent search', async () => {
      const {server, baseUrl} = await startTestApp(undefined)
      try {
        const r = await httpRequest(baseUrl, 'GET', '/api/memory/search?q=test&agentId=*')
        expect(r.status).to.equal(200)
      } finally {
        await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      }
    })
  })

  // GET /api/memory/:id was the one memory route with no identity check, while
  // POST, search and DELETE all called assertAgentId. The suite mirrored that
  // gap exactly -- it covered the three enforced routes and never asked about
  // read-by-id -- so the hole stayed green. Flagged in PR #12 review, unfixed.
  describe('GET /api/memory/:id — token enforcement (IDOR)', () => {
    it('does not return a memory belonging to another agent', async () => {
      const {server, baseUrl, mm} = await startTestApp('claude-4090')
      try {
        const victimId = await seedMemory(mm, 'crush-spark', 'another agent private memory')
        const r = await httpRequest(baseUrl, 'GET', `/api/memory/${victimId}`)
        expect(r.status).to.not.equal(200)
        // The body must not leak the record under any status.
        expect(JSON.stringify(r.body)).to.not.contain('another agent private memory')
      } finally {
        await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      }
    })

    it('answers 404 (not 403) for another agent memory, so IDs cannot be probed', async () => {
      const {server, baseUrl, mm} = await startTestApp('claude-4090')
      try {
        const victimId = await seedMemory(mm, 'crush-spark', 'private')
        const hit = await httpRequest(baseUrl, 'GET', `/api/memory/${victimId}`)
        const miss = await httpRequest(baseUrl, 'GET', '/api/memory/definitely-not-a-real-id')
        // Identical responses: a 403 here would confirm the id EXISTS and is
        // simply owned by someone else, which is an enumeration oracle over
        // nanoid(12) keys. "Not yours" and "not there" must be indistinguishable.
        expect(hit.status).to.equal(404)
        expect(miss.status).to.equal(404)
      } finally {
        await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      }
    })

    it('allows an agent to read its own memory', async () => {
      const {server, baseUrl, mm} = await startTestApp('claude-4090')
      try {
        const ownId = await seedMemory(mm, 'claude-4090', 'my own memory')
        const r = await httpRequest(baseUrl, 'GET', `/api/memory/${ownId}`)
        expect(r.status).to.equal(200)
        expect(r.body.content).to.equal('my own memory')
        expect(r.body.agentId).to.equal('claude-4090')
      } finally {
        await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      }
    })

    it('advisory mode (no token) still allows cross-agent read', async () => {
      // Advisory mode is the documented dev-skip path: assertAgentId returns
      // early when the request carries no agent identity. Enforcing here would
      // break every unauthenticated local workflow, so this asserts the fix is
      // scoped to token mode and changes nothing else.
      const {server, baseUrl, mm} = await startTestApp(undefined)
      try {
        const id = await seedMemory(mm, 'crush-spark', 'advisory readable')
        const r = await httpRequest(baseUrl, 'GET', `/api/memory/${id}`)
        expect(r.status).to.equal(200)
        expect(r.body.content).to.equal('advisory readable')
      } finally {
        await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      }
    })

    it('still 404s for an id that does not exist', async () => {
      const {server, baseUrl} = await startTestApp('claude-4090')
      try {
        const r = await httpRequest(baseUrl, 'GET', '/api/memory/no-such-id')
        expect(r.status).to.equal(404)
      } finally {
        await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      }
    })
  })

  // DELETE already carried an ownership check, but it guarded on
  // `ownerAgentId && ownerAgentId !== agentId` -- so a record with NO recorded
  // owner skipped the check entirely and was deletable by any token holder.
  // That is data loss rather than disclosure, which makes it the more serious
  // of the two. It also answered 403 and named the owning agent, both of which
  // leak more than GET does after the fix in this stack.
  describe('DELETE /api/memory/:id — ownership', () => {
    it('does not delete a memory that has no recorded owner', async () => {
      const {server, baseUrl, mm} = await startTestApp('claude-4090')
      try {
        // No agentId in metadata at all -- a legacy or unattributed record.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const created = await (mm as any).create({content: 'unowned', metadata: {category: 'context'}, tags: []})
        created.createdAt = Date.now()
        const r = await httpRequest(baseUrl, 'DELETE', `/api/memory/${created.id}?agentId=claude-4090`)
        expect(r.status).to.not.equal(204)
        // And it must still be there afterwards.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const survivor = await (mm as any).get(created.id).catch(() => undefined)
        expect(survivor, 'unowned memory was deleted').to.not.equal(undefined)
      } finally {
        await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      }
    })

    it('does not delete another agent memory, and answers 404 not 403', async () => {
      const {server, baseUrl, mm} = await startTestApp('claude-4090')
      try {
        const victimId = await seedMemory(mm, 'crush-spark', 'not yours')
        const r = await httpRequest(baseUrl, 'DELETE', `/api/memory/${victimId}?agentId=claude-4090`)
        expect(r.status).to.equal(404)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const survivor = await (mm as any).get(victimId).catch(() => undefined)
        expect(survivor, 'another agent memory was deleted').to.not.equal(undefined)
      } finally {
        await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      }
    })

    it('does not name the owning agent in the error body', async () => {
      const {server, baseUrl, mm} = await startTestApp('claude-4090')
      try {
        const victimId = await seedMemory(mm, 'crush-spark', 'not yours')
        const r = await httpRequest(baseUrl, 'DELETE', `/api/memory/${victimId}?agentId=claude-4090`)
        // Naming the owner discloses WHO holds the record on top of confirming
        // that it exists. Operators still need that detail -- it belongs in the
        // server log, not the response.
        expect(JSON.stringify(r.body)).to.not.contain('crush-spark')
      } finally {
        await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      }
    })

    it('still lets an agent delete its own memory', async () => {
      const {server, baseUrl, mm} = await startTestApp('claude-4090')
      try {
        const ownId = await seedMemory(mm, 'claude-4090', 'mine to remove')
        const r = await httpRequest(baseUrl, 'DELETE', `/api/memory/${ownId}?agentId=claude-4090`)
        expect(r.status).to.equal(204)
      } finally {
        await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      }
    })

    it('still 404s for an id that does not exist', async () => {
      const {server, baseUrl} = await startTestApp('claude-4090')
      try {
        const r = await httpRequest(baseUrl, 'DELETE', '/api/memory/no-such-id?agentId=claude-4090')
        expect(r.status).to.equal(404)
      } finally {
        await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      }
    })
  })
})
