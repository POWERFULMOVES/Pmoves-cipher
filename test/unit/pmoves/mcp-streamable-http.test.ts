import type {AddressInfo} from 'node:net'

import {expect} from 'chai'
import express from 'express'
import http from 'node:http'

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
    emitReasoningStored() {},
    emitSearched() {},
    emitStored() {},
  } as unknown as PmovesNatsEmitter
}

function makeMockMemoryManager(): MemoryManager {
  return {
    create: async () => ({content: '', createdAt: Date.now(), id: 'x', metadata: {}, tags: [], updatedAt: Date.now()}),
    async delete() {},
    get: async () => ({content: '', createdAt: Date.now(), id: 'x', metadata: {}, tags: [], updatedAt: Date.now()}),
    list: async () => [],
  } as unknown as MemoryManager
}

async function startApp(): Promise<{baseUrl: string; server: http.Server;}> {
  const app = express()
  app.use(express.json())
  app.use('/mcp', createMcpSseRouter(makeMockMemoryManager(), makeMockNats()))
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const {port} = server.address() as AddressInfo
      resolve({baseUrl: `http://localhost:${port}`, server})
    })
  })
}

function mcpPost(baseUrl: string, body: Record<string, unknown>): Promise<{body: string; status: number;}> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(`${baseUrl}/mcp`, {
      headers: {
        // streamable-http requires the client to accept both framings
        Accept: 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(data),
        'Content-Type': 'application/json',
      },
      method: 'POST',
    }, (res) => {
      let buf = ''
      res.on('data', (c) => {
        buf += c
      })
      res.on('end', () => resolve({body: buf, status: res.statusCode ?? 0}))
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

const INITIALIZE = {
  id: 1,
  jsonrpc: '2.0',
  method: 'initialize',
  params: {capabilities: {}, clientInfo: {name: 'test', version: '1.0'}, protocolVersion: '2024-11-05'},
}

describe('pmoves MCP streamable-http endpoint (POST /mcp)', () => {
  let server: http.Server
  let baseUrl: string

  beforeEach(async () => {
    const app = await startApp()
    server = app.server
    baseUrl = app.baseUrl
  })

  afterEach((done) => {
    server.close(done)
  })

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
