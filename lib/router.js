/**
 * 会话路由：一个 QQ 私聊映射到一个 DSH 会话，用户用聊天内指令在它们之间切换。
 *
 * 从 `dsh-wechat/packages/core/src/router.ts` **逐函数移植**。为什么用指令而不是选择器：
 * QQ 给频道的也只有一个聊天界面，所以会话列表必须活在消息流里。指令在每个客户端上今天就能用。
 *
 * 会话 id 由本模块按 DSH 自己的格式（`session-<8位hex>-<uuid>`）铸造，
 * 中间的 8 位既是 `/list` 打印的短 id，也是 `/switch` 接受的输入——两者一致才能用手机键盘切换。
 *
 * @module dsh-qq/router
 */
import { randomUUID } from 'node:crypto'

/**
 * 路由一条入站消息。
 *
 * @typedef {object} SessionBinding
 * @property {string} conversationId
 * @property {string} accountId
 * @property {string} peerId
 * @property {string} sessionId - DSH 会话 id，`session-<uuid>` 形态。
 * @property {string} title - `/list` 里显示的人类标签。
 * @property {number} createdAt
 * @property {number} lastUsedAt
 */

/**
 * 本路由需要宿主提供的会话面。
 *
 * 保持窄接口意味着路由规则**不用启动 DSH 就能单测**，同时也写明了频道依赖哪些宿主调用。
 */
export class SessionRouter {
  #gateway
  #store
  #titlePrefix
  #bindings

  /**
   * @param options.gateway - 宿主会话接口。
   * @param options.store - 绑定持久化。
   * @param options.titlePrefix - 自动生成会话标题时用的前缀。
   */
  constructor(options) {
    this.#gateway = options.gateway
    this.#store = options.store
    this.#titlePrefix = options.titlePrefix ?? 'QQ'
  }

  /**
   * 路由一条入站消息。
   *
   * @param params.conversationId - 稳定的对话键。
   * @param params.accountId - 消息到达的机器人账号。
   * @param params.peerId - 对方用户 id。
   * @param params.text - 消息文本。
   * @returns `{ kind: 'reply', text }` 直接回复，或 `{ kind: 'prompt', decision }` 交给会话。
   */
  async route(params) {
    const text = params.text.trim()

    if (text.startsWith('/')) {
      return await this.#command(params, text)
    }

    const bindings = await this.#load()
    let binding = bindings[params.conversationId]
    let created = false
    if (binding === undefined) {
      binding = await this.#bind(params, undefined)
      created = true
    } else {
      // DSH 可能在这条绑定之后重启过；交提示词之前先确保会话还活着。
      await this.#gateway.ensureSession(binding.sessionId, binding.title)
    }

    binding.lastUsedAt = Date.now()
    await this.#store.save(bindings)

    return {
      kind: 'prompt',
      decision: { sessionId: binding.sessionId, prompt: text, created },
    }
  }

