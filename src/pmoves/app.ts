import express from 'express'

import type {MemoryManager} from '../agent/infra/memory/memory-manager.js'
import type {PmovesNatsEmitter} from './nats-emitter.js'

import {createA2ARouter} from './a2a.js'
import {createPmovesAuthMiddleware} from './auth.js'
import {createHealthRouter} from './health.js'
import {createMcpSseRouter} from './mcp-sse.js'
import {createMemoryRoutes} from './memory-routes.js'

/**
 * The shim's HTTP app, extracted from rest-server.ts so its WIRING is testable
 * (F6): mcp-per-request-auth.test.ts checks the per-request identity logic, and
 * rest-server-wiring.test.ts drives THIS app with the real auth middleware, so
 * a /mcp mount placed before auth — or any route that stops seeing
 * req.agentId — fails a test instead of shipping.
 */
export function createPmovesApp(memoryManager: MemoryManager, nats: PmovesNatsEmitter): express.Express {
  const app = express()

  app.use(createHealthRouter())
  app.use(createA2ARouter())
  app.use((req, res, next) => {
    if (req.path === '/health' || req.path === '/healthz') return next()
    return createPmovesAuthMiddleware()(req, res, next)
  })

  // MCP /messages POST must bypass express.json() — the MCP SDK's
  // SSEServerTransport.handlePostMessage() reads the raw body stream itself.
  // Auth middleware runs FIRST (reads headers only, never body), then /mcp
  // gets the raw stream + req.agentId for enforcement. Router created ONCE
  // so the internal sessions Map persists across SSE + POST requests — which
  // is exactly why identity is NOT passed here: the router reads req.agentId /
  // req.scopes per request and binds them to each SSE session.
  // Enforcement of that identity is gated by CIPHER_MCP_ENFORCE (default off =
  // advisory: declared-name mismatches are accepted and logged). See mcp-sse.ts.
  app.use('/mcp', createMcpSseRouter(memoryManager, nats))

  app.use(express.json({limit: '5mb'}))
  app.use('/api', createMemoryRoutes(memoryManager, nats))
  return app
}
