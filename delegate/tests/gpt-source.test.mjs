// GPT 来源（ChatGPT 订阅 / CPA 自定义供应商）与前缀显示：纯逻辑，直接 import 源码里的 .ts 模块。
//
//   node --test tests/gpt-source.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalize, setGptHidePrefix, setGptSource } from '../hooks/lib/config.ts'
import {
  GPT_DEFAULT_MODEL,
  gptDisplayModel,
  gptLabel,
  gptSourceModelOf,
  gptWireModel,
} from '../hooks/lib/gpt.ts'

const CPA = [
  { id: 'mypool-chat', name: 'Pool chat' },
  { id: 'mypool-resp', name: 'Pool resp' },
]
const raw = (extra = {}) => ({ providers: CPA, slots: {}, ...extra })

test('gptSource 跟着供应商走：保留、被删就清空、垃圾当订阅', () => {
  assert.equal(normalize(raw({ gptSource: 'mypool-resp' })).gptSource, 'mypool-resp')
  assert.equal(normalize(raw({ gptSource: ' mypool-chat ' })).gptSource, 'mypool-chat')
  // 供应商被删：回到 ChatGPT 订阅
  assert.equal(normalize(raw({ providers: [CPA[0]], gptSource: 'mypool-resp' })).gptSource, '')
  // 缺省 / 垃圾
  assert.equal(normalize(raw()).gptSource, '')
  assert.equal(normalize({ providers: CPA, slots: {}, gptSource: 42 }).gptSource, '')
  assert.equal(normalize(undefined).gptSource, '')
})

test('gptHidePrefix 默认开，只有明确写 false 才关', () => {
  assert.equal(normalize(raw()).gptHidePrefix, true)
  assert.equal(normalize(raw({ gptHidePrefix: true })).gptHidePrefix, true)
  assert.equal(normalize(raw({ gptHidePrefix: false })).gptHidePrefix, false)
  assert.equal(normalize(raw({ gptHidePrefix: 'no' })).gptHidePrefix, true)
  assert.equal(normalize(undefined).gptHidePrefix, true)
})

test('setGptSource 只认已有供应商，空串回到订阅', () => {
  const base = normalize(raw())
  assert.equal(setGptSource(base, 'mypool-resp').config.gptSource, 'mypool-resp')
  assert.equal(setGptSource(base, '').config.gptSource, '')
  assert.match(setGptSource(base, 'nope').error ?? '', /没有叫/)
  assert.equal(setGptSource(base, 'nope').config, base) // 出错时不改配置
  assert.equal(setGptHidePrefix(base, false).config.gptHidePrefix, false)
})

test('发给 CPA 的 model 带供应商前缀（CPA 靠它路由）', () => {
  assert.equal(gptWireModel('mypool-resp', 'gpt-6.1-sol'), 'mypool-resp/gpt-6.1-sol')
  assert.equal(gptWireModel(' mypool-chat ', 'gpt-6-sol'), 'mypool-chat/gpt-6-sol')
  // 走订阅：不加任何前缀
  assert.equal(gptWireModel('', 'gpt-6.1-sol'), 'gpt-6.1-sol')
})

test('走自定义供应商时可用该供应商的任意模型，其余报错并列出可用项', () => {
  const models = ['gpt-6-sol', 'gpt-6.1-sol', 'gpt-5.6-terra']
  assert.equal(gptSourceModelOf('', models), GPT_DEFAULT_MODEL)
  assert.equal(gptSourceModelOf(' gpt-5.6-terra ', models), 'gpt-5.6-terra')
  const bad = gptSourceModelOf('gpt-9', models)
  assert.match(bad.error, /未知的 GPT 模型「gpt-9」/)
  assert.match(bad.error, /gpt-5\.6-terra/)
  // 列表里没有默认模型：退回列表第一个
  assert.equal(gptSourceModelOf('', ['gpt-6-sol']), 'gpt-6-sol')
})

test('显示名默认去前缀，关掉开关才显示完整前缀', () => {
  assert.equal(gptDisplayModel('gpt-6.1-sol', 'mypool-resp', true), 'gpt-6.1-sol')
  assert.equal(gptDisplayModel('gpt-6.1-sol', 'mypool-resp', undefined), 'gpt-6.1-sol')
  assert.equal(gptDisplayModel('mypool-resp/gpt-6.1-sol', 'mypool-resp', true), 'gpt-6.1-sol')
  assert.equal(gptDisplayModel('gpt-6.1-sol', 'mypool-resp', false), 'mypool-resp/gpt-6.1-sol')
  // 订阅没有前缀可加
  assert.equal(gptDisplayModel('gpt-6.1-sol', '', false), 'gpt-6.1-sol')
})

test('runner 原样透传带前缀的 gpt model，不按模型名做判断', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const src = fs.readFileSync(path.join(here, '../scripts/run-delegate.mjs'), 'utf8')
  // gpt 的 model 原样进 ANTHROPIC_MODEL（CPA 按前缀路由）；只有非 gpt 的 effort=off 才会被改名
  assert.match(src, /const routedModel = !gpt && job\.effort === 'off' \? model \+ '\(none\)' : model/)
  assert.match(src, /ANTHROPIC_MODEL: routedModel/)
  assert.doesNotMatch(src, /model\.split\('\/'?\)/)
})

test('gptLabel 用来源名，订阅仍显示 ChatGPT 订阅', () => {
  assert.equal(
    gptLabel('gpt-6.1-sol', { background: false, work: true }, 'Pool resp'),
    'gpt · Pool resp / gpt-6.1-sol · 前台 · 可改文件',
  )
  assert.equal(
    gptLabel('gpt-6.1-sol', { background: false, work: true }),
    'gpt · ChatGPT 订阅 / gpt-6.1-sol · 前台 · 可改文件',
  )
})
