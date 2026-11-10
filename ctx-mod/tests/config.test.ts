import { expect, test } from 'claude-code/testing'

import { ENV, changedText, enabledOf, readConfig } from '../hooks/lib/config.ts'
import { DEFAULTS } from '../hooks/lib/types.ts'

test('with nothing configured the result is DEFAULTS itself, field for field', () => {
  expect(readConfig({}, {})).toEqual(DEFAULTS)
  expect(readConfig(undefined)).toEqual(DEFAULTS)
  expect(changedText(DEFAULTS)).toBe('')
})

test('the manifest values apply when no environment variable is set', () => {
  const config = readConfig({
    compactWindow: 500_000,
    boundaryTokens: 160_000,
    softTokens: 180_000,
    urgentTokens: 200_000,
    cooldownRequests: 0,
    maxSwitchesPerHour: 2,
    coldMinTokens: 90_000,
    gateMinTokens: 100_000,
  })

  expect(config).toEqual({
    ...DEFAULTS,
    compactWindow: 500_000,
    boundaryTokens: 160_000,
    softTokens: 180_000,
    urgentTokens: 200_000,
    cooldownRequests: 0,
    maxSwitchesPerHour: 2,
    coldMinTokens: 90_000,
    gateMinTokens: 100_000,
  })
})

test('an environment variable overrides the manifest value, and is read as a number', () => {
  const config = readConfig(
    { compactWindow: 500_000, boundaryTokens: 160_000, softTokens: 180_000, urgentTokens: 200_000, maxSwitchesPerHour: 2 },
    {
      [ENV.compactWindow]: '600000',
      [ENV.boundaryTokens]: ' 170000 ',
      [ENV.maxSwitchesPerHour]: '3',
      [ENV.cooldownRequests]: '0',
    },
  )

  expect(config.compactWindow).toBe(600_000)
  expect(config.boundaryTokens).toBe(170_000)
  expect(config.maxSwitchesPerHour).toBe(3)
  expect(config.cooldownRequests).toBe(0)
  // A variable not set leaves the manifest's value in place.
  expect(config.softTokens).toBe(180_000)
  expect(config.urgentTokens).toBe(200_000)
})

test('a value that is not a finite number of the right sign falls back to its default', () => {
  const config = readConfig(
    { compactWindow: -1, cooldownRequests: -1, gateMinTokens: Number.NaN },
    {
      [ENV.boundaryTokens]: 'abc',
      [ENV.softTokens]: 'Infinity',
      [ENV.urgentTokens]: '0',
      [ENV.maxSwitchesPerHour]: '-2',
      [ENV.coldMinTokens]: '',
    },
  )

  for (const field of ['compactWindow', 'boundaryTokens', 'softTokens', 'urgentTokens', 'cooldownRequests', 'maxSwitchesPerHour', 'coldMinTokens', 'gateMinTokens'] as const) {
    expect(config[field]).toBe(DEFAULTS[field])
  }
})

test('zero is a value only for the two counts', () => {
  const config = readConfig({}, { [ENV.cooldownRequests]: '0', [ENV.maxSwitchesPerHour]: '0' })

  expect(config.cooldownRequests).toBe(0)
  expect(config.maxSwitchesPerHour).toBe(0)
})

test('three fills out of order drop the whole group to the defaults and say so once', () => {
  const warnings: string[] = []
  const config = readConfig(
    {},
    { [ENV.boundaryTokens]: '260000', [ENV.softTokens]: '250000', [ENV.urgentTokens]: '350000', [ENV.compactWindow]: '500000' },
    text => warnings.push(text),
  )

  expect(config.boundaryTokens).toBe(DEFAULTS.boundaryTokens)
  expect(config.softTokens).toBe(DEFAULTS.softTokens)
  expect(config.urgentTokens).toBe(DEFAULTS.urgentTokens)
  // Only the group falls back: the other fields keep what was configured.
  expect(config.compactWindow).toBe(500_000)
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('boundaryTokens')
})

test('three fills that climb, equal ones included, are kept', () => {
  const config = readConfig({}, { [ENV.boundaryTokens]: '200000', [ENV.softTokens]: '200000', [ENV.urgentTokens]: '200000' })

  expect([config.boundaryTokens, config.softTokens, config.urgentTokens]).toEqual([200_000, 200_000, 200_000])
})

test('the environment switch wins over enabled, and an unset switch follows it', () => {
  expect(enabledOf({ enabled: true }, {})).toBe(true)
  expect(enabledOf({ enabled: false }, {})).toBe(false)
  expect(enabledOf({ enabled: true }, { [ENV.enabled]: '1' })).toBe(true)
  expect(enabledOf({ enabled: false }, { [ENV.enabled]: '1' })).toBe(true)
  expect(enabledOf({ enabled: true }, { [ENV.enabled]: '0' })).toBe(false)
  expect(enabledOf({ enabled: false }, { [ENV.enabled]: '0' })).toBe(false)
  // A value that is neither 0 nor 1 leaves the choice to the option.
  expect(enabledOf({ enabled: true }, { [ENV.enabled]: 'yes' })).toBe(true)
})

test('the status line lists only the fields that differ from their defaults', () => {
  expect(changedText({ ...DEFAULTS, boundaryTokens: 150_000 })).toBe('\n配置：boundaryTokens=150000（默认 200000）')
  const text = changedText({ ...DEFAULTS, softTokens: 250_000, gateMinTokens: 100_000 })
  expect(text).toContain('softTokens=250000（默认 300000）')
  expect(text).toContain('gateMinTokens=100000（默认 120000）')
  expect(text).not.toContain('compactWindow=')
})
