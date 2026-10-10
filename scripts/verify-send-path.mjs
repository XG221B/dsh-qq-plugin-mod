/**
 * 发送路径自检：用**假 SDK** 真跑一遍 `QqRuntime` 的发送路径。
 *
 * 为什么必须有这个文件：`#send` 那条路径上有三件安全攸关的事——被动→主动降级、
 * `ReplyLimiter` 限流、超长分块。它们只在"真的调用 `bot.sendText`"时才执行，
 * 所以纯函数级自检（`verify.mjs`）碰不到。这个文件是那条路径**唯一**的测试。
 *
 * ## 假 SDK 怎么进去的
 *
 * 用 `node:module` 的 `register()` 装一个 `resolve` 钩子，把
 * `@tencent-connect/qqbot-nodejs` 映射到内联的假实现。**`node_modules` 一个字节都不动**：
 * 这个仓库以前的做法是改写 `node_modules` 里的 `dist/index.js` 再还原，
 * 那东西一旦还原失败就会把用户装好的插件弄坏。
 *
 * `@tencent-connect/qqbot-nodejs/protocol` **不伪造**，仍然加载真包——
 * 这一测的正是 `ReplyLimiter` 与 `chunkText` 的真实行为。
 *
 * ## 入口的选择
 *
 * 大部分场景从 `push()` 进（它直接转发给 `#send`）。但 `push()` 丢掉返回值，
 * 而"返回 true/false"是安全语义（待发队列靠它决定入不入队），所以返回值那几条
 * 改从 `notifyFromTool()`（`notify_qq`）进——那是 `#deliverOrQueue` 这一条真实消费路径，
 * "文本已发送"与"文本已排队"就是 `#send` 的 true/false。
 *
 * 用法：node scripts/verify-send-path.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

let failures = 0

/** 断言相等。 */
function check(label, actual, expected) {
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  期望 ${String(expected)}，实际 ${String(actual)}`}`)
}

/** 断言为真（用于 `includes` 这类谓词）。 */
function checkThat(label, actual) {
  check(label, actual === true, true)
}

