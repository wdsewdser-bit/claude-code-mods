// 运行中的“输出”用量：上游网关只在 stream_event 的 message_start / message_delta 里给 usage，
// 每条 assistant 行的 message.usage.output_tokens 恒为 0，整次运行的真实总数只在最后的 result 行
// （result.usage.output_tokens）。所以运行中的输出只能从半成品事件里数出来。
//
// 口径：message_start 起一条新消息，message_delta 给的是这条消息的累计值（取最大，不重复相加），
// 整次运行 = 已结束消息之和 + 当前这条；result 到来时用它的总数覆盖。
//
// 输入同理按“每条请求一次”累加：每日 token 上限算的是整次运行里每次请求的 input + 缓存读 + 缓存写
// （每条 message_delta 给的是这条消息自己的真数，不能拿最后一次请求代表整次运行）。

const num = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

export const createOutputTracker = () => {
  let done = 0 // 已经结束的消息累计输出
  let current = 0 // 当前这条消息的累计输出
  let total = 0 // 对外给出的整次运行输出（只增不减）
  // 最近一次请求的真实输入（含缓存）。message_start 里的 input 是 CPA 预估的（把历史 thinking 也算进去、
  // 中文还多估约 1.4 倍），只有 message_delta 带上游回报的真数。
  let context = 0
  // 整次运行的输入分项：同样按消息累加，同一条消息里取最大（message_delta 是累计值，不是增量）。
  let inDone = 0
  let crDone = 0
  let cwDone = 0
  let inCur = 0
  let crCur = 0
  let cwCur = 0
  let sawInput = false
  // overwrite：message_delta 是这条消息的真数，message_start 里的是 CPA 预估（偏大），有真数就覆盖。
  const take = (usage, overwrite) => {
    const input = num(usage?.input_tokens)
    const read = num(usage?.cache_read_input_tokens)
    const write = num(usage?.cache_creation_input_tokens)
    const put = (value, cur) => (overwrite && value > 0 ? value : Math.max(cur, value))
    inCur = put(input, inCur)
    crCur = put(read, crCur)
    cwCur = put(write, cwCur)
    if (input > 0 || read > 0 || write > 0) sawInput = true
  }
  const flush = () => {
    inDone += inCur
    crDone += crCur
    cwDone += cwCur
    inCur = 0
    crCur = 0
    cwCur = 0
  }

  const raise = n => {
    if (n > total) total = n

    return total
  }

  return {
    /** 已经数到的整次运行输出。 */
    get total() {
      return total
    },
    /** 最近一次请求的真实输入 token（没收到 message_delta 时为 0）。 */
    get context() {
      return context
    },
    /** 整次运行的输入分项 + 输出；供应商一次都没给输入时三项为 0。 */
    get parts() {
      return {
        input: inDone + inCur,
        cacheRead: crDone + crCur,
        cacheWrite: cwDone + cwCur,
        output: total,
      }
    },
    /** 吃一条 stream_event.event，返回最新的整次运行输出。 */
    onEvent(event) {
      const type = typeof event?.type === 'string' ? event.type : ''
      if (type === 'message_start') {
        done += current
        flush()
        current = num(event?.message?.usage?.output_tokens ?? event?.usage?.output_tokens)
        take(event?.message?.usage ?? event?.usage, false)

        return raise(done + current)
      }
      if (type === 'message_delta') {
        const u = event?.usage
        const input = num(u?.input_tokens) + num(u?.cache_read_input_tokens) + num(u?.cache_creation_input_tokens)
        if (input > 0) context = input
        take(u, true)
        const v = num(u?.output_tokens)
        if (v > current) current = v

        return raise(done + current)
      }

      return total
    },
    /** result 行的 usage：真实总数，直接覆盖（没有可用数字时保留已数到的值）。 */
    final(usage) {
      // 半成品事件一次都没带输入（旧 CLI / 网关不报）时，退回 result 行的输入：它只代表最后一次请求，
      // 但总比把整次运行记成 0 强；有流里的分项就绝不覆盖，免得把最后一次当总数。
      if (!sawInput) {
        const input = num(usage?.input_tokens)
        const read = num(usage?.cache_read_input_tokens)
        const write = num(usage?.cache_creation_input_tokens)
        if (input > 0 || read > 0 || write > 0) {
          inDone = input
          crDone = read
          cwDone = write
          inCur = 0
          crCur = 0
          cwCur = 0
          sawInput = true
        }
      }
      const v = num(usage?.output_tokens)
      if (v === 0) return total
      done = v
      current = 0

      return raise(v)
    },
  }
}
