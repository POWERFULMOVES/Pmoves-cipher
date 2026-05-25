/**
 * Golden-baseline integration test for the TS migrator.
 *
 * Iterates every `test/fixtures/migrate/<scenario>/` directory,
 * reads `input.md` + `rel-path.txt`, runs `convertMarkdownTopicToHtml`
 * with a fixed mtime, and asserts byte-equal HTML + warnings list
 * against the captured oracle output.
 *
 * Regenerate fixtures via:
 *   <python-venv>/bin/python test/fixtures/migrate/_regenerate.py
 */

import {expect} from 'chai'
import {readdirSync, readFileSync, statSync} from 'node:fs'
import {join} from 'node:path'

import {convertMarkdownTopicToHtml} from '../../../../../src/server/infra/migrate/convert.js'

const FIXED_MTIME_MS = 1_700_000_000_000 // 2023-11-14T22:13:20.000Z
const FIXTURES_DIR = join(process.cwd(), 'test/fixtures/migrate')

function loadFixtures(): Array<{
  expectedHtml: string
  expectedWarnings: string[]
  input: string
  name: string
  relPath: string
}> {
  const entries = readdirSync(FIXTURES_DIR)
  const out = []
  for (const name of entries) {
    const dir = join(FIXTURES_DIR, name)
    let stat
    try {
      stat = statSync(dir)
    } catch {
      continue
    }

    if (!stat.isDirectory()) continue
    if (name.startsWith('_') || name.startsWith('.')) continue
    const inputPath = join(dir, 'input.md')
    const relPathFile = join(dir, 'rel-path.txt')
    const expectedHtmlPath = join(dir, 'expected.html')
    const expectedWarningsPath = join(dir, 'expected-warnings.json')
    let input: string
    let relPath: string
    let expectedHtml: string
    let expectedWarnings: string[]
    try {
      input = readFileSync(inputPath, 'utf8')
      relPath = readFileSync(relPathFile, 'utf8').trim()
      expectedHtml = readFileSync(expectedHtmlPath, 'utf8')
      const wRaw = readFileSync(expectedWarningsPath, 'utf8')
      const wParsed: unknown = JSON.parse(wRaw)
      if (!Array.isArray(wParsed)) throw new Error('warnings not an array')
      expectedWarnings = wParsed.map(String)
    } catch (error) {
      throw new Error(`Fixture ${name} is missing or malformed: ${String(error)}`)
    }

    out.push({expectedHtml, expectedWarnings, input, name, relPath})
  }

  return out.sort((a, b) => a.name.localeCompare(b.name))
}

describe('migrate/convert — golden baseline against Python oracle', () => {
  const fixtures = loadFixtures()

  it('found fixtures', () => {
    expect(fixtures.length).to.be.greaterThan(15)
  })

  for (const f of fixtures) {
    describe(f.name, () => {
      const actual = convertMarkdownTopicToHtml({
        markdown: f.input,
        mtimeMs: FIXED_MTIME_MS,
        relPath: f.relPath,
      })

      it('HTML matches oracle byte-for-byte', () => {
        expect(actual.html).to.equal(f.expectedHtml)
      })

      it('warnings match oracle', () => {
        expect(actual.warnings).to.deep.equal(f.expectedWarnings)
      })
    })
  }
})
