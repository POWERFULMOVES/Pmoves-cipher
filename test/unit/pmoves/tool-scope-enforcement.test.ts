import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js'
import {expect} from 'chai'

import type {MemoryManager} from '../../../src/agent/infra/memory/memory-manager.js'
import type {McpAuthContext} from '../../../src/pmoves/mcp-sse.js'
import type {PmovesNatsEmitter} from '../../../src/pmoves/nats-emitter.js'

import {buildMcpServer} from '../../../src/pmoves/mcp-sse.js'

// tool-scopes.test.ts pins the tool -> scope TABLE. This file pins the CALL
// SITE that consults it, which is where the table can be skipped entirely.
//
// The gate read `if (argsAgentId) assertAgentId(...)`, so omitting `agentId`
// from the tool arguments skipped BOTH the identity check and the scope check.
// Most handlers throw on a missing agentId on their own, but
// pmoves_cipher_hybrid_search and pmoves_cipher_session_recall do not -- they
// pass `undefined` straight through to EmbeddingSidecar.search(), which only
// applies the Qdrant agentId filter `if (agentId)`. An omitted agentId
// therefore produced an UNSCOPED, cross-agent search from a token that may not
// even hold memory:read.
//
// Every tool schema marks agentId as required, but `required` is advisory --
// a non-conforming client simply leaves it out. These tests speak JSON-RPC
// directly, which is exactly what such a client does.

function makeMockNats(): PmovesNatsEmitter {
  return {
    emitReasoningStored() {},
    emitSearched() {},
    emitStored() {},
  } as unknown as PmovesNatsEmitter
}

function makeMockMemoryManager(): MemoryManager {
  return {
    create: async () => ({content: '', createdAt: Date.now(), id: 'x', metadata: {}, tags: [], updatedAt: Date.now()}),
    async delete() {},
    get: async () => ({content: '', createdAt: Date.now(), id: 'x', metadata: {}, tags: [], updatedAt: Date.now()}),
    list: async () => [],
  } as unknown as MemoryManager
}

async function connectClient(auth: McpAuthContext): Promise<Client> {
  const server = buildMcpServer(makeMockMemoryManager(), makeMockNats(), auth)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({name: 'scope-test', version: '1.0'}, {capabilities: {}})
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

/** Returns the error message if the call was rejected, or undefined if it succeeded. */
async function callToolError(client: Client, name: string, args: Record<string, unknown>): Promise<string | undefined> {
  try {
    const result = await client.callTool({arguments: args, name})
    // The MCP SDK surfaces a handler throw as isError + text content rather
    // than a transport rejection, so check both shapes.
    if (result.isError) return JSON.stringify(result.content)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * Silences both console and direct stream writes for the duration of `fn`.
 * The embedding sidecar reports unreachable backends with
 * `process.stderr.write` rather than console (see embedding.ts), so stubbing
 * console alone leaves the suite output dirty.
 */
async function withSilencedOutput<T>(fn: () => Promise<T>): Promise<T> {
  const {error, log, warn} = console
  const stderrWrite = process.stderr.write.bind(process.stderr)
  console.error = () => {}
  console.log = () => {}
  console.warn = () => {}
  process.stderr.write = () => true
  try {
    return await fn()
  } finally {
    console.error = error
    console.log = log
    console.warn = warn
    process.stderr.write = stderrWrite
  }
}

const SCOPED_TOKEN: McpAuthContext = {agentId: 'crush-spark', scopes: ['memory:read', 'memory:write']}

describe('pmoves MCP per-tool scope enforcement (call site)', () => {
  describe('a token holder cannot skip the check by omitting agentId', () => {
    it('rejects pmoves_cipher_hybrid_search with no agentId instead of running an unscoped search', async () => {
      const client = await connectClient(SCOPED_TOKEN)
      const error = await callToolError(client, 'pmoves_cipher_hybrid_search', {query: 'secrets'})
      expect(error, 'omitted agentId must be rejected, not treated as cross-agent').to.be.a('string')
      expect(error).to.include('agentId')
    })

    it('rejects pmoves_cipher_session_recall with no agentId', async () => {
      const client = await connectClient(SCOPED_TOKEN)
      const error = await callToolError(client, 'pmoves_cipher_session_recall', {query: 'latest session'})
      expect(error, 'omitted agentId must be rejected').to.be.a('string')
      expect(error).to.include('agentId')
    })

    // The scope table is only consulted once the call site actually reaches
    // assertAgentId. A token with NO memory:read that omits agentId must not
    // sail past both checks at once.
    it('rejects a scopeless token that omits agentId on a memory:read tool', async () => {
      const client = await connectClient({agentId: 'crush-spark', scopes: []})
      const error = await callToolError(client, 'pmoves_cipher_hybrid_search', {query: 'secrets'})
      expect(error).to.be.a('string')
    })
  })

  describe('checks that already worked keep working', () => {
    it('still rejects a token missing the tool scope when agentId IS supplied', async () => {
      const client = await connectClient({agentId: 'crush-spark', scopes: ['session:read']})
      const error = await callToolError(client, 'pmoves_cipher_hybrid_search', {agentId: 'crush-spark', query: 'x'})
      expect(error).to.be.a('string')
      expect(error).to.include('memory:read')
    })

    it('still rejects an agentId that does not match the token', async () => {
      const client = await connectClient(SCOPED_TOKEN)
      const error = await callToolError(client, 'pmoves_cipher_hybrid_search', {agentId: 'claude-4090', query: 'x'})
      expect(error).to.be.a('string')
      expect(error).to.include('crush-spark')
    })
  })

  // assertAgentId's documented dev-skip: with no authenticated agent there is
  // no token to enforce against, and unauthenticated local workflows that
  // never opted into per-agent tokens must keep working. Tightening the gate
  // must not tighten THIS.
  describe('advisory mode (no authenticated agent) is untouched', () => {
    it('does not reject an omitted agentId when the request is unauthenticated', async () => {
      const client = await connectClient({})
      // This is the one case that reaches the embedding sidecar, which warns
      // on every unreachable backend. Silence it so the suite output stays
      // clean; the assertion below is on the return value, not the log.
      const error = await withSilencedOutput(() =>
        callToolError(client, 'pmoves_cipher_session_recall', {query: 'latest session'}))
      // It may still fail downstream on the mocked sidecar, but it must NOT
      // fail the authorization gate.
      if (error !== undefined) expect(error).to.not.include('Forbidden')
    })
  })
})
