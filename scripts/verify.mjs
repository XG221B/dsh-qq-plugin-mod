/**
 * 离线自检：不依赖 DSH 宿主，只验证模块解析与纯函数行为。
 *
 * 这类错误在 DSH 里只表现为"插件加载失败"，排查代价高，所以在装进 profile 之前先在这里挡住。
 *
 * 用法：node scripts/verify.mjs
 */
let failures = 0

function check(label, actual, expected) {
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  期望 ${String(expected)}，实际 ${String(actual)}`}`)
}

function show(label, value) {
  console.log(`      ${label}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
}

// ---- 官方 SDK 的两个入口都要能解析 ----------------------------------------
const main = await import('@tencent-connect/qqbot-nodejs')
const proto = await import('@tencent-connect/qqbot-nodejs/protocol')

check('QQBot 导出', typeof main.QQBot, 'function')
check('ReplyLimiter 从 protocol 子入口导出', typeof proto.ReplyLimiter, 'function')
check('chunkText 导出', typeof proto.chunkText, 'function')
show('TEXT_CHUNK_LIMIT', proto.TEXT_CHUNK_LIMIT)
check('MsgType.TEXT', main.MsgType.TEXT, 0)
check('MsgType.MARKDOWN', main.MsgType.MARKDOWN, 2)

// ---- 限流器行为：4 次 / 1 小时 ---------------------------------------------
const limiter = new proto.ReplyLimiter()
show('limiter 默认配置', limiter.getConfig())
const first = limiter.checkLimit('m1')
check('首次允许被动回复', first.allowed, true)
for (let i = 0; i < 4; i += 1) limiter.record('m1')
const after = limiter.checkLimit('m1')
check('用完 4 次后不再允许', after.allowed, false)
check('并建议降级为主动', after.shouldFallbackToProactive, true)
show('降级原因', after.fallbackReason)
check('新消息不受影响', limiter.checkLimit('m2').allowed, true)

// ---- 文本切分 --------------------------------------------------------------
const long = 'a'.repeat(proto.TEXT_CHUNK_LIMIT * 2 + 10)
const chunks = proto.chunkText(long, proto.TEXT_CHUNK_LIMIT)
check('超长文本被切成 3 段', chunks.length, 3)
check('切分不丢字符', chunks.join('').length, long.length)

// ---- 本插件自己的模块 ------------------------------------------------------
const runtime = await import('../lib/runtime.js')
check('QqRuntime 导出', typeof runtime.QqRuntime, 'function')
const sessionId = runtime.mintSessionId()
check('sessionId 形如 session-<8hex>-<uuid>', /^session-[0-9a-f]{8}-[0-9a-f-]{36}$/.test(sessionId), true)
show('mintSessionId()', sessionId)
check('shortId 取第二段', runtime.shortId(sessionId), sessionId.split('-')[1])

const state = await import('../lib/state.js')
check('conversationKey 只有两维', state.conversationKey('1905760478', 'E56C740F'), '1905760478:E56C740F')
const normalized = state.normalizeState({
  accounts: { '1': { userOpenid: 'u1', enabled: true } },
  bindings: { 'k': { sessionId: 's', peerId: 'p', accountId: '1' } },
})
check('normalizeState 保留账号', normalized.accounts['1'].userOpenid, 'u1')
check('normalizeState 保留绑定', normalized.bindings['k'].sessionId, 's')
check('normalizeState 拒绝缺 sessionId 的绑定', Object.keys(state.normalizeState({ bindings: { k: { peerId: 'p' } } }).bindings).length, 0)

const creds = await import('../lib/credentials.js')
check('appId 是纯数字时 key 仍合法', creds.accountRecordKey('1905760478'), 'dsh-qq-plugin/app-1905760478')
check('key 段符合 ^[a-z][a-z0-9-]*$', /^[a-z][a-z0-9-]*$/.test(creds.sanitizeKeySegment('app-1905760478')), true)
// ★ 这几条是为一次**造成用户应用无法启动**的事故而加的：凭据记录的 `kind` 是封闭枚举，
//   写错会让 @deepseek-ai/dsh-credentials-local 在启动时解析失败，进而拖垮整个桌面端。
check('★ 凭据记录 kind 是官方承认的 grant', creds.CREDENTIAL_KIND, 'grant')
check('★ kind 落在官方枚举内', creds.ALLOWED_RECORD_KINDS.includes(creds.CREDENTIAL_KIND), true)
check('官方枚举就是 api-key 与 grant', JSON.stringify([...creds.ALLOWED_RECORD_KINDS]), JSON.stringify(['api-key', 'grant']))

const frame = await import('../lib/stream-frame.js')
const wrap = (frameObj) => frame.readStreamFrame({ agent: { session: { id: 's1' } }, frame: frameObj })
check('end 帧 = 回合结束', wrap({ type: 'end' }).completed, true)
check('text-delta 取到文本', wrap({ chunk: { type: 'text-delta', text: 'hi' } }).text, 'hi')
check('sessionId 正确', wrap({ chunk: { type: 'text-delta', text: 'hi' } }).sessionId, 's1')
check('finish 不算回合结束', wrap({ chunk: { type: 'finish' } }).completed, undefined)
check('reasoning-delta 不进正文', wrap({ chunk: { type: 'reasoning-delta', text: '想' } }).text, undefined)
check('未知帧被记录形态', typeof wrap({ weird: 1 }).frameShape, 'string')

// ---- 会话路由（纯函数；手机键盘容错最易悄悄写错）---------------------------
{
  const r = await import('../lib/router.js')

  // splitCommand：空格可选、冒号可代、`/news` 不能被吃成 `/new` + `s`
  check('"/switch 3"', JSON.stringify(r.splitCommand('/switch 3')), JSON.stringify({ command: '/switch', args: '3' }))
  check('"/switch3" 粘连也认', JSON.stringify(r.splitCommand('/switch3')), JSON.stringify({ command: '/switch', args: '3' }))
  check('"/switch:3" 冒号也认', JSON.stringify(r.splitCommand('/switch:3')), JSON.stringify({ command: '/switch', args: '3' }))
  check('★ "/news" 不是 /new', JSON.stringify(r.splitCommand('/news')), JSON.stringify({ command: '/news', args: '' }))
  check('★ "/new我的任务" 合法粘连参数', JSON.stringify(r.splitCommand('/new我的任务')), JSON.stringify({ command: '/new', args: '我的任务' }))
  check('"/new 修复登录"', JSON.stringify(r.splitCommand('/new 修复登录')), JSON.stringify({ command: '/new', args: '修复登录' }))
  check('"/list all"', JSON.stringify(r.splitCommand('/list all')), JSON.stringify({ command: '/list', args: 'all' }))
  check('"/help" 无参数', JSON.stringify(r.splitCommand('/help')), JSON.stringify({ command: '/help', args: '' }))
  check('大小写不敏感', JSON.stringify(r.splitCommand('/LIST')), JSON.stringify({ command: '/list', args: '' }))

  // resolveTarget
  const sessions = [
    { sessionId: 'session-aaaaaaaa-1111', title: '修复登录', updatedAt: 3 },
    { sessionId: 'session-bbbbbbbb-2222', title: '北京行程', updatedAt: 2 },
    { sessionId: 'session-cccccccc-3333', title: '', updatedAt: 1 },
  ]
  check('序号 2', r.resolveTarget('2', sessions)?.sessionId, 'session-bbbbbbbb-2222')
  check('完整 id', r.resolveTarget('session-cccccccc-3333', sessions)?.sessionId, 'session-cccccccc-3333')
  check('短 id', r.resolveTarget('aaaaaaaa', sessions)?.sessionId, 'session-aaaaaaaa-1111')
  check('精确标题', r.resolveTarget('修复登录', sessions)?.sessionId, 'session-aaaaaaaa-1111')
  check('★ 双向包含：敲片段', r.resolveTarget('北京', sessions)?.sessionId, 'session-bbbbbbbb-2222')
  check('★ 双向包含：自己加词', r.resolveTarget('北京行程安排', sessions)?.sessionId, 'session-bbbbbbbb-2222')
  check('找不到时 undefined', r.resolveTarget('不存在的对话', sessions), undefined)
  check('空参数 undefined', r.resolveTarget('   ', sessions), undefined)
  check('序号越界不误配', r.resolveTarget('99', sessions), undefined)
  check('★ 有歧义必须失败', r.resolveTarget('session-', sessions), undefined)

  const all = [...sessions, { sessionId: 'session-dddddddd-4444', title: '别的项目', updatedAt: 0 }]
  check('★ 序号按用户看到的列表编号', r.resolveTarget('1', all, sessions)?.sessionId, 'session-aaaaaaaa-1111')
  check('★ 标题可在全机器范围搜到', r.resolveTarget('别的项目', all, sessions)?.sessionId, 'session-dddddddd-4444')

  const list = r.renderSessionList(sessions.slice(0, 2), 'session-bbbbbbbb-2222', { held: [sessions[2]] })
  check('列表标出当前', list.includes('← 当前'), true)
  check('列表有编号', list.includes('1. 修复登录') && list.includes('2. 北京行程'), true)
  check('★ 列表报出被藏起来的数量', /另有 1 个对话在其它工作区/.test(list), true)
  check('列表给出切换提示', list.includes('回复数字即可切换'), true)
  check('relativeTime 刚刚', r.relativeTime(Date.now()), '刚刚')
  check('relativeTime 分钟', r.relativeTime(Date.now() - 5 * 60_000), '5 分钟前')
  check('shortId 取中间段', r.shortId('session-5843df2a-501d'), '5843df2a')

}

// ---- 会话索引：目录编码是实测出来的精确字符串 ------------------------------
{
  const si = await import('../lib/session-index.js')
  check('★ encodeWorkspaceDir 精确值', si.encodeWorkspaceDir('C:\\Users\\me\\.dsh\\dsh_qq'), '--C-Users-me-.dsh-dsh_qq--')
  check('★ encodeWorkspaceDir 去首尾分隔符', si.encodeWorkspaceDir('/home/me/x/'), '--home-me-x--')
  check('反斜杠与正斜杠等价', si.isSameWorkspace('C:\\a\\b', 'C:/a/b'), true)
  check('尾部斜杠不影响', si.isSameWorkspace('C:\\a\\b\\', 'C:\\a\\b'), true)
  check('不同目录不相等', si.isSameWorkspace('C:\\a\\b', 'C:\\a\\c'), false)
  check('Windows 忽略大小写', si.isSameWorkspace('C:\\A\\B', 'c:\\a\\b'), true)
  check('★ Linux 不忽略大小写', si.isSameWorkspace('/A/B', '/a/b', false), false)
}

// ---- 审批与提问的文本解析（"否定优先"是最易写错的一条）--------------------
{
  const ia = await import('../lib/interactions.js')

  check('允许', ia.parseApprovalReply('允许'), 'allowed-once')
  check('拒绝', ia.parseApprovalReply('拒绝'), 'rejected')
  check('★「不允许」判为拒绝（含「允许」子串）', ia.parseApprovalReply('不允许'), 'rejected')
  check('★「不可以」判为拒绝（含「可以」子串）', ia.parseApprovalReply('不可以'), 'rejected')
  check('可以 → 允许', ia.parseApprovalReply('可以'), 'allowed-once')
  check('yes/ok/allow', [ia.parseApprovalReply('yes'), ia.parseApprovalReply('ok'), ia.parseApprovalReply('allow')].join(','), 'allowed-once,allowed-once,allowed-once')
  check('no/n/deny', [ia.parseApprovalReply('no'), ia.parseApprovalReply('n'), ia.parseApprovalReply('deny')].join(','), 'rejected,rejected,rejected')
  check('大小写不敏感', ia.parseApprovalReply('YES'), 'allowed-once')
  check('★ 看不懂返回 undefined（不猜）', ia.parseApprovalReply('今天天气不错'), undefined)
  check('空串 undefined', ia.parseApprovalReply('   '), undefined)

  const approval = ia.presentApproval({ toolName: 'exec', displayReason: 'rm -rf build' })
  check('权限提示含工具名', approval.body.includes('exec'), true)
  check('权限提示含理由', approval.body.includes('rm -rf build'), true)
  check('权限提示给出回复方式', approval.body.includes('回复 允许 或 拒绝'), true)

  const qs = [{ id: 'q1', question: '选哪个方案？', options: [{ label: '方案A' }, { label: '方案B', description: '更快' }] }]
  const presented = ia.presentQuestions(qs)
  check('提问渲染编号选项', presented.body.includes('1. 方案A') && presented.body.includes('2. 方案B'), true)
  check('提问渲染选项描述', presented.body.includes('— 更快'), true)
  check('单选提示', presented.body.includes('回复编号，或直接回复你的答案'), true)

  const multi = ia.presentQuestions([{ id: 'q1', question: '多选', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }])
  check('多选提示可多个', multi.body.includes('可多个，如 1,3'), true)

  const numeric = ia.parseQuestionReply(qs, '2')
  check('★ 数字回复选中对应选项', JSON.stringify(numeric.answers[0].selected), JSON.stringify(['方案B']))
  check('标签回复也能认', JSON.stringify(ia.parseQuestionReply(qs, '方案A').answers[0].selected), JSON.stringify(['方案A']))
  const freeform = ia.parseQuestionReply(qs, '都不太满意，说说你的想法')
  check('★ 自由文本走 custom，不被拒绝', JSON.stringify(freeform.answers[0].custom), JSON.stringify('都不太满意，说说你的想法'))
  const twoOptions = [{ id: 'q1', question: 'x', options: [{ label: 'A' }, { label: 'B' }] }]
  const threeMulti = [{ id: 'q1', question: 'x', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], multiSelect: true }]
  check('★ 全角逗号多选', JSON.stringify(ia.parseQuestionReply(threeMulti, '1，3').answers[0].selected), JSON.stringify(['A', 'C']))
  check('空格分隔多选', JSON.stringify(ia.parseQuestionReply(twoOptions.map((q) => ({ ...q, multiSelect: true })), '1 2').answers[0].selected), JSON.stringify(['A', 'B']))
  check('★ 越界数字不当成选择', JSON.stringify(ia.parseQuestionReply(twoOptions, '5').answers[0]), JSON.stringify({ id: 'q1', selected: [], custom: '5' }))
  check('无选项时整条作为 custom', JSON.stringify(ia.parseQuestionReply([{ id: 'q1', question: '叫什么名字？' }], '鲸鱼娘').answers[0]), JSON.stringify({ id: 'q1', selected: [], custom: '鲸鱼娘' }))
  check('单选只取第一个', JSON.stringify(ia.parseQuestionReply(twoOptions, '1 2').answers[0].selected), JSON.stringify(['A']))
}

// ---- session_control 工具（自然语言会话控制）------------------------------
{
  const st = await import('../lib/session-tool.js')
  const rt = await import('../lib/router.js')

  const def = st.sessionToolDefinition({
    requireConfirmation: true,
    control: async () => ({ ok: true, detail: 'x', sessions: [], otherWorkspaces: 0, otherNames: [] }),
    log: () => {},
  })
  check('★ 工具名带 qq_ 前缀（避免与微信的 session_control 重名）', def.name, 'qq_session_control')
  check('action 枚举完整', JSON.stringify(def.parameters.properties.action.enum), JSON.stringify(['list', 'switch', 'new', 'current', 'cancel']))
  check('action 必填', JSON.stringify(def.parameters.required), JSON.stringify(['action']))
  check('output 声明 detail/ok', JSON.stringify(def.output.schema.required), JSON.stringify(['detail', 'ok']))
  check('output.schema 含 otherWorkspaces', def.output.schema.properties.otherWorkspaces.type, 'number')
  check('render 返回数组', Array.isArray(def.output.render({ action: 'list' })), true)
  check('★ 确认策略在描述里（开）', def.description.includes('IMPORTANT'), true)
  const off = st.sessionToolDescription(false)
  check('★ 确认策略在描述里（关）', !off.includes('IMPORTANT') && off.includes('confirmation off'), true)
  check('描述要求不要复述结果', def.description.includes('do not repeat that outcome'), true)

  check('新建确认文案（有标题）', st.switchConfirmation('new', '测试会话'), '已新建对话「测试会话」，从现在起你的消息发到这里。')
  check('新建确认文案（无标题）', st.switchConfirmation('new', ''), '已新建对话，从现在起你的消息发到这里。')
  check('切换确认文案', st.switchConfirmation('switch', '周报'), '已切换到「周报」。')
  const failure = st.switchFailure('switch', '3', '找不到这个对话。\n第二行')
  check('★ 失败文案只取原因第一行', failure.split('\n')[0], '切换到「3」没有成功。找不到这个对话。')
  check('失败文案给出下一步', failure.includes('/list'), true)
  check('workspaceLabel 取末段', st.workspaceLabel('C:\\Users\\me\\.dsh\\dsh_qq'), 'dsh_qq')
  check('workspaceLabel 处理正斜杠', st.workspaceLabel('/home/me/work'), 'work')

  // ★ 一致性断言：工具版渲染与 router 版渲染必须逐字相同。
  // 为避免 router 与工具互相依赖，两处各有一份实现，所以必须靠断言钉住。
  const sample = [
    { sessionId: 'session-aaaaaaaa-1111', title: '修复登录', updatedAt: 1791628347908 },
    { sessionId: 'session-bbbbbbbb-2222', title: '', updatedAt: 1791628347908 },
  ]
  const viaRouter = sample.map((s, i) => rt.renderSessionRow(s, i, 'session-aaaaaaaa-1111')).join('\n\n')
  const viaTool = st.renderTable(sample, 'session-aaaaaaaa-1111')
  check('★ 工具渲染与 /list 渲染逐字一致', viaTool, viaRouter)
  check('空标题渲染为 (无标题)', viaTool.includes('(无标题)'), true)
  check('当前会话被标出', viaTool.includes('← 当前'), true)
}

// ---- 出站文件与主动推送两个工具 --------------------------------------------
{
  const st = await import('../lib/send-tools.js')

  check('图片扩展名走图片通道', st.mediaKindFor('C:\\a\\b.png'), 'image')
  check('jpg 也走图片通道', st.mediaKindFor('/tmp/x.JPG'), 'image')
  check('视频扩展名走视频通道', st.mediaKindFor('/tmp/x.mp4'), 'video')
  check('其它走文件通道', st.mediaKindFor('/tmp/report.pdf'), 'file')
  check('无扩展名走文件通道', st.mediaKindFor('/tmp/noext'), 'file')
  check('目录名里的点不误判', st.mediaKindFor('/a.b/report'), 'file')

  const sendDef = st.sendToQqToolDefinition({ deliver: async () => 'ok', log: () => {} })
  check('send_to_qq 名字', sendDef.name, 'send_to_qq')
  check('send_to_qq 只要求 path', JSON.stringify(sendDef.parameters.required), JSON.stringify(['path']))
  check('send_to_qq 说明绝对路径', sendDef.description.includes('must be absolute'), true)
  check('send_to_qq output 契约', JSON.stringify(sendDef.output.schema.required), JSON.stringify(['detail']))

  const notifyDef = st.notifyQqToolDefinition({ deliver: async () => 'ok', log: () => {} })
  check('notify_qq 名字', notifyDef.name, 'notify_qq')
  check('notify_qq 只要求 text', JSON.stringify(notifyDef.parameters.required), JSON.stringify(['text']))
  check('★ notify_qq 不接受目标参数（agent 无法瞄错）', Object.keys(notifyDef.parameters.properties).join(','), 'text,path')
  check('notify_qq 说明任意会话可用', notifyDef.description.includes('works from any session'), true)
  check('notify_qq 说明无法选择别的对话', notifyDef.description.includes('no way to choose another'), true)
  check('notify_qq output 契约', JSON.stringify(notifyDef.output.schema.required), JSON.stringify(['detail']))

  // 执行路径：deliver 抛错时工具必须把错误传出去（而不是静默返回空 detail）
  const failing = st.sendToQqToolDefinition({
    deliver: async () => {
      throw new Error('路径必须是绝对路径：x')
    },
    log: () => {},
  })
  let threw = false
  try {
    await failing.execute({ path: 'x' }, {})
  } catch {
    threw = true
  }
  check('★ deliver 抛错时工具也抛（不静默）', threw, true)
}

// ---- 提示词合成：agent 到底看到了什么 --------------------------------------
{
  const p = await import('../lib/prompt.js')

  check('纯文本', p.composePrompt({ content: '你好' }), '你好')
  check('空白内容 → 空串', p.composePrompt({ content: '   ' }), '')
  check('缺内容不抛', p.composePrompt({}), '')

  // 语音：服务端转写优先，不做 SILK 解码
  const voice = p.composePrompt({
    content: '',
    attachments: [{ content_type: 'voice', url: 'https://x/v', asr_refer_text: '今天天气怎么样' }],
  })
  check('★ 语音用服务端转写', voice, '[语音转写] 今天天气怎么样')

  // 普通附件
  const file = p.composePrompt({
    content: '看看这个',
    attachments: [{ content_type: 'file', filename: '报告.pdf', url: 'https://x/f' }],
  })
  check('附件带名称与链接', file, '看看这个\n[附件 报告.pdf] https://x/f')
  check('无文件名的附件有兜底标签', p.composePrompt({ attachments: [{ content_type: 'image/png', url: 'u' }] }), '[附件 image/png] u')

  // 引用：QQ 白送正文
  const quoted = p.composePrompt({
    content: '这句是什么意思',
    refMsgIdx: 'REFIDX_A',
    msgElements: [
      { msg_idx: 'REFIDX_OTHER', content: '无关的另一条' },
      { msg_idx: 'REFIDX_A', content: '被引用的原文' },
    ],
  })
  check('★ 引用正文被注入且在正文之前', quoted, '[引用] 被引用的原文\n这句是什么意思')
  check('★ 逐项核对，不误取第一条', quoted.includes('无关的另一条'), false)

  // 引用了纯媒体：说类型，别静默
  const quotedMedia = p.composePrompt({
    content: '这张图',
    refMsgIdx: 'R1',
    msgElements: [{ msg_idx: 'R1', attachments: [{ content_type: 'image/png' }] }],
  })
  check('引用纯媒体时说明类型', quotedMedia, '[引用] （引用了image/png）\n这张图')

  // 没有 refMsgIdx / 匹配不上 → 不产生空壳引用
  check('无 refMsgIdx 不产生引用', p.composePrompt({ content: 'hi', msgElements: [{ msg_idx: 'R', content: 'x' }] }), 'hi')
  check('★ refMsgIdx 匹配不上时不产生引用', p.composePrompt({ content: 'hi', refMsgIdx: 'R9', msgElements: [{ msg_idx: 'R1', content: 'x' }] }), 'hi')
  check('元素无正文且无附件 → 不产生引用', p.composePrompt({ content: 'hi', refMsgIdx: 'R1', msgElements: [{ msg_idx: 'R1' }] }), 'hi')

  check('quotedText 直接调用', p.quotedText({ refMsgIdx: 'R1', msgElements: [{ msg_idx: 'R1', content: '原文' }] }), '原文')
  check('quotedText 无输入时 undefined', p.quotedText({}), undefined)
}

// ---- 设置页后端：快照、施加、以及工具重注册 --------------------------------
// `requireConfirmation` 只存在于 session_control 的**描述**里，而注册表按值取走描述，
// 所以改它必须重新注册工具。这条路径没有别的测试能覆盖。
{
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { QqRuntime } = await import('../lib/runtime.js')

  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-settings-'))
  try {
    const registered = []
    const services = {
      // 只提供工具服务与权限预设目录；其余服务缺失应当被容忍（本插件只降级，不失败）。
      tools: {
        register: (definition) => {
          registered.push(definition)
          return () => {
            const at = registered.indexOf(definition)
            if (at >= 0) registered.splice(at, 1)
          }
        },
      },
      permissionPresets: { names: ['workspace-write', 'danger-full-access', 'auto'] },
    }
    const ctx = { get: (name) => services[name] }
    const credentials = {
      available: false,
      save: async () => ({}),
      load: async () => undefined,
      remove: async () => {},
      describe: async () => ({ configured: false }),
    }
    const runtime = new QqRuntime(ctx, {
      home: dir,
      stateFile: join(dir, 'state.json'),
      workspace: join(dir, 'dsh_qq'),
      credentials,
    })

    const initial = runtime.settingsSnapshot()
    check('默认 permissionPreset 与微信一致', initial.permissionPreset, 'danger-full-access')
    check('默认 requireConfirmation 与微信一致', initial.requireConfirmation, true)
    check('默认 allowCrossSessionNotify 与微信一致', initial.allowCrossSessionNotify, true)
    check('★ settleMs 默认与微信一致（1200）', initial.settleMs, 1200)
    check('快照同时给出默认值', initial.settleMsDefault, 1200)

    const names = runtime.permissionPresetsInfo().available
    check('★ 预设目录来自服务而不是硬编码', JSON.stringify(names), JSON.stringify(['workspace-write', 'danger-full-access', 'auto']))
    check('哨兵值标注为 default', runtime.permissionPresetsInfo().sentinel, 'default')

    // 注册三个工具
    runtime.registerTools()
    const toolNames = registered.map((d) => d.name).sort()
    check('★ 注册了三个工具', JSON.stringify(toolNames), JSON.stringify(['notify_qq', 'qq_session_control', 'send_to_qq']))
    const control = registered.find((d) => d.name === 'qq_session_control')
    check('初始描述含确认条款', control.description.includes('IMPORTANT'), true)

    // 关掉确认 → 必须重新注册，且新描述不含确认条款
    runtime.applySettings({ requireConfirmation: false })
    const after = registered.find((d) => d.name === 'qq_session_control')
    check('★ 关掉确认后工具被重新注册', after !== control, true)
    check('★ 新描述不再含确认条款', after.description.includes('IMPORTANT'), false)
    check('重新注册后仍是三个工具（旧的已注销）', registered.length, 3)

    // 其余设置不应触发重注册
    const before = registered.find((d) => d.name === 'qq_session_control')
    runtime.applySettings({ allowCrossSessionNotify: false, settleMs: 500 })
    check('★ 无关设置不触发重注册', registered.find((d) => d.name === 'qq_session_control') === before, true)
    check('settleMs 已更新', runtime.settingsSnapshot().settleMs, 500)
    check('allowCrossSessionNotify 已更新', runtime.settingsSnapshot().allowCrossSessionNotify, false)

    // 切换预设
    runtime.applySettings({ permissionPreset: 'auto' })
    check('预设已切换', runtime.settingsSnapshot().permissionPreset, 'auto')

    // ★ 设置页形状：微信客户端解构的是 `.settings` 与 `.defaults`，两个对象同键
    const page = runtime.settingsForPage()
    check('★ settingsForPage 返回 settings/defaults 两层', JSON.stringify(Object.keys(page).sort()), JSON.stringify(['defaults', 'settings']))
    const pageKeys = Object.keys(page.settings).sort()
    check('★ 两层键集合一致', JSON.stringify(Object.keys(page.defaults).sort()), JSON.stringify(pageKeys))
    check('★ 设置项就是这九项', JSON.stringify(pageKeys), JSON.stringify(['allowCrossSessionNotify', 'autoReplyAttachments', 'maxReplyChars', 'mergeWindowMs', 'permissionPreset', 'presenceNote', 'requireConfirmation', 'settleMs', 'workspacePath']))
    const defaults = page.defaults
    check('默认预设与微信一致', defaults.permissionPreset, 'danger-full-access')
    check('默认确认策略与微信一致', defaults.requireConfirmation, true)
    check('默认跨会话推送与微信一致', defaults.allowCrossSessionNotify, true)
    check('默认静默窗口与微信一致', defaults.settleMs, 1200)
    check('★ 默认合并窗口与微信一致（10 秒）', defaults.mergeWindowMs, 10000)
    check('★ 默认自动回应附件与微信一致', defaults.autoReplyAttachments, true)
    check('★ 默认回复字数上限与微信一致（4000）', defaults.maxReplyChars, 4000)
    // 这段说明的**每一句都对应一种真实发生过的答非所问**，所以逐句钉住，而不是只比长度。
    check('★ presenceNote 说明对方在手机', defaults.presenceNote.includes('在手机上'), true)
    check('★ presenceNote 说明看不到屏幕与文件系统', defaults.presenceNote.includes('看不到这台电脑的屏幕和文件系统'), true)
    check('★ presenceNote 要求直接发送而不是让用户去看路径', defaults.presenceNote.includes('不要让他去'), true)
    check('★ presenceNote 要求回复简短', defaults.presenceNote.includes('回复尽量简短'), true)
    check('presenceNote 标注的渠道是 QQ', defaults.presenceNote.includes('[渠道：QQ]'), true)

    // ★ 扫码状态词表必须与设置页客户端契约一致（它认 phase 与 qrDataUrl）
    const bind = runtime.bindSnapshot()
    check('★ 扫码状态用 phase 而不是 status', 'phase' in bind && !('status' in bind), true)
    check('初始 phase 是 idle', bind.phase, 'idle')
    const { QqBindSession } = await import('../lib/login.js')
    const session = new QqBindSession({})
    check('新建会话 phase 是 idle', session.snapshot().phase, 'idle')
    check('取消后仍是 idle', (session.cancel(), session.snapshot().phase), 'idle')

    // ★ 中间态必须是 running + step，不能是自定义 phase。
    // 微信的设置页只在 `phase === 'running'` 时轮询扫码状态；若 start() 返回 'starting'，
    // 轮询永不启动、二维码永不出现（表现为「点了开始扫码什么都没发生」）。
    const started = await session.start()
    check('★ start() 后 phase 是 running（不是 starting）', started.phase, 'running')
    check('★ 中间态用 step 表达', typeof started.step, 'string')
    check('★ running 是唯一的进行中 phase', ['idle', 'running', 'succeeded', 'already-bound', 'failed'].includes(started.phase), true)
    session.cancel()

    // 设置持久化往返
    const settingsFile = join(dir, 'persist.json')
    const makeRuntime = () =>
      new QqRuntime(ctx, {
        home: dir,
        stateFile: settingsFile,
        workspace: join(dir, 'ws-persist'),
        credentials,
      })
    const writer = makeRuntime()
    writer.applySettings({ permissionPreset: 'auto', requireConfirmation: false, settleMs: 700, allowCrossSessionNotify: false })
    // 写盘是 fire-and-forget，等一拍
    await new Promise((resolve) => setTimeout(resolve, 120))
    const reader = makeRuntime()
    await reader.hydrateSettings()
    const restored = reader.settingsSnapshot()
    check('★ 权限预设被持久化', restored.permissionPreset, 'auto')
    check('★ requireConfirmation 被持久化', restored.requireConfirmation, false)
    check('★ allowCrossSessionNotify 被持久化', restored.allowCrossSessionNotify, false)
    check('★ settleMs 被持久化', restored.settleMs, 700)

    // 老状态文件（没有 settings 块）必须仍然可读，且回落默认值
    const legacyFile = join(dir, 'legacy.json')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(legacyFile, JSON.stringify({ version: 1, accounts: {}, bindings: {}, autoStart: true }), 'utf8')
    const legacy = new QqRuntime(ctx, { home: dir, stateFile: legacyFile, workspace: join(dir, 'ws-legacy'), credentials })
    await legacy.hydrateSettings()
    check('★ 老状态文件回落默认预设', legacy.settingsSnapshot().permissionPreset, 'danger-full-access')
    check('★ 老状态文件回落默认 settleMs', legacy.settingsSnapshot().settleMs, 1200)

    // ---- 数值设置的上下限与取整（细节：上限是防打错，不是格式规则）----
    runtime.applySettings({ mergeWindowMs: 10_000, settleMs: 1200, maxReplyChars: 4000 })
    runtime.applySettings({ mergeWindowMs: 36_000_000 })
    check('★ 超过上限的窗口被丢弃（保持原值）', runtime.settingsSnapshot().mergeWindowMs, 10_000)
    runtime.applySettings({ mergeWindowMs: 5000.7 })
    check('★ 合法值被取整', runtime.settingsSnapshot().mergeWindowMs, 5001)
    runtime.applySettings({ maxReplyChars: 999_999_999 })
    check('★ 超过字数上限被丢弃（保持原值）', runtime.settingsSnapshot().maxReplyChars, 4000)
    runtime.applySettings({ maxReplyChars: 0 })
    check('★ maxReplyChars=0（不限制）是合法值，不被上限逻辑拦掉', runtime.settingsSnapshot().maxReplyChars, 0)
    runtime.applySettings({ settleMs: -1 })
    check('★ 负数被丢弃（保持原值）', runtime.settingsSnapshot().settleMs, 1200)
    runtime.applySettings({ settleMs: 1.4 })
    check('★ 小数被取整而不是原样存下', runtime.settingsSnapshot().settleMs, 1)
    runtime.applySettings({ settleMs: Number.NaN })
    check('★ NaN 被丢弃', runtime.settingsSnapshot().settleMs, 1)
    runtime.applySettings({ settleMs: '500' })
    check('★ 字符串被丢弃（不改类型）', runtime.settingsSnapshot().settleMs, 1)
    // 上限本身是合法的
    runtime.applySettings({ settleMs: 3_600_000 })
    check('恰好等于上限是合法的', runtime.settingsSnapshot().settleMs, 3_600_000)

    // ---- allowCrossSessionNotify 关闭时是 fail-closed ----
    // 这条是审查时发现的死设置：它以前只存在于设置面板的读写管线里，没有任何强制点。
    runtime.applySettings({ allowCrossSessionNotify: false })
    const stateFileForNotify = join(dir, 'notify-state.json')
    const { writeFileSync: writeState } = await import('node:fs')
    writeState(
      stateFileForNotify,
      JSON.stringify({
        version: 1,
        accounts: { '111': { appId: '111', enabled: true } },
        bindings: { '111:E56C': { conversationId: '111:E56C', accountId: '111', peerId: 'E56C', sessionId: 'session-bound', title: 'qq' } },
        settings: { allowCrossSessionNotify: false },
        autoStart: true,
      }),
      'utf8',
    )
    const notifier = new QqRuntime(ctx, {
      home: dir,
      stateFile: stateFileForNotify,
      workspace: join(dir, 'ws-notify'),
      credentials,
    })
    await notifier.hydrateSettings()
    check('★ 关闭跨会话推送被持久化读回', notifier.settingsSnapshot().allowCrossSessionNotify, false)
    // 调用者不是绑定的那个会话 → 必须**拒绝**，而不是退回"推给当前绑定的"
    let rejected = false
    try {
      await notifier.notifyFromTool({ text: '你好' }, { agent: { session: { id: 'session-other' } } })
    } catch (error) {
      rejected = error instanceof Error && error.message.includes('允许任意会话主动推送')
    }
    check('★ 关闭时未绑定会话的推送被拒绝（fail-closed）', rejected, true)
    // 调用者就是绑定的那个会话 → 允许，只是发不出去（无 bot）所以进队列
    const queued = await notifier.notifyFromTool({ text: '你好' }, { agent: { session: { id: 'session-bound' } } })
    check('★ 关闭时绑定会话仍可推送', queued.includes('排队'), true)
    const queuedState = JSON.parse((await import('node:fs')).readFileSync(stateFileForNotify, 'utf8'))
    check('★ 入队确实落到了状态文件', (queuedState.pendingNotifications ?? []).length, 1)
    check('入队条目记的是本对话', queuedState.pendingNotifications[0].conversationId, '111:E56C')

    // ---- 会话文件夹路径：坏路径只能"没生效"，绝不能"起不来" ----
    // 这是设置页里唯一一个可以让插件启动失败的地方，所以运行时这一层必须兜住。
    const originalWorkspace = (await runtime.status()).workspace
    let wsThrew = false
    try {
      runtime.applySettings({ workspacePath: 'relative-not-absolute' })
    } catch {
      wsThrew = true
    }
    check('★ 坏路径不让 applySettings 抛', wsThrew, false)
    check('★ 坏路径不生效（仍用原工作区）', (await runtime.status()).workspace, originalWorkspace)
    check('★ 设置页仍显示用户填的原文（好让用户能改）', runtime.settingsSnapshot().workspacePath, 'relative-not-absolute')
    // 合法路径立即生效
    const customWorkspace = join(dir, 'ws-custom')
    runtime.applySettings({ workspacePath: customWorkspace })
    check('★ 合法路径立即生效', (await runtime.status()).workspace, customWorkspace)
    // 空串回到默认
    runtime.applySettings({ workspacePath: '' })
    const backToDefault = (await runtime.status()).workspace
    check('★ 空串回到默认位置（以 dsh_qq 结尾）', backToDefault.endsWith('dsh_qq'), true)
    check('★ 回到默认后工作区缓存被清（id 会重新解析）', backToDefault !== customWorkspace, true)

    // 缺服务时的降级：不应该抛
    const bare = new QqRuntime({ get: () => undefined }, {
      home: dir,
      stateFile: join(dir, 's2.json'),
      workspace: join(dir, 'ws2'),
      credentials,
    })
    check('★ 无任何服务时不抛', bare.settingsSnapshot().permissionPreset, 'danger-full-access')
    check('★ 无权限预设服务时 available 为空且有说明', JSON.stringify([bare.permissionPresetsInfo().available, typeof bare.permissionPresetsInfo().note]), JSON.stringify([[], 'string']))
    const dispose = bare.registerTools()
    check('★ 无工具服务时返回可调用的清理函数', typeof dispose, 'function')
    dispose()
    bare.disposeTools()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---- 入站媒体：分类、选 URL、描述 ------------------------------------------
{
  const m = await import('../lib/media.js')

  // 分类：content_type 优先，缺失时退回文件名后缀
  check('image/png → 图片', m.attachmentKind({ content_type: 'image/png' }), 'image')
  check('video/mp4 → 视频', m.attachmentKind({ content_type: 'video/mp4' }), 'video')
  check('audio/wav → 语音', m.attachmentKind({ content_type: 'audio/wav' }), 'voice')
  check('voice → 语音', m.attachmentKind({ content_type: 'voice' }), 'voice')
  check('★ content_type 缺失时用后缀兜底', m.attachmentKind({ filename: '照片.JPG' }), 'image')
  check('★ 无类型无后缀 → 文件', m.attachmentKind({}), 'file')
  check('file → 文件', m.attachmentKind({ content_type: 'file' }), 'file')

  // 选 URL：语音优先服务端转好的 WAV
  check('★ 语音优先 voice_wav_url（不用 SILK）', m.downloadUrlFor({ voice_wav_url: 'wav://a', url: 'silk://b' }), 'wav://a')
  check('没有 voice_wav_url 时退回 url', m.downloadUrlFor({ url: 'x://c' }), 'x://c')
  check('都没有时 undefined', m.downloadUrlFor({}), undefined)

  // 描述：语音多给转写，决定 agent 要不要碰文件
  const described = m.describeMedia({ path: 'C:\\m\\a.png', bytes: 2048, kind: 'image' })
  check('描述含类别与路径', described.startsWith('[图片] C:\\m\\a.png'), true)
  check('描述含可读大小', described.includes('2.0 KB'), true)
  check('小于 1KB 用 B', m.describeMedia({ path: 'p', bytes: 512, kind: 'file' }).includes('512 B'), true)

  const voiceDescribed = m.describeMedia({ path: 'C:\\m\\v.wav', bytes: 100, kind: 'voice', transcript: '今天天气怎么样' })
  check('★ 语音描述带服务端转写', voiceDescribed.includes('服务端转写：今天天气怎么样'), true)
  // QQ 服务端直接给 WAV，所以微信那句"仍是原始 SILK"的免责说明不该出现
  check('★ 不含 SILK 免责（QQ 不需要）', voiceDescribed.includes('SILK'), false)

  // 下载失败必须留痕，不能让用户的图无声消失
  check('★ 下载失败有说明而不是沉默', m.describeMissing({ filename: 'a.png' }, 0), '[附件 a.png]（未能下载到本地，agent 无法读取）')
  check('无文件名时用序号兜底', m.describeMissing({}, 2).includes('附件3'), true)

  // 媒体目录按需创建
  const { mkdtempSync, existsSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-media-'))
  try {
    // 参数是**工作区路径本身**（不是 home + 目录名）——路径可自定义后媒体必须跟着走
    const workspace = join(dir, 'dsh_qq')
    const made = m.mediaDir(workspace)
    check('★ 媒体目录被创建', existsSync(made), true)
    check('媒体目录在工作区之下', made.startsWith(workspace), true)
    check('媒体目录名与微信同形（中文）', made.endsWith(m.MEDIA_DIR_NAME), true)
    const custom = join(dir, '我的QQ会话')
    check('★ 自定义工作区时媒体落在自定义目录下', m.mediaDir(custom).startsWith(custom), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---- 长回复降级决策 --------------------------------------------------------
{
  const r = await import('../lib/reply-limit.js')

  const short = r.planReply('你好', 4000)
  check('短回复原样发送', JSON.stringify(short), JSON.stringify({ kind: 'send', text: '你好' }))
  check('恰好等于上限时原样发送', r.planReply('a'.repeat(4000), 4000).kind, 'send')

  // ★ <= 0 是"不限制"，不是"全部截断"——这条最易写反
  const unlimited = r.planReply('a'.repeat(9000), 0)
  check('★ limit=0 表示不限制（不是截断）', unlimited.kind, 'send')
  check('★ limit=0 时文本完整保留', unlimited.text.length, 9000)
  const negative = r.planReply('a'.repeat(9000), -1)
  check('负数也当不限制', negative.text.length, 9000)

  const long = r.planReply('a'.repeat(4001), 4000)
  check('超限时走文件', long.kind, 'file')
  check('超限时保留完整正文', long.text.length, 4001)
  check('★ caption 报出真实字数', long.caption, '回复较长（4001 字），已作为文件发送。')

  // 文件名：带时间戳、扩展名是 .md
  const name = r.longReplyFileName(new Date('2026-10-10T12:34:56.789Z'))
  check('文件名带时间戳且不含冒号点', name.includes('2026-10-10T12-34-56-789Z'), true)
  check('文件扩展名是 .md', name.endsWith('.md'), true)
  check('文件名词头是 回复-', name.startsWith('回复-'), true)
  // 两次调用不能撞名（同目录里会互相覆盖）
  check('★ 不同时刻文件名不同', r.longReplyFileName(new Date(1)) !== r.longReplyFileName(new Date(2)), true)
}

// ---- 待发消息队列 ----------------------------------------------------------
// 「发不出去」和「丢掉」是两回事。这一节钉住队列的边界行为。
{
  const p = await import('../lib/pending.js')

  const state = {}
  const dropped = p.queuePendingNotification(state, { conversationId: 'c1', text: '干完了' }, 1000)
  check('入队返回丢弃数 0', dropped, 0)
  check('队列里有 1 条', state.pendingNotifications.length, 1)
  check('条目带 id', typeof state.pendingNotifications[0].id, 'string')
  check('条目记下 queuedAt', state.pendingNotifications[0].queuedAt, 1000)
  check('只有文字时不带 path 键', 'path' in state.pendingNotifications[0], false)

  p.queuePendingNotification(state, { conversationId: 'c1', text: '', path: 'C:\\a.png' }, 1001)
  check('带文件时记录 path', state.pendingNotifications[1].path, 'C:\\a.png')

  // ★ 队列上限：丢最旧的
  const tiny = { pendingNotifications: [] }
  for (let i = 0; i < p.PENDING_QUEUE_LIMIT + 3; i += 1) {
    p.queuePendingNotification(tiny, { conversationId: 'c1', text: `m${String(i)}` }, 2000 + i)
  }
  check('★ 队列被截到上限', tiny.pendingNotifications.length, p.PENDING_QUEUE_LIMIT)
  check('★ 丢的是最旧的（最早那条已不在）', tiny.pendingNotifications.some((e) => e.text === 'm0'), false)
  check('★ 最新的那条还在', tiny.pendingNotifications.at(-1).text, `m${String(p.PENDING_QUEUE_LIMIT + 2)}`)

  // 过期
  const old = {}
  p.queuePendingNotification(old, { conversationId: 'c1', text: '很旧' }, 0)
  p.queuePendingNotification(old, { conversationId: 'c1', text: '很新' }, 10_000)
  const expired = p.expirePendingNotifications(old, 10_000, 5000)
  check('★ 过期只丢超龄的', expired.length, 1)
  check('★ 未超龄的被保留', old.pendingNotifications.length, 1)
  check('保留的是新的那条', old.pendingNotifications[0].text, '很新')
  check('★ 全部过期时删掉整个字段', (() => { const s = {}; p.queuePendingNotification(s, { conversationId: 'c', text: 'x' }, 0); p.expirePendingNotifications(s, 10_000_000, 1000); return 'pendingNotifications' in s })(), false)

  // 按对话筛选、保持顺序
  const mixed = {}
  p.queuePendingNotification(mixed, { conversationId: 'c1', text: 'a' }, 1)
  p.queuePendingNotification(mixed, { conversationId: 'c2', text: 'b' }, 2)
  p.queuePendingNotification(mixed, { conversationId: 'c1', text: 'c' }, 3)
  check('★ 只取本对话的，且保持先后顺序', p.pendingFor(mixed, 'c1').map((e) => e.text).join(''), 'ac')
  check('别的对话取到自己的', p.pendingFor(mixed, 'c2').map((e) => e.text).join(''), 'b')
  check('没有条目时返回空数组', p.pendingFor({}, 'c1').length, 0)

  // 移除
  const id = p.pendingFor(mixed, 'c1')[0].id
  check('移除成功', p.dropPending(mixed, id), true)
  check('移除后只剩一条 c1', p.pendingFor(mixed, 'c1').length, 1)
  check('移除不存在的 id 返回 false', p.dropPending(mixed, 'nope'), false)

  // 归一化：坏条目丢掉而不是整体拒绝
  const norm = p.normalizePending([
    { id: 'a', conversationId: 'c', text: 'ok', queuedAt: 1 },
    { id: '', conversationId: 'c', text: 'x', queuedAt: 1 },
    { id: 'b', conversationId: '', text: 'x', queuedAt: 1 },
    { id: 'c', conversationId: 'c', text: 'x', queuedAt: 'nope' },
    null,
    'string',
  ])
  check('★ 坏条目被逐条丢弃，好的留下', JSON.stringify(norm.map((e) => e.id)), JSON.stringify(['a']))
  check('非数组输入返回空', p.normalizePending('nope').length, 0)
  check('缺 text 时补空串', p.normalizePending([{ id: 'z', conversationId: 'c', queuedAt: 5 }])[0].text, '')
  // 下载重试：只重试"可能是瞬时"的失败，持久失败不浪费时间
  {
    const m = await import('../lib/media.js')
    const { mkdtempSync, rmSync, existsSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-dl-'))
    const realFetch = globalThis.fetch
    try {
      // ① 404（链接过期）→ 不该重试
      let calls = 0
      globalThis.fetch = async () => {
        calls += 1
        return { ok: false, status: 404, headers: new Map() }
      }
      const notFound = await m.downloadAttachment({
        attachment: { url: 'https://x/expired.png', content_type: 'image/png' },
        dir,
        index: 0,
      })
      check('★ 404 不重试（链接过期，重试无意义）', calls, 1)

      // ② 500 两次后成功 → 应该重试并最终拿到文件
      calls = 0
      globalThis.fetch = async () => {
        calls += 1
        if (calls < 3) return { ok: false, status: 500, headers: new Map() }
        return {
          ok: true,
          status: 200,
          headers: new Map([['content-length', '5']]),
          arrayBuffer: async () => new Uint8Array([1, 2, 3, 4, 5]).buffer,
        }
      }
      const recovered = await m.downloadAttachment({
        attachment: { url: 'https://x/ok.png', content_type: 'image/png', asr_refer_text: '' },
        dir,
        index: 1,
      })
      check('★ 5xx 会重试', calls, 3)
      check('★ 重试后成功并落盘', recovered !== undefined && existsSync(recovered.path), true)
      check('重试成功后字节数正确', recovered.bytes, 5)

      // ③ 一直 5xx → 4 次后放弃，返回 undefined（而不是抛）
      calls = 0
      globalThis.fetch = async () => {
        calls += 1
        return { ok: false, status: 503, headers: new Map() }
      }
      const gaveUp = await m.downloadAttachment({
        attachment: { url: 'https://x/down.png', content_type: 'image/png' },
        dir,
        index: 2,
      })
      check('★ 持续失败试满 4 次后放弃', calls, 4)
      check('★ 放弃时返回 undefined 而不是抛', gaveUp, undefined)

      // ④ 网络异常（fetch 抛）也要重试
      calls = 0
      globalThis.fetch = async () => {
        calls += 1
        if (calls < 2) throw new Error('ECONNRESET')
        return {
          ok: true,
          status: 200,
          headers: new Map(),
          arrayBuffer: async () => new Uint8Array([9]).buffer,
        }
      }
      const afterThrow = await m.downloadAttachment({
        attachment: { url: 'https://x/flaky.png', content_type: 'image/png' },
        dir,
        index: 3,
      })
      check('★ 网络异常会重试', calls, 2)
      check('网络异常后成功', afterThrow !== undefined, true)

      // ⑤ 没有 URL 时直接跳过，不该发起任何请求
      calls = 0
      globalThis.fetch = async () => {
        calls += 1
        throw new Error('不该被调用')
      }
      const noUrl = await m.downloadAttachment({ attachment: { content_type: 'image/png' }, dir, index: 4 })
      check('无 URL 时不发请求', calls, 0)
      check('无 URL 时返回 undefined', noUrl, undefined)
    } finally {
      globalThis.fetch = realFetch
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

// ---- 会话文件夹路径校验（坏路径只能"没生效"，不能"起不来"）----------------
{
  const { mkdtempSync, rmSync, existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const p = await import('../lib/paths.js')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-ws-'))
  try {
    const fallback = join(dir, p.WORKSPACE_DIR_NAME)

    check('空串 → 默认位置，不算回落', JSON.stringify(p.resolveWorkspaceDir(dir, '')), JSON.stringify({ path: fallback, fellBack: false }))
    check('未定义 → 默认位置', p.resolveWorkspaceDir(dir, undefined).path, fallback)
    check('只有空白 → 默认位置', p.resolveWorkspaceDir(dir, '   ').path, fallback)

    // ★ 相对路径必须被拒：它会相对于进程 cwd 解析，和用户以为的位置不是一回事
    const relative = p.resolveWorkspaceDir(dir, 'my-qq-folder')
    check('★ 相对路径被拒并回落', relative.fellBack, true)
    check('★ 相对路径回落时不抛（值仍然可用）', relative.path, fallback)
    check('★ 拒的理由说清是绝对路径问题', String(relative.reason).includes('不是绝对路径'), true)

    // 合法的绝对路径
    const custom = join(dir, '我的QQ会话')
    const accepted = p.resolveWorkspaceDir(dir, custom)
    check('★ 合法绝对路径被接受', accepted.path, custom)
    check('★ 被接受时不标记回落', accepted.fellBack, false)
    check('★ 目录真的被建出来了', existsSync(custom), true)

    // 不可用的绝对路径（Windows 上不存在的盘符）
    const bad = p.resolveWorkspaceDir(dir, 'Z:\\不存在的盘\\QQ')
    check('★ 不可用的绝对路径被拒并回落', bad.fellBack, true)
    check('★ 不可用时值仍然可用（不抛）', bad.path, fallback)
    check('回落时给出理由', typeof bad.reason, 'string')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---- StateStore 真实磁盘往返 ★ ---------------------------------------------
// 这一节是为了一个已经踩过的坑而加的：`readFile` 曾从 `node:fs`（回调版）导入，
// 于是每次读都是空状态、每次写只写回自己那一半，accounts 与 bindings 互相覆盖。
// 纯函数测试抓不到它——必须真的落盘再读回来。
{
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-state-'))
  const file = join(dir, 'state.json')
  try {
    const { StateStore } = state
    const errors = []
    const store = new StateStore(file, { onError: (m) => errors.push(m) })

    check('新文件读出来是空状态', Object.keys((await store.read()).accounts).length, 0)
    check('新文件不产生错误上报', errors.length, 0)

    // 模拟真实写入序列：先写 accounts，再写 bindings —— 第二次不能抹掉第一次。
    await store.update((next) => {
      next.accounts['1905760478'] = { appId: '1905760478', userOpenid: 'u1', enabled: true }
    })
    await store.update((next) => {
      next.bindings['1905760478:u1'] = {
        conversationId: '1905760478:u1',
        accountId: '1905760478',
        peerId: 'u1',
        sessionId: 's-1',
        title: 'QQ s-1',
        createdAt: 1,
        lastUsedAt: 1,
      }
    })

    const after = await store.read()
    check('★ 第二次写入没有抹掉 accounts', Object.keys(after.accounts).length, 1)
    check('★ 第二次写入保留了 bindings', Object.keys(after.bindings).length, 1)
    check('两个字段都在同一份文件里', JSON.stringify(Object.keys(after).sort()), JSON.stringify(['accounts', 'autoStart', 'bindings', 'pendingNotifications', 'settings', 'version']))

    // 换一个实例读同一个文件，确认真的落盘了（而不是内存里的假象）。
    const reopened = await new StateStore(file).read()
    check('★ 新实例能读回 accounts', Object.keys(reopened.accounts).length, 1)
    check('★ 新实例能读回 bindings', Object.keys(reopened.bindings).length, 1)

    // 并发写必须串行，不能互相覆盖。
    await Promise.all([
      store.update((next) => {
        next.accounts['a'] = { appId: 'a', enabled: true }
      }),
      store.update((next) => {
        next.accounts['b'] = { appId: 'b', enabled: true }
      }),
    ])
    const concurrent = await store.read()
    check('★ 并发写不丢数据', Object.keys(concurrent.accounts).length, 3)

    // 损坏文件：应留档并从空状态继续，且上报。
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, '{ 这不是 JSON', 'utf8')
    const corruptStore = new StateStore(file, { onError: (m) => errors.push(m) })
    check('损坏文件回退为空状态', Object.keys((await corruptStore.read()).accounts).length, 0)
    check('损坏文件会上报', errors.some((m) => m.includes('损坏')), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
