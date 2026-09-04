import {expect} from 'chai'
import express from 'express'
import http from 'node:http'
import type {AddressInfo} from 'node:net'

import type {MemoryManager} from '../../../src/agent/infra/memory/memory-manager.js'
import type {PmovesNatsEmitter} from '../../../src/pmoves/nats-emitter.js'
import {createMcpSseRouter} from '../../../src/pmoves/mcp-sse.js'

// The legacy SSE transport (GET /mcp/sse + POST /mcp/messages) keeps sessions in
// an in-memory Map, which fails ("Unknown session", HTTP 400) when the SSE stream
// and the message POST don't share the exact same in-process transport instance —
// the failure Agent Zero hit. A stateless streamable-http endpoint (POST /mcp,
// sessionIdGenerator: undefined) needs no session map: each request is complete on
// its own. These tests pin that endpoint's contract.

function makeMockNats(): PmovesNatsEmitter {
  return {
    emitStored: () => {},
    emitSearched: () => {},
    emitReasoningStored: () => {},
  } as unknown as PmovesNatsEmitter
}

function makeMockMemoryManager(): MemoryManager {
  return {
    create: async () => ({id: 'x', content: '', tags: [], metadata: {}, createdAt: Date.now(), updatedAt: Date.now()}),
    get: async () => ({id: 'x', content: '', tags: [], metadata: {}, createdAt: Date.now(), updatedAt: Date.now()}),
    list: async () => [],
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
        // streamable-http requires the client to accept both framings
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

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'test', version: '1.0'}},
}

describe('pmoves MCP streamable-http endpoint (POST /mcp)', () => {
  let server: http.Server
  let baseUrl: string

  beforeEach(async () => {
    const app = await startApp()
    server = app.server
    baseUrl = app.baseUrl
  })

  afterEach((done) => server.close(done))

  it('handles an MCP initialize handshake statelessly (200 + serverInfo)', async () => {
    const r = await mcpPost(baseUrl, INITIALIZE)
    expect(r.status).to.equal(200)
    // JSON or SSE-framed, the payload carries the server identity
    expect(r.body).to.include('pmoves-cipher')
  })

  it('does not 400 "Unknown session" — the legacy-SSE failure mode', async () => {
    const r = await mcpPost(baseUrl, INITIALIZE)
    expect(r.body).to.not.include('Unknown session')
    expect(r.status).to.not.equal(400)
  })
})
