 
import {expect} from 'chai'
import {existsSync} from 'node:fs'
import {mkdir, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {restore, stub} from 'sinon'

import {FileBlobStorage} from '../../../../src/agent/infra/blob/file-blob-storage.js'
import {MemoryManager} from '../../../../src/agent/infra/memory/index.js'

/**
 * Regression coverage for the 2026-10-01 outage: pmoves/mcp-sse.ts calls
 * memoryManager.list({limit, tags}) from pmoves_cipher_session_recall and
 * pmoves_cipher_reasoning_patterns, but ListMemoriesOptionsSchema was
 * .strict() without a `tags` field — every such call died as
 * zod unrecognized_keys ["tags"] before reaching storage, leaving
 * session_recall and reasoning_patterns hard down server-side.
 */
describe('Memory Module', () => {
  describe('MemoryManager.list - tags filter', () => {
    let memoryManager: MemoryManager
    let blobStorage: FileBlobStorage
    let testDir: string

    beforeEach(async () => {
      stub(console, 'log')
      stub(console, 'warn')
      testDir = join(tmpdir(), `memory-list-tags-test-${Date.now()}`)
      await mkdir(testDir, {recursive: true})

      blobStorage = new FileBlobStorage({
        maxBlobSize: 1024 * 1024,
        maxTotalSize: 5 * 1024 * 1024,
        storageDir: join(testDir, 'blobs'),
      })
      await blobStorage.initialize()

      memoryManager = new MemoryManager(blobStorage)

      await memoryManager.create({content: 'checkpoint one', metadata: {agentId: 'probe', category: 'agent_checkpoint'}, tags: ['agent_checkpoint']})
      await memoryManager.create({content: 'reasoning one', metadata: {agentId: 'probe', category: 'reasoning'}, tags: ['reasoning']})
      await memoryManager.create({content: 'plain context', metadata: {agentId: 'probe', category: 'context'}, tags: []})
      await memoryManager.create({content: 'multi tag', metadata: {agentId: 'probe', category: 'context'}, tags: ['reasoning', 'agent_checkpoint']})
    })

    afterEach(async () => {
      if (existsSync(testDir)) {
        await rm(testDir, {force: true, recursive: true})
      }

      restore()
    })

    it('accepts {limit, tags} — the exact shape session_recall sends (was unrecognized_keys)', async () => {
      const listed = await memoryManager.list({limit: 1000, tags: ['agent_checkpoint']})
      expect(listed).to.be.an('array')
    })

    it('keeps only memories carrying at least one listed tag (ANY overlap)', async () => {
      const listed = await memoryManager.list({limit: 1000, tags: ['agent_checkpoint']})
      expect(listed).to.have.lengthOf(2)
      for (const memory of listed) {
        expect((memory.tags ?? []).includes('agent_checkpoint')).to.equal(true)
      }
    })

    it('matches a memory tagged with several listed tags once', async () => {
      const listed = await memoryManager.list({limit: 1000, tags: ['reasoning', 'agent_checkpoint']})
      expect(listed).to.have.lengthOf(3)
    })

    it('excludes memories with no tags when a filter is present', async () => {
      const listed = await memoryManager.list({limit: 1000, tags: ['reasoning']})
      expect(listed).to.have.lengthOf(2)
      for (const memory of listed) {
        expect((memory.tags ?? []).length).to.be.greaterThan(0)
      }
    })

    it('returns an empty array when no memory carries the tag', async () => {
      const listed = await memoryManager.list({limit: 1000, tags: ['no-such-tag']})
      expect(listed).to.have.lengthOf(0)
    })

    it('treats an empty tags array as no filter (unchanged behavior)', async () => {
      const listed = await memoryManager.list({limit: 1000, tags: []})
      expect(listed).to.have.lengthOf(4)
    })

    it('still rejects genuinely unknown options (schema stays strict)', async () => {
      let thrown: unknown
      try {
        await memoryManager.list({limit: 5, nope: true} as never)
      } catch (error) {
        thrown = error
      }

      expect(thrown).to.be.an('error')
      expect((thrown as Error).message).to.match(/unrecognized|nope/i)
    })
  })
})
