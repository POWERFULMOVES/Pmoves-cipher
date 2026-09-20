/* eslint-disable camelcase -- REST API response fields match the Postgres DB schema (snake_case convention) */
import express, {Router} from 'express'

import type {MemoryManager} from '../agent/infra/memory/memory-manager.js'
import type {PmovesNatsEmitter} from './nats-emitter.js'

import {getEmbeddingSidecar} from './embedding.js'
import './auth.js'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 100

function assertAgentId(req: express.Request, argsAgentId?: string, allowWildcard = false): void {
  const authAgentId = req.agentId
  if (!authAgentId) return // dev-skip / advisory mode
  if (!argsAgentId) {
    throw new Error('agentId is required when a token is present')
  }

  if (allowWildcard && argsAgentId === '*') {
    throw new Error('Forbidden: cross-agent wildcard search is not allowed in token enforcement mode')
  }

  if (argsAgentId !== authAgentId) {
    throw new Error(`Forbidden: token belongs to agent '${authAgentId}', but request specified '${argsAgentId}'`)
  }
}

export function createMemoryRoutes(memoryManager: MemoryManager, nats: PmovesNatsEmitter): Router {
  // eslint-disable-next-line new-cap -- express Router() is designed to be called without new
  const router = Router()
  const sidecar = getEmbeddingSidecar()

  router.post('/memory', async (req, res) => {
    try {
      const {agentId, category = 'context', content, metadata = {}, tags = []} = req.body ?? {}
      if (!content || typeof content !== 'string') {
        res.status(400).json({error: 'content is required and must be a string'})
        return
      }

      if (!agentId || typeof agentId !== 'string') {
        res.status(400).json({error: 'agentId is required for per-agent scope'})
        return
      }

      assertAgentId(req, agentId)
      const allTags = [category, ...tags].filter(Boolean)
      // Spread custom metadata FIRST, then set category + agentId — prevents
      // caller-supplied metadata.agentId from overriding the validated top-level agentId.
      const safeMetadata = {...metadata}
      delete safeMetadata.agentId
      delete safeMetadata.category
      const created = await memoryManager.create({
        content,
        metadata: {...safeMetadata, agentId, category},
        tags: allTags,
      })

      const embedding = await sidecar.embed(content)
      if (embedding) {
        await sidecar.storeVector(created.id, embedding, category, allTags, content, agentId)
      }

      nats.emitStored(created.id, category, allTags)
      res.status(201).json({agentId, embedding_id: embedding ? created.id : null, id: created.id})
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.startsWith('Forbidden:')) {
        res.status(403).json({error: message})
        return
      }

      if (/agentId is required when a token is present/.test(message)) {
        res.status(400).json({error: message})
        return
      }

      res.status(500).json({error: message})
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
      assertAgentId(req, agentIdRaw, true)

      const queryEmbedding = await sidecar.embed(q)
      let results: Array<{agentId?: string; category: string; content: string; created_at: string; id: string; score?: number; tags: string[];}>

      if (queryEmbedding) {
        const vectorHits = await sidecar.search(queryEmbedding, q, limit, category, scopedAgentId)
        if (vectorHits.length > 0) {
          const memories = await Promise.all(
            vectorHits.map(async (hit) => {
              try {
                const m = await memoryManager.get(hit.id)
                return {
                  agentId: (m.metadata?.agentId as string) ?? 'unknown',
                  category: (m.metadata?.category as string) ?? 'context',
                  content: m.content,
                  created_at: new Date(m.createdAt).toISOString(),
                  id: m.id,
                  score: hit.score,
                  tags: m.tags ?? [],
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
      const message = error instanceof Error ? error.message : String(error)
      if (message.startsWith('Forbidden:')) {
        res.status(403).json({error: message})
        return
      }

      if (/agentId is required when a token is present/.test(message)) {
        res.status(400).json({error: message})
        return
      }

      res.status(500).json({error: message})
    }
  })

  router.get('/memory/:id', async (req, res) => {
    try {
      const memory = await memoryManager.get(req.params.id)

      // Ownership check, mirroring DELETE /memory/:id below. This route is
      // fetch-by-key, so the caller supplies no agentId for assertAgentId to
      // compare against -- the owner is a property of the STORED record. That
      // shape difference is why the sibling routes' pattern did not fit here
      // and why the check was missed (raised in PR #12 review, unfixed since).
      //
      // 404 rather than DELETE's 403, deliberately: a 403 confirms the id
      // exists and is merely someone else's, which is an enumeration oracle
      // over nanoid(12) keys on a READ path. "Not yours" and "not there" must
      // be indistinguishable. DELETE additionally names the owning agent in its
      // error, a milder form of the same leak, left alone here as out of scope.
      //
      // Advisory mode (no req.agentId) is untouched, matching assertAgentId's
      // documented dev-skip: enforcing there would break unauthenticated local
      // workflows that never opted into per-agent tokens.
      const authAgentId = req.agentId
      const ownerAgentId = memory.metadata?.agentId as string | undefined
      if (authAgentId && ownerAgentId !== authAgentId) {
        res.status(404).json({error: 'Memory not found'})
        return
      }

      res.json({
        agentId: (memory.metadata?.agentId as string) ?? 'unknown',
        category: (memory.metadata?.category as string) ?? 'context',
        content: memory.content,
        created_at: new Date(memory.createdAt).toISOString(),
        id: memory.id,
        tags: memory.tags ?? [],
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
      assertAgentId(req, agentId)
      // Ownership check: fetch the memory first and verify it belongs to the
      // requesting agent BEFORE deleting anything. Prevents an agent from
      // deleting another agent's memory by guessing the id.
      //
      // The comparison is `ownerAgentId !== agentId`, NOT
      // `ownerAgentId && ownerAgentId !== agentId`. The earlier form skipped
      // the check entirely for a record carrying no agentId in its metadata,
      // so any token holder could delete unattributed memories -- data loss,
      // not merely disclosure, and the most serious of the three defects here.
      // Absent ownership now reads as "not yours", matching GET /memory/:id.
      //
      // 404 rather than 403, and no owner name in the body: a 403 confirms the
      // id exists, and naming the owner additionally discloses who holds it.
      // The operator-facing detail is dropped rather than logged because
      // nothing under src/pmoves/ logs, and introducing a logger here is out of
      // scope for a security fix.
      if (agentId) {
        try {
          const memory = await memoryManager.get(req.params.id)
          const ownerAgentId = memory.metadata?.agentId as string | undefined
          if (ownerAgentId !== agentId) {
            res.status(404).json({error: 'Memory not found'})
            return
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          if (/not found/i.test(msg)) {
            res.status(404).json({error: 'Memory not found'})
            return
          }

          throw error
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

      if (message.startsWith('Forbidden:')) {
        res.status(403).json({error: message})
        return
      }

      if (/agentId is required when a token is present/.test(message)) {
        res.status(400).json({error: message})
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
): Promise<Array<{agentId?: string; category: string; content: string; created_at: string; id: string; tags: string[];}>> {
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
    agentId: (m.metadata?.agentId as string) ?? 'unknown',
    category: (m.metadata?.category as string) ?? 'context',
    content: m.content,
    created_at: new Date(m.createdAt).toISOString(),
    id: m.id,
    tags: m.tags ?? [],
  }))
}
