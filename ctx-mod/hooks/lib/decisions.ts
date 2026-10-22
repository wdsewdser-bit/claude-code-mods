// Which of the person's own words are decisions: the constraints they set and the
// answers they gave. The handoff carries them into every new window verbatim,
// because the failures this exists for are the model quietly breaking a rule the
// person had already settled — and the rule was made in a window no longer in context.
//
// The rules are deterministic on purpose (markers and sentence shape, no score or
// threshold): the same history must always yield the same section, and a false
// positive is visible and harmless while a silent miss is not.

import { repliesAnswered, stripInjected } from './history.ts'
import type { HistoryRecord } from './types.ts'

/** One decision a person stated, as the handoff carries it. */
export type Decision = {
  /** The history seq of the message it was said in. */
  seq: number
  ts: number
  window: number
  /** The sentence itself, verbatim; only a very long one is clipped. */
  text: string
  /** The model's reply a short answer answers: "可以" means nothing without its question. */
  answered?: HistoryRecord
}

/**
 * One decision the person took back. Kept beside the ledger: the section stops
 * carrying that message's decisions, history still has the words, and the next
 * window can see that the rule was withdrawn rather than never made.
 */
export type DecisionRevoke = {
  /** The history seq of the message the withdrawn decision was said in. */
  seq: number
  ts: number
  window: number
  /** The message that replaces it, when the person said what to do instead. */
  by?: number
  /** Why it was withdrawn, in the person's or the model's words. */
  reason?: string
}

/** A sentence longer than this is clipped, with a pointer to its history row. */
export const MAX_DECISION_CHARS = 300

/** A sentence this short that opens with an answer word is a reply, not a request. */
const REPLY_MAX_CHARS = 24

/**
 * How many decisions one message may contribute. A long pasted report carries a
 * dozen lines that read like rules and would crowd every older decision out of
 * the section; the person's own decisions are mostly a sentence or two.
 */
const MAX_PER_MESSAGE = 3

/**
 * How much of the answered reply is shown: enough to say what the answer settled,
 * not the whole report it came after.
 */
const ANSWERED_HEAD_CHARS = 60
const ANSWERED_TAIL_CHARS = 100

/**
 * What marks a sentence as a decision: a prohibition, a requirement, a default, a
 * standing order or a change of mind. These are the person's own words for setting
 * a rule; a sentence carrying one is carried as it stands.
 */
const CONSTRAINT_MARKERS: readonly RegExp[] = [
  /不要/,
  /不用/,
  /别再?[用把在给写改动碰删加调弄]/,
  /(?:^|[，,、；;：:\s])别(?!的|人)/,
  /必须/,
  /务必/,
  /一律/,
  /以后/,
  /默认/,
  /先[^。！？!?\n]{1,40}再/,
  /改成/,
  /就用/,
  /统一/,
  /禁止/,
  /不准/,
  /保留/,
  /只用/,
  /只做/,
  /仅用/,
  /只允许/,
  /只给/,
  /不能再/,
  /不再/,
  // Requirements stated as needs: "还得要能清理", "需要你按这个来", "先离线分析吧".
  /还得/,
  /得要/,
  /要能/,
  /需要(?:你|按|用|先|只|做|能|把|改|加|跑|测)/,
  /应该(?:用|按|只|先|直|默)/,
  /就先/,
  /不跑/,
  /别跑/,
  /就行(?:了)?/,
  /没必要/,
  /先[^。！？!?\n]{1,40}吧/,
  /只[^。！？!?\n]{0,20}不/,
  // What the thing is for: "我们这个是用来仿造 dsh 的 ptc 模式". A purpose said once
  // settles the shape of everything after it, and the sentence carries no other marker.
  /仿造|仿照/,
  // A number said on its own with a softener is a threshold chosen: "99有点危险 95吧".
  /(?:^|[\s，,、])[\d][\d.%％万千wkKW]*\s*(?:吧|呗)[。！!]*$/,
]

/**
 * How a short answer to the model's question opens: a choice made ("选 A", "1+2")
 * or an assent. The question it answers is carried beside it, since the answer
 * alone does not say what was settled.
 */
/** The softeners a spoken answer trails off with: "1+2吧", "可以呗", "就这样了". */
const TRAILING_PARTICLE = '(?:吧|呗|啊|呀|哈|了|哦|嘛)?[。．.!！?？]*$'

