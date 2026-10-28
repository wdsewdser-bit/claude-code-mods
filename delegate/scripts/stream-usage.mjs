// 运行中的“输出”用量：上游网关只在 stream_event 的 message_start / message_delta 里给 usage，
// 每条 assistant 行的 message.usage.output_tokens 恒为 0，整次运行的真实总数只在最后的 result 行
// （result.usage.output_tokens）。所以运行中的输出只能从半成品事件里数出来。
//
// 口径：message_start 起一条新消息，message_delta 给的是这条消息的累计值（取最大，不重复相加），
// 整次运行 = 已结束消息之和 + 当前这条；result 到来时用它的总数覆盖。

const num = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

export const createOutputTracker = () => {
  let done = 0 // 已经结束的消息累计输出
  let current = 0 // 当前这条消息的累计输出
  let total = 0 // 对外给出的整次运行输出（只增不减）
  // 最近一次请求的真实输入（含缓存）。message_start 里的 input 是 CPA 预估的（把历史 thinking 也算进去、
  // 中文还多估约 1.4 倍），只有 message_delta 带上游回报的真数。
  let context = 0

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
    /** 吃一条 stream_event.event，返回最新的整次运行输出。 */
    onEvent(event) {
      const type = typeof event?.type === 'string' ? event.type : ''
      if (type === 'message_start') {
        done += current
        current = num(event?.message?.usage?.output_tokens ?? event?.usage?.output_tokens)

        return raise(done + current)
      }
      if (type === 'message_delta') {
        const u = event?.usage
        const input = num(u?.input_tokens) + num(u?.cache_read_input_tokens) + num(u?.cache_creation_input_tokens)
        if (input > 0) context = input
        const v = num(u?.output_tokens)
        if (v > current) current = v

        return raise(done + current)
      }

      return total
    },
    /** result 行的 usage：真实总数，直接覆盖（没有可用数字时保留已数到的值）。 */
    final(usage) {
      const v = num(usage?.output_tokens)
      if (v === 0) return total
      done = v
      current = 0

      return raise(v)
    },
  }
}
