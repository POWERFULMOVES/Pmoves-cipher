/**
 * PMOVES HiRAG Client — proxy to Hi-RAG v2 for hybrid retrieval.
 *
 * Pattern (i) from TAC_CIPHER_VILLAGE.md: cipher calls HiRAG as a service.
 * Cipher stays focused on memory; HiRAG owns KB retrieval.
 *
 * Fail-open design: if HiRAG is unreachable, returns empty results.
 *
 * Config (env):
 *   HIRAG_URL       — default http://hi-rag-gateway-v2:8086 (CPU)
 *   HIRAG_GPU_URL   — default http://hi-rag-gateway-v2-gpu:8087 (GPU, optional)
 */

export interface HiragQueryParams {
  query: string
  rerank?: boolean
  topK?: number
}

export interface HiragResult {
  collection: string
  content: string
  metadata?: Record<string, unknown>
  score: number
}

interface HiragQueryRow {
  content: string
  metadata?: Record<string, unknown>
  score: number
}

interface HiragQueryEnvelope {
  hits?: HiragQueryRow[]
  results?: HiragQueryRow[]
}

export const HIRAG_DEFAULT_GPU_URL = 'http://hi-rag-gateway-v2-gpu:8086'

const DEFAULT_CPU_URL = process.env.HIRAG_URL ?? 'http://hi-rag-gateway-v2:8086'
const DEFAULT_GPU_URL = process.env.HIRAG_GPU_URL ?? HIRAG_DEFAULT_GPU_URL

export class HiragClientImpl {
  private readonly cpuUrl: string
  private gpuAvailable: boolean | null = null
  private readonly gpuUrl: string

  constructor() {
    this.cpuUrl = DEFAULT_CPU_URL
    this.gpuUrl = DEFAULT_GPU_URL
  }

  async healthCheck(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.cpuUrl}/healthz`, {signal: AbortSignal.timeout(3000)})
      return resp.ok
    } catch {
      return false
    }
  }

  async query(params: HiragQueryParams): Promise<HiragResult[]> {
    const {query, rerank = true, topK = 10} = params
    const url = rerank && (await this.checkGpu()) ? this.gpuUrl : this.cpuUrl
    try {
      const resp = await fetch(`${url}/hirag/query`, {
        body: JSON.stringify({k: topK, query, use_rerank: rerank}),
        headers: {'Content-Type': 'application/json'},
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
      })
      if (!resp.ok) {
        process.stderr.write(`pmoves-hirag: HiRAG returned ${resp.status}\n`)
        return []
      }

      const data = await resp.json() as HiragQueryEnvelope
      // Hi-RAG v2 answers {query, k, used_rerank, rerank_provider, hits}; older
      // builds answered {results}. Accept either, and an unknown shape as empty.
      const rows = data?.hits ?? data?.results ?? []
      return rows.map((r) => ({
        collection: 'pmoves_chunks_qwen3',
        content: r.content,
        metadata: r.metadata,
        score: r.score,
      }))
    } catch (error) {
      process.stderr.write(`pmoves-hirag: query failed — ${error}\n`)
      return []
    }
  }

  private async checkGpu(): Promise<boolean> {
    if (this.gpuAvailable !== null) return this.gpuAvailable
    try {
      const resp = await fetch(`${this.gpuUrl}/healthz`, {signal: AbortSignal.timeout(3000)})
      this.gpuAvailable = resp.ok
    } catch {
      this.gpuAvailable = false
    }

    return this.gpuAvailable
  }
}

let hiragInstance: HiragClientImpl | null = null

export function getHiragClient(): HiragClientImpl {
  if (!hiragInstance) {
    hiragInstance = new HiragClientImpl()
  }

  return hiragInstance
}
