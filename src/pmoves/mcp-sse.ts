import {Router} from 'express'
import {Server} from '@modelcontextprotocol/sdk/server/index.js'
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js'
import {SSEServerTransport} from '@modelcontextprotocol/sdk/server/sse.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type {MemoryManager} from '../../agent/infra/memory/memory-manager.js'
import type {PmovesNatsEmitter} from './nats-emitter.js'

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
        description: 'Store knowledge with category and tags',
        inputSchema: {
          type: 'object',
          properties: {
            content: {type: 'string'},
            category: {type: 'string', enum: CATEGORIES},
            tags: {type: 'array', items: {type: 'string'}},
          },
          required: ['content'],
        },
      },
      {
        name: TOOL_SEARCH,
        description: 'Semantic search over stored memories',
        inputSchema: {
          type: 'object',
          properties: {
            query: {type: 'string'},
            category: {type: 'string'},
            limit: {type: 'number'},
          },
          required: ['query'],
        },
      },
      {
        name: TOOL_STORE_REASONING,
        description: 'Store chain-of-thought reasoning traces',
        inputSchema: {
          type: 'object',
          properties: {
            question: {type: 'string'},
            reasoning: {type: 'string'},
            result: {type: 'string'},
          },
          required: ['question', 'reasoning', 'result'],
        },
      },
      {
        name: TOOL_REASONING_PATTERNS,
        description: 'Search past reasoning for similar problems',
        inputSchema: {
          type: 'object',
          properties: {
            query: {type: 'string'},
            limit: {type: 'number'},
          },
          required: ['query'],
        },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const {name, arguments: args = {}} = request.params

    if (name === TOOL_STORE) {
      const {content, category = 'context', tags = []} = args as {
        content: string
        category?: string
        tags?: string[]
      }
      const allTags = [category, ...tags].filter(Boolean)
      const created = await memoryManager.create({
        content,
        tags: allTags,
        metadata: {category},
      })
      nats.emitStored(created.id, category, allTags)
      return {
        content: [{type: 'text', text: JSON.stringify({id: created.id, status: 'stored'})}],
      }
    }

    if (name === TOOL_SEARCH) {
      const {query, category, limit = 10} = args as {query: string; category?: string; limit?: number}
      const memories = await memoryManager.list({
        limit: Math.min(limit, 100),
        tags: category ? [category] : undefined,
      })
      const results = memories.map((m) => ({
        id: m.id,
        content: m.content,
        category: (m.metadata?.category as string) ?? 'context',
        tags: m.tags ?? [],
      }))
      nats.emitSearched(query, results.length, category)
      return {
        content: [{type: 'text', text: JSON.stringify({results})}],
      }
    }

    if (name === TOOL_STORE_REASONING) {
      const {question, reasoning, result} = args as {
        question: string
        reasoning: string
        result: string
      }
      const content = `Q: ${question}\n\nReasoning:\n${reasoning}\n\nResult:\n${result}`
      const created = await memoryManager.create({
        content,
        tags: ['reasoning'],
        metadata: {category: 'reasoning', question},
      })
      nats.emitReasoningStored(created.id, question.slice(0, 200))
      return {
        content: [{type: 'text', text: JSON.stringify({id: created.id, status: 'stored'})}],
      }
    }

    if (name === TOOL_REASONING_PATTERNS) {
      const {query, limit = 5} = args as {query: string; limit?: number}
      const memories = await memoryManager.list({
        limit,
        tags: ['reasoning'],
      })
      const results = memories.map((m) => ({
        id: m.id,
        content: m.content,
        category: 'reasoning',
      }))
      nats.emitSearched(query, results.length, 'reasoning')
      return {
        content: [{type: 'text', text: JSON.stringify({results})}],
      }
    }

    throw new Error(`Unknown tool: ${name}`)
  })

  return server
}
