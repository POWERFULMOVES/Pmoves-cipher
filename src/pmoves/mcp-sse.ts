import {Server} from '@modelcontextprotocol/sdk/server/index.js'
import {SSEServerTransport} from '@modelcontextprotocol/sdk/server/sse.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {Router} from 'express'

import type {MemoryManager} from '../agent/infra/memory/memory-manager.js'
import type {PmovesNatsEmitter} from './nats-emitter.js'

import {getEmbeddingSidecar} from './embedding.js'
import {getGraphClient} from './graph.js'
import {getHiragClient} from './hirag-client.js'
import {getMCPCatalogClient} from './mcp-catalog.js'

export interface McpAuthContext {
  /** Resolved agentId from auth middleware (undefined in dev-skip mode). */
  agentId?: string
  /** Resolved scopes from auth middleware. */
  scopes?: string[]
}

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

export function createMcpSseRouter(memoryManager: MemoryManager, nats: PmovesNatsEmitter, auth: McpAuthContext = {}): Router {
  const router = Router()
  const transports = new Map<string, SSEServerTransport>()

  router.get('/sse', async (req, res) => {
    const transport = new SSEServerTransport('/mcp/messages', res)
    const {sessionId} = transport
    transports.set(sessionId, transport)
    const server = buildMcpServer(memoryManager, nats, auth)
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

function buildMcpServer(memoryManager: MemoryManager, nats: PmovesNatsEmitter, auth: McpAuthContext = {}): Server {
  const {agentId: authAgentId, scopes: authScopes = []} = auth

  function assertAgentId(argsAgentId?: string, requiredScope?: string): void {
    if (authAgentId && argsAgentId !== authAgentId) {
      throw new Error(`Forbidden: token belongs to agent '${authAgentId}', but request specified '${argsAgentId}'`)
    }

    if (requiredScope && authAgentId && !authScopes.includes(requiredScope) && !authScopes.includes('admin')) {
      throw new Error(`Forbidden: missing required scope '${requiredScope}'`)
    }
  }

  const server = new Server(
    {name: 'pmoves-cipher', version: '0.1.0'},
    {capabilities: {tools: {}}},
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        description: 'Store knowledge with category, tags, and agent scope. agentId is required for per-agent isolation — use your signing card agent_id (e.g. crush-spark, claude-4090).',
        inputSchema: {
          properties: {
            agentId: {description: 'Agent identifier (e.g. crush-spark). Required for per-agent scope.', type: 'string'},
            category: {enum: CATEGORIES, type: 'string'},
            content: {type: 'string'},
            tags: {items: {type: 'string'}, type: 'array'},
          },
          required: ['content', 'agentId'],
          type: 'object',
        },
        name: TOOL_STORE,
      },
      {
        description: 'Semantic search over stored memories, scoped by agentId. Returns only memories stored by the same agent unless agentId="*" (wildcard, cross-agent search).',
        inputSchema: {
          properties: {
            agentId: {description: 'Agent identifier to scope search. Use "*" for cross-agent search (advisory mode only).', type: 'string'},
            category: {type: 'string'},
            limit: {type: 'number'},
            query: {type: 'string'},
          },
          required: ['query', 'agentId'],
          type: 'object',
        },
        name: TOOL_SEARCH,
      },
      {
        description: 'Store chain-of-thought reasoning traces, scoped by agentId.',
        inputSchema: {
          properties: {
            agentId: {description: 'Agent identifier.', type: 'string'},
            question: {type: 'string'},
            reasoning: {type: 'string'},
            result: {type: 'string'},
          },
          required: ['question', 'reasoning', 'result', 'agentId'],
          type: 'object',
        },
        name: TOOL_STORE_REASONING,
      },
      {
        description: 'Search past reasoning for similar problems, scoped by agentId.',
        inputSchema: {
          properties: {
            agentId: {description: 'Agent identifier. Use "*" for cross-agent search.', type: 'string'},
            limit: {type: 'number'},
            query: {type: 'string'},
          },
          required: ['query', 'agentId'],
          type: 'object',
        },
        name: TOOL_REASONING_PATTERNS,
      },
      {
        description: 'Save a session checkpoint — cold-start semantic cache. Call this at the END of every session with a summary of what was done, decisions made, and next steps. The NEXT cold start will call pmoves_cipher_session_recall to retrieve this instead of re-reading large context files (AGNOTE4482, ROADMAP, etc.). Saves ~30k tokens per cold start.',
        inputSchema: {
          properties: {
            activeLanes: {description: 'Lane IDs or PR numbers still in-flight.', items: {type: 'string'}, type: 'array'},
            agentId: {description: 'Agent identifier (e.g. crush-spark).', type: 'string'},
            contextPaths: {description: 'Context files loaded this session (for replay).', items: {type: 'string'}, type: 'array'},
            harness: {default: 'unknown', description: 'Harness name (crush, claude-code, kimi-cli, kilocode, hermes-agent).', type: 'string'},
            model: {default: 'unknown', description: 'Model powering the agent (e.g. glm-5.2, qwen3.5:35b).', type: 'string'},
            summary: {description: 'Concise summary of session work: what was done, decisions made, blockers hit, next steps.', type: 'string'},
          },
          required: ['summary', 'agentId'],
          type: 'object',
        },
        name: TOOL_SESSION_SAVE,
      },
      {
        description: 'Recall the most relevant session checkpoint for cold-start bootstrap. Call this at the START of every session. Returns the best semantic match from past session summaries (category=agent_checkpoint). If no good match, returns the most recent checkpoint for this agent. Eliminates the need to re-read AGNOTE4482 / ROADMAP / SITREP on every cold start.',
        inputSchema: {
          properties: {
            agentId: {description: 'Agent identifier (e.g. crush-spark).', type: 'string'},
            limit: {default: 3, description: 'Max checkpoints to return.', type: 'number'},
            query: {description: 'What you are looking for (e.g. "latest state of play", "cipher agent scope PR status"). Defaults to "latest session" if omitted.', type: 'string'},
          },
          required: ['agentId'],
          type: 'object',
        },
        name: TOOL_SESSION_RECALL,
      },
      {
        description: 'Hybrid search across both cipher memory (this agent\'s stored context) and the PMOVES knowledge base (Hi-RAG v2). Fuses results from Qdrant cipher collection + HiRAG\'s KB collection. Use this when you need both your own past notes AND project documentation in one query. Rerank uses GPU if available.',
        inputSchema: {
          properties: {
            agentId: {description: 'Agent identifier (scopes cipher memory search).', type: 'string'},
            query: {description: 'Natural language search query.', type: 'string'},
            rerank: {default: true, description: 'Use cross-encoder rerank (GPU if available). Default true.', type: 'boolean'},
            topK: {default: 5, description: 'Results per source. Default 5 (10 total).', type: 'number'},
          },
          required: ['query', 'agentId'],
          type: 'object',
        },
        name: TOOL_HYBRID_SEARCH,
      },
      {
        description: 'Given a memory id, return its graph neighborhood (N-hop traversal via Neo4j). Discovers related memories that share categories, tags, or inferred relationships. Use after pmoves_cipher_search to find contextually connected memories the vector search missed.',
        inputSchema: {
          properties: {
            agentId: {type: 'string'},
            maxDepth: {default: 2, description: 'Max traversal depth (1-3). Default 2.', type: 'number'},
            memoryId: {description: 'Memory id from a prior search result.', type: 'string'},
          },
          required: ['memoryId', 'agentId'],
          type: 'object',
        },
        name: TOOL_GRAPH_EXPAND,
      },
      {
        description: 'List available MCP servers from the gateway-agent tool registry.',
        inputSchema: {
          properties: {
            agentId: {type: 'string'},
            transport: {enum: ['stdio', 'sse', 'http'], type: 'string'},
          },
          required: ['agentId'],
          type: 'object',
        },
        name: TOOL_MCP_LIST,
      },
      {
        description: 'Get detailed configuration for one MCP server from the gateway-agent registry.',
        inputSchema: {
          properties: {
            agentId: {type: 'string'},
            name: {type: 'string'},
          },
          required: ['name', 'agentId'],
          type: 'object',
        },
        name: TOOL_MCP_GET,
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const {arguments: args = {}, name} = request.params
    const argsAgentId = (args as {agentId?: string}).agentId
    if (argsAgentId) assertAgentId(argsAgentId)

    // ── TOOL_STORE ──────────────────────────────────────────────────────
    if (name === TOOL_STORE) {
      const {agentId, category = 'context', content, tags = []} = args as {
        agentId?: string; category?: string; content: string; tags?: string[];
      }
      if (!agentId) throw new Error('agentId is required for pmoves_cipher_store')
      const allTags = [category, ...tags].filter(Boolean)
      const created = await memoryManager.create({content, metadata: {agentId, category}, tags: allTags})
      const sidecar = getEmbeddingSidecar()
      const embedding = await sidecar.embed(content)
      if (embedding) await sidecar.storeVector(created.id, embedding, category, allTags, content, agentId)
      nats.emitStored(created.id, category, allTags)
      // Graph: write memory node + background edge inference (fail-open)
      const graph = getGraphClient()
      if (graph) {
        graph.writeMemory({agentId, category, contentPreview: content.slice(0, 200), id: created.id, tags: allTags, ts: new Date().toISOString()}).catch(() => {})
        graph.inferEdges(created.id).catch(() => {})
      }

      return {content: [{text: JSON.stringify({agentId, embedded: Boolean(embedding), id: created.id, status: 'stored'}), type: 'text'}]}
    }

    // ── TOOL_SEARCH ─────────────────────────────────────────────────────
    if (name === TOOL_SEARCH) {
      const {agentId, category, limit = 10, query} = args as {agentId?: string; category?: string; limit?: number; query: string;}
      if (!agentId) throw new Error('agentId is required for pmoves_cipher_search')
      const scopedAgentId = agentId === '*' ? undefined : agentId
      const sidecar = getEmbeddingSidecar()
      const queryEmbedding = await sidecar.embed(query)
      let results: Array<{agentId?: string; category: string; content: string; id: string; score?: number; tags: string[];}>

      if (queryEmbedding) {
        const vectorHits = await sidecar.search(queryEmbedding, query, Math.min(limit, 100), category, scopedAgentId)
        if (vectorHits.length > 0) {
          const memories = await Promise.all(
            vectorHits.map(async (hit) => {
              try {
                const m = await memoryManager.get(hit.id)
                return {agentId: (m.metadata?.agentId as string) ?? 'unknown', category: (m.metadata?.category as string) ?? 'context', content: m.content, id: m.id, score: hit.score, tags: m.tags ?? []}
              } catch { return null }
            }),
          )
          results = memories.filter((m): m is NonNullable<typeof m> => m !== null)
        } else {
          const memories = await memoryManager.list({limit: 1000})
          results = memories.filter((m) => (!scopedAgentId || (m.metadata?.agentId as string) === scopedAgentId) && (!category || (m.metadata?.category as string) === category || (m.tags ?? []).includes(category))).slice(0, limit).map((m) => ({agentId: (m.metadata?.agentId as string) ?? 'unknown', category: (m.metadata?.category as string) ?? 'context', content: m.content, id: m.id, tags: m.tags ?? []}))
        }
      } else {
        const memories = await memoryManager.list({limit: 1000})
        results = memories.filter((m) => (!scopedAgentId || (m.metadata?.agentId as string) === scopedAgentId) && (!category || (m.metadata?.category as string) === category || (m.tags ?? []).includes(category))).slice(0, limit).map((m) => ({agentId: (m.metadata?.agentId as string) ?? 'unknown', category: (m.metadata?.category as string) ?? 'context', content: m.content, id: m.id, tags: m.tags ?? []}))
      }

      nats.emitSearched(query, results.length, category)
      return {content: [{text: JSON.stringify({results}), type: 'text'}]}
    }

    // ── TOOL_STORE_REASONING ────────────────────────────────────────────
    if (name === TOOL_STORE_REASONING) {
      const {agentId, question, reasoning, result} = args as {agentId?: string; question: string; reasoning: string; result: string;}
      if (!agentId) throw new Error('agentId is required for pmoves_cipher_store_reasoning')
      const content = `Q: ${question}\n\nReasoning:\n${reasoning}\n\nResult:\n${result}`
      const created = await memoryManager.create({content, metadata: {agentId, category: 'reasoning', question}, tags: ['reasoning']})
      const sidecar = getEmbeddingSidecar()
      const embedding = await sidecar.embed(content)
      if (embedding) await sidecar.storeVector(created.id, embedding, 'reasoning', ['reasoning'], content, agentId)
      nats.emitReasoningStored(created.id, question.slice(0, 200))
      return {content: [{text: JSON.stringify({agentId, embedded: Boolean(embedding), id: created.id, status: 'stored'}), type: 'text'}]}
    }

    // ── TOOL_REASONING_PATTERNS ─────────────────────────────────────────
    if (name === TOOL_REASONING_PATTERNS) {
      const {agentId, limit = 5, query} = args as {agentId?: string; limit?: number; query: string;}
      if (!agentId) throw new Error('agentId is required for pmoves_cipher_reasoning_patterns')
      const scopedAgentId = agentId === '*' ? undefined : agentId
      const sidecar = getEmbeddingSidecar()
      const queryEmbedding = await sidecar.embed(query)
      let results: Array<{agentId?: string; category: string; content: string; id: string; score?: number}>

      if (queryEmbedding) {
        const vectorHits = await sidecar.search(queryEmbedding, query, Math.min(limit, 20), 'reasoning', scopedAgentId)
        if (vectorHits.length > 0) {
          const memories = await Promise.all(
            vectorHits.map(async (hit) => {
              try {
                const m = await memoryManager.get(hit.id)
                return {agentId: (m.metadata?.agentId as string) ?? 'unknown', category: 'reasoning', content: m.content, id: m.id, score: hit.score}
              } catch { return null }
            }),
          )
          results = memories.filter((m): m is NonNullable<typeof m> => m !== null)
        } else { results = [] }
      } else { results = [] }

      if (results.length === 0) {
        const memories = await memoryManager.list({limit: 1000, tags: ['reasoning']})
        results = memories.filter((m) => !scopedAgentId || (m.metadata?.agentId as string) === scopedAgentId).slice(0, limit).map((m) => ({agentId: (m.metadata?.agentId as string) ?? 'unknown', category: 'reasoning', content: m.content, id: m.id}))
      }

      nats.emitSearched(query, results.length, 'reasoning')
      return {content: [{text: JSON.stringify({results}), type: 'text'}]}
    }

    // ── TOOL_SESSION_SAVE ───────────────────────────────────────────────
    if (name === TOOL_SESSION_SAVE) {
      const {activeLanes = [], agentId, contextPaths = [], harness = 'unknown', model = 'unknown', summary} = args as {
        activeLanes?: string[]; agentId: string; contextPaths?: string[]; harness?: string; model?: string; summary: string;
      }
      const ts = new Date().toISOString()
      const enrichedContent = `[${ts}] ${agentId} (${harness}/${model})\n\n${summary}\n\nActive lanes: ${activeLanes.join(', ') || 'none'}\nContext: ${contextPaths.join(', ') || 'none'}`
      const created = await memoryManager.create({content: enrichedContent, metadata: {activeLanes, agentId, category: 'agent_checkpoint', contextPaths, harness, model, ts}, tags: ['agent_checkpoint']})
      const sidecar = getEmbeddingSidecar()
      const embedding = await sidecar.embed(enrichedContent)
      if (embedding) await sidecar.storeVector(created.id, embedding, 'agent_checkpoint', ['agent_checkpoint'], enrichedContent, agentId)
      nats.emitStored(created.id, 'agent_checkpoint', ['agent_checkpoint'])
      return {content: [{text: JSON.stringify({agentId, embedded: Boolean(embedding), id: created.id, status: 'checkpoint_saved', ts}), type: 'text'}]}
    }

    // ── TOOL_SESSION_RECALL ─────────────────────────────────────────────
    if (name === TOOL_SESSION_RECALL) {
      const {agentId, limit = 3, query = 'latest session'} = args as {agentId: string; limit?: number; query?: string;}
      const sidecar = getEmbeddingSidecar()
      const queryEmbedding = await sidecar.embed(`${query} ${agentId}`)
      let results: Array<{activeLanes?: string[]; content: string; harness?: string; id: string; model?: string; score?: number; ts: string;}>

      if (queryEmbedding) {
        const vectorHits = await sidecar.search(queryEmbedding, query, Math.min(limit, 10), 'agent_checkpoint', agentId)
        if (vectorHits.length > 0) {
          const memories = await Promise.all(
            vectorHits.map(async (hit) => {
              try {
                const m = await memoryManager.get(hit.id)
                return {activeLanes: (m.metadata?.activeLanes as string[]) ?? [], content: m.content, harness: (m.metadata?.harness as string) ?? 'unknown', id: m.id, model: (m.metadata?.model as string) ?? 'unknown', score: hit.score, ts: (m.metadata?.ts as string) ?? new Date(m.createdAt).toISOString()}
              } catch { return null }
            }),
          )
          results = memories.filter((m): m is NonNullable<typeof m> => m !== null)
        } else { results = [] }
      } else { results = [] }

      if (results.length === 0) {
        const memories = await memoryManager.list({limit: 1000, tags: ['agent_checkpoint']})
        results = memories.filter((m) => (m.metadata?.agentId as string) === agentId).slice(0, limit).map((m) => ({activeLanes: (m.metadata?.activeLanes as string[]) ?? [], content: m.content, harness: (m.metadata?.harness as string) ?? 'unknown', id: m.id, model: (m.metadata?.model as string) ?? 'unknown', ts: (m.metadata?.ts as string) ?? new Date(m.createdAt).toISOString()}))
      }

      nats.emitSearched(query, results.length, 'agent_checkpoint')
      return {content: [{text: JSON.stringify({agentId, hasCheckpoint: results.length > 0, results}), type: 'text'}]}
    }

    // ── TOOL_HYBRID_SEARCH ──────────────────────────────────────────────
    if (name === TOOL_HYBRID_SEARCH) {
      const {agentId, query, rerank = true, topK = 5} = args as {agentId: string; query: string; rerank?: boolean; topK?: number;}
      const hirag = getHiragClient()
      const sidecar = getEmbeddingSidecar()
      const queryEmbedding = await sidecar.embed(query)

      const [hiragResults, cipherResults] = await Promise.all([
        hirag.query({query, rerank, topK}),
        (async () => {
          if (!queryEmbedding) return []
          const hits = await sidecar.search(queryEmbedding, query, topK, undefined, agentId)
          return Promise.all(hits.map(async (h) => {
            try {
              const m = await memoryManager.get(h.id)
              return {collection: 'cipher_memory', content: m.content, metadata: {agentId, category: m.metadata?.category, id: m.id}, score: h.score, source: 'cipher'}
            } catch { return null }
          })).then((rs) => rs.filter((r): r is NonNullable<typeof r> => r !== null))
        })(),
      ])

      const fused = [
        ...hiragResults.map((r) => ({...r, source: 'kb'})),
        ...cipherResults.map((r) => ({...r, source: 'cipher_memory'})),
      ].sort((a, b) => b.score - a.score)

      nats.emitSearched(query, fused.length, 'hybrid')
      return {content: [{text: JSON.stringify({results: fused, sources: {cipher: cipherResults.length, kb: hiragResults.length}}), type: 'text'}]}
    }

    // ── TOOL_GRAPH_EXPAND ───────────────────────────────────────────────
    if (name === TOOL_GRAPH_EXPAND) {
      const {agentId, maxDepth = 2, memoryId} = args as {agentId: string; maxDepth?: number; memoryId: string;}
      const graph = getGraphClient()
      if (!graph) {
        return {content: [{text: JSON.stringify({center: null, error: 'Neo4j not available', neighbors: []}), type: 'text'}]}
      }

      const neighborhood = await graph.expand(memoryId, Math.min(maxDepth, 3), agentId)
      return {content: [{text: JSON.stringify(neighborhood), type: 'text'}]}
    }


    // ── TOOL_MCP_LIST ──
    if (name === TOOL_MCP_LIST) {
      const {transport} = args as {transport?: string}
      const catalog = getMCPCatalogClient()
      const entries = await catalog.list()
      const filtered = transport ? entries.filter((e) => e.transport === transport) : entries
      return {content: [{text: JSON.stringify({count: filtered.length, mcpServers: filtered}), type: 'text'}]}
    }

    // ── TOOL_MCP_GET ──
    if (name === TOOL_MCP_GET) {
      const {name: mcpName} = args as {name: string}
      const catalog = getMCPCatalogClient()
      const entry = await catalog.get(mcpName)
      if (!entry) return {content: [{text: JSON.stringify({error: 'Not found', name: mcpName}), type: 'text'}]}
      return {content: [{text: JSON.stringify(entry), type: 'text'}]}
    }

    throw new Error(`Unknown tool: ${name}`)
  })

  return server
}