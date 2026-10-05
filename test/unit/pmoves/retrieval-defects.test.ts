/* eslint-disable @typescript-eslint/no-explicit-any, no-return-assign,
   perfectionist/sort-objects, perfectionist/sort-object-types, perfectionist/sort-imports,
   n/no-unsupported-features/node-builtins, unicorn/prefer-global-this, unicorn/no-new-array,
   object-shorthand, @stylistic/padding-line-between-statements, no-undef, camelcase */
// Test-file rule relaxations. `fetch`/`Response`/`RequestInit` are the
// harness's own stubs (the node-builtins rule targets a >=20 engines range,
// while the suite runs on the image's Node); `camelcase` covers the live
// Hi-RAG v2 wire keys `used_rerank`/`rerank_provider`, which must be spelled
// exactly as the server sends them; the ordering rules are cosmetic here.
import {expect} from 'chai'
import express from 'express'
import http from 'node:http'
import type {AddressInfo} from 'node:net'

import type {MemoryManager} from '../../../src/agent/infra/memory/memory-manager.js'
import type {PmovesNatsEmitter} from '../../../src/pmoves/nats-emitter.js'
import {createMcpSseRouter} from '../../../src/pmoves/mcp-sse.js'

// Pins the three mcp-sse retrieval defects fixed with the Hi-RAG v2 envelope
// change: (2) list() must not receive the unsupported `tags` key on the
// reasoning_patterns / session_recall fallback branches, (3) hybrid_search must
// translate agentId "*" to undefined before scoping the vector search.

function makeMockNats(): PmovesNatsEmitter {
  return {
    emitStored: () => {},
    emitSearched: () => {},
    emitReasoningStored: () => {},
  } as unknown as PmovesNatsEmitter
}

function makeMockMemoryManager(): MemoryManager {
  const memories: any[] = [
    {id: 'm-reason-a', content: 'reasoning for agent-a', tags: ['reasoning'], metadata: {agentId: 'agent-a', category: 'reasoning'}, createdAt: Date.now(), updatedAt: Date.now()},
    {id: 'm-reason-b', content: 'reasoning for agent-b', tags: ['reasoning'], metadata: {agentId: 'agent-b', category: 'reasoning'}, createdAt: Date.now(), updatedAt: Date.now()},
    {id: 'm-context-a', content: 'plain context for agent-a', tags: ['context'], metadata: {agentId: 'agent-a', category: 'context'}, createdAt: Date.now(), updatedAt: Date.now()},
    {id: 'm-checkpoint-a', content: 'checkpoint for agent-a', tags: ['agent_checkpoint'], metadata: {agentId: 'agent-a', category: 'agent_checkpoint', ts: '2026-09-22T00:00:00Z'}, createdAt: Date.now(), updatedAt: Date.now()},
    {id: 'm-checkpoint-b', content: 'checkpoint for agent-b', tags: ['agent_checkpoint'], metadata: {agentId: 'agent-b', category: 'agent_checkpoint', ts: '2026-09-22T00:00:00Z'}, createdAt: Date.now(), updatedAt: Date.now()},
  ]
  return {
    create: async (args: any) => {
      const m = {id: `test-${Date.now()}`, content: args.content, tags: args.tags ?? [], metadata: args.metadata ?? {}, createdAt: Date.now(), updatedAt: Date.now()}
      memories.push(m)
      return m
    },
    get: async (id: string) => {
      const m = memories.find((x) => x.id === id)
      if (!m) throw new Error(`Memory ${id} not found`)
      return m
    },
    list: async (opts?: any) => {
      // Mirror upstream MemoryManager.list(): only `limit` is recognized.
      const unsupported = Object.keys(opts ?? {}).filter((k) => k !== 'limit')
      if (unsupported.length > 0) {
        throw new Error(`unrecognized_keys: ${JSON.stringify(unsupported)}`)
      }
      let result = [...memories]
      if (opts?.limit) result = result.slice(0, opts.limit)
      return result
    },
    delete: async () => {},
  } as unknown as MemoryManager
}

async function startApp(): Promise<{server: http.Server; baseUrl: string}> {
  const app = express()
  app.use(express.json())
  app.use('/mcp', createMcpSseRouter(makeMockMemoryManager(), makeMockNats()))
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const {port} = server.address() as AddressInfo
      resolve({server, baseUrl: `http://localhost:${port}`})
    })
  })
}

function mcpPost(baseUrl: string, body: Record<string, unknown>): Promise<{status: number; body: string}> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let buf = ''
      res.on('data', (c) => (buf += c))
      res.on('end', () => resolve({status: res.statusCode ?? 0, body: buf}))
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

function parseMcpBody(body: string): any {
  const dataLine = body.split('\n').find((l) => l.startsWith('data: '))
  if (dataLine) return JSON.parse(dataLine.slice('data: '.length))
  return JSON.parse(body)
}

