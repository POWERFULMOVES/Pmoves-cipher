const SUBJECT_STORED = 'cipher.memory.stored.v1'
const SUBJECT_SEARCHED = 'cipher.memory.searched.v1'
const SUBJECT_REASONING = 'cipher.reasoning.stored.v1'
const SUBJECT_ANNOUNCE = 'services.announce.v1'

export interface PmovesNatsEmitter {
  emitStored(memoryId: string, category: string, tags: string[]): void
  emitSearched(query: string, resultCount: number, category?: string): void
  emitReasoningStored(reasoningId: string, question: string): void
  announce(slug: string, url: string, port: number): void
  close(): Promise<void>
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
      emitStored: (memoryId, category, tags) => publish(SUBJECT_STORED, {memory_id: memoryId, category, tags}),
      emitSearched: (query, resultCount, category) => publish(SUBJECT_SEARCHED, {query, result_count: resultCount, category}),
      emitReasoningStored: (reasoningId, question) => publish(SUBJECT_REASONING, {reasoning_id: reasoningId, question}),
      announce: (slug, url, port) => {
        publish(SUBJECT_ANNOUNCE, {
          slug,
          name: 'Cipher Memory (PMOVES Shim)',
          url,
          health_check: `${url}/health`,
          tier: 'data',
          port,
          timestamp: new Date().toISOString(),
          metadata: {bridge_for: 'cipher-memory', protocol: 'rest+mcp', transport: 'sse'},
        })
      },
      close: async () => {
        try {
          await nc.drain()
        } catch {
          // ignore
        }
      },
    }
  } catch (error) {
    process.stderr.write(`pmoves-nats: connect failed — emitting no-op (${error})\n`)
    return createNoOpEmitter()
  }
}

function createNoOpEmitter(): PmovesNatsEmitter {
  return {
    emitStored() {},
    emitSearched() {},
    emitReasoningStored() {},
    announce() {},
    async close() {},
  }
}
