/* eslint-disable @typescript-eslint/no-explicit-any, unicorn/no-useless-undefined */
import type {AddressInfo} from 'node:net'

import {expect} from 'chai'
import express from 'express'
import http from 'node:http'

import type {MemoryManager} from '../../../src/agent/infra/memory/memory-manager.js'
import type {PmovesNatsEmitter} from '../../../src/pmoves/nats-emitter.js'

import {createMemoryRoutes} from '../../../src/pmoves/memory-routes.js'

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
  return {
    async create(args: any) {
      const m = {content: args.content, id: `test-${Date.now()}`, metadata: args.metadata ?? {}, tags: args.tags ?? []}
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
    async list(opts?: any) {
      let result = [...memories]
      if (opts?.limit) result = result.slice(0, opts.limit)
      return result
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

async function startTestApp(authAgentId: string | undefined): Promise<{baseUrl: string; server: http.Server;}> {
  const app = express()
  app.use(express.json())
  app.use(simulatedAuthMiddleware(authAgentId, ['memory:read', 'memory:write']))
  const mm = makeMockMemoryManager()
  app.use('/api', createMemoryRoutes(mm, makeMockNats()))
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const {port} = server.address() as AddressInfo
      resolve({baseUrl: `http://localhost:${port}`, server})
    })
  })
}

function httpRequest(baseUrl: string, method: string, path: string, body?: any): Promise<{body: any; status: number;}> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined
    const req = http.request(`${baseUrl}${path}`, {
      headers: {'Content-Type': 'application/json', ...(data ? {'Content-Length': data.length} : {})},
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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('pmoves per-agent token enforcement (Phase B PR 2)', () => {
  describe('POST /api/memory — token enforcement', () => {
    it('rejects store when args.agentId does not match token agentId (403)', async () => {
      const {baseUrl, server} = await startTestApp('crush-spark')
      try {
        const r = await httpRequest(baseUrl, 'POST', '/api/memory', {agentId: 'claude-4090', content: 'sneaky'})
        expect(r.status).to.equal(403)
        expect(r.body.error).to.include('Forbidden')
      } finally {
        await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      }
    })

    it('allows store when args.agentId matches token agentId', async () => {
      const {baseUrl, server} = await startTestApp('crush-spark')
      try {
        const r = await httpRequest(baseUrl, 'POST', '/api/memory', {agentId: 'crush-spark', content: 'legit'})
        expect(r.status).to.equal(201)
      } finally {
        await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      }
    })

    it('rejects store without agentId when token is present (400)', async () => {
      const {baseUrl, server} = await startTestApp('crush-spark')
      try {
        const r = await httpRequest(baseUrl, 'POST', '/api/memory', {content: 'no agent'})
        expect(r.status).to.equal(400)
      } finally {
        await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      }
    })

    it('advisory mode (no token) allows self-declared agentId', async () => {
      const {baseUrl, server} = await startTestApp(undefined)
      try {
        const r = await httpRequest(baseUrl, 'POST', '/api/memory', {agentId: 'kimi-spark', content: 'advisory'})
        expect(r.status).to.equal(201)
      } finally {
        await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      }
    })
  })

  describe('GET /api/memory/search — token enforcement', () => {
    it('rejects wildcard agentId=* in token enforcement mode', async () => {
      const {baseUrl, server} = await startTestApp('crush-spark')
      try {
        const r = await httpRequest(baseUrl, 'GET', '/api/memory/search?q=test&agentId=*')
        expect(r.status).to.equal(403)
        expect(r.body.error).to.include('wildcard')
      } finally {
        await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      }
    })

    it('rejects search when args.agentId mismatches token', async () => {
      const {baseUrl, server} = await startTestApp('crush-spark')
      try {
        const r = await httpRequest(baseUrl, 'GET', '/api/memory/search?q=test&agentId=claude-4090')
        expect(r.status).to.equal(403)
      } finally {
        await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      }
    })

    it('advisory mode allows wildcard cross-agent search', async () => {
      const {baseUrl, server} = await startTestApp(undefined)
      try {
        const r = await httpRequest(baseUrl, 'GET', '/api/memory/search?q=test&agentId=*')
        expect(r.status).to.equal(200)
      } finally {
        await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      }
    })
  })
})
