import {expect} from 'chai'

import {positiveNumberFromEnv} from '../../../src/pmoves/embedding.js'

// PR #15 shipped `Number(process.env.PMOVES_EMBED_TIMEOUT_MS ?? 30000)` with a
// review comment asking for validation that was never actioned. `Number('')` is
// 0 and `Number('abc')` is NaN, and AbortSignal.timeout() given either aborts
// the request immediately -- which the embed path logs as "unreachable", the
// exact false-negative that cost this fleet a multi-day misdiagnosis once
// already. A bad env value must fall back, never silently disable embeddings.
describe('pmoves env number parsing', () => {
  describe('positiveNumberFromEnv', () => {
    it('uses the value when it is a positive number', () => {
      expect(positiveNumberFromEnv('45000', 30_000)).to.equal(45_000)
    })

    it('falls back when the variable is unset', () => {
      expect(positiveNumberFromEnv(undefined, 30_000)).to.equal(30_000)
    })

    it('falls back on an empty string rather than yielding 0', () => {
      // Number('') === 0, and a 0ms AbortSignal.timeout aborts instantly.
      expect(positiveNumberFromEnv('', 30_000)).to.equal(30_000)
    })

    it('falls back on a non-numeric value rather than yielding NaN', () => {
      expect(positiveNumberFromEnv('abc', 30_000)).to.equal(30_000)
      expect(positiveNumberFromEnv('30s', 30_000)).to.equal(30_000)
    })

    it('falls back on zero and on negatives', () => {
      expect(positiveNumberFromEnv('0', 30_000)).to.equal(30_000)
      expect(positiveNumberFromEnv('-1', 30_000)).to.equal(30_000)
    })

    it('falls back on Infinity', () => {
      expect(positiveNumberFromEnv('Infinity', 30_000)).to.equal(30_000)
    })

    it('tolerates surrounding whitespace, since env values often carry it', () => {
      expect(positiveNumberFromEnv(' 45000 ', 30_000)).to.equal(45_000)
    })
  })
})