  /** 某对话当前绑定的会话，没有则 `undefined`。 */
  async current(conversationId) {
    return (await this.#load())[conversationId]
  }

  async #command(params, text) {
    const { command, args } = splitCommand(text)
    const bindings = await this.#load()

    switch (command) {
      case '/help':
        return { kind: 'reply', text: HELP_TEXT }

      case '/new': {
        const binding = await this.#bind(params, args || undefined)
        // 重新绑定正是 `/new` 的意义：这个对话从此**就是**新会话，
        // 否则下一条消息会落进旧会话，新会话存在却够不着。
        bindings[params.conversationId] = binding
        await this.#store.save(bindings)
        return {
          kind: 'reply',
          text: `已新建对话「${binding.title}」。\n${shortId(binding.sessionId)}\n\n从现在起，你的消息发到这里。`,
        }
      }

      case '/list': {
        /*
         * 默认只列本工作区自己的对话，其余仅报数量。
         *
         * 这与"用嘴问"的结果一致，所以同一句话无论怎么问答案都一样。
         * 默认列全部会把本聊天创建的十个对话埋进别的项目来的五十个里，且没有任何标记区分。
         */
        const all = await this.#gateway.listSessions()
        if (all.length === 0) return { kind: 'reply', text: '还没有任何对话，直接发消息就会新建一个。' }
        const currentId = bindings[params.conversationId]?.sessionId
        const own = (await this.#gateway.listOwnSessions?.()) ?? all
        const wantsAll = args.trim().toLowerCase() === 'all'
        const shown = wantsAll ? all : own
        // 只把**真正**被藏起来的工作区报出来，提示才不会宣称一个列表里已经有的工作区。
        const held = wantsAll ? [] : all.filter((session) => !own.includes(session))
        return {
          kind: 'reply',
          text: renderSessionList(shown, currentId, { held }),
        }
      }

      case '/switch': {
        /*
         * 搜索全部会话，但只对用户看到过的那份列表编号。
         *
         * 别的工作区的会话会出现在 `/list all` 里，所以它必须能从那里选中——
         * 否则列表提供了一个选不了的东西。实践里"切到某个具名对话"失败正是这个原因：
         * 标题是真的、会话是真的，而搜索只在本工作区里找。
         */
        const all = await this.#gateway.listSessions()
        const own = (await this.#gateway.listOwnSessions?.()) ?? all
        const target = resolveTarget(args, all, own)
        if (target === undefined) {
          return { kind: 'reply', text: '找不到这个对话。回复「列表」看清单，再回复数字。' }
        }
        await this.#gateway.ensureSession(target.sessionId, target.title)
        const previous = bindings[params.conversationId]
        const binding = {
          conversationId: params.conversationId,
          accountId: params.accountId,
          peerId: params.peerId,
          sessionId: target.sessionId,
          /*
           * 标题三级回退，比微信插件多一级。
           *
           * 微信是 `target.title || this.#titlePrefix`。当目标会话在索引里还没有标题时
           * （DSH 要等第一个回合结束才写标题），绑定标题会退化成光秃秃的前缀——
           * 实测就撞上了：`/new` 之后立刻 `/switch` 回它，`/current` 会显示「当前对话「QQ」」。
           *
           * 所以中间插一级"沿用这个对话原来的标题"：那总比一个光前缀有信息量，
           * 且不改变任何其它行为。
           */
          title: target.title || previous?.title || this.#titlePrefix,
          createdAt: previous?.createdAt ?? Date.now(),
          lastUsedAt: Date.now(),
        }
        bindings[params.conversationId] = binding
        await this.#store.save(bindings)
        return { kind: 'reply', text: `已切换到「${binding.title}」。\n${shortId(binding.sessionId)}` }
      }

      case '/current': {
        const binding = bindings[params.conversationId]
        if (binding === undefined) return { kind: 'reply', text: '当前没有对话，发任意消息就会新建一个。' }
        return {
          kind: 'reply',
          text: `当前对话「${binding.title}」\n${shortId(binding.sessionId)}\n最后使用：${new Date(binding.lastUsedAt).toLocaleString('zh-CN')}`,
        }
      }

      case '/cancel': {
        const binding = bindings[params.conversationId]
        if (binding === undefined) return { kind: 'reply', text: '当前没有对话。' }
        await this.#gateway.cancel(binding.sessionId)
        return { kind: 'reply', text: '已请求中断当前任务。' }
      }

      default:
        return { kind: 'reply', text: `未知指令 ${command}。\n\n${HELP_TEXT}` }
    }
  }

  /** 创建一个绑定、它的会话，并持久化。 */
  async #bind(params, requestedTitle) {
    const bindings = await this.#load()
    const sessionId = mintSessionId()
    const title = requestedTitle?.trim() || `${this.#titlePrefix} ${shortId(sessionId)}`
    await this.#gateway.ensureSession(sessionId, title)
    const now = Date.now()
    const binding = {
      conversationId: params.conversationId,
      accountId: params.accountId,
      peerId: params.peerId,
      sessionId,
      title,
      createdAt: now,
      lastUsedAt: now,
    }
    bindings[params.conversationId] = binding
    await this.#store.save(bindings)
    return binding
  }

  async #load() {
    this.#bindings ??= await this.#store.load()
    return this.#bindings
  }
}

/** 可以带参数、也可以不带的指令。 */
const COMMANDS_WITH_ARG = ['/new', '/switch']

/** 从不带参数的指令。 */
const COMMANDS_BARE = ['/help', '/list', '/current', '/cancel']

