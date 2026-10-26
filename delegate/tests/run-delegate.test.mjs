// The runner's readPaths hand-off, checked where a real child cannot be started from a test (spawning claude needs a
// real CLI and a live model): the source must wire readPaths into PTC_RUN_READ_ROOTS and into the appended prompt,
// and only for read + ptc:'only'. The env variable's real effect is covered by ptc-run's tests/e2e-hook.mjs.
//
//   node --test tests/run-delegate.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readRootsEnv, readRootsOf, readRootsPromptArg } from '../scripts/read-roots.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(here, '../scripts/run-delegate.mjs'), 'utf8')

test('the runner derives the roots from the job and only for the read-only sandbox', () => {
  assert.match(src, /const roOnly = job\.mode !== 'work' && job\.ptc === 'only'/)
  assert.match(src, /const readRoots = readRootsOf\(job, roOnly\)/)
  assert.match(src, /if \(readRootsValue !== ''\) env\.PTC_RUN_READ_ROOTS = readRootsValue/)
  assert.match(src, /else delete env\.PTC_RUN_READ_ROOTS/)
  assert.match(src, /\.\.\.readRootsPromptArg\(readRoots\)/)
})

test('the env value is what the child gets: PATH-separated, nothing when there is nothing', () => {
  const job = { mode: 'read', ptc: 'only', readPaths: ['C:/ext/one', 'D:/ext/two'] }
  const roots = readRootsOf(job, true)
  assert.equal(readRootsEnv(roots, ';'), 'C:/ext/one;D:/ext/two')
  assert.equal(readRootsEnv(readRootsOf({ mode: 'work', readPaths: ['C:/x'] }, false), ';'), '')
  assert.deepEqual(readRootsPromptArg(roots).slice(0, 1), ['--append-system-prompt'])
})

test('the read-only prompt no longer claims the working directory is the only readable place', () => {
  const prompt = fs.readFileSync(path.join(here, '../scripts/ptc-readonly-system.md'), 'utf8')
  assert.doesNotMatch(prompt, /Only files under the working directory can be read or searched/)
  assert.match(prompt, /working directory plus the extra readable directories/)
})
