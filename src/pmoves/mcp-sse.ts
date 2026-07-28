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
const TOOL_SESSION_SAVE = 'pmoves_cipher_session_save'
const TOOL_SESSION_RECALL = 'pmoves_cipher_session_recall'

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
      {
        name: TOOL_SESSION_SAVE,
        description: 'Save a session checkpoint — cold-start semantic cache. Call this at the END of every session with a summary of what was done, decisions made, and next steps. The NEXT cold start will call pmoves_cipher_session_recall to retrieve this instead of re-reading large context files (AGNOTE4482, ROADMAP, etc.). Saves ~30k tokens per cold start.',
        inputSchema: {
          type: 'object',
          properties: {
            summary: {type: 'string', description: 'Concise summary of session work: what was done, decisions made, blockers hit, next steps.'},
            agentId: {type: 'string', description: 'Agent identifier (e.g. crush-spark).'},
            harness: {type: 'string', description: 'Harness name (crush, claude-code, kimi-cli, kilocode, hermes-agent).', default: 'unknown'},
            model: {type: 'string', description: 'Model powering the agent (e.g. glm-5.2, qwen3.5:35b).', default: 'unknown'},
            contextPaths: {type: 'array', items: {type: 'string'}, description: 'Context files loaded this session (for replay).'},
            activeLanes: {type: 'array', items: {type: 'string'}, description: 'Lane IDs or PR numbers still in-flight.'},
          },
          required: ['summary', 'agentId'],
        },
      },
      {
        name: TOOL_SESSION_RECALL,
        description: 'Recall the most relevant session checkpoint for cold-start bootstrap. Call this at the START of every session. Returns the best semantic match from past session summaries (category=agent_checkpoint). If no good match, returns the most recent checkpoint for this agent. Eliminates the need to re-read AGNOTE4482 / ROADMAP / SITREP on every cold start.',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: {type: 'string', description: 'Agent identifier (e.g. crush-spark).'},
            query: {type: 'string', description: 'What you are looking for (e.g. "latest state of play", "cipher agent scope PR status", "archon dead-dir retire"). Defaults to "latest session" if omitted.'},
            limit: {type: 'number', description: 'Max checkpoints to return.', default: 3},
          },
          required: ['agentId'],
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

    if (name === TOOL_SESSION_SAVE) {
      const {summary, agentId, harness = 'unknown', model = 'unknown', contextPaths = [], activeLanes = []} = args as {
        summary: string
        agentId: string
        harness?: string
        model?: string
        contextPaths?: string[]
        activeLanes?: string[]
      }
      const ts = new Date().toISOString()
      const enrichedContent = `[${ts}] ${agentId} (${harness}/${model})\n\n${summary}\n\nActive lanes: ${activeLanes.join(', ') || 'none'}\nContext: ${contextPaths.join(', ') || 'none'}`
      const created = await memoryManager.create({
        content: enrichedContent,
        tags: ['agent_checkpoint'],
        metadata: {category: 'agent_checkpoint', agentId, harness, model, ts, contextPaths, activeLanes},
      })
      const sidecar = getEmbeddingSidecar()
      const embedding = await sidecar.embed(enrichedContent)
      if (embedding) {
        await sidecar.storeVector(created.id, embedding, 'agent_checkpoint', ['agent_checkpoint'], enrichedContent, agentId)
      }
      nats.emitStored(created.id, 'agent_checkpoint', ['agent_checkpoint'])
      return {
        content: [{type: 'text', text: JSON.stringify({id: created.id, agentId, status: 'checkpoint_saved', embedded: !!embedding, ts})}],
      }
    }

    if (name === TOOL_SESSION_RECALL) {
      const {agentId, query = 'latest session', limit = 3} = args as {agentId: string; query?: string; limit?: number}
      const sidecar = getEmbeddingSidecar()
      const queryEmbedding = await sidecar.embed(`${query} ${agentId}`)
      let results: Array<{id: string; content: string; ts: string; harness?: string; model?: string; activeLanes?: string[]; score?: number}>

      if (queryEmbedding) {
        const vectorHits = await sidecar.search(queryEmbedding, query, Math.min(limit, 10), 'agent_checkpoint', agentId)
        if (vectorHits.length > 0) {
          const memories = await Promise.all(
            vectorHits.map(async (hit) => {
              try {
                const m = await memoryManager.get(hit.id)
                return {
                  id: m.id,
                  content: m.content,
                  ts: (m.metadata?.ts as string) ?? new Date(m.createdAt).toISOString(),
                  harness: (m.metadata?.harness as string) ?? 'unknown',
                  model: (m.metadata?.model as string) ?? 'unknown',
                  activeLanes: (m.metadata?.activeLanes as string[]) ?? [],
                  score: hit.score,
                }
              } catch {
                return null
              }
            }),
          )
          results = memories.filter((m): m is NonNullable<typeof m> => m !== null)
        } else {
          results = []
        }
      } else {
        results = []
      }

      // If no semantic hits, fall back to most recent checkpoint for this agent
      if (results.length === 0) {
        const memories = await memoryManager.list({limit: Math.min(limit, 10), tags: ['agent_checkpoint']})
        results = memories
          .filter((m) => (m.metadata?.agentId as string) === agentId)
          .slice(0, limit)
          .map((m) => ({
            id: m.id,
            content: m.content,
            ts: (m.metadata?.ts as string) ?? new Date(m.createdAt).toISOString(),
            harness: (m.metadata?.harness as string) ?? 'unknown',
            model: (m.metadata?.model as string) ?? 'unknown',
            activeLanes: (m.metadata?.activeLanes as string[]) ?? [],
          }))
      }

      nats.emitSearched(query, results.length, 'agent_checkpoint')
      const hasHit = results.length > 0
      return {
        content: [{type: 'text', text: JSON.stringify({agentId, hasCheckpoint: hasHit, results})}],
      }
    }

    throw new Error(`Unknown tool: ${name}`)
  })

  return server
}
