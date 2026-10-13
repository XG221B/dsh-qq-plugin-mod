/**
 * 状态文件。
 *
 * 从微信插件的 `StateStore` 移植，四条性质都是踩过坑才有的，不要简化：
 *
 * 1. **原子写**：写临时文件再 `rename`，避免半截 JSON。
 * 2. **0600**：状态文件里有会话映射与 openid，不该给别的用户读。
 * 3. **写串行**：并发 `update` 必须排队，否则后写的覆盖先写的。
 * 4. **加载单飞 + 容错**：文件缺失或损坏时返回**空状态**而不是致命；并发读共享同一次加载，
 *    否则"第二次读回退成空状态并缓存"会把真实状态抹掉。
 *
 * 与微信插件的一个刻意差异：**AppSecret 不存在这里**。QQ 的 AppSecret 是长期密钥，
 * 放 DSH 的 `ctx.credentials`（见 `credentials.js`）。本文件只放非机密状态。
 *
 * @module dsh-qq/state
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
// ★ 必须从 `node:fs/promises` 取 `readFile`。
// 从 `node:fs` 取到的是回调版 API：`await readFile(...)` 不返回内容，而是抛
// "callback must be a function"，被下面的 catch 吞掉后每次都返回空状态——
// 表现为**每次写盘都只写回当前改动的那一半，另一半静默丢失**。
// 这个 bug 曾经让 accounts 与 bindings 互相覆盖。
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { normalizePending } from './pending.js'
// 设置项的定义**只有一份**（`lib/settings.js`：每项一个校验器 + 一个默认值）。
// 这里原来是一份手抄的九项白名单，与运行时落盘清单是两份各写各的名单——
// 那就意味着"加了设置却忘了改这里"会静默丢字段，而且**每次写盘都重新加载并重新规范化**，
// 于是下一次写盘把这份丢失持久化。见 `settings.js` 文件头。
import { normalizeSettings } from './settings.js'
// 浏览位置与编号清单的归一**只有一份实现**，在 `router.js`（那是它们的语义归属：
// 一个位置决定「查看其余」翻哪一屏、一屏编号决定用户回的那个数字指哪一行）。
// 这里借它来过滤状态文件里的值，免得两处各写一套慢慢漂移——
// 与本项目"一个判定点"的既有做法一致。
import { emptyRouteState, normalizeRouteState } from './router.js'

/** 状态文件的当前版本。字段含义变化时递增。 */
export const STATE_VERSION = 1

/**
 * 空状态。
 */
export function emptyState() {
  const route = emptyRouteState()
  return {
    version: STATE_VERSION,
    /** appId → 账号信息（**不含 AppSecret**）。 */
    accounts: {},
    /** conversationId → 会话绑定。 */
    bindings: {},
    /**
     * conversationId → 浏览位置 `{ level, workspace, page, at }`。
     *
     * **必须持久化**：「查看其余」没有目标，它的意思是"我正在看的那份的下十条"，
     * 而这份记录是唯一知道"我正在看哪份"的东西。重启之后位置还在，才谈得上"接着翻"。
     */
    browsing: route.browsing,
    /**
     * conversationId → 最近发出的几屏编号清单（正文 + 行 + 起始编号）。
     *
     * 微信把编号钉在**消息 id** 上；QQ 的引用直接给正文，所以这里钉的是正文本身。
     * 存下来之后，即使 DSH 重启过，一次引用仍然能按那条消息印的编号解析。
     */
    sessionLists: route.sessionLists,
    /**
     * 用户在设置页调过的项。
     *
     * **必须持久化**：这些是用户显式选择的行为，重启后静默回默认值是最糟的一种"没有效果"——
     * 用户会在下次真正需要它们的时候才发现。微信插件同样把这些存在它的状态文件里。
     * 缺字段一律回落到默认值（见 `runtime.js` 的 DEFAULT_* 常量），所以老状态文件仍然可读。
     */
    settings: {},
    /**
     * 主动推送被拒时存下来的待发消息，等用户下次说话时补发。
     *
     * 见 `pending.js`：**"发不出去"和"丢掉"是两回事**。
     */
    pendingNotifications: [],
    /** 是否在启动时自动重连。 */
    autoStart: true,
  }
}

/**
 * 把任意解析结果归一化成合法状态。
 *
 * 逐字段过滤而不是整体信任：旧版本写下的文件、手工编辑过的文件都会经过这里。
 *
 * @param value - `JSON.parse` 的结果。
 */
