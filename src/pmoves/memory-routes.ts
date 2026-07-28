import {Router} from 'express'
import type {MemoryManager} from '../agent/infra/memory/memory-manager.js'
import type {PmovesNatsEmitter} from './nats-emitter.js'
import {getEmbeddingSidecar} from './embedding.js'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 100

export function createMemoryRoutes(memoryManager: MemoryManager, nats: PmovesNatsEmitter): Router {
  const router = Router()
  const sidecar = getEmbeddingSidecar()

  router.post('/memory', async (req, res) => {
    try {
      const {content, category = 'context', tags = [], metadata = {}, agentId} = req.body ?? {}
      if (!content || typeof content !== 'string') {
        res.status(400).json({error: 'content is required and must be a string'})
        return
      }
      if (!agentId || typeof agentId !== 'string') {
        res.status(400).json({error: 'agentId is required for per-agent scope'})
        return
      }
      const allTags = [category, ...tags].filter(Boolean)
      // Spread custom metadata FIRST, then set category + agentId — prevents
      // caller-supplied metadata.agentId from overriding the validated top-level agentId.
      const safeMetadata = {...metadata}
      delete safeMetadata.agentId
      delete safeMetadata.category
      const created = await memoryManager.create({
        content,
        tags: allTags,
        metadata: {...safeMetadata, category, agentId},
      })

      const embedding = await sidecar.embed(content)
      if (embedding) {
        await sidecar.storeVector(created.id, embedding, category, allTags, content, agentId)
      }

      nats.emitStored(created.id, category, allTags)
      res.status(201).json({id: created.id, agentId, embedding_id: embedding ? created.id : null})
    } catch (error) {
      res.status(500).json({error: error instanceof Error ? error.message : String(error)})
    }
  })

  router.get('/memory/search', async (req, res) => {
    try {
      const q = String(req.query.q ?? '').trim()
      if (!q) {
        res.status(400).json({error: 'q query parameter is required'})
        return
      }
      const limit = Math.min(Math.max(Number(req.query.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT)
      const category = req.query.category ? String(req.query.category) : undefined
      // agentId query param scopes search. Use "*" for cross-agent (advisory).
      const agentIdRaw = req.query.agentId ? String(req.query.agentId) : undefined
      const scopedAgentId = agentIdRaw && agentIdRaw !== '*' ? agentIdRaw : undefined

      const queryEmbedding = await sidecar.embed(q)
      let results: Array<{id: string; content: string; category: string; tags: string[]; agentId?: string; created_at: string; score?: number}>

      if (queryEmbedding) {
        const vectorHits = await sidecar.search(queryEmbedding, q, limit, category, scopedAgentId)
        if (vectorHits.length > 0) {
          const memories = await Promise.all(
            vectorHits.map(async (hit) => {
              try {
                const m = await memoryManager.get(hit.id)
                return {
                  id: m.id,
                  content: m.content,
                  category: (m.metadata?.category as string) ?? 'context',
                  tags: m.tags ?? [],
                  agentId: (m.metadata?.agentId as string) ?? 'unknown',
                  created_at: new Date(m.createdAt).toISOString(),
                  score: hit.score,
                }
              } catch {
                return null
              }
            }),
          )
          results = memories.filter((m): m is NonNullable<typeof m> => m !== null)
        } else {
          results = await lexicalFallback(memoryManager, limit, category, scopedAgentId)
        }
      } else {
        results = await lexicalFallback(memoryManager, limit, category, scopedAgentId)
      }

      nats.emitSearched(q, results.length, category)
      res.json({results})
    } catch (error) {
      res.status(500).json({error: error instanceof Error ? error.message : String(error)})
    }
  })

  router.get('/memory/:id', async (req, res) => {
    try {
      const memory = await memoryManager.get(req.params.id)
      res.json({
        id: memory.id,
        content: memory.content,
        category: (memory.metadata?.category as string) ?? 'context',
        tags: memory.tags ?? [],
        agentId: (memory.metadata?.agentId as string) ?? 'unknown',
        created_at: new Date(memory.createdAt).toISOString(),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/not found/i.test(message)) {
        res.status(404).json({error: 'Memory not found'})
        return
      }
      res.status(500).json({error: message})
    }
  })

  router.delete('/memory/:id', async (req, res) => {
    try {
      const agentId = req.query.agentId ? String(req.query.agentId) : undefined
      // Ownership check: fetch the memory first and verify it belongs to the
      // requesting agent BEFORE deleting anything. Prevents an agent from
      // deleting another agent's memory by guessing the id.
      if (agentId) {
        try {
          const memory = await memoryManager.get(req.params.id)
          const ownerAgentId = (memory.metadata?.agentId as string) ?? undefined
          if (ownerAgentId && ownerAgentId !== agentId) {
            res.status(403).json({error: `Memory ${req.params.id} belongs to agent '${ownerAgentId}', not '${agentId}'`})
            return
          }
        } catch (checkErr) {
          const msg = checkErr instanceof Error ? checkErr.message : String(checkErr)
          if (/not found/i.test(msg)) {
            res.status(404).json({error: 'Memory not found'})
            return
          }
          throw checkErr
        }
      }
      await memoryManager.delete(req.params.id)
      await sidecar.deleteVector(req.params.id, agentId)
      res.status(204).end()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/not found/i.test(message)) {
        res.status(404).json({error: 'Memory not found'})
        return
      }
      res.status(500).json({error: message})
    }
  })

  return router
}

async function lexicalFallback(
  memoryManager: MemoryManager,
  limit: number,
  category?: string,
  agentId?: string,
): Promise<Array<{id: string; content: string; category: string; tags: string[]; agentId?: string; created_at: string}>> {
  // Load all memories (MemoryManager.list already loads from blob storage in full,
  // then filters in-memory). We pass a high limit to avoid truncating before the
  // agentId filter can exclude records from other agents. Filter FIRST, then slice.
  const memories = await memoryManager.list({limit: 1000})
  const filtered = memories.filter((m) => {
    if (agentId && (m.metadata?.agentId as string) !== agentId) return false
    if (category && (m.metadata?.category as string) !== category && !(m.tags ?? []).includes(category)) return false
    return true
  })
  return filtered.slice(0, limit).map((m) => ({
    id: m.id,
    content: m.content,
    category: (m.metadata?.category as string) ?? 'context',
    tags: m.tags ?? [],
    agentId: (m.metadata?.agentId as string) ?? 'unknown',
    created_at: new Date(m.createdAt).toISOString(),
  }))
}
