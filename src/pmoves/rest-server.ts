import express from 'express'
import {createBlobStorage} from '../../agent/infra/blob/blob-storage-factory.js'
import {MemoryManager} from '../../agent/infra/memory/memory-manager.js'
import {createPmovesAuthMiddleware} from './auth.js'
import {createHealthRouter} from './health.js'
import {createMemoryRoutes} from './memory-routes.js'
import {createMcpSseRouter} from './mcp-sse.js'
import {createNatsEmitter, type PmovesNatsEmitter} from './nats-emitter.js'

const DEFAULT_PORT = 8105
const DEFAULT_HOST = '0.0.0.0'

function parseArgs(): {port: number; host: string} {
  const args = process.argv.slice(2)
  const port = Number(args[args.indexOf('--port') + 1] ?? process.env.PMOVES_PORT ?? DEFAULT_PORT)
  const hostIdx = args.indexOf('--host')
  const host = hostIdx >= 0 ? args[hostIdx + 1] : process.env.PMOVES_HOST ?? DEFAULT_HOST
  return {port, host}
}

async function main(): Promise<void> {
  const {port, host} = parseArgs()
  const natsUrl = process.env.NATS_URL ?? ''
  const storageDir = process.env.PMOVES_STORAGE_DIR

  const blobStorage = createBlobStorage(storageDir ? {storageDir} : undefined)
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
  app.use(express.json({limit: '5mb'}))

  app.use(createHealthRouter())
  app.use((req, res, next) => {
    if (req.path === '/health' || req.path === '/healthz') return next()
    return createPmovesAuthMiddleware()(req, res, next)
  })
  app.use('/api', createMemoryRoutes(memoryManager, nats))
  app.use('/mcp', createMcpSseRouter(memoryManager, nats))

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

main().catch((error) => {
  process.stderr.write(`pmoves-cipher-shim fatal: ${error}\n`)
  process.exit(1)
})
