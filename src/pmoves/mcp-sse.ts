import {Router} from 'express'
import {Server} from '@modelcontextprotocol/sdk/server/index.js'
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js'
import {SSEServerTransport} from '@modelcontextprotocol/sdk/server/sse.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type {MemoryManager} from '../agent/infra/memory/memory-manager.js'
import type {PmovesNatsEmitter} from './nats-emitter.js'
import {getEmbeddingSidecar} from './embedding.js'

const TOOL_STORE = 'pmoves_cipher_store'
const TOOL_SEARCH = 'pmoves_cipher_search'
const TOOL_STORE_REASONING = 'pmoves_cipher_store_reasoning'
const TOOL_REASONING_PATTERNS = 'pmoves_cipher_reasoning_patterns'

const CATEGORIES = [
  'code_pattern',
  'decision',
  'context',
  'submodule',
  'architecture',
  'reasoning',
  'agent_plan',
  'agent_checkpoint',
  'agent_completion',
]

export function createMcpSseRouter(memoryManager: MemoryManager, nats: PmovesNatsEmitter): Router {
  const router = Router()
  const transports = new Map<string, SSEServerTransport>()

  router.get('/sse', async (req, res) => {
    const transport = new SSEServerTransport('/mcp/messages', res)
    const sessionId = transport.sessionId
    transports.set(sessionId, transport)
    const server = buildMcpServer(memoryManager, nats)
    await server.connect(transport)
    res.on('close', () => {
      transports.delete(sessionId)
    })
  })

  router.post('/messages', async (req, res) => {
    const sessionId = String(req.query.sessionId ?? '')
    const transport = transports.get(sessionId)
    if (!transport) {
      res.status(400).json({error: 'Unknown session'})
      return
    }
    await transport.handlePostMessage(req, res)
  })

  return router
}

