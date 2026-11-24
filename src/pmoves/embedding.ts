/**
 * PMOVES Embedding Sidecar - TensorZero + Qdrant integration.
 *
 * On POST /api/memory: embed content via TensorZero, store vector in Qdrant.
 * On GET /api/memory/search: vector similarity query against Qdrant.
 *
 * Fail-open design: if TensorZero or Qdrant is unreachable, the shim
 * falls back to ByteRover's list() (lexical-only). Memory operations
 * never fail due to embedding infrastructure being down.
 *
 * Config (env):
 *   TENSORZERO_URL       - default http://tensorzero-gateway:3000
 *   QDRANT_URL           - default http://qdrant:6333
 *   QDRANT_API_KEY       - optional (if Qdrant requires auth)
 *   QDRANT_COLLECTION    - default pmoves_cipher_memory
 *   EMBEDDING_MODEL      - default tensorzero::embedding_model_name::qwen3_embedding_4b_local
 *   EMBEDDING_DIM        - default 2560
 *   PMOVES_EMBED_TIMEOUT_MS - embed fetch budget, default 30000. Warm embed
 *                         measures ~7.2s against the old 10s budget (see
 *                         handoff embedding-model-routing-2026-09-02); 30s
 *                         absorbs a post-restart model load.
 */

import { randomUUID } from 'node:crypto'

const DEFAULT_TENSORZERO_URL = process.env.TENSORZERO_URL ?? 'http://tensorzero-gateway:3000'
const DEFAULT_QDRANT_URL = process.env.QDRANT_URL ?? 'http://qdrant:6333'
const DEFAULT_QDRANT_COLLECTION = process.env.QDRANT_COLLECTION ?? 'pmoves_cipher_memory'
const DEFAULT_EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'tensorzero::embedding_model_name::qwen3_embedding_4b_local'
const DEFAULT_EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM ?? 2560)
const QDRANT_API_KEY = process.env.QDRANT_API_KEY ?? ''
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://pmoves-ollama:11434'
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? 'qwen3-embedding:4b'
const EMBED_TIMEOUT_MS = Number(process.env.PMOVES_EMBED_TIMEOUT_MS ?? 30_000)

// Named vector fields in the Qdrant collection.
const DENSE_FIELD = 'dense'
const BM25_FIELD = 'bm25'

export interface EmbeddingResult {
  dim: number
  vector: number[]
}

export interface SearchResult {
  id: string
  score: number
}

class EmbeddingSidecar {
  private collectionReady = false
  private readonly embeddingDim: number
  private readonly embeddingModel: string
  private readonly qdrantCollection: string
  private readonly qdrantUrl: string
  private readonly tensorzeroUrl: string

  constructor() {
    this.tensorzeroUrl = DEFAULT_TENSORZERO_URL
    this.qdrantUrl = DEFAULT_QDRANT_URL
    this.qdrantCollection = DEFAULT_QDRANT_COLLECTION
    this.embeddingModel = DEFAULT_EMBEDDING_MODEL
    this.embeddingDim = DEFAULT_EMBEDDING_DIM
  }

  async deleteVector(memoryId: string, agentId?: string): Promise<void> {
    if (!(await this.ensureCollection())) return
    try {
      const headers: Record<string, string> = {'Content-Type': 'application/json'}
      if (QDRANT_API_KEY) headers.Authorization = `Bearer ${QDRANT_API_KEY}`

      // Delete by payload filter (memoryId is stored in payload, not as point id).
      // If agentId is provided, scope the delete to that agent (defensive - prevents
      // a compromised agent from deleting another agent's memories by guessing ids).
      const must: Array<{key: string, match: {value: string}}> = [{key: 'memoryId', match: {value: memoryId}}]
      if (agentId) must.push({key: 'agentId', match: {value: agentId}})
      await fetch(`${this.qdrantUrl}/collections/${this.qdrantCollection}/points/delete`, {
        body: JSON.stringify({
          filter: {must},
        }),
        headers,
        method: 'POST',
        signal: AbortSignal.timeout(5000),
      })
    } catch (error) {
      process.stderr.write(`pmoves-embed: Qdrant delete failed - ${error}\n`)
    }
  }

  async embed(text: string): Promise<EmbeddingResult | null> {
    const tzResult = await this.embedTensorZero(text)
    if (tzResult) return tzResult
    return this.embedOllama(text)
  }

  async ensureCollection(): Promise<boolean> {
    if (this.collectionReady) return true
    try {
      const headers: Record<string, string> = {'Content-Type': 'application/json'}
      if (QDRANT_API_KEY) headers.Authorization = `Bearer ${QDRANT_API_KEY}`

      const checkResp = await fetch(`${this.qdrantUrl}/collections/${this.qdrantCollection}`, {
        headers,
        signal: AbortSignal.timeout(5000),
      })
      if (checkResp.ok) {
        this.collectionReady = true
        return true
      }

      if (checkResp.status !== 404) {
        process.stderr.write(`pmoves-embed: Qdrant collection check returned ${checkResp.status}\n`)
        return false
      }

      const createResp = await fetch(`${this.qdrantUrl}/collections/${this.qdrantCollection}`, {
        body: JSON.stringify({
          sparse_vectors: {
            [BM25_FIELD]: {modifier: 'idf'},
          },
          vectors: {[DENSE_FIELD]: {distance: 'Cosine', size: this.embeddingDim}},
        }),
        headers,
        method: 'PUT',
        signal: AbortSignal.timeout(5000),
      })
      if (createResp.ok) {
        process.stdout.write(`pmoves-embed: created Qdrant collection ${this.qdrantCollection} (${this.embeddingDim}d dense + BM25 sparse)\n`)
        this.collectionReady = true
        return true
      }

      process.stderr.write(`pmoves-embed: Qdrant collection create failed ${createResp.status}\n`)
      return false
    } catch (error) {
      process.stderr.write(`pmoves-embed: Qdrant unreachable - ${error}\n`)
      return false
    }
  }

  async search(queryEmbedding: EmbeddingResult, queryText: string, limit: number, category?: string, agentId?: string): Promise<SearchResult[]> {
    if (!(await this.ensureCollection())) return []
    try {
      const headers: Record<string, string> = {'Content-Type': 'application/json'}
      if (QDRANT_API_KEY) headers.Authorization = `Bearer ${QDRANT_API_KEY}`

      // Build filter conditions. agentId uses `must` (hard scope) when present;
      // category uses `must` as well. Both compose into a single must[] array.
      const must: Array<{key: string, match: {value: string}}> = []
      if (category) must.push({key: 'category', match: {value: category}})
      if (agentId) must.push({key: 'agentId', match: {value: agentId}})
      const filter = must.length > 0 ? {must} : undefined

      // Hybrid query: dense semantic prefetch + BM25 sparse prefetch → RRF fusion.
      // The dense path uses the pre-computed embedding vector; the BM25 path
      // passes the raw query text and lets Qdrant tokenize it server-side.
      // Qdrant 1.16+: fusion goes in the top-level "query" field, not as a sibling.
      const resp = await fetch(`${this.qdrantUrl}/collections/${this.qdrantCollection}/points/query`, {
        body: JSON.stringify({
          limit,
          prefetch: [
            {
              limit: limit * 3,
              query: queryEmbedding.vector,
              using: DENSE_FIELD,
              ...(filter && {filter}),
            },
            {
              limit: limit * 3,
              query: {model: 'qdrant/bm25', text: queryText},
              using: BM25_FIELD,
              ...(filter && {filter}),
            },
          ],
          query: {fusion: 'rrf'},
          with_payload: true,
        }),
        headers,
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
      })
      if (!resp.ok) {
        process.stderr.write(`pmoves-embed: Qdrant query returned ${resp.status}\n`)
        return []
      }

      const data = await resp.json() as {result: {points: Array<{id: number | string, payload?: {memoryId?: string}; score: number,}>}}
      const points = data.result?.points ?? []
      // Surface payload.memoryId so memory-routes.ts can map hits back to
      // MemoryManager.get(). Legacy rows without payload.memoryId are dropped.
      return points
        .map((p) => ({id: p.payload?.memoryId ?? '', score: p.score}))
        .filter((r) => r.id)
    } catch (error) {
      process.stderr.write(`pmoves-embed: Qdrant query failed - ${error}\n`)
      return []
    }
  }

