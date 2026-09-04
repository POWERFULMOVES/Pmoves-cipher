import {expect} from 'chai'
import type {HiragClientImpl} from '../../../src/pmoves/hirag-client.js'

// The client captures HIRAG_URL / HIRAG_GPU_URL at module load, so the env is
// set here and the module is imported dynamically in before().

describe('hirag-client (HiRAG v2 payload serialization)', () => {
  let getHiragClient: () => HiragClientImpl
  const captured: Array<{url: string; init: RequestInit | undefined}> = []
  let originalFetch: typeof global.fetch

  before(async () => {
    process.env.HIRAG_URL = 'http://hirag-cpu.test'
    process.env.HIRAG_GPU_URL = 'http://hirag-gpu.test'
    ;({getHiragClient} = await import('../../../src/pmoves/hirag-client.js'))
  })

  beforeEach(() => {
    captured.length = 0
    originalFetch = global.fetch
    global.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      captured.push({url, init})
      // checkGpu() probes the GPU gateway first: answer NOT ok so the query
      // deterministically goes to the CPU gateway.
      if (url.includes('/healthz')) {
        return {ok: false} as Response
      }
      return {
        ok: true,
        json: async () => ({results: [{content: 'hit', score: 0.9, metadata: {}}]}),
      } as Response
    }) as typeof fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('serializes the v2 payload: topK -> k and rerank -> use_rerank', async () => {
    const client = getHiragClient()
    const results = await client.query({query: 'test', topK: 5, rerank: true})

    const queryCall = captured.find((c) => c.url.includes('/hirag/query'))
    expect(queryCall, 'a POST to /hirag/query must have been made').to.exist
    const body = JSON.parse(String(queryCall?.init?.body))
    expect(body).to.deep.equal({query: 'test', k: 5, use_rerank: true})
    expect(results).to.have.lengthOf(1)
    expect(results[0].content).to.equal('hit')
  })

  it('applies the documented defaults: k=10, use_rerank=true', async () => {
    const client = getHiragClient()
    await client.query({query: 'defaults'})

    const queryCall = captured.find((c) => c.url.includes('/hirag/query'))
    const body = JSON.parse(String(queryCall?.init?.body))
    expect(body.k).to.equal(10)
    expect(body.use_rerank).to.equal(true)
  })
})
