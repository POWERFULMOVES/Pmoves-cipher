/* eslint-disable perfectionist/sort-objects, perfectionist/sort-object-types,
   n/no-unsupported-features/node-builtins, unicorn/prefer-global-this,
   @stylistic/padding-line-between-statements, no-undef, camelcase */
// `fetch`/`Response`/`RequestInit` are this harness's own stubs, and the
// camelcase exemption covers the live Hi-RAG v2 wire keys `used_rerank` /
// `rerank_provider` / `use_rerank`, which must match the server byte for byte.
import {expect} from 'chai'

import type {HiragClientImpl} from '../../../src/pmoves/hirag-client.js'

// The client captures HIRAG_URL / HIRAG_GPU_URL at module load, so the env is
// set here and the module is imported dynamically in before().

const V2_ENVELOPE = {
  query: 'test',
  k: 5,
  used_rerank: true,
  rerank_provider: 'cpu',
  hits: [{content: 'hit', score: 0.9, metadata: {}}],
}

describe('hirag-client (HiRAG v2 payload serialization)', () => {
  let getHiragClient: () => HiragClientImpl
  let HIRAG_DEFAULT_GPU_URL: string
  const captured: Array<{url: string; init: RequestInit | undefined}> = []
  let originalFetch: typeof global.fetch

  before(async () => {
    process.env.HIRAG_URL = 'http://hirag-cpu.test'
    process.env.HIRAG_GPU_URL = 'http://hirag-gpu.test'
    const mod = await import('../../../src/pmoves/hirag-client.js')
    getHiragClient = mod.getHiragClient
    HIRAG_DEFAULT_GPU_URL = mod.HIRAG_DEFAULT_GPU_URL
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
      // Live Hi-RAG v2 envelope: {query, k, used_rerank, rerank_provider, hits}.
      return {
        ok: true,
        json: async () => V2_ENVELOPE,
      } as Response
    }) as typeof fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('serializes the v2 payload: topK -> k and rerank -> use_rerank', async () => {
    const client = getHiragClient()
    await client.query({query: 'test', topK: 5, rerank: true})

    const queryCall = captured.find((c) => c.url.includes('/hirag/query'))
    expect(queryCall, 'a POST to /hirag/query must have been made').to.exist
    const body = JSON.parse(String(queryCall?.init?.body))
    expect(body).to.deep.equal({query: 'test', k: 5, use_rerank: true})
  })

  it('applies the documented defaults: k=10, use_rerank=true', async () => {
    const client = getHiragClient()
    await client.query({query: 'defaults'})

    const queryCall = captured.find((c) => c.url.includes('/hirag/query'))
    const body = JSON.parse(String(queryCall?.init?.body))
    expect(body.k).to.equal(10)
    expect(body.use_rerank).to.equal(true)
  })

  it('reads results from the live v2 "hits" envelope (defect: kb reported 0)', async () => {
    const client = getHiragClient()
    const results = await client.query({query: 'test'})

    expect(results).to.have.lengthOf(1)
    expect(results[0].content).to.equal('hit')
    expect(results[0].score).to.equal(0.9)
  })

  it('still accepts the legacy "results" envelope (both-keys compatibility)', async () => {
    originalFetch = global.fetch
    global.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      captured.push({url, init})
      if (url.includes('/healthz')) {
        return {ok: false} as Response
      }
      return {
        ok: true,
        json: async () => ({results: [{content: 'legacy hit', score: 0.7, metadata: {}}]}),
      } as Response
    }) as typeof fetch

    const client = getHiragClient()
    const results = await client.query({query: 'legacy'})
    expect(results).to.have.lengthOf(1)
    expect(results[0].content).to.equal('legacy hit')
  })

  it('maps unknown envelopes to empty results instead of throwing', async () => {
    originalFetch = global.fetch
    global.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      captured.push({url, init})
      if (url.includes('/healthz')) {
        return {ok: false} as Response
      }
      return {ok: true, json: async () => ({unexpected: true})} as Response
    }) as typeof fetch

    const client = getHiragClient()
    const results = await client.query({query: 'garbage'})
    expect(results).to.have.lengthOf(0)
  })

  it('defaults the GPU gateway to the internal :8086 port (defect: :8087 is host-only)', () => {
    expect(HIRAG_DEFAULT_GPU_URL).to.equal('http://hi-rag-gateway-v2-gpu:8086')
  })
})
