// node --test delegate/tests/ptc-rules.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { composedPromptFile, delegateRulesBlock, hardRules, reportRules } from '../scripts/ptc-rules.mjs'
import { agentFileOf } from '../scripts/run-agy.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const SYNC_SHAPE = /tools\.read\(\{\s*path|tools\.sh\(|同步返回/
const DSH_SHAPE = /file_path|await tools\./

test('DS/GPT prompts get the shared rules in DSH shape only', () => {
  for (const [file, kind] of [['ptc-only-system.md', 'dsh'], ['ptc-readonly-system.md', 'dshRo']]) {
    const src = path.join(here, '..', 'scripts', file)
    assert.doesNotMatch(fs.readFileSync(src, 'utf8'), /## 工作方式（硬规则）|## 批量规则/, file + ' must not carry pasted rules')
    const text = fs.readFileSync(composedPromptFile(src, kind, false), 'utf8')
    assert.ok(text.endsWith(delegateRulesBlock(kind) + '\n'))
    assert.match(text, /TASK_TERMINAL: completed/)
    assert.doesNotMatch(delegateRulesBlock(kind), SYNC_SHAPE)
  }
  assert.doesNotMatch(delegateRulesBlock('dshRo'), /tools\.(edit|bash|write)/)
  assert.equal(composedPromptFile('X.md', 'dsh', true), 'X.md')
})

test('AGY agents carry the same rule lines in the sync shape', () => {
  for (const k of ['read', 'work']) {
    const body = agentFileOf(k)
    for (const line of [...hardRules('sync'), ...reportRules]) assert.ok(body.includes(line), k + ' misses: ' + line)
    assert.doesNotMatch(hardRules('sync').join('\n'), DSH_SHAPE)
  }
})
