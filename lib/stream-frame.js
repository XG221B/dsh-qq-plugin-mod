/**
 * 从 `agent/assistant-stream` 的载荷里读出「哪个会话、这段可见文本、回合是否结束」。
 *
 * 直接移植自 dsh-wechat-plugin 的 `lib/services.js`（同版本、已在生产验证）。保留它的全部
 * 谨慎之处，因为这类代码**写错是静默失败**——字段名对不上，回复就凭空消失，任何地方都不报错。
 *
 * 两条最容易搞错的语义：
 *
 * 1. **只有 `frame.type === 'end'` 才算回合结束。** `finish` 每完成一个模型步骤就发一次，
 *    一个带工具调用的回合会有好几个 `finish`；拿它当结束会把一个答案拆成好几条 QQ 消息。
 * 2. `reasoning-delta` / `usage` / `block-*` 都不是用户可见文本，不能拼进回复。
 *
 * @module dsh-qq/stream-frame
 */

/**
 * @typedef {object} StreamFrame
 * @property {string} [sessionId] - 该帧属于哪个会话。
 * @property {string} [text] - 本帧新增的可见文本。
 * @property {boolean} [completed] - 回合是否结束。
 * @property {{id: string, name: string}} [toolCall] - 识别出的工具调用。
 * @property {string} [toolCallShape] - 未识别形态的字段列表（仅供观测）。
 * @property {string} [chunkType] - 本帧的 chunk type（仅供观测）。
 * @property {string} [frameShape] - 未知帧形态（仅供观测）。
 * @property {string} [blockShape] - 块边界的字段列表（仅供观测）。
 */

/**
 * @param {unknown} payload - `agent/assistant-stream` 的载荷。
 * @returns {StreamFrame}
 */
export function readStreamFrame(payload) {
  const record = asRecord(payload)
  const rawId = asRecord(asRecord(record?.agent)?.session)?.id
  const sessionId = typeof rawId === 'string' ? rawId : undefined
  const withId = sessionId === undefined ? {} : { sessionId }

  const frame = asRecord(record?.frame)
  if (frame === undefined) return withId

  // end 帧没有 chunk，它是唯一的回合结束信号。
  if (frame.type === 'end') return { ...withId, completed: true }

  const chunk = asRecord(frame.chunk)
  if (chunk === undefined) {
    // 没有 chunk 的帧不是这个解析器认识的形态。把帧的种类记下来，这是"宿主到底发了什么"
    // 唯一的观测途径——未观测到的假设无法与错误的假设区分开。
    return { ...withId, frameShape: `frame:${Object.keys(frame).join(',')};type=${String(frame.type)}` }
  }

  const observed = { ...withId, chunkType: String(chunk.type) }

  switch (chunk.type) {
    case 'text-delta':
      // 模型真正的输出。
      return typeof chunk.text === 'string' ? { ...withId, text: chunk.text, ...observed } : observed

    case 'tool-call-delta': {
      // 观测事实：这个帧带 `type,index,id,argumentsDelta`，**不带工具名**。
      const id = typeof chunk.id === 'string' ? chunk.id : undefined
      const name = typeof chunk.name === 'string' ? chunk.name : undefined
      if (id === undefined || name === undefined || name === '') {
        return { ...withId, toolCallShape: Object.keys(chunk).join(','), ...observed }
      }
      return { ...withId, toolCall: { id, name }, ...observed }
    }

    case 'block-start':
    case 'block-end':
      // 工具块的起始帧才是工具名的可能载体（delta 帧只有 id 和参数片段）。
      return { ...withId, blockShape: `${String(chunk.type)}:${Object.keys(chunk).join(',')}`, ...observed }

    default:
      // reasoning-delta / block-start / block-end / usage / finish，以及将来新增的类型：
      // 都不是用户可见文本。见文件头第 1 条——`finish` 刻意不算结束信号。
      return observed
  }
}

function asRecord(value) {
  if (typeof value !== 'object' || value === null) return undefined
  return value
}
