import type { Ttl } from './pricing.ts'

export type StepKind = 'build' | 'probe' | 'keeper'

export type PlanStep = {
  /** Seconds after the build request started. */
  atSec: number
  kind: StepKind
}

export type Plan = {
  /** What `/cache-keeper experiment <name>` takes. */
  name: string
  /** The experiment id rows and run records carry. */
  id: string
  title: string
  /** The TTL the session must have been started with, when the plan needs one. */
  requiresTtl: Ttl | null
  steps: readonly PlanStep[]
}

const BUILD: PlanStep = { atSec: 0, kind: 'build' }

const every = (
  kind: StepKind,
  periodSec: number,
  times: number,
): PlanStep[] =>
  Array.from({ length: times }, (_, index) => ({
    atSec: periodSec * (index + 1),
    kind,
  }))

export const PLANS: readonly Plan[] = [
  {
    name: 'ttl',
    id: 'A-ttl',
    title: 'TTL takes effect: build the cache, probe after 90 s',
    requiresTtl: null,
    steps: [BUILD, { atSec: 90, kind: 'probe' }],
  },
  {
    name: 'renew',
    id: 'B-renew',
    title: 'A 5m hit renews the TTL: keepalives at 4:00 and 8:00, probe at 12:00',
    requiresTtl: '5m',
    steps: [BUILD, ...every('keeper', 240, 2), { atSec: 720, kind: 'probe' }],
  },
  {
    name: 'renew-control',
    id: 'B-control',
    title: 'Control for B: no keepalive, probe at 6:30',
    requiresTtl: '5m',
    steps: [BUILD, { atSec: 390, kind: 'probe' }],
  },
  {
    name: 'active',
    id: 'C1-active',
    title: 'Active coding: 11 probes, 3 minutes apart',
    requiresTtl: null,
    steps: [BUILD, ...every('probe', 180, 11)],
  },
  {
    name: 'intermittent',
    id: 'C2-intermittent',
    title: 'Intermittent coding: 5 probes, 10 minutes apart',
    requiresTtl: null,
    steps: [BUILD, ...every('probe', 600, 5)],
  },
  {
    name: 'keeper',
    id: 'D2-keeper',
    title: '18 minutes idle with a keepalive every 4:05, then a probe',
    requiresTtl: '5m',
    steps: [BUILD, ...every('keeper', 245, 4), { atSec: 1080, kind: 'probe' }],
  },
  {
    name: 'keeper-control',
    id: 'D1-idle',
    title: '18 minutes idle with no keepalive, then a probe',
    requiresTtl: null,
    steps: [BUILD, { atSec: 1080, kind: 'probe' }],
  },
]

export const planNamed = (name: string): Plan | undefined =>
  PLANS.find(plan => plan.name === name)

export const planDurationSec = (plan: Plan): number =>
  Math.max(...plan.steps.map(step => step.atSec))

const WORDS = (
  'the of and to in is that for it as was with be by on not he this are or ' +
  'his from at which but have an had they you were their one all we can her ' +
  'has there been if more when will would who so no out up into than them ' +
  'time only some could these two may then do first any my now such like ' +
  'our over man me even most made after also did many before must through ' +
  'years where much your way well down should because each just those people ' +
  'how too little state good very make world still own see men work long get ' +
  'here between both life being under never day same another know while last ' +
  'might us great old year off come since against go came right used take three'
).split(' ')

const seedOf = (text: string): number => {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619)
  }

  return hash >>> 0 || 1
}

/**
 * Static filler of about `targetTokens` tokens (one common word is about one
 * token), the same for the same nonce and different from the first word on
 * for another, so no two runs can be served each other's cache entry.
 */
export const buildFiller = (nonce: string, targetTokens: number): string => {
  let state = seedOf(nonce)
  const lines: string[] = []
  let line: string[] = []
  for (let index = 0; index < targetTokens; index += 1) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    line.push(WORDS[(state >>> 0) % WORDS.length] ?? 'the')
    if (line.length === 16) {
      lines.push(line.join(' '))
      line = []
    }
  }
  if (line.length > 0) lines.push(line.join(' '))

  return lines.join('\n')
}

export const marker = (kind: StepKind, nonce: string, index: number): string =>
  `[cache-keeper:${kind}:${nonce}:${index}]`

export const buildPrompt = (
  nonce: string,
  targetTokens: number,
  probePrompt: string,
): string =>
  [
    `${marker('build', nonce, 0)} The block below is static filler for a prompt-cache benchmark. Do not analyze, summarize or act on it, and do not call any tool.`,
    '',
    '<filler>',
    buildFiller(nonce, targetTokens),
    '</filler>',
    '',
    probePrompt,
  ].join('\n')

export const probePromptFor = (
  nonce: string,
  index: number,
  probePrompt: string,
): string => `${marker('probe', nonce, index)} ${probePrompt}`
