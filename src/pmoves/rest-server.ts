import os from 'node:os'

import {createBlobStorage} from '../agent/infra/blob/blob-storage-factory.js'
import {MemoryManager} from '../agent/infra/memory/memory-manager.js'
import {createPmovesApp} from './app.js'
import {createNatsEmitter, type PmovesNatsEmitter} from './nats-emitter.js'

const DEFAULT_PORT = 8105
const DEFAULT_HOST = '0.0.0.0'
const DEFAULT_ANNOUNCE_INTERVAL_S = 60

function announceHost(host: string): string {
  // Bind host is not a routable address. When bound wide, announce the
  // container hostname (routable inside the compose network) unless an
  // explicit PMOVES_ANNOUNCE_HOST is set (e.g. `cipher-api`).
  if (host !== '0.0.0.0' && host !== '::') {
    return host
  }

  return process.env.PMOVES_ANNOUNCE_HOST ?? os.hostname()
}

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
    const announceUrl = `http://${announceHost(host)}:${port}`
    nats.announce('cipher-memory', announceUrl, port)
    // Heartbeat: re-announce periodically so fleet-sentinel's
    // last_announce_age_s stays bounded instead of growing forever
    // after a single startup publish.
    const intervalS = Number(process.env.PMOVES_ANNOUNCE_INTERVAL_S ?? DEFAULT_ANNOUNCE_INTERVAL_S)
    const heartbeat = intervalS > 0
      ? setInterval(() => nats.announce('cipher-memory', announceUrl, port), intervalS * 1000)
      : undefined
    heartbeat?.unref()
  } catch (error) {
    process.stderr.write(`pmoves-shim: NATS init failed, continuing with no-op: ${error}\n`)
    nats = await createNatsEmitter('')
  }

  const app = createPmovesApp(memoryManager, nats)

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