/**
 * 把 `/cmd args` 拆成两半。
 *
 * 分隔空格是可选的，且接受 `:` 代替它——因为这些指令是在手机键盘上敲的，掉空格是常态。
 * `/switch1`、`/switch 1`、`/switch:1` 意思相同。
 * 只是**以**指令名开头的词不会被吃掉，所以 `/news` 不是 `/new`。
 *
 * @param text - 原始文本。
 * @returns `{ command, args }`
 */
export function splitCommand(text) {
  const trimmed = text.trim()
  const lower = trimmed.toLowerCase()

  const space = trimmed.search(/\s/)
  if (space >= 0) {
    return { command: lower.slice(0, space), args: trimmed.slice(space + 1).trim() }
  }

  const colon = lower.indexOf(':')
  if (colon > 0) {
    return { command: lower.slice(0, colon), args: trimmed.slice(colon + 1).trim() }
  }

  if (COMMANDS_BARE.includes(lower)) {
    return { command: lower, args: '' }
  }

  for (const command of COMMANDS_WITH_ARG) {
    if (!lower.startsWith(command)) continue
    const rest = trimmed.slice(command.length)
    // 紧跟一个 ASCII 字母说明这是另一个词，而不是这条指令粘了个参数：
    // `/news` 不能被解析成 `/new` 加 `s`。数字与非 ASCII 文本是合法的粘连参数
    // （`/switch1`、`/new我的任务`）。
    if (/^[a-z]/.test(rest)) continue
    return { command, args: rest.replace(/^[:\s]+/, '').trim() }
  }

  return { command: lower, args: '' }
}

/**
 * 把 `/switch` 的参数解析成一条会话。
 *
 * 接受 1 起的位置序号、完整会话 id、`/list` 打印的短 id，或精确标题——
 * 手机键盘让复制完整 uuid 很痛苦。
 *
 * 匹配刻意严格。会话 id 共享同一形态（`session-<短>-<uuid>`），
 * 松散的 `includes` 会匹配到多行；有歧义的参数必须失败，而不是切到一个意外的会话。
 *
 * @param args - 用户在 `/switch` 后面敲的。
 * @param sessions - 所有可被选中的会话，通常是整台机器。
 * @param numbered - 数字所指向的那份列表，当它与 `sessions` 不同时传入。
 * @returns `{ sessionId, title }` 或 `undefined`。
 */
export function resolveTarget(args, sessions, numbered = sessions) {
  const value = args.trim()
  if (!value) return undefined

  if (/^\d+$/.test(value)) {
    // 数字指向用户**看到过**的那份列表，而不一定是整台机器——所以用 `numbered` 而非 `sessions`。
    const byIndex = numbered[Number(value) - 1]
    if (byIndex !== undefined) return { sessionId: byIndex.sessionId, title: byIndex.title }
    // 继续往下：纯数字字符串也可能是个标题。
  }

  const exactId = sessions.find((session) => session.sessionId === value)
  if (exactId !== undefined) return { sessionId: exactId.sessionId, title: exactId.title }

  // 短 id 在中间：`session-<短>-<uuid>`。
  const byShort = sessions.filter((session) => session.sessionId.startsWith(`session-${value}-`))
  if (byShort.length === 1) return { sessionId: byShort[0].sessionId, title: byShort[0].title }

  const bySuffix = sessions.filter((session) => session.sessionId.endsWith(value))
  if (bySuffix.length === 1) return { sessionId: bySuffix[0].sessionId, title: bySuffix[0].title }

  const byTitle = sessions.find((session) => session.title === value)
  if (byTitle !== undefined) return { sessionId: byTitle.sessionId, title: byTitle.title }

  /*
   * 最后才是**双向**的标题包含匹配——且只在恰好一条命中时成立。
   *
   * 人用"自己怎么称呼这个对话"的方式称呼它，松紧两个方向都会出现：
   * 敲一个片段（「北京」），或者自己加词（「北京今天天气如何**会话**」）。
   * 两者与精确标题是同一个请求，而只做精确匹配在这两种情况下都失败过——
   * 对一个用户看得出能答的请求来说，这是硬失败。
   *
   * 唯一性是保险，也是它排在最后的原因。命中多条或零条都返回 undefined：
   * 有歧义的参数必须失败，而不是把对话移到用户没要求的地方去。
   * 短到单个字的词在这里通常命中不了，同样出于这个原因——那会是猜。
   */
  const core = (session) => session.title.includes(value) || value.includes(session.title)
  const byCore = sessions.filter((session) => session.title !== '' && core(session))
  if (byCore.length === 1) return { sessionId: byCore[0].sessionId, title: byCore[0].title }

  return undefined
}

