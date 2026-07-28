import {Router} from 'express'
import {Server} from '@modelcontextprotocol/sdk/server/index.js'
import {SSEServerTransport} from '@modelcontextprotocol/sdk/server/sse.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type {MemoryManager} from '../agent/infra/memory/memory-manager.js'
import type {PmovesNatsEmitter} from './nats-emitter.js'
import {getEmbeddingSidecar} from './embedding.js'
import {getHiragClient} from './hirag-client.js'
import {getGraphClient} from './graph.js'
import {getMCPCatalogClient} from './mcp-catalog.js'

const TOOL_STORE = 'pmoves_cipher_store'
const TOOL_SEARCH = 'pmoves_cipher_search'
const TOOL_STORE_REASONING = 'pmoves_cipher_store_reasoning'
const TOOL_REASONING_PATTERNS = 'pmoves_cipher_reasoning_patterns'
const TOOL_SESSION_SAVE = 'pmoves_cipher_session_save'
const TOOL_SESSION_RECALL = 'pmoves_cipher_session_recall'
const TOOL_HYBRID_SEARCH = 'pmoves_cipher_hybrid_search'
const TOOL_GRAPH_EXPAND = 'pmoves_cipher_graph_expand'
const TOOL_MCP_LIST = 'pmoves_cipher_mcp_list'
const TOOL_MCP_GET = 'pmoves_cipher_mcp_get'

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
            query: {type: 'string', description: 'What you are looking for (e.g. "latest state of play", "cipher agent scope PR status"). Defaults to "latest session" if omitted.'},
            limit: {type: 'number', description: 'Max checkpoints to return.', default: 3},
          },
          required: ['agentId'],
        },
      },
      {
        name: TOOL_HYBRID_SEARCH,
        description: 'Hybrid search across both cipher memory (this agent\'s stored context) and the PMOVES knowledge base (Hi-RAG v2). Fuses results from Qdrant cipher collection + HiRAG\'s KB collection. Use this when you need both your own past notes AND project documentation in one query. Rerank uses GPU if available.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {type: 'string', description: 'Natural language search query.'},
            agentId: {type: 'string', description: 'Agent identifier (scopes cipher memory search).'},
            topK: {type: 'number', description: 'Results per source. Default 5 (10 total).', default: 5},
            rerank: {type: 'boolean', description: 'Use cross-encoder rerank (GPU if available). Default true.', default: true},
          },
          required: ['query', 'agentId'],
        },
      },
      {
        name: TOOL_GRAPH_EXPAND,
        description: 'Given a memory id, return its graph neighborhood (N-hop traversal via Neo4j). Discovers related memories that share categories, tags, or inferred relationships. Use after pmoves_cipher_search to find contextually connected memories the vector search missed.',
        inputSchema: {
          type: 'object',
          properties: {
            memoryId: {type: 'string', description: 'Memory id from a prior search result.'},
            agentId: {type: 'string'},
            maxDepth: {type: 'number', description: 'Max traversal depth (1-3). Default 2.', default: 2},
          },
          required: ['memoryId', 'agentId'],
        },
      },
      {
        name: TOOL_MCP_LIST,
        description: 'List available MCP servers from the gateway-agent tool registry.',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: {type: 'string'},
            transport: {type: 'string', enum: ['stdio', 'sse', 'http']},
          },
          required: ['agentId'],
        },
      },
      {
        name: TOOL_MCP_GET,
        description: 'Get detailed configuration for one MCP server from the gateway-agent registry.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {type: 'string'},
            agentId: {type: 'string'},
          },
          required: ['name', 'agentId'],
        },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const {name, arguments: args = {}} = request.params

    // ── TOOL_STORE ──────────────────────────────────────────────────────
    if (name === TOOL_STORE) {
      const {content, category = 'context', tags = [], agentId} = args as {
        content: string; category?: string; tags?: string[]; agentId?: string
      }
      if (!agentId) throw new Error('agentId is required for pmoves_cipher_store')
      const allTags = [category, ...tags].filter(Boolean)
      const created = await memoryManager.create({content, tags: allTags, metadata: {category, agentId}})
      const sidecar = getEmbeddingSidecar()
      const embedding = await sidecar.embed(content)
      if (embedding) await sidecar.storeVector(created.id, embedding, category, allTags, content, agentId)
      nats.emitStored(created.id, category, allTags)
      // Graph: write memory node + background edge inference (fail-open)
      const graph = getGraphClient()
      if (graph) {
        graph.writeMemory({id: created.id, agentId, category, tags: allTags, contentPreview: content.slice(0, 200), ts: new Date().toISOString()}).catch(() => {})
        graph.inferEdges(created.id).catch(() => {})
      }
      return {content: [{type: 'text', text: JSON.stringify({id: created.id, agentId, status: 'stored', embedded: !!embedding})}]}
    }

    // ── TOOL_SEARCH ─────────────────────────────────────────────────────
    if (name === TOOL_SEARCH) {
      const {query, category, limit = 10, agentId} = args as {query: string; category?: string; limit?: number; agentId?: string}
      if (!agentId) throw new Error('agentId is required for pmoves_cipher_search')
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
              } catch { return null }
            }),
          )
          results = memories.filter((m): m is NonNullable<typeof m> => m !== null)
        } else {
          const memories = await memoryManager.list({limit: 1000})
          results = memories.filter((m) => (!scopedAgentId || (m.metadata?.agentId as string) === scopedAgentId) && (!category || (m.metadata?.category as string) === category || (m.tags ?? []).includes(category))).slice(0, limit).map((m) => ({id: m.id, content: m.content, category: (m.metadata?.category as string) ?? 'context', tags: m.tags ?? [], agentId: (m.metadata?.agentId as string) ?? 'unknown'}))
        }
      } else {
        const memories = await memoryManager.list({limit: 1000})
        results = memories.filter((m) => (!scopedAgentId || (m.metadata?.agentId as string) === scopedAgentId) && (!category || (m.metadata?.category as string) === category || (m.tags ?? []).includes(category))).slice(0, limit).map((m) => ({id: m.id, content: m.content, category: (m.metadata?.category as string) ?? 'context', tags: m.tags ?? [], agentId: (m.metadata?.agentId as string) ?? 'unknown'}))
      }
      nats.emitSearched(query, results.length, category)
      return {content: [{type: 'text', text: JSON.stringify({results})}]}
    }

    // ── TOOL_STORE_REASONING ────────────────────────────────────────────
    if (name === TOOL_STORE_REASONING) {
      const {question, reasoning, result, agentId} = args as {question: string; reasoning: string; result: string; agentId?: string}
      if (!agentId) throw new Error('agentId is required for pmoves_cipher_store_reasoning')
      const content = `Q: ${question}\n\nReasoning:\n${reasoning}\n\nResult:\n${result}`
      const created = await memoryManager.create({content, tags: ['reasoning'], metadata: {category: 'reasoning', question, agentId}})
      const sidecar = getEmbeddingSidecar()
      const embedding = await sidecar.embed(content)
      if (embedding) await sidecar.storeVector(created.id, embedding, 'reasoning', ['reasoning'], content, agentId)
      nats.emitReasoningStored(created.id, question.slice(0, 200))
      return {content: [{type: 'text', text: JSON.stringify({id: created.id, agentId, status: 'stored', embedded: !!embedding})}]}
    }

    // ── TOOL_REASONING_PATTERNS ─────────────────────────────────────────
    if (name === TOOL_REASONING_PATTERNS) {
      const {query, limit = 5, agentId} = args as {query: string; limit?: number; agentId?: string}
      if (!agentId) throw new Error('agentId is required for pmoves_cipher_reasoning_patterns')
      const scopedAgentId = agentId === '*' ? undefined : agentId
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
              } catch { return null }
            }),
          )
          results = memories.filter((m): m is NonNullable<typeof m> => m !== null)
        } else { results = [] }
      } else { results = [] }

      if (results.length === 0) {
        const memories = await memoryManager.list({limit: 1000, tags: ['reasoning']})
        results = memories.filter((m) => !scopedAgentId || (m.metadata?.agentId as string) === scopedAgentId).slice(0, limit).map((m) => ({id: m.id, content: m.content, category: 'reasoning', agentId: (m.metadata?.agentId as string) ?? 'unknown'}))
      }
      nats.emitSearched(query, results.length, 'reasoning')
      return {content: [{type: 'text', text: JSON.stringify({results})}]}
    }

    // ── TOOL_SESSION_SAVE ───────────────────────────────────────────────
    if (name === TOOL_SESSION_SAVE) {
      const {summary, agentId, harness = 'unknown', model = 'unknown', contextPaths = [], activeLanes = []} = args as {
        summary: string; agentId: string; harness?: string; model?: string; contextPaths?: string[]; activeLanes?: string[]
      }
      const ts = new Date().toISOString()
      const enrichedContent = `[${ts}] ${agentId} (${harness}/${model})\n\n${summary}\n\nActive lanes: ${activeLanes.join(', ') || 'none'}\nContext: ${contextPaths.join(', ') || 'none'}`
      const created = await memoryManager.create({content: enrichedContent, tags: ['agent_checkpoint'], metadata: {category: 'agent_checkpoint', agentId, harness, model, ts, contextPaths, activeLanes}})
      const sidecar = getEmbeddingSidecar()
      const embedding = await sidecar.embed(enrichedContent)
      if (embedding) await sidecar.storeVector(created.id, embedding, 'agent_checkpoint', ['agent_checkpoint'], enrichedContent, agentId)
      nats.emitStored(created.id, 'agent_checkpoint', ['agent_checkpoint'])
      return {content: [{type: 'text', text: JSON.stringify({id: created.id, agentId, status: 'checkpoint_saved', embedded: !!embedding, ts})}]}
    }

    // ── TOOL_SESSION_RECALL ─────────────────────────────────────────────
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
                return {id: m.id, content: m.content, ts: (m.metadata?.ts as string) ?? new Date(m.createdAt).toISOString(), harness: (m.metadata?.harness as string) ?? 'unknown', model: (m.metadata?.model as string) ?? 'unknown', activeLanes: (m.metadata?.activeLanes as string[]) ?? [], score: hit.score}
              } catch { return null }
            }),
          )
          results = memories.filter((m): m is NonNullable<typeof m> => m !== null)
        } else { results = [] }
      } else { results = [] }

      if (results.length === 0) {
        const memories = await memoryManager.list({limit: 1000, tags: ['agent_checkpoint']})
        results = memories.filter((m) => (m.metadata?.agentId as string) === agentId).slice(0, limit).map((m) => ({id: m.id, content: m.content, ts: (m.metadata?.ts as string) ?? new Date(m.createdAt).toISOString(), harness: (m.metadata?.harness as string) ?? 'unknown', model: (m.metadata?.model as string) ?? 'unknown', activeLanes: (m.metadata?.activeLanes as string[]) ?? []}))
      }
      nats.emitSearched(query, results.length, 'agent_checkpoint')
      return {content: [{type: 'text', text: JSON.stringify({agentId, hasCheckpoint: results.length > 0, results})}]}
    }

    // ── TOOL_HYBRID_SEARCH ──────────────────────────────────────────────
    if (name === TOOL_HYBRID_SEARCH) {
      const {query, agentId, topK = 5, rerank = true} = args as {query: string; agentId: string; topK?: number; rerank?: boolean}
      const hirag = getHiragClient()
      const sidecar = getEmbeddingSidecar()
      const queryEmbedding = await sidecar.embed(query)

      const [hiragResults, cipherResults] = await Promise.all([
        hirag.query({query, topK, rerank}),
        (async () => {
          if (!queryEmbedding) return []
          const hits = await sidecar.search(queryEmbedding, query, topK, undefined, agentId)
          return Promise.all(hits.map(async (h) => {
            try {
              const m = await memoryManager.get(h.id)
              return {content: m.content, score: h.score, collection: 'cipher_memory', source: 'cipher', metadata: {agentId, category: m.metadata?.category, id: m.id}}
            } catch { return null }
          })).then((rs) => rs.filter((r): r is NonNullable<typeof r> => r !== null))
        })(),
      ])

      const fused = [
        ...hiragResults.map((r) => ({...r, source: 'kb'})),
        ...cipherResults.map((r) => ({...r, source: 'cipher_memory'})),
      ].sort((a, b) => b.score - a.score)

      nats.emitSearched(query, fused.length, 'hybrid')
      return {content: [{type: 'text', text: JSON.stringify({results: fused, sources: {kb: hiragResults.length, cipher: cipherResults.length}})}]}
    }

    // ── TOOL_GRAPH_EXPAND ───────────────────────────────────────────────
    if (name === TOOL_GRAPH_EXPAND) {
      const {memoryId, agentId, maxDepth = 2} = args as {memoryId: string; agentId: string; maxDepth?: number}
      const graph = getGraphClient()
      if (!graph) {
        return {content: [{type: 'text', text: JSON.stringify({error: 'Neo4j not available', center: null, neighbors: []})}]}
      }
      const neighborhood = await graph.expand(memoryId, Math.min(maxDepth, 3), agentId)
      return {content: [{type: 'text', text: JSON.stringify(neighborhood)}]}
    }


    // ── TOOL_MCP_LIST ──
    if (name === TOOL_MCP_LIST) {
      const {transport} = args as {transport?: string}
      const catalog = getMCPCatalogClient()
      const entries = await catalog.list()
      const filtered = transport ? entries.filter((e) => e.transport === transport) : entries
      return {content: [{type: 'text', text: JSON.stringify({mcpServers: filtered, count: filtered.length})}]}
    }

    // ── TOOL_MCP_GET ──
    if (name === TOOL_MCP_GET) {
      const {name: mcpName} = args as {name: string}
      const catalog = getMCPCatalogClient()
      const entry = await catalog.get(mcpName)
      if (!entry) return {content: [{type: 'text', text: JSON.stringify({error: 'Not found', name: mcpName})}]}
      return {content: [{type: 'text', text: JSON.stringify(entry)}]}
    }

    throw new Error(`Unknown tool: ${name}`)
  })

  return server
}