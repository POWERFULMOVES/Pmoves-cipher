/**
 * PMOVES Embedding Sidecar — TensorZero + Qdrant integration.
 *
 * On POST /api/memory: embed content via TensorZero, store vector in Qdrant.
 * On GET /api/memory/search: vector similarity query against Qdrant.
 *
 * Fail-open design: if TensorZero or Qdrant is unreachable, the shim
 * falls back to ByteRover's list() (lexical-only). Memory operations
 * never fail due to embedding infrastructure being down.
 *
 * Config (env):
 *   TENSORZERO_URL       — default http://tensorzero-gateway:3030
 *   QDRANT_URL           — default http://qdrant:6333
 *   QDRANT_API_KEY       — optional (if Qdrant requires auth)
 *   QDRANT_COLLECTION    — default pmoves_cipher_memory
 *   EMBEDDING_MODEL      — default tensorzero::embedding_model_name::qwen3_embedding_4b_local
 *   EMBEDDING_DIM        — default 2560
 */

const DEFAULT_TENSORZERO_URL = process.env.TENSORZERO_URL ?? 'http://tensorzero-gateway:3030'
const DEFAULT_QDRANT_URL = process.env.QDRANT_URL ?? 'http://qdrant:6333'
const DEFAULT_QDRANT_COLLECTION = process.env.QDRANT_COLLECTION ?? 'pmoves_cipher_memory'
const DEFAULT_EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'tensorzero::embedding_model_name::qwen3_embedding_4b_local'
const DEFAULT_EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM ?? 2560)
const QDRANT_API_KEY = process.env.QDRANT_API_KEY ?? ''
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://pmoves-ollama:11434'
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? 'qwen3-embedding:4b'

export interface EmbeddingResult {
  vector: number[]
  dim: number
}

export interface SearchResult {
  id: string
  score: number
}

class EmbeddingSidecar {
  private readonly tensorzeroUrl: string
  private readonly qdrantUrl: string
  private readonly qdrantCollection: string
  private readonly embeddingModel: string
  private readonly embeddingDim: number
  private collectionReady = false

  constructor() {
    this.tensorzeroUrl = DEFAULT_TENSORZERO_URL
    this.qdrantUrl = DEFAULT_QDRANT_URL
    this.qdrantCollection = DEFAULT_QDRANT_COLLECTION
    this.embeddingModel = DEFAULT_EMBEDDING_MODEL
    this.embeddingDim = DEFAULT_EMBEDDING_DIM
  }

  async embed(text: string): Promise<EmbeddingResult | null> {
    const tzResult = await this.embedTensorZero(text)
    if (tzResult) return tzResult
    return this.embedOllama(text)
  }

  private async embedTensorZero(text: string): Promise<EmbeddingResult | null> {
    try {
      const resp = await fetch(`${this.tensorzeroUrl}/openai/v1/embeddings`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({model: this.embeddingModel, input: text}),
        signal: AbortSignal.timeout(10000),
      })
      if (!resp.ok) {
        process.stderr.write(`pmoves-embed: TensorZero returned ${resp.status}\n`)
        return null
      }
      const data = await resp.json() as {data: Array<{embedding: number[]}>}
      if (!data.data?.[0]?.embedding) {
        return null
      }
      return {vector: data.data[0].embedding, dim: data.data[0].embedding.length}
    } catch (error) {
      process.stderr.write(`pmoves-embed: TensorZero unreachable — trying Ollama fallback\n`)
      return null
    }
  }

  private async embedOllama(text: string): Promise<EmbeddingResult | null> {
    try {
      const resp = await fetch(`${OLLAMA_URL}/api/embed`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({model: OLLAMA_EMBED_MODEL, input: text}),
        signal: AbortSignal.timeout(10000),
      })
      if (!resp.ok) {
        process.stderr.write(`pmoves-embed: Ollama returned ${resp.status}\n`)
        return null
      }
      const data = await resp.json() as {embeddings: number[][]}
      if (!data.embeddings?.[0]) {
        return null
      }
      return {vector: data.embeddings[0], dim: data.embeddings[0].length}
    } catch (error) {
      process.stderr.write(`pmoves-embed: Ollama unreachable — ${error}\n`)
      return null
    }
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
        method: 'PUT',
        headers,
        body: JSON.stringify({
          vectors: {size: this.embeddingDim, distance: 'Cosine'},
        }),
        signal: AbortSignal.timeout(5000),
      })
      if (createResp.ok) {
        process.stdout.write(`pmoves-embed: created Qdrant collection ${this.qdrantCollection} (${this.embeddingDim}d)\n`)
        this.collectionReady = true
        return true
      }
      process.stderr.write(`pmoves-embed: Qdrant collection create failed ${createResp.status}\n`)
      return false
    } catch (error) {
      process.stderr.write(`pmoves-embed: Qdrant unreachable — ${error}\n`)
      return false
    }
  }

  async storeVector(memoryId: string, embedding: EmbeddingResult, category: string, tags: string[]): Promise<void> {
    if (!(await this.ensureCollection())) return
    try {
      const headers: Record<string, string> = {'Content-Type': 'application/json'}
      if (QDRANT_API_KEY) headers.Authorization = `Bearer ${QDRANT_API_KEY}`

      await fetch(`${this.qdrantUrl}/collections/${this.qdrantCollection}/points`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          points: [{
            id: memoryId,
            vector: embedding.vector,
            payload: {category, tags},
          }],
        }),
        signal: AbortSignal.timeout(5000),
      })
    } catch (error) {
      process.stderr.write(`pmoves-embed: Qdrant store failed — ${error}\n`)
    }
  }

  async search(queryEmbedding: EmbeddingResult, limit: number, category?: string): Promise<SearchResult[]> {
    if (!(await this.ensureCollection())) return []
    try {
      const headers: Record<string, string> = {'Content-Type': 'application/json'}
      if (QDRANT_API_KEY) headers.Authorization = `Bearer ${QDRANT_API_KEY}`

      const filter = category
        ? {must: [{key: 'category', match: {value: category}}]}
        : undefined

      const resp = await fetch(`${this.qdrantUrl}/collections/${this.qdrantCollection}/points/search`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          vector: queryEmbedding.vector,
          limit,
          ...(filter && {filter}),
          with_payload: false,
        }),
        signal: AbortSignal.timeout(5000),
      })
      if (!resp.ok) {
        process.stderr.write(`pmoves-embed: Qdrant search returned ${resp.status}\n`)
        return []
      }
      const data = await resp.json() as {result: Array<{id: string, score: number}>}
      return (data.result ?? []).map((r) => ({id: String(r.id), score: r.score}))
    } catch (error) {
      process.stderr.write(`pmoves-embed: Qdrant search failed — ${error}\n`)
      return []
    }
  }

  async deleteVector(memoryId: string): Promise<void> {
    if (!(await this.ensureCollection())) return
    try {
      const headers: Record<string, string> = {'Content-Type': 'application/json'}
      if (QDRANT_API_KEY) headers.Authorization = `Bearer ${QDRANT_API_KEY}`

      await fetch(`${this.qdrantUrl}/collections/${this.qdrantCollection}/points/delete`, {
        method: 'POST',
        headers,
        body: JSON.stringify({points: [memoryId]}),
        signal: AbortSignal.timeout(5000),
      })
    } catch (error) {
      process.stderr.write(`pmoves-embed: Qdrant delete failed — ${error}\n`)
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