/**
 * 按 DSH 自己的格式铸造会话 id。
 *
 * 形态是 `session-<8位hex>-<uuid>`，因为宿主把这个形态当作它的原生会话身份。
 * 前一段取自随机 uuid，这样 `/list` 显示的紧凑形式也正是 `/switch` 接受的形式——
 * 两者相同才能用手机键盘切换。
 *
 * @param random - 注入用的随机源（测试）。
 */
export function mintSessionId(random = randomUUID) {
  const uuid = random()
  const tail = uuid.replace(/-/g, '').slice(0, 8)
  return `session-${tail}-${uuid}`
}

/** 给用户看的紧凑标识，也是 `/switch` 接受的输入。 */
export function shortId(sessionId) {
  const match = /^session-([0-9a-f]{8})-/i.exec(sessionId)
  if (match) return match[1]
  return sessionId.replace(/^session-/, '').slice(0, 8)
}

/** 列表最多显示多少行；再多就只能靠 id 或标题够着。 */
const LIST_LIMIT = 20

/**
 * 渲染会话列表里的一行。
 *
 * 标题在前，因为那是人认得出的东西。短 id 另起一行，因为一个工作区的标题被其中每条会话共享，
 * 于是同一工作区里的两个对话否则无法区分——而数字不够用时，`/switch` 接受的就是这个 id。
 *
 * @param session - 要渲染的会话。
 * @param index - 0 起的位置，渲染成回复用的 1 起编号。
 * @param currentId - 本对话绑定的会话，在列表里标出。
 */
export function renderSessionRow(session, index, currentId) {
  const mark = session.sessionId === currentId ? '  ← 当前' : ''
  const title = (session.title ?? '').trim() || '(无标题)'
  const when = session.updatedAt === undefined ? '' : ` · ${relativeTime(session.updatedAt)}`
  return `${index + 1}. ${title}${mark}\n   ${shortId(session.sessionId)}${when}`
}

/**
 * 渲染会话列表。
 *
 * @param sessions - 要显示的会话，最新在前。
 * @param currentId - 本对话绑定的会话，在列表里标出。
 * @param options.held - 被藏起来的会话，好让消息能说明它们存在以及怎么看。
 *   点名它们是全部意义所在：一个从没被告知的用户问不出来。
 * @param options.heldHint - 怎么够到那些被藏起来的会话；打字与说话需要不同措辞。
 */
export function renderSessionList(sessions, currentId, options = {}) {
  const held = options.held ?? []
  const shown = sessions.slice(0, LIST_LIMIT)
  const lines = shown.map((session, index) => renderSessionRow(session, index, currentId))
  const more =
    sessions.length > shown.length ? `\n\n（还有 ${sessions.length - shown.length} 个更早的对话未显示）` : ''
  const elsewhere =
    held.length === 0
      ? ''
      : `\n\n另有 ${String(held.length)} 个对话在其它工作区，${options.heldHint ?? '一起看就发 /list all。'}`
  const all = sessions.length + held.length
  return [
    `共 ${String(all)} 个对话${held.length === 0 ? '' : `（这里显示 ${String(sessions.length)} 个）`}：`,
    '',
    lines.join('\n\n'),
    more,
    elsewhere,
    '',
    '回复数字即可切换，例如「3」。',
  ].join('\n')
}

/**
 * 一件事过去了多久，用人的说法。
 *
 * 用相对时间而非绝对时间，因为列表回答的问题是"我刚才在弄哪个"，
 * 24 小时制只会让这件事更难，不会更容易。
 *
 * @param at - 毫秒时间戳。
 * @param now - 当前时间，可注入以便测试。
 */
export function relativeTime(at, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(at).toLocaleDateString('zh-CN')
}

export const HELP_TEXT = [
  '可用指令：',
  '/new [标题]     新建对话',
  '/list           列出最近对话',
  '/list all       列出包括其它工作区在内的全部对话',
  '/switch <编号>  切换到某个对话',
  '/current        显示当前对话',
  '/cancel         中断当前任务',
  '/help           显示本帮助',
  '',
  '直接发消息即与当前对话对话。',
  '',
  '也可以直接用大白话说，例如「查看对话列表」「换个对话」「停下」。',
].join('\n')
