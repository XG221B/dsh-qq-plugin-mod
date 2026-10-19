/**
 * 任务完成提醒的**纯逻辑**：什么算一条提醒、消息怎么拼、`/detail` 怎么显示。
 *
 * 这里不碰宿主、不碰 IO、不碰定时器——那些在 `runtime.js`。分开的理由和 `reply-limit.js`
 * 一样：**消息文本是测试能钉住的东西**，而"定时器有没有漏清理"是测试钉不住的东西。
 * 把能钉的钉死，剩下的才用真机验证。
 *
 * ## 为什么默认不带回答正文
 *
 * 用户的原话："发个消息说某某项目的某某对话已结束任务就行了，如果我没有追问就不需要
 * 展示具体的回答"。手机上，一条任务通知的价值是"可以去看一眼了"，而不是把一张几万字的
 * 答案再读一遍——正文只在他**要**的时候（`/detail`）才出现。
 *
 * ## 为什么多个完成要合并成一条
 *
 * QQ 单关系主动消息有频控（实测规则可达 20 条/分钟），而"两个会话同时跑完"是常态。
 * 一条消息里分行列出每个完成，既没有丢信息，也不会把手机震十下。合并窗口由 runtime 的
 * 定时器实现（{@link COMPLETION_MERGE_MS}），这里只负责把已经收齐的条目拼成文本。
 *
 * @module dsh-qq/completion-notify
 */
import { truncateTitle } from './router.js'

/** 多个完成事件合并成一条消息的窗口（毫秒）。 */
export const COMPLETION_MERGE_MS = 3_000

/** 合并消息里最多列多少个会话；其余的折叠成"等 N 个"。 */
export const COMPLETION_MAX_VISIBLE = 5

/** 内存里每条回答最多保留多少字（超出截断，防止长回答把内存撑大）。 */
export const COMPLETION_ANSWER_LIMIT = 16_000

/**
 * 一条完成事件的展示信息。
 *
 * @typedef {object} CompletionEntry
 * @property {string} sessionId - 会话 id（短 id 由它派生）。
 * @property {string} title - 会话标题；空串表示宿主还没起名。
 * @property {string} project - 项目/工作区名；空串表示没有可显示的项目。
 * @property {string} text - 这次回合的最终可见文本（可空）。
 * @property {number} at - 完成时刻（毫秒）。
 */

/** 标题为空时的代称。 */
const UNTITLED = '(无标题)'

/**
 * 一条完成事件的"项目 · 对话"标签。
 *
 * 没有项目名时只印标题，而不是印一个空的「 · 标题」。
 *
 * @param entry - 完成事件。
 * @returns 标签文本。
 */
export function completionLabel(entry) {
  const title = truncateTitle(entry?.title ?? '') || UNTITLED
  const project = typeof entry?.project === 'string' ? entry.project.trim() : ''
  return project === '' ? title : `${project} · ${title}`
}

/**
 * 把一批完成事件拼成一条 QQ 提醒。
 *
 * **只报状态，不加任何多余提示**——用户的原话："发个消息说某某项目的某某对话已结束任务
 * 就行了，不要有多余的提示"。所以这里不附回答摘要、不附 `/detail` 用法、不附编号；
 * 想看那次说了什么，他自己发 `/detail` 即可。
 *
 * @param entries - 合并窗口内收齐的完成事件，按完成先后。
 * @param options.maxVisible - 最多列几条，默认 {@link COMPLETION_MAX_VISIBLE}。
 * @returns 消息文本；`entries` 为空时返回空串（调用方据此不发）。
 */
export function composeCompletionNotice(entries, options = {}) {
  const list = Array.isArray(entries) ? entries.filter((entry) => entry !== undefined) : []
  if (list.length === 0) return ''
  const maxVisible = Math.max(1, options.maxVisible ?? COMPLETION_MAX_VISIBLE)

  if (list.length === 1) {
    return `「${completionLabel(list[0])}」已结束任务`
  }

  const lines = [`${String(list.length)} 个对话已结束任务：`]
  for (const entry of list.slice(0, maxVisible)) {
    lines.push(`· ${completionLabel(entry)}`)
  }
  if (list.length > maxVisible) lines.push(`…等 ${String(list.length)} 个`)
  return lines.join('\n')
}

/**
 * 把一条缓存回答截到设置的显示上限。
 *
 * `0` = 不限制（与 `maxReplyChars` / `completionDetailChars` 的语义一致）。
 *
 * @param text - 原始回答。
 * @param maxChars - 上限；`0` 表示不限制。
 * @returns 用于 QQ 的正文。
 */
export function truncateAnswer(text, maxChars) {
  const value = typeof text === 'string' ? text : ''
  if (maxChars === undefined || maxChars === null || maxChars <= 0) return value
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n\n…（还有 ${String(value.length - maxChars)} 字，完整回答在电脑上的 DSH 里）`
}

/**
 * "有对话正在等你回答"的提醒文本。
 *
 * **只有状态，没有问题摘要**——用户的原话："不需要问题简介，只需要提醒就行了"。
 * 提醒的职责是让他知道"有东西在等我"，不是替他把问题读一遍；问题本身回电脑上看。
 *
 * @param options.title - 会话标题。
 * @param options.project - 项目名。
 * @param options.kind - `'approval'` 或 `'question'`。
 * @returns 消息文本。
 */
export function composeWaitingNotice({ title, project, kind }) {
  const label = completionLabel({ title, project })
  const action = kind === 'approval' ? '在等你确认操作' : '在等你回答'
  return `「${label}」${action}`
}

/**
 * `/detail` 的回复文本。
 *
 * 只有标题与回答本身；截断时尾巴也只是一句"后略"，不附任何操作提示。
 *
 * @param entry - 缓存条目（可能来自内存缓存的第一条或用户点名的短 id）。
 * @param maxChars - 显示上限。
 * @returns 回复正文。
 */
export function formatDetailReply(entry, maxChars) {
  const header = `「${completionLabel(entry)}」的最后回答：`
  const body = truncateAnswer(entry?.text ?? '', maxChars).trim()
  return [header, '', body === '' ? '（这次没有文字回答）' : body].join('\n')
}
