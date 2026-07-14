import {Router} from 'express'
import type {MemoryManager} from '../../agent/infra/memory/memory-manager.js'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 100

export function createMemoryRoutes(memoryManager: MemoryManager): Router {
  const router = Router()

  router.post('/memory', async (req, res) => {
    try {
      const {content, category = 'context', tags = [], metadata = {}} = req.body ?? {}
      if (!content || typeof content !== 'string') {
        res.status(400).json({error: 'content is required and must be a string'})
        return
      }
      const created = await memoryManager.create({
        content,
        tags: [category, ...tags].filter(Boolean),
        metadata: {category, ...metadata},
      })
      res.status(201).json({id: created.id, embedding_id: null})
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
      const memories = await memoryManager.list({
        limit,
        tags: category ? [category] : undefined,
      })
      const results = memories.map((m) => ({
        id: m.id,
        content: m.content,
        category: (m.metadata?.category as string) ?? 'context',
        tags: m.tags ?? [],
        created_at: new Date(m.createdAt).toISOString(),
      }))
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
      await memoryManager.delete(req.params.id)
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
