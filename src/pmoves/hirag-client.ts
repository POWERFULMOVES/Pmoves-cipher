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
  topK?: number
  rerank?: boolean
}

export interface HiragResult {
  content: string
  score: number
  collection: string
  metadata?: Record<string, unknown>
}

const DEFAULT_CPU_URL = process.env.HIRAG_URL ?? 'http://hi-rag-gateway-v2:8086'
const DEFAULT_GPU_URL = process.env.HIRAG_GPU_URL ?? 'http://hi-rag-gateway-v2-gpu:8087'

class HiragClientImpl {
  private readonly cpuUrl: string
  private readonly gpuUrl: string
  private gpuAvailable: boolean | null = null

  constructor() {
    this.cpuUrl = DEFAULT_CPU_URL
    this.gpuUrl = DEFAULT_GPU_URL
  }

  async query(params: HiragQueryParams): Promise<HiragResult[]> {
    const {query, topK = 10, rerank = true} = params
    const url = rerank && (await this.checkGpu()) ? this.gpuUrl : this.cpuUrl
    try {
      const resp = await fetch(`${url}/hirag/query`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({query, top_k: topK, rerank}),
        signal: AbortSignal.timeout(15000),
      })
      if (!resp.ok) {
        process.stderr.write(`pmoves-hirag: HiRAG returned ${resp.status}\n`)
        return []
      }
      const data = await resp.json() as {results: Array<{content: string; score: number; metadata?: Record<string, unknown>}>}
      return (data.results ?? []).map((r) => ({
        content: r.content,
        score: r.score,
        collection: 'pmoves_chunks_qwen3',
        metadata: r.metadata,
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

  async healthCheck(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.cpuUrl}/healthz`, {signal: AbortSignal.timeout(3000)})
      return resp.ok
    } catch {
      return false
    }
  }
}

let hiragInstance: HiragClientImpl | null = null

export function getHiragClient(): HiragClientImpl {
  if (!hiragInstance) {
    hiragInstance = new HiragClientImpl()
  }
  return hiragInstance
}
