/**
 * 完成提醒与 `/list all` 平铺视图的自检。
 *
 * 与三个主套件分开：那三套的检查数被 README/RELEASING 的"782/108/60"钉着，
 * 新功能的断言放这里，加多少都不会让文档里的数字失真。
 *
 * 这里只测**纯逻辑**（消息文本、排序、分页编号、设置默认值）——
 * "宿主真的事件顺序"与"手机上看起来对不对"只能真机验证，不在这里冒充。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  COMPLETION_MAX_VISIBLE,
  completionLabel,
  composeCompletionNotice,
  composeWaitingNotice,
  formatDetailReply,
  truncateAnswer,
} from '../lib/completion-notify.js'
import * as router from '../lib/router.js'
import * as settings from '../lib/settings.js'
import * as si from '../lib/session-index.js'

let passed = 0
let failed = 0
const failures = []

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    passed += 1
    console.log(`PASS  ${name}`)
  } else {
    failed += 1
    failures.push(name)
    console.log(`FAIL  ${name}  期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

const entry = (overrides = {}) => ({
  sessionId: 'session-abcdef-0000',
  title: '修登录',
  project: '项目甲',
  text: '这是回答正文',
  at: 1_000,
  ...overrides,
})

// ---- 一、完成提醒的消息文本：只有一行状态，没有任何多余提示 ----
{
  const text = composeCompletionNotice([entry()])
  check('★ 单条完成提醒只有一行', text.split('\n').length, 1)
  check('★ 单条完成提醒的格式', text, '「项目甲 · 修登录」已结束任务')
  check('★ 单条完成提醒不带回答摘要', text.includes('这是回答正文'), false)
  check('★ 单条完成提醒不带任何操作提示', text.includes('/detail') || text.includes('/switch'), false)

  const bare = composeCompletionNotice([entry({ project: '' })])
  check('没有项目名时只印对话名', bare, '「修登录」已结束任务')

  const untitled = composeCompletionNotice([entry({ title: '' })])
  check('没有标题时印占位而不是空引号', untitled, '「项目甲 · (无标题)」已结束任务')

  check('空列表不产生消息', composeCompletionNotice([]), '')

  const merged = composeCompletionNotice([
    entry({ sessionId: 'session-111111-0000', title: '修登录', at: 1 }),
    entry({ sessionId: 'session-222222-0000', title: '写周报', project: '项目乙', at: 2 }),
    entry({ sessionId: 'session-333333-0000', title: '别的', project: '项目甲', at: 3 }),
  ])
  check('★ 多条完成合并成一条（首行报数量）', merged.split('\n')[0], '3 个对话已结束任务：')
  check('★ 合并消息逐条列出项目与对话名', merged.includes('· 项目甲 · 修登录') && merged.includes('· 项目乙 · 写周报'), true)
  check('★ 合并消息同样不带操作提示', merged.includes('/detail') || merged.includes('/switch'), false)

  const many = composeCompletionNotice(
    Array.from({ length: COMPLETION_MAX_VISIBLE + 3 }, (_, index) =>
      entry({ sessionId: `session-${String(index).padStart(6, '0')}-0000`, title: `对话${String(index)}`, at: index }),
    ),
  )
  check('★ 合并消息最多列 5 个，其余折叠', many.includes('…等 8 个') && many.split('\n').filter((line) => line.startsWith('· ')).length, 5)
}

// ---- 二、/detail 的文本与截断 ----
{
  check('★ 回答不超限时原样显示', truncateAnswer('短回答', 0), '短回答')
  check('★ 0 表示不限制', truncateAnswer('a'.repeat(2_000), 0).length, 2_000)
  const cut = truncateAnswer('a'.repeat(1_200), 1_000)
  check('★ 超限时截断并说明还有多少字', cut.startsWith('a'.repeat(1_000)) && cut.includes('还有 200 字'), true)

  const reply = formatDetailReply(entry(), 1_000)
  check('★ /detail 带标题与正文', reply.startsWith('「项目甲 · 修登录」的最后回答：') && reply.includes('这是回答正文'), true)
  check('★ /detail 不带切换提示', reply.includes('/switch'), false)

  const empty = formatDetailReply(entry({ text: '' }), 1_000)
  check('★ 没有文字回答时给出人话', empty.includes('（这次没有文字回答）'), true)

  check('completionLabel 在项目为空时只取标题', completionLabel(entry({ project: '' })), '修登录')
}

// ---- 三、/list all 的排序、分组与编号 ----
{
  const SELF = 'C:\\me\\dsh_qq'
  const row = (n, updatedAt, workspace) => ({
    sessionId: `session-${String(n).padStart(6, '0')}-0000`,
    title: `对话${String(n)}`,
    updatedAt,
    ...(workspace === undefined ? {} : { workspace }),
  })

  const own = [row(1, 100), row(2, 90), row(3, 80)]
  const projectA = { 'C:\\me\\项目甲': [row(11, 300), row(12, 200)] }
  const projectB = { 'C:\\me\\项目乙': [row(21, 50)] }
  const rows = [
    ...own,
    ...Object.entries(projectA).flatMap(([workspace, list]) => list.map((session) => ({ ...session, workspace }))),
    ...Object.entries(projectB).flatMap(([workspace, list]) => list.map((session) => ({ ...session, workspace }))),
  ]

  const flat = router.allSessionRows(rows, SELF)
  check('★ 本工作区排最前（按最近活跃）', flat.slice(0, 3).map((session) => session.title), ['对话1', '对话2', '对话3'])
  check('★ 项目组之间按各组最新会话排', flat.slice(3).map((session) => session.title), ['对话11', '对话12', '对话21'])
  check('平铺结果保留原有字段', flat[0].sessionId, 'session-000001-0000')

  const screen = router.renderAllScreen(flat, { ownWorkspace: SELF, ownLabel: 'QQ 会话', page: 1 })
  check('★ 平铺清单标题带屏号', screen.text.startsWith('全部对话（1/1）'), true)
  check('★ 项目作为分组标题', screen.text.includes('【QQ 会话】') && screen.text.includes('【项目甲】') && screen.text.includes('【项目乙】'), true)
  check('★ 行复用会话行格式（编号 + 标题 + 短 id）', screen.text.includes('4. 对话11'), true)
  check('★ numbered 与印出的行逐行一致', JSON.stringify([screen.numbered.first, screen.numbered.sessions.length, screen.numbered.sessions[3].sessionId]), JSON.stringify([1, 6, 'session-000011-0000']))
  check('★ 一页装不下时邀请翻页', screen.text.includes('查看其余'), false)

  // workspaceTitle（注册表里的项目标题）优先于目录末段
  const titled = flat.map((session) =>
    session.workspace === 'C:\\me\\项目甲' ? { ...session, workspaceTitle: '甲项目（自定义名）' } : session,
  )
  const titledScreen = router.renderAllScreen(titled, { ownWorkspace: SELF, ownLabel: 'QQ 会话', page: 1 })
  check('★ 项目名优先用注册表标题', titledScreen.text.includes('【甲项目（自定义名）】'), true)

  const many = Array.from({ length: 25 }, (_, index) => row(index + 1, 2_000 - index))
  const page1 = router.renderAllScreen(many, { ownWorkspace: SELF, ownLabel: 'QQ 会话', page: 1 })
  const page2 = router.renderAllScreen(many, { ownWorkspace: SELF, ownLabel: 'QQ 会话', page: 2 })
  check('★ 每屏 10 条', page1.text.split('\n').filter((line) => /^\d+\. /.test(line)).length, 10)
  check('★ 编号跨屏连续（第二屏从 11 起）', [page2.numbered.first, page2.text.includes('11. 对话11')], [11, true])
}

// ---- 四、新设置项的默认值与归档过滤数据源 ----
{
  check('★ completionNotify 默认开', settings.SETTINGS_DEFAULTS.completionNotify, true)
  check('★ completionDetailChars 默认 1000', settings.SETTINGS_DEFAULTS.completionDetailChars, 1_000)
  check('★ 两个新设置项都进了 schema 键集', JSON.stringify(['completionNotify', 'completionDetailChars'].filter((key) => settings.SETTINGS_KEYS.includes(key))), JSON.stringify(['completionNotify', 'completionDetailChars']))

  const home = join(tmpdir(), `dsh-qq-notify-test-${String(Date.now())}`)
  try {
    mkdirSync(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
    writeFileSync(
      join(home, 'storages', 'session_projcache', 'sessions', 'abc.json'),
      JSON.stringify({
        record: {
          identity: { cwd: 'C:\\me\\项目甲', createdAt: 5 },
          rows: { title: { val: '修登录' }, sessionListMetadata: { val: { lastPromptAt: 7 } } },
        },
      }),
      'utf8',
    )
    const read = await si.readStoredSession(home, 'abc')
    check('★ readStoredSession 读得出标题/cwd/时间', JSON.stringify([read.title, read.cwd, read.updatedAt]), JSON.stringify(['修登录', 'C:\\me\\项目甲', 7]))
    check('★ 没有记录时返回 undefined', await si.readStoredSession(home, 'not-there'), undefined)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

// ---- 五、"在等你回答"的提醒：只有一行状态，没有问题摘要 ----
{
  check('★ 提问提醒只报状态', composeWaitingNotice({ title: '修登录', project: '项目甲', kind: 'question' }), '「项目甲 · 修登录」在等你回答')
  check('★ 审批提醒措辞区分确认', composeWaitingNotice({ title: '修登录', project: '项目甲', kind: 'approval' }), '「项目甲 · 修登录」在等你确认操作')
  check('★ 没有项目时只印对话名', composeWaitingNotice({ title: '修登录', project: '', kind: 'question' }), '「修登录」在等你回答')
  check('★ 提醒里不含问题/摘要文本', composeWaitingNotice({ title: '修登录', project: '项目甲', kind: 'question' }).includes('：'), false)
}

console.log('')
if (failures.length > 0) {
  console.log(`失败 ${String(failures.length)} 项：`)
  for (const name of failures) console.log(`  - ${name}`)
  process.exitCode = 1
} else {
  console.log(`=== ${String(passed)}/${String(passed)} checks passed ===`)
}