const REPLY_MARKERS: readonly RegExp[] = [
  /^(?:嗯|好|那|就|还是|都|全部)*\s*(?:可以|好的|确认|同意|是的|没问题|就这样|ok|OK)/,
  // A one-character assent needs a boundary after it: "对比一下" is not "对", nor "行数" an "行".
  /^(?:嗯|好|那|就|\s)*(?:行|好|对)(?=$|[\s，,。．.!！?？]|(?:吧|呗|啊|呀|哈|了|哦|嘛))/,
  /^(?:就|那|还是|都|全部)*\s*选\s*[A-Za-z0-9一二三四五六七八九十]/,
  new RegExp(`^[A-Za-z0-9一二三四五六七八九十]+(?:\\s*[+＋]\\s*[A-Za-z0-9一二三四五六七八九十]+)+${TRAILING_PARTICLE}`),
]

/** An answer with nothing else in it: with no question to attach, it says nothing at all. */
const BARE_ANSWER = new RegExp(
  `^(?:嗯|好|那|就|\\s)*(?:可以|行|好的|好|确认|同意|对|是的|没问题|就这样|ok)${TRAILING_PARTICLE}`,
  'i',
)

/** Sentences that ask, however they are punctuated: a question is not a decision, even when it names one. */
const ASKING_OPEN = /^(?:要不要|能不能|可不可以|是不是|有没有|行不行|会不会|为什么|为啥|怎么|如何|哪里|哪个|是否)/
const ASKING_END = /(?:吗|呢|么|是吧|对吧|好不好|行不行|可不可以|是不是)[。．.!！?？]*$/
/**
 * An asking phrase anywhere: "按钮要不要改成蓝色？" offers a choice, it does not
 * settle one. A trailing 吗 or 呢 asks too, even when the line has no question mark.
 */
const ASKING_ANYWHERE = /(?:要不要|能不能|可不可以|是不是|有没有|行不行|会不会)|(?:吗|呢)(?=$|[了。．.!！?？\s])/

/** A sentence ends at any of these; the mark is kept so a question stays recognisable. */
const SENTENCE_MARKS = '。．！？!?；;\n'

const sentencesOf = (text: string): string[] => {
  const out: string[] = []
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    if (!SENTENCE_MARKS.includes(text[index])) continue
    out.push(text.slice(start, index + 1))
    start = index + 1
  }
  if (start < text.length) out.push(text.slice(start))

  return out.map(sentence => sentence.trim()).filter(sentence => sentence !== '')
}

/**
 * A document the person pasted for review is not the person speaking: the engine
 * wraps it in its own tag, and a report is full of "保留", "统一" and "默认" that
 * settled nothing. The words after the paste are still theirs.
 */
const PASTED_BLOCK = /<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content>/g
const PASTED_UNCLOSED = /<pasted_content\b[^>]*>[\s\S]*$/

const stripPasted = (text: string): string => text.replace(PASTED_BLOCK, '\n').replace(PASTED_UNCLOSED, '\n')

/** A heading or a table row is document furniture, never a sentence a person decided in. */
const DOCUMENT_LINE = /^(?:#{1,6}\s|\|)/

/** A list marker is formatting, not words: "- 不要用 npm" decides the same thing "不要用 npm" does. */
const LIST_PREFIX = /^(?:[-*+]|\d+[.)])\s+/

/** The same sentence said twice is one decision: whitespace and the closing mark do not make it new. */
const dedupeKey = (text: string): string =>
  text.replace(/\s+/g, '').replace(/[。．.!！?？,，、；;：:…]+$/g, '')

const clipDecision = (text: string, seq: number): string =>
  text.length > MAX_DECISION_CHARS
    ? `${text.slice(0, MAX_DECISION_CHARS)}……（原文更长，用 history 读 #${seq}）`
    : text

const clipAnswered = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length <= ANSWERED_HEAD_CHARS + ANSWERED_TAIL_CHARS
    ? flat
    : `${flat.slice(0, ANSWERED_HEAD_CHARS)} …… ${flat.slice(flat.length - ANSWERED_TAIL_CHARS)}`
}

/** Whether the sentence is a question, whatever markers it happens to carry. */
const isQuestion = (sentence: string): boolean =>
  ASKING_OPEN.test(sentence) ||
  ASKING_END.test(sentence) ||
  ASKING_ANYWHERE.test(sentence) ||
  (/[？?]\s*$/.test(sentence) && !CONSTRAINT_MARKERS.some(marker => marker.test(sentence)))

/**
 * The sentence as a decision, or nothing when it states none. A constraint stands
 * on its own; an answer is kept only with the reply it answered, or when it also
 * carries a constraint of its own (a bare "可以" with no question is dropped).
 */