function show(label, value) {
  console.log(`      ${label}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
}

// ---------------------------------------------------------------- 假 SDK 注入

/**
 * 假 `QQBot`。`sendText` 的每一次尝试逐次记进 `attempts`；成功的同时进 `sent`。
 * 拒绝与否由构造后的 `plan` 决定（默认全放行）。
 *
 * 每个实例都进 `instances`，因为**运行时的 bot 是它自己 new 的**（`start()` 里
 * `new QQBot(...)`），外部塞不进去——测试只能从这份名册里把运行时那一个领回来。
 *
 * `start()` 返回一个立刻兑现的 Promise 并**结束**，不是永不兑现的：
 * 运行时那边是 `void bot.start().catch(...)`，挂着一个永不落定的 Promise
 * 会让这个测试进程永远不退出（也不报错，只是挂着）。
 */
const FAKE_SDK_SOURCE = `
import { EventEmitter } from 'node:events'

export const instances = []

export class QQBot extends EventEmitter {
  constructor() {
    super()
    this.sent = []
    this.attempts = []
    this.plan = () => ({ ok: true })
    instances.push(this)
  }

  async start() {}

  stop() {}

  async sendText(target, content) {
    // 记的是**值**，不是引用：里面那个 target 对象可能在别处被复用。
    const attempt = {
      target: { scope: target?.scope, targetId: target?.targetId, msgId: target?.msgId },
      text: content,
    }
    this.attempts.push(attempt)
    const verdict = this.plan(attempt, this.attempts.length)
    if (verdict.ok) {
      this.sent.push(attempt)
      return { ok: true }
    }
    throw new Error(verdict.why ?? '假 SDK 拒绝发送')
  }
}
`

// 真 protocol 的入口。这里拿到的是**官方那个文件**：钩子只拦截裸包名，
// 不碰它，所以原样交给 Node 加载——`ReplyLimiter` / `chunkText` 用的都是真货。
// 不能用 `createRequire().resolve()` 取：那个包只声明了 `import` 条件，CJS 条件解不开它。
const PROTOCOL_URL = import.meta.resolve('@tencent-connect/qqbot-nodejs/protocol')
const FAKE_SDK_URL = `data:text/javascript;base64,${Buffer.from(FAKE_SDK_SOURCE, 'utf8').toString('base64')}`

const HOOK_SOURCE = `
const FAKE = ${JSON.stringify(FAKE_SDK_URL)}
const PROTOCOL = ${JSON.stringify(PROTOCOL_URL)}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@tencent-connect/qqbot-nodejs') {
    return { url: FAKE, shortCircuit: true }
  }
  if (specifier === '@tencent-connect/qqbot-nodejs/protocol') {
    return { url: PROTOCOL, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
`

register(
  `data:text/javascript;base64,${Buffer.from(HOOK_SOURCE, 'utf8').toString('base64')}`,
  pathToFileURL(`${process.cwd()}/`),
)

const { QQBot: FakeQQBot, instances } = await import('@tencent-connect/qqbot-nodejs')
const protocol = await import('@tencent-connect/qqbot-nodejs/protocol')
const { TEXT_CHUNK_LIMIT } = protocol
const { conversationKey } = await import('../lib/state.js')

checkThat(
  '注入生效：QQBot 换成了假实现',
  FakeQQBot.name === 'QQBot' && typeof FakeQQBot.prototype.sendText === 'function' && Array.isArray(instances),
)
check('protocol 仍走真包', typeof TEXT_CHUNK_LIMIT, 'number')
show('TEXT_CHUNK_LIMIT', TEXT_CHUNK_LIMIT)

// ---------------------------------------------------------------- 测试脚手架

/** 宿主上下文：只提供工具服务与权限预设目录，其余服务缺失应当被容忍。 */
const services = {
  tools: { register: () => () => {} },
  permissionPresets: { names: ['workspace-write', 'danger-full-access', 'auto'] },
}
const ctx = { get: (name) => services[name] }

const APP_ID = '1905760478'
const credentials = {
  available: true,
  save: async () => ({}),
  load: async () => ({ appId: APP_ID, appSecret: 'fake-secret' }),
  remove: async () => {},
  describe: async () => ({ configured: true }),
}

/**
 * 起一个**全新的**运行时，并连上一个假 bot。
 *
 * 每个场景一个实例：`ReplyLimiter` 是实例状态，共用实例会让上一个场景攒下的
 * 计数泄漏到下一个（第 7 条正是靠这个计数攒满 4 次）。
 *
 * @param options.peerId - 预先写进状态文件的绑定；`undefined` 表示没有绑定。
 * @param options.connected - `false` 表示不调用 `start()`，即"未连接"。
 */
async function newRuntime({ peerId, connected = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-send-path-'))
  const { QqRuntime } = await import('../lib/runtime.js')

  const bindings = {}
  if (peerId !== undefined) {
    const conversationId = conversationKey(APP_ID, peerId)
    bindings[conversationId] = {
      conversationId,
      accountId: APP_ID,
      peerId,
      sessionId: 'session-send-path',
      title: 'qq',
      lastUsedAt: Date.now(),
    }
  }
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      version: 1,
      accounts: { [APP_ID]: { appId: APP_ID, enabled: true } },
      bindings,
      autoStart: true,
    }),
    'utf8',
  )

  const runtime = new QqRuntime(ctx, {
    home: dir,
    stateFile: join(dir, 'state.json'),
    workspace: join(dir, 'dsh_qq'),
    credentials,
  })
  if (!connected) return { runtime, dir, bot: undefined, conversationId: conversationKey(APP_ID, peerId ?? '') }

  // 运行时的 bot 是 `start()` 内部 new 出来的，所以从名册里领运行时刚造的那一个。
  const before = instances.length
  await runtime.start(APP_ID)
  checkThat('脚手架：假 bot 已挂上运行时', runtime.connected === true)
  check('脚手架：运行时恰好新造了一个假 bot', instances.length, before + 1)
  const bot = instances[instances.length - 1]
  return { runtime, dir, bot, conversationId: conversationKey(APP_ID, peerId ?? '') }
}

/**
 * 让运行时"见过"一条入站消息，于是它记住了这个对话的 `msgId`。
 *
 * 走的是运行时真正的入站入口（`bot.on('message')`），不是内部字段——测的才是真实链路。
 * 正文故意留空：`#handleInbound` 记下 `msgId` 后会提前返回，不碰 DSH 会话，
 * 于是这里只覆盖发送路径本身。
 */
async function seeInbound(bot, { peerId, msgId }) {
  bot.emit('message', {}, { kind: 'c2c', messageId: msgId, senderId: peerId, content: '', attachments: [] })
  // `#handleInbound` 记下 msgId 之前有若干 `await`，让出一拍等它落定。
  await new Promise((resolve) => setTimeout(resolve, 20))
}

/** 最近若干条错误里有没有含这段文字的。 */
async function errorMatches(runtime, needle) {
  const errors = (await runtime.status()).errors
  return errors.some((line) => line.includes(needle))
}

// ---------------------------------------------------------------- 1. 被动窗口内

{
  const { runtime, dir, bot, conversationId } = await newRuntime({ peerId: 'PEER_A' })
  try {
    await seeInbound(bot, { peerId: 'PEER_A', msgId: 'MSG-1' })

    // 返回值那一半：`notify_qq` 走的正是"看 #send 的返回值决定入不入队"。
    const outcome = await runtime.notifyFromTool({ text: '窗口内的回复' }, { agent: { session: { id: 'session-send-path' } } })
    checkThat('1. 窗口内：报"文本已发送"（#send 返回 true）', outcome.includes('文本已发送'))

    check('1. 只调了一次 sendText', bot.sent.length, 1)
    check('1. target 带 msgId', bot.sent[0]?.target.msgId, 'MSG-1')
    check('1. target 指向对方', bot.sent[0]?.target.targetId, 'PEER_A')
    check('1. scope 是 c2c', bot.sent[0]?.target.scope, 'c2c')
    check('1. 文本原样送达', bot.sent[0]?.text, '窗口内的回复')
    check('1. 没有错误', (await runtime.status()).errors.length, 0)
    show('1. 对话键', conversationId)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- 2. 被动失败 → 主动兜底

{
  const { runtime, dir, bot } = await newRuntime({ peerId: 'PEER_B' })
  try {
    await seeInbound(bot, { peerId: 'PEER_B', msgId: 'MSG-2' })
    // 带 msgId 的那次被拒（窗口过期的真实形态），不带 msgId 的放行。
    bot.plan = (attempt) => (attempt.target.msgId === undefined ? { ok: true } : { ok: false, why: '窗口已过期' })

    const outcome = await runtime.notifyFromTool({ text: '兜底推送' }, { agent: { session: { id: 'session-send-path' } } })
    checkThat('2. 兜底成功后报"文本已发送"（#send 返回 true）', outcome.includes('文本已发送'))
    check('2. 试了两次', bot.attempts.length, 2)
    check('2. 第一次带 msgId', bot.attempts[0]?.target.msgId, 'MSG-2')
    check('2. 第二次不带 msgId', bot.attempts[1]?.target.msgId, undefined)
    check('2. 第二次仍是 c2c', bot.attempts[1]?.target.scope, 'c2c')
    check('2. 第二次仍打到同一个人', bot.attempts[1]?.target.targetId, 'PEER_B')
    check('2. 只有主动那次算成功', bot.sent.length, 1)
    check('2. 兜底时两块文本一致', bot.attempts[0]?.text, bot.attempts[1]?.text)
    check('2. 兜底成功不留下"发送失败"', await errorMatches(runtime, '发送失败'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- 3. 两条路都失败

{
  const { runtime, dir, bot } = await newRuntime({ peerId: 'PEER_C' })
  try {
    await seeInbound(bot, { peerId: 'PEER_C', msgId: 'MSG-3' })
    bot.plan = () => ({ ok: false, why: '平台拒绝' })

    let threw
    let outcome
    try {
      outcome = await runtime.notifyFromTool({ text: '发不出去' }, { agent: { session: { id: 'session-send-path' } } })
    } catch (error) {
      threw = error
    }
    check('3. 没有抛出', threw, undefined)
    checkThat('3. 转成"已排队"（#send 返回 false）', String(outcome).includes('文本已排队'))
    check('3. 两次都试过了', bot.attempts.length, 2)
    check('3. 成功零条', bot.sent.length, 0)
    // `describeError` 的形态是 `<name>: <message>`，所以这里连 `Error:` 一起对。
    checkThat('3. 错误里记下被动那次', await errorMatches(runtime, '发送失败: Error: 平台拒绝'))
    checkThat('3. 错误里记下主动那次', await errorMatches(runtime, '主动推送也失败: Error: 平台拒绝'))
    show('3. status().errors', (await runtime.status()).errors)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- 4. 超长文本分块

{
  const { runtime, dir, bot } = await newRuntime({ peerId: 'PEER_D' })
  try {
    await seeInbound(bot, { peerId: 'PEER_D', msgId: 'MSG-4' })
    const long = 'a'.repeat(TEXT_CHUNK_LIMIT * 2 + 10)

    await runtime.push(conversationKey(APP_ID, 'PEER_D'), long)
    check('4. 切成 3 块', bot.sent.length, 3)
    check('4. 第一块正好是上限', bot.sent[0]?.text.length, TEXT_CHUNK_LIMIT)
    check('4. 第二块正好是上限', bot.sent[1]?.text.length, TEXT_CHUNK_LIMIT)
    check('4. 第三块是余数', bot.sent[2]?.text.length, 10)
    check('4. 每块都带上同一条 msgId', bot.sent.every((one) => one.target.msgId === 'MSG-4'), true)
    check('4. 拼回来不丢字符', bot.sent.map((one) => one.text).join('').length, long.length)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- 5. bot 未连接

{
  const { runtime, dir } = await newRuntime({ peerId: 'PEER_E', connected: false })
  try {
    let threw
    try {
      await runtime.push(conversationKey(APP_ID, 'PEER_E'), '没连上')
    } catch (error) {
      threw = error
    }
    check('5. 没有抛出', threw, undefined)
    check('5. 确实没连上', runtime.connected, false)
    checkThat('5. 记下"未连接 QQ"', await errorMatches(runtime, '未连接 QQ，消息丢弃'))
    // 返回值那一半：未连接时待发队列必须接管，否则这条消息就凭空消失了。
    const outcome = await runtime.notifyFromTool({ text: '没连上' }, { agent: { session: { id: 'session-send-path' } } })
    checkThat('5. 转成"已排队"（#send 返回 false）', String(outcome).includes('文本已排队'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- 6. 找不到 peerId

{
  const { runtime, dir, bot } = await newRuntime({ peerId: 'PEER_F' })
  try {
    // 对话键只有一段：既没有入站记录可取，也切不出第二段。
    let threw
    try {
      await runtime.push(APP_ID, '没有收件人')
    } catch (error) {
      threw = error
    }
    check('6. 没有抛出', threw, undefined)
    check('6. 一条都没发出去', bot.attempts.length, 0)
    checkThat('6. 记下"找不到对话的 peerId"', await errorMatches(runtime, '找不到对话的 peerId'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- 7. ReplyLimiter 用尽

{
  const { runtime, dir, bot } = await newRuntime({ peerId: 'PEER_G' })
  try {
    await seeInbound(bot, { peerId: 'PEER_G', msgId: 'MSG-7' })

    // 同一条 msgId 前 4 次走被动，第 5 次必须由 ReplyLimiter 判定降级为主动。
    for (let i = 0; i < 5; i += 1) {
      const outcome = await runtime.notifyFromTool(
        { text: `第 ${String(i + 1)} 条` },
        { agent: { session: { id: 'session-send-path' } } },
      )
      checkThat(`7. 第 ${String(i + 1)} 条报"文本已发送"`, outcome.includes('文本已发送'))
    }

    const msgIds = bot.sent.map((one) => one.target.msgId)
    check('7. 5 次都发出去了', bot.sent.length, 5)
    check('7. 前 4 次被动（带 msgId）', JSON.stringify(msgIds.slice(0, 4)), JSON.stringify(['MSG-7', 'MSG-7', 'MSG-7', 'MSG-7']))
    check('7. 第 5 次转主动（不带 msgId）', msgIds[4], undefined)
    check('7. 转主动后仍打到同一个人', bot.sent[4]?.target.targetId, 'PEER_G')
    check('7. 转主动不是靠重试（每次只调一次）', bot.attempts.length, 5)
    check('7. 没有留下错误', (await runtime.status()).errors.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(failures === 0 ? '\n全部通过' : `\n${String(failures)} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