async function mcpCall(baseUrl: string, name: string, args: Record<string, unknown>): Promise<any> {
  await mcpPost(baseUrl, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'test', version: '1.0'}},
  })
  const r = await mcpPost(baseUrl, {jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name, arguments: args}})
  return parseMcpBody(r.body)
}

describe('pmoves MCP retrieval defects (round-2 fixes)', () => {
  let server: http.Server
  let baseUrl: string
  const captured: Array<{url: string; init: RequestInit | undefined}> = []
  let originalFetch: typeof global.fetch

  beforeEach(async () => {
    const app = await startApp()
    server = app.server
    baseUrl = app.baseUrl
    captured.length = 0
    originalFetch = global.fetch
  })

  afterEach((done) => {
    global.fetch = originalFetch
    server.close(done)
  })

  describe('reasoning_patterns fallback (no embedding available)', () => {
    beforeEach(() => {
      // Every upstream fails: embed() returns null, forcing the list() fallback.
      global.fetch = (async (input: unknown, init?: RequestInit) => {
        captured.push({url: String(input), init})
        return {ok: false} as Response
      }) as typeof fetch
    })

    it('does not pass the unsupported tags key to list() and filters client-side', async () => {
      const msg = await mcpCall(baseUrl, 'pmoves_cipher_reasoning_patterns', {agentId: 'agent-a', query: 'anything', limit: 5})

      expect(JSON.stringify(msg), 'fallback must not surface unrecognized_keys').to.not.include('unrecognized_keys')
      const payload = JSON.parse(msg.result.content[0].text)
      expect(payload.results).to.have.lengthOf(1)
      expect(payload.results[0].id).to.equal('m-reason-a')
    })
  })

  describe('session_recall fallback (no embedding available)', () => {
    beforeEach(() => {
      global.fetch = (async (input: unknown, init?: RequestInit) => {
        captured.push({url: String(input), init})
        return {ok: false} as Response
      }) as typeof fetch
    })

    it('does not pass the unsupported tags key to list() on the checkpoint fallback', async () => {
      const msg = await mcpCall(baseUrl, 'pmoves_cipher_session_recall', {agentId: 'agent-a', query: 'latest session'})

      expect(JSON.stringify(msg), 'fallback must not surface unrecognized_keys').to.not.include('unrecognized_keys')
      const payload = JSON.parse(msg.result.content[0].text)
      expect(payload.hasCheckpoint).to.equal(true)
      expect(payload.results).to.have.lengthOf(1)
      expect(payload.results[0].id).to.equal('m-checkpoint-a')
    })
  })

  describe('hybrid_search agentId wildcard', () => {
    beforeEach(() => {
      global.fetch = (async (input: unknown, init?: RequestInit) => {
        const url = String(input)
        captured.push({url, init})
        if (url.includes('/healthz')) {
          // GPU probe fails -> CPU gateway serves the query.
          return {ok: false} as Response
        }
        if (url.includes('/openai/v1/embeddings')) {
          return {ok: true, json: async () => ({data: [{embedding: new Array(8).fill(0.1)}]})} as Response
        }
        if (url.includes(`/collections/${process.env.QDRANT_COLLECTION ?? 'pmoves_cipher_memory'}`) && url.includes('/points/query')) {
          return {ok: true, json: async () => ({result: {points: [{id: 'pt-1', score: 0.95, payload: {memoryId: 'm-context-a'}}]}})} as Response
        }
        if (url.includes('/collections/')) {
          // ensureCollection() check/create
          return {ok: true, json: async () => ({})} as Response
        }
        if (url.includes('/hirag/query')) {
          return {
            ok: true,
            json: async () => ({query: 'x', k: 5, used_rerank: true, rerank_provider: 'cpu', hits: [{content: 'kb hit', score: 0.8, metadata: {}}]}),
          } as Response
        }
        return {ok: false} as Response
      }) as typeof fetch
    })

    it('translates agentId "*" to unscoped instead of filtering on the literal wildcard', async () => {
      const msg = await mcpCall(baseUrl, 'pmoves_cipher_hybrid_search', {agentId: '*', query: 'context', topK: 5})

      expect(JSON.stringify(msg)).to.not.include('error')
      const payload = JSON.parse(msg.result.content[0].text)
      expect(payload.sources.kb, 'KB branch must read the v2 hits envelope').to.equal(1)
      expect(payload.sources.cipher, 'wildcard must not zero the cipher branch').to.equal(1)

      const qdrantCall = captured.find((c) => c.url.includes('/points/query'))
      expect(qdrantCall, 'a Qdrant prefetch query must have been made').to.exist
      const qdrantBody = JSON.parse(String(qdrantCall?.init?.body))
      for (const prefetch of qdrantBody.prefetch ?? []) {
        expect(JSON.stringify(prefetch.filter ?? {}), 'wildcard must not appear as an agentId filter').to.not.include('agentId')
      }
    })
  })
})