const decisionOf = (
  sentence: string,
  reply: HistoryRecord | undefined,
): { text: string; answered?: HistoryRecord } | undefined => {
  const text = sentence.trim().replace(LIST_PREFIX, '')
  const bare = text.replace(/[。．.!！?？,，、；;：:\s]/g, '')
  // Nothing but punctuation: not a sentence anyone decided anything in. One word
  // can still be the whole answer ("对"), so a single character stays when there
  // is a question it answers.
  if (bare.length === 0) return undefined
  if (bare.length < 2 && !(reply !== undefined && BARE_ANSWER.test(bare))) return undefined
  if (isQuestion(text)) return undefined
  if (DOCUMENT_LINE.test(text)) return undefined
  const constrained = CONSTRAINT_MARKERS.some(marker => marker.test(text))
  const answered = REPLY_MARKERS.some(marker => marker.test(text)) && text.length <= REPLY_MAX_CHARS
  if (!constrained && !answered) return undefined
  if (!constrained && reply === undefined) {
    if (BARE_ANSWER.test(text.replace(/[。．.!！?？,，、；;：:\s]+$/g, ''))) return undefined
  }

  return answered && reply !== undefined ? { text, answered: reply } : { text }
}

/**
 * Every decision the person stated, across every window, oldest first. Only rows
 * the engine marked as the person's own count, so a relay, a delivery or a
 * notification never becomes a decision; the engine's injected reminder blocks
 * are stripped before the words are read.
 *
 * `revoked` holds the history seqs the person took back (see `DecisionRevoke`):
 * what they withdrew is left out of the section, though history keeps it.
 */
export const extractDecisions = (
  rows: readonly HistoryRecord[],
  revoked: ReadonlySet<number> = new Set(),
): Decision[] => {
  const ordered = [...rows].sort((left, right) => left.seq - right.seq)
  const people = ordered.filter(row => row.isPerson === true)
  const answered = repliesAnswered(ordered, people)
  const byKey = new Map<string, Decision>()
  for (const row of people) {
    if (revoked.has(row.seq)) continue
    const text = stripPasted(stripInjected(row.text))
    if (text.trim() === '') continue
    let taken = 0
    for (const sentence of sentencesOf(text)) {
      if (taken >= MAX_PER_MESSAGE) break
      const decided = decisionOf(sentence, answered.get(row.seq))
      if (decided === undefined) continue
      taken += 1
      // Said twice, the later saying is the one that stands: it is also what a
      // repeat is for. Keeping it drops the earlier copy from the section.
      byKey.set(dedupeKey(decided.text), {
        seq: row.seq,
        ts: row.ts,
        window: row.window,
        text: clipDecision(decided.text, row.seq),
        ...(decided.answered === undefined ? {} : { answered: decided.answered }),
      })
    }
  }

  return [...byKey.values()].sort((left, right) => left.ts - right.ts || left.seq - right.seq)
}

const lineOf = (decision: Decision): string => {
  const head = `- [#${decision.seq}] ${new Date(decision.ts).toISOString()} ${decision.text}`

  return decision.answered === undefined
    ? head
    : `${head}\n  - 回复的是助手 [#${decision.answered.seq}]：${clipAnswered(decision.answered.text)}`
}

/**
 * The section a new window opens with, or nothing when the person settled nothing.
 * `maxChars` is a ceiling on the whole section: past it the oldest decisions are
 * dropped and one line says how many, since the newest are the ones still standing.
 * The newest decision always stays, even alone over budget.
 *
 * Decisions from `protectedFrom` on are never dropped for budget: the last two
 * windows are what the model was just doing, and a rule settled there is the one
 * most likely to be broken next. If they alone overrun the ceiling they still stay.
 */
export const renderDecisions = (
  decisions: readonly Decision[],
  maxChars: number,
  protectedFrom = Number.NEGATIVE_INFINITY,
): string => {
  if (decisions.length === 0) return ''
  const kept = [...decisions]
  const build = (): string => {
    const omitted = decisions.length - kept.length
    const lines = [
      '## 用户已定决策',
      '（用户在本会话里亲口定过的决定，跨全部窗口，原文照搬。后面的优先；与下面任务里的说法冲突时，以这里为准。用户改主意时用 decision_revoke 撤销旧条。）',
      ...kept.map(lineOf),
    ]
    if (omitted > 0) lines.push(`（已省略 ${omitted} 条较早的决策，用 history 按关键词搜索查看原文）`)

    return lines.join('\n')
  }
  while (kept.length > 1 && build().length > maxChars) {
    // Oldest first, and an unprotected one before any protected one: a rule from
    // the last two windows is only cut when those alone are over the ceiling.
    const unprotected = kept.findIndex(decision => decision.window < protectedFrom)
    kept.splice(unprotected >= 0 ? unprotected : 0, 1)
  }

  return build()
}