export function normalizeState(value) {
  const base = emptyState()
  if (typeof value !== 'object' || value === null) return base
  const record = value

  const state = { ...base, version: STATE_VERSION }

  if (typeof record.autoStart === 'boolean') state.autoStart = record.autoStart

  // 待发队列：逐条过滤，坏条目丢掉而不是整体拒绝——一条坏记录不该让所有待发消息消失。
  state.pendingNotifications = normalizePending(record.pendingNotifications)

  /*
   * 设置逐字段过滤，**由 `SETTINGS_SCHEMA` 驱动**（不再手抄字段名与类型）。
   *
   * 这样一份被手工编辑坏的状态文件不会把非法值带进运行时的行为里，
   * 而"加了设置却没加校验器"在纯 JS 里唯一的挡板就是测试——
   * 所以校验器表与运行时设置字段集的键集一致性由 `verify.mjs` 断言（见那里的注释）。
   *
   * 语义与迁移前逐条一致：越界或类型不对**丢弃该字段**（下落不明的那一项保持
   * 运行时的默认值），不是回落到默认值；空串在 `presenceNote` / `workspacePath`
   * 上都是合法值。唯一的收紧是数值项现在也施加与运行时相同的上限
   * （`CEILING_MS` / `CEILING_CHARS`）——迁移前这一层只判"非负"，上限在
   * `hydrateSettings` 里。因为读回时那边本来就会丢掉越界值，运行时的可观测行为不变。
   */
  state.settings = normalizeSettings(record.settings)

  if (typeof record.accounts === 'object' && record.accounts !== null) {
    for (const [appId, raw] of Object.entries(record.accounts)) {
      if (typeof raw !== 'object' || raw === null) continue
      const account = raw
      state.accounts[appId] = {
        appId,
        userOpenid: typeof account.userOpenid === 'string' ? account.userOpenid : undefined,
        boundAt: typeof account.boundAt === 'string' ? account.boundAt : undefined,
        enabled: account.enabled !== false,
      }
    }
  }

  if (typeof record.bindings === 'object' && record.bindings !== null) {
    for (const [conversationId, raw] of Object.entries(record.bindings)) {
      if (typeof raw !== 'object' || raw === null) continue
      const binding = raw
      if (typeof binding.sessionId !== 'string') continue
      if (typeof binding.peerId !== 'string') continue
      state.bindings[conversationId] = {
        conversationId,
        accountId: typeof binding.accountId === 'string' ? binding.accountId : '',
        peerId: binding.peerId,
        sessionId: binding.sessionId,
        title: typeof binding.title === 'string' ? binding.title : '',
        createdAt: typeof binding.createdAt === 'number' ? binding.createdAt : Date.now(),
        lastUsedAt: typeof binding.lastUsedAt === 'number' ? binding.lastUsedAt : Date.now(),
      }
    }
  }

  // 浏览位置与编号清单走 `router.js` 那一份归一（见文件头的 import 注释）。
  const route = normalizeRouteState({ browsing: record.browsing, sessionLists: record.sessionLists })
  state.browsing = route.browsing
  state.sessionLists = route.sessionLists

  return state
}

/**
 * 会话键。
 *
 * 只做私聊，所以没有 group 维度——比微信插件的 `accountId:groupId:peerId` 少一维。
 *
 * @param accountId - 机器人 appId。
 * @param peerId - 对方 openid。
 */
export function conversationKey(accountId, peerId) {
  return `${accountId}:${peerId}`
}

/**
 * 串行化、原子化的状态存储。
 */
export class StateStore {
  /** @type {string} */
  #file
  /** 已排队写入的尾部 Promise，保证写操作严格串行。 */
  #writeChain = Promise.resolve()
  /** 进行中的加载；并发读共享它。 */
  #loading
  /** 非预期读失败的上报口（不抛错，只记录）。 */
  #onError

  /**
   * @param file - 状态文件绝对路径。
   * @param options.onError - 上报非预期读失败；省略则静默。
   */
  constructor(file, options = {}) {
    this.#file = file
    this.#onError = options.onError
  }

  /** 状态文件路径。 */
  get file() {
    return this.#file
  }

  /**
   * 读取状态。文件不存在或损坏时返回空状态。
   */
  async read() {
    if (this.#loading !== undefined) return this.#loading
    this.#loading = this.#load()
    try {
      return await this.#loading
    } finally {
      // 加载完成后释放单飞锁，让下一次读能拿到最新写盘结果。
      this.#loading = undefined
    }
  }

  async #load() {
    let text
    try {
      text = await readFile(this.#file, 'utf8')
    } catch (error) {
      // 只有"文件不存在"是预期内的。其它读失败（权限、API 用错、路径异常）必须发声——
      // 上面的回调版 readFile bug 就是被"一律当不存在"吞掉的，代价是每次写盘丢一半状态。
      if (error?.code !== 'ENOENT') {
        this.#onError?.(`读取状态文件失败（按空状态继续，可能会覆盖已有状态）: ${error?.message ?? String(error)}`)
      }
      return emptyState()
    }
    try {
      return normalizeState(JSON.parse(text))
    } catch (error) {
      // 损坏的状态不能变成致命错误；留一份坏文件供排查，然后从空状态继续。
      this.#onError?.(`状态文件损坏，已改名留档: ${error?.message ?? String(error)}`)
      try {
        renameSync(this.#file, `${this.#file}.corrupt`)
      } catch {
        // 改名失败无所谓。
      }
      return emptyState()
    }
  }

  /**
   * 原子地修改状态。
   *
   * @param mutate - 就地进行修改的函数。
   * @returns 修改后的状态。
   */
  async update(mutate) {
    const run = async () => {
      const state = await this.#load()
      mutate(state)
      this.#write(state)
      return state
    }
    // 串到写链尾部，保证不会有两个 update 交错。
    const next = this.#writeChain.then(run, run)
    this.#writeChain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  #write(state) {
    mkdirSync(dirname(this.#file), { recursive: true })
    const temp = `${this.#file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, this.#file)
  }
}
