import express from 'express'

import {createBlobStorage} from '../agent/infra/blob/blob-storage-factory.js'
import {MemoryManager} from '../agent/infra/memory/memory-manager.js'
import {createA2ARouter} from './a2a.js'
import {createPmovesAuthMiddleware} from './auth.js'
import {createHealthRouter} from './health.js'
import {createMcpSseRouter} from './mcp-sse.js'
import {createMemoryRoutes} from './memory-routes.js'
import {createNatsEmitter, type PmovesNatsEmitter} from './nats-emitter.js'

const DEFAULT_PORT = 8105
const DEFAULT_HOST = '0.0.0.0'

function parseArgs(): {host: string; port: number;} {
  const args = process.argv.slice(2)
  const port = Number(args[args.indexOf('--port') + 1] ?? process.env.PMOVES_PORT ?? DEFAULT_PORT)
  const hostIdx = args.indexOf('--host')
  const host = hostIdx === -1 ? process.env.PMOVES_HOST ?? DEFAULT_HOST : args[hostIdx + 1]
  return {host, port}
}

async function main(): Promise<void> {
  const {host, port} = parseArgs()
  const natsUrl = process.env.NATS_URL ?? ''
  const storageDir = process.env.PMOVES_STORAGE_DIR
  const useInMemory = !storageDir

  const blobStorage = createBlobStorage(
    useInMemory ? {inMemory: true} : {storageDir},
  )
  await blobStorage.initialize()
  const memoryManager = new MemoryManager(blobStorage)

  let nats: PmovesNatsEmitter
  try {
    nats = await createNatsEmitter(natsUrl)
    nats.announce('cipher-memory', `http://${host}:${port}`, port)
  } catch (error) {
    process.stderr.write(`pmoves-shim: NATS init failed, continuing with no-op: ${error}\n`)
    nats = await createNatsEmitter('')
  }

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
  // so the internal transports Map persists across SSE + POST requests.
  app.use('/mcp', createMcpSseRouter(memoryManager, nats))

  app.use(express.json({limit: '5mb'}))
  app.use('/api', createMemoryRoutes(memoryManager, nats))

  return new Promise((resolve) => {
    const server = app.listen(port, host, () => {
      process.stdout.write(`pmoves-cipher-shim listening on http://${host}:${port}\n`)
    })
    const shutdown = async () => {
      server.close()
      await nats.close()
      resolve()
    }

    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)
  })
}

try {
  await main()
} catch (error) {
  process.stderr.write(`pmoves-cipher-shim fatal: ${error}\n`)
  process.exitCode = 1
}