  async storeVector(memoryId: string, embedding: EmbeddingResult, category: string, tags: string[], content: string, agentId: string): Promise<void> {
    if (!(await this.ensureCollection())) return
    try {
      const headers: Record<string, string> = {'Content-Type': 'application/json'}
      if (QDRANT_API_KEY) headers.Authorization = `Bearer ${QDRANT_API_KEY}`

      // Qdrant point IDs must be unsigned integers or UUID strings.
      // Cipher memory IDs are 12-char nanoids (not UUID-compatible), so we
      // generate a UUID for the Qdrant point id and store the memoryId in payload.
      const pointId = randomUUID()

      const resp = await fetch(`${this.qdrantUrl}/collections/${this.qdrantCollection}/points`, {
        body: JSON.stringify({
          points: [{
            id: pointId,
            payload: {agentId, category, content, memoryId, tags},
            vector: {
              [BM25_FIELD]: {model: 'qdrant/bm25', text: content},
              [DENSE_FIELD]: embedding.vector,
            },
          }],
        }),
        headers,
        method: 'PUT',
        signal: AbortSignal.timeout(10_000),
      })
      if (!resp.ok) {
        const body = await resp.text().catch(() => '')
        process.stderr.write(`pmoves-embed: Qdrant store returned ${resp.status} for memory ${memoryId}: ${body}\n`)
      }
    } catch (error) {
      process.stderr.write(`pmoves-embed: Qdrant store failed - ${error}\n`)
    }
  }

  private async embedOllama(text: string): Promise<EmbeddingResult | null> {
    try {
      const resp = await fetch(`${OLLAMA_URL}/api/embed`, {
        body: JSON.stringify({input: text, model: OLLAMA_EMBED_MODEL}),
        headers: {'Content-Type': 'application/json'},
        method: 'POST',
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      })
      if (!resp.ok) {
        process.stderr.write(`pmoves-embed: Ollama returned ${resp.status}\n`)
        return null
      }

      const data = await resp.json() as {embeddings: number[][]}
      if (!data.embeddings?.[0]) {
        return null
      }

      return {dim: data.embeddings[0].length, vector: data.embeddings[0]}
    } catch (error) {
      process.stderr.write(`pmoves-embed: Ollama unreachable - ${error}\n`)
      return null
    }
  }

  private async embedTensorZero(text: string): Promise<EmbeddingResult | null> {
    try {
      const resp = await fetch(`${this.tensorzeroUrl}/openai/v1/embeddings`, {
        body: JSON.stringify({input: text, model: this.embeddingModel}),
        headers: {'Content-Type': 'application/json'},
        method: 'POST',
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      })
      if (!resp.ok) {
        process.stderr.write(`pmoves-embed: TensorZero returned ${resp.status}\n`)
        return null
      }

      const data = await resp.json() as {data: Array<{embedding: number[]}>}
      if (!data.data?.[0]?.embedding) {
        return null
      }

      return {dim: data.data[0].embedding.length, vector: data.data[0].embedding}
    } catch {
      process.stderr.write(`pmoves-embed: TensorZero unreachable - trying Ollama fallback\n`)
      return null
    }
  }
}

let sidecarInstance: EmbeddingSidecar | null = null

export function getEmbeddingSidecar(): EmbeddingSidecar {
  if (!sidecarInstance) {
    sidecarInstance = new EmbeddingSidecar()
  }

  return sidecarInstance
}
