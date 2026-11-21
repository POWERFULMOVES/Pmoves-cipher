const SUBJECT_STORED = 'cipher.memory.stored.v1'
const SUBJECT_SEARCHED = 'cipher.memory.searched.v1'
const SUBJECT_REASONING = 'cipher.reasoning.stored.v1'
const SUBJECT_ANNOUNCE = 'services.announce.v1'

export interface PmovesNatsEmitter {
  announce(slug: string, url: string, port: number): void
  close(): Promise<void>
  emitReasoningStored(reasoningId: string, question: string): void
  emitSearched(query: string, resultCount: number, category?: string): void
  emitStored(memoryId: string, category: string, tags: string[]): void
}

export async function createNatsEmitter(url: string): Promise<PmovesNatsEmitter> {
  if (!url) {
    return createNoOpEmitter()
  }

  try {
    const natsModule = await import('nats')

    // Parse credentials from URL (nats://user:pass@host:port)
    let servers: string = url
    let user: string | undefined
    let pass: string | undefined
    try {
      const parsed = new URL(url)
      if (parsed.username) {
        user = decodeURIComponent(parsed.username)
        pass = parsed.password ? decodeURIComponent(parsed.password) : undefined
        servers = `${parsed.protocol}//${parsed.host}`
      }
    } catch {
      // URL parse failed — pass raw string to nats client
    }

    const nc = await natsModule.connect({
      servers,
      ...(user && {user}),
      ...(pass && {pass}),
    })
    const publish = (subject: string, payload: Record<string, unknown>) => {
      try {
        nc.publish(subject, new TextEncoder().encode(JSON.stringify({...payload, timestamp: new Date().toISOString()})))
      } catch (error) {
        process.stderr.write(`pmoves-nats: publish failed on ${subject}: ${error}\n`)
      }
    }

    return {
      announce(slug, url, port) {
        publish(SUBJECT_ANNOUNCE, {
          health_check: `${url}/health`,
          metadata: {bridge_for: 'cipher-memory', protocol: 'rest+mcp', transport: 'sse'},
          name: 'Cipher Memory (PMOVES Shim)',
          port,
          slug,
          tier: 'data',
          timestamp: new Date().toISOString(),
          url,
        })
      },
      async close() {
        try {
          await nc.drain()
        } catch {
          // ignore
        }
      },
      emitReasoningStored: (reasoningId, question) => publish(SUBJECT_REASONING, {question, reasoning_id: reasoningId}),
      emitSearched: (query, resultCount, category) => publish(SUBJECT_SEARCHED, {category, query, result_count: resultCount}),
      emitStored: (memoryId, category, tags) => publish(SUBJECT_STORED, {category, memory_id: memoryId, tags}),
    }
  } catch (error) {
    process.stderr.write(`pmoves-nats: connect failed — emitting no-op (${error})\n`)
    return createNoOpEmitter()
  }
}

function createNoOpEmitter(): PmovesNatsEmitter {
  return {
    announce() {},
    async close() {},
    emitReasoningStored() {},
    emitSearched() {},
    emitStored() {},
  }
}
