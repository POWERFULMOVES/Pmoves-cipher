import {expect} from 'chai'

import {requiredScopeForTool} from '../../../src/pmoves/mcp-sse.js'

// assertAgentId() has accepted a `requiredScope` argument since PR #12 and
// implements the check correctly -- but its single call site never passed one,
// so per-operation scope enforcement described in the tool schemas never ran.
// This maps each tool to the scope it needs, which is what makes that
// parameter reachable.
describe('pmoves MCP tool scopes', () => {
  describe('requiredScopeForTool', () => {
    it('requires memory:write to store', () => {
      expect(requiredScopeForTool('pmoves_cipher_store')).to.equal('memory:write')
    })

    it('requires memory:read for every read path', () => {
      expect(requiredScopeForTool('pmoves_cipher_search')).to.equal('memory:read')
      expect(requiredScopeForTool('pmoves_cipher_hybrid_search')).to.equal('memory:read')
      expect(requiredScopeForTool('pmoves_cipher_graph_expand')).to.equal('memory:read')
    })

    it('separates reasoning from memory', () => {
      expect(requiredScopeForTool('pmoves_cipher_store_reasoning')).to.equal('reasoning:write')
      expect(requiredScopeForTool('pmoves_cipher_reasoning_patterns')).to.equal('reasoning:read')
    })

    it('separates session from memory', () => {
      expect(requiredScopeForTool('pmoves_cipher_session_save')).to.equal('session:write')
      expect(requiredScopeForTool('pmoves_cipher_session_recall')).to.equal('session:read')
    })

    // The mint default is memory:{read,write} reasoning:{read,write}
    // session:{read,write} -- there is no mcp:* scope. Mapping these two to any
    // scope would reject EVERY token in existence, converting a missing check
    // into a total outage. They stay unmapped until such a scope is actually
    // issued.
    it('leaves the MCP catalog tools unmapped, because no issued token has an mcp scope', () => {
      expect(requiredScopeForTool('pmoves_cipher_mcp_list')).to.equal(undefined)
      expect(requiredScopeForTool('pmoves_cipher_mcp_get')).to.equal(undefined)
    })

    it('returns undefined for an unknown tool rather than inventing a scope', () => {
      expect(requiredScopeForTool('not_a_real_tool')).to.equal(undefined)
    })

    it('only ever returns scopes the minting default actually issues', () => {
      const issued = new Set([
        'memory:read', 'memory:write',
        'reasoning:read', 'reasoning:write',
        'session:read', 'session:write',
      ])
      const tools = [
        'pmoves_cipher_store', 'pmoves_cipher_search', 'pmoves_cipher_store_reasoning',
        'pmoves_cipher_reasoning_patterns', 'pmoves_cipher_session_save',
        'pmoves_cipher_session_recall', 'pmoves_cipher_hybrid_search',
        'pmoves_cipher_graph_expand', 'pmoves_cipher_mcp_list', 'pmoves_cipher_mcp_get',
      ]
      for (const t of tools) {
        const scope = requiredScopeForTool(t)
        if (scope !== undefined) {
          expect(issued.has(scope), `tool ${t} demands unissued scope '${scope}'`).to.equal(true)
        }
      }
    })
  })
})