function buildMcpServer(memoryManager: MemoryManager, nats: PmovesNatsEmitter): Server {
  const server = new Server(
    {name: 'pmoves-cipher', version: '0.1.0'},
    {capabilities: {tools: {}}},
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: TOOL_STORE,
        description: 'Store knowledge with category, tags, and agent scope. agentId is required for per-agent isolation — use your signing card agent_id (e.g. crush-spark, claude-4090).',
        inputSchema: {
          type: 'object',
          properties: {
            content: {type: 'string'},
            category: {type: 'string', enum: CATEGORIES},
            tags: {type: 'array', items: {type: 'string'}},
            agentId: {type: 'string', description: 'Agent identifier (e.g. crush-spark). Required for per-agent scope.'},
          },
          required: ['content', 'agentId'],
        },
      },
      {
        name: TOOL_SEARCH,
        description: 'Semantic search over stored memories, scoped by agentId. Returns only memories stored by the same agent unless agentId="*" (wildcard, cross-agent search).',
        inputSchema: {
          type: 'object',
          properties: {
            query: {type: 'string'},
            category: {type: 'string'},
            limit: {type: 'number'},
            agentId: {type: 'string', description: 'Agent identifier to scope search. Use "*" for cross-agent search (advisory mode only).'},
          },
          required: ['query', 'agentId'],
        },
      },
      {
        name: TOOL_STORE_REASONING,
        description: 'Store chain-of-thought reasoning traces, scoped by agentId.',
        inputSchema: {
          type: 'object',
          properties: {
            question: {type: 'string'},
            reasoning: {type: 'string'},
            result: {type: 'string'},
            agentId: {type: 'string', description: 'Agent identifier.'},
          },
          required: ['question', 'reasoning', 'result', 'agentId'],
        },
      },
      {
        name: TOOL_REASONING_PATTERNS,
        description: 'Search past reasoning for similar problems, scoped by agentId.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {type: 'string'},
            limit: {type: 'number'},
            agentId: {type: 'string', description: 'Agent identifier. Use "*" for cross-agent search.'},
          },
          required: ['query', 'agentId'],
        },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const {name, arguments: args = {}} = request.params

    if (name === TOOL_STORE) {
      const {content, category = 'context', tags = [], agentId} = args as {
        content: string
        category?: string
        tags?: string[]
        agentId?: string
      }
      if (!agentId) {
        throw new Error('agentId is required for pmoves_cipher_store')
      }
      const allTags = [category, ...tags].filter(Boolean)
      const created = await memoryManager.create({
        content,
        tags: allTags,
        metadata: {category, agentId},
      })
      const sidecar = getEmbeddingSidecar()
      const embedding = await sidecar.embed(content)
      if (embedding) {
        await sidecar.storeVector(created.id, embedding, category, allTags, content, agentId)
      }
      nats.emitStored(created.id, category, allTags)
      return {
        content: [{type: 'text', text: JSON.stringify({id: created.id, agentId, status: 'stored', embedded: !!embedding})}],
      }
    }

    if (name === TOOL_SEARCH) {
      const {query, category, limit = 10, agentId} = args as {query: string; category?: string; limit?: number; agentId?: string}
      if (!agentId) {
        throw new Error('agentId is required for pmoves_cipher_search')
      }
      // Wildcard "*" means cross-agent search — omit agentId from Qdrant filter
      // and metadata filter. Advisory mode only — token enforcement (PR 2) can override.
      const scopedAgentId = agentId === '*' ? undefined : agentId
      const sidecar = getEmbeddingSidecar()
      const queryEmbedding = await sidecar.embed(query)
      let results: Array<{id: string; content: string; category: string; tags: string[]; agentId?: string; score?: number}>

      if (queryEmbedding) {
        const vectorHits = await sidecar.search(queryEmbedding, query, Math.min(limit, 100), category, scopedAgentId)
        if (vectorHits.length > 0) {
          const memories = await Promise.all(
            vectorHits.map(async (hit) => {
              try {
                const m = await memoryManager.get(hit.id)
                return {id: m.id, content: m.content, category: (m.metadata?.category as string) ?? 'context', tags: m.tags ?? [], agentId: (m.metadata?.agentId as string) ?? 'unknown', score: hit.score}
              } catch {
                return null
              }
            }),
          )
          results = memories.filter((m): m is NonNullable<typeof m> => m !== null)
        } else {
          const memories = await memoryManager.list({limit: Math.min(limit, 100)})
          results = memories
            .filter((m) => {
              if (scopedAgentId && (m.metadata?.agentId as string) !== scopedAgentId) return false
              if (category && (m.metadata?.category as string) !== category && !(m.tags ?? []).includes(category)) return false
              return true
            })
            .map((m) => ({id: m.id, content: m.content, category: (m.metadata?.category as string) ?? 'context', tags: m.tags ?? [], agentId: (m.metadata?.agentId as string) ?? 'unknown'}))
        }
      } else {
        const memories = await memoryManager.list({limit: Math.min(limit, 100)})
        results = memories
          .filter((m) => {
            if (scopedAgentId && (m.metadata?.agentId as string) !== scopedAgentId) return false
            if (category && (m.metadata?.category as string) !== category && !(m.tags ?? []).includes(category)) return false
            return true
          })
          .map((m) => ({id: m.id, content: m.content, category: (m.metadata?.category as string) ?? 'context', tags: m.tags ?? [], agentId: (m.metadata?.agentId as string) ?? 'unknown'}))
      }
      nats.emitSearched(query, results.length, category)
      return {
        content: [{type: 'text', text: JSON.stringify({results})}],
      }
    }

    if (name === TOOL_STORE_REASONING) {
      const {question, reasoning, result, agentId} = args as {
        question: string
        reasoning: string
        result: string
        agentId?: string
      }
      if (!agentId) {
        throw new Error('agentId is required for pmoves_cipher_store_reasoning')
      }
      const content = `Q: ${question}\n\nReasoning:\n${reasoning}\n\nResult:\n${result}`
      const created = await memoryManager.create({
        content,
        tags: ['reasoning'],
        metadata: {category: 'reasoning', question, agentId},
      })
      // Store reasoning in Qdrant too (dense + BM25) for semantic search across reasoning traces
      const sidecar = getEmbeddingSidecar()
      const embedding = await sidecar.embed(content)
      if (embedding) {
        await sidecar.storeVector(created.id, embedding, 'reasoning', ['reasoning'], content, agentId)
      }
      nats.emitReasoningStored(created.id, question.slice(0, 200))
      return {
        content: [{type: 'text', text: JSON.stringify({id: created.id, agentId, status: 'stored', embedded: !!embedding})}],
      }
    }

    if (name === TOOL_REASONING_PATTERNS) {
      const {query, limit = 5, agentId} = args as {query: string; limit?: number; agentId?: string}
      if (!agentId) {
        throw new Error('agentId is required for pmoves_cipher_reasoning_patterns')
      }
      // Wildcard cross-agent search
      const scopedAgentId = agentId === '*' ? undefined : agentId
      // Use semantic search via Qdrant first (dense + BM25 hybrid), fall back to lexical list
      const sidecar = getEmbeddingSidecar()
      const queryEmbedding = await sidecar.embed(query)
      let results: Array<{id: string; content: string; category: string; agentId?: string; score?: number}>

      if (queryEmbedding) {
        const vectorHits = await sidecar.search(queryEmbedding, query, Math.min(limit, 20), 'reasoning', scopedAgentId)
        if (vectorHits.length > 0) {
          const memories = await Promise.all(
            vectorHits.map(async (hit) => {
              try {
                const m = await memoryManager.get(hit.id)
                return {id: m.id, content: m.content, category: 'reasoning', agentId: (m.metadata?.agentId as string) ?? 'unknown', score: hit.score}
              } catch {
                return null
              }
            }),
          )
          results = memories.filter((m): m is NonNullable<typeof m> => m !== null)
        } else {
          const memories = await memoryManager.list({limit: Math.min(limit, 20), tags: ['reasoning']})
          results = memories
            .filter((m) => !scopedAgentId || (m.metadata?.agentId as string) === scopedAgentId)
            .map((m) => ({id: m.id, content: m.content, category: 'reasoning', agentId: (m.metadata?.agentId as string) ?? 'unknown'}))
        }
      } else {
        const memories = await memoryManager.list({
          limit: Math.min(limit, 20),
          tags: ['reasoning'],
        })
        results = memories
          .filter((m) => !scopedAgentId || (m.metadata?.agentId as string) === scopedAgentId)
          .map((m) => ({
            id: m.id,
            content: m.content,
            category: 'reasoning',
            agentId: (m.metadata?.agentId as string) ?? 'unknown',
          }))
      }
      nats.emitSearched(query, results.length, 'reasoning')
      return {
        content: [{type: 'text', text: JSON.stringify({results})}],
      }
    }

    throw new Error(`Unknown tool: ${name}`)
  })

  return server
}
