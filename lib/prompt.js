/**
 * 把一条入站 QQ 消息拼成给 agent 的提示词。
 *
 * 抽成纯函数是为了**可测**：这段决定"agent 到底看到了什么"，
 * 而它是整条链路上最该被钉住的行为——拼错不会报错，只会让 agent 答非所问。
 *
 * @module dsh-qq/prompt
 */

/**
 * @param message - SDK 归一化后的入站消息。
 * @returns 提示词文本（可能为空串，调用方据此丢弃该消息）。
 */
export function composePrompt(message) {
  const parts = []

  // 引用：只有当 `msg_elements` 里确实带着被引内容时才加，避免产生空壳「[引用]」。
  const quoted = quotedText(message)
  if (quoted !== undefined) parts.push(`[引用] ${quoted}`)

  const text = typeof message?.content === 'string' ? message.content.trim() : ''
  if (text !== '') parts.push(text)

  for (const attachment of message?.attachments ?? []) {
    // 语音优先用服务端转写——QQ 自带 ASR，因此**不需要 SILK 解码**。
    const voiceText = attachment?.asr_refer_text
    if (typeof voiceText === 'string' && voiceText.trim() !== '') {
      parts.push(`[语音转写] ${voiceText.trim()}`)
      continue
    }
    const label = attachment?.filename ?? attachment?.content_type ?? '附件'
    const url = typeof attachment?.url === 'string' ? attachment.url : ''
    parts.push(`[附件 ${label}] ${url}`.trim())
  }
  return parts.join('\n')
}

/**
 * 从入站消息里取出被引用消息的内容。
 *
 * QQ 的形态：`msg_elements[]` 里某一条的 `msg_idx` 等于本消息的 `refMsgIdx`，
 * 那条的 `content` 就是被引正文。
 *
 * **逐项核对而不是直接取 `[0]`**：拿错一条会把"用户在回复什么"讲反，
 * 而那比完全没有引用更糟。
 *
 * 这是相对微信的一处白送：iLink 的 `ref_msg` 只有 `type:0 + msg_id`，
 * 微信插件为此自建了一套引用缓存，而 QQ 协议直接给了正文。
 *
 * @param message - SDK 归一化后的入站消息。
 * @returns 被引内容，或 `undefined`。
 */
export function quotedText(message) {
  const refIdx = message?.refMsgIdx
  if (typeof refIdx !== 'string' || refIdx === '') return undefined
  const elements = Array.isArray(message?.msgElements) ? message.msgElements : []
  for (const element of elements) {
    if (element?.msg_idx !== refIdx) continue
    const content = typeof element.content === 'string' ? element.content.trim() : ''
    if (content !== '') return content
    // 引用的是纯媒体消息：没有正文，把附件类型说出来也比什么都不说强。
    const kinds = (element.attachments ?? [])
      .map((item) => item?.content_type)
      .filter((kind) => typeof kind === 'string' && kind !== '')
    if (kinds.length > 0) return `（引用了${kinds.join('、')}）`
    return undefined
  }
  return undefined
}
