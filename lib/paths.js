/**
 * 路径解析。
 *
 * 两条硬约束，都来自微信插件的事故记录：
 *
 * 1. **会话工作目录必须恒定。** 宿主在"采用"一个已存在会话时会比对 `cwd`，不一致直接抛
 *    `ApiSessionCwdConflict`，那个会话就永远接不回来了。所以它是常量，不是每个对话一个目录。
 *
 * 2. **目录必须在 apply 阶段就创建。** 宿主用 `realpath` 解析 `cwd`，目录不存在时第一条消息
 *    会以 `ENOENT` 失败，用户只看到"处理这条消息时出错了"。微信插件当年因为"只在有附件时才建目录"
 *    而把这个问题藏了很久。
 *
 * @module dsh-qq/paths
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { describeError } from './log.js'

/** 会话工作目录名。放在 `$DSH_HOME` 下，桌面上好认。 */
export const WORKSPACE_DIR_NAME = 'dsh_qq'

/** 状态文件所在目录名。 */
export const STATE_DIR_NAME = 'qq'

/**
 * 解析 DSH 主目录。
 *
 * 三级回退，按可靠性排序。实测：**宿主进程内 `DSH_HOME` 是未设置的**
 * （只有 shell 调用里才有），而 `homePaths` 服务在桌面端组合里**不存在**，
 * 所以生产上通常落到第三级——这不是异常路径，是主路径。
 *
 * @param ctx - 宿主上下文。
 */
export function resolveHome(ctx) {
  const fromService = safeServiceHome(ctx)
  if (fromService !== undefined) return fromService
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

function safeServiceHome(ctx) {
  try {
    const homePaths = typeof ctx.get === 'function' ? ctx.get('homePaths') : undefined
    const home = homePaths?.home
    if (typeof home === 'string' && home.trim() !== '') return home.trim()
  } catch {
    // 服务探测失败不能影响插件加载。
  }
  return undefined
}

/**
 * 解析状态文件与会话工作目录，并**确保工作目录存在**。
 *
 * @param ctx - 宿主上下文。
 * @param config - patch 里的 config。
 * @returns `{ home, stateFile, workspace }`
 */
export function resolvePaths(ctx, config = {}) {
  const home = resolveHome(ctx)
  const workspace =
    typeof config.workspace === 'string' && config.workspace.trim() !== ''
      ? config.workspace.trim()
      : join(home, WORKSPACE_DIR_NAME)
  const stateFile =
    typeof config.stateFile === 'string' && config.stateFile.trim() !== ''
      ? config.stateFile.trim()
      : join(home, STATE_DIR_NAME, 'state.json')

  // 见文件头第 2 条：必须在这里建，且必须 recursive。
  mkdirSync(workspace, { recursive: true })

  return { home, stateFile, workspace }
}

/**
 * 校验用户自定义的会话文件夹路径。
 *
 * ## 为什么这个函数必须存在
 *
 * 设置页里一个路径输入框，就是一个可以让插件**起不来**的地方：
 * 用户填了 `D:\QQ会话` 而那台机器上没有 D 盘，`mkdirSync` 就会抛，
 * 插件在 `apply` 阶段失败 → 启动审计判定它没激活 → **整个应用起不来**。
 *
 * 所以这里的铁律是：**坏路径永远只是"没生效"，绝不是"起不来"**。
 * 校验不过就回落到默认位置，并留下一条能被看见的理由。
 *
 * 校验顺序也是有意的：**先判绝对路径再碰磁盘**。
 * 相对路径会相对于进程 cwd 解析，那和用户以为的位置完全不是一回事。
 *
 * @param home - DSH 主目录。
 * @param candidate - 用户填的路径（空串表示用默认）。
 * @returns `{ path, fellBack, reason? }`
 */
export function resolveWorkspaceDir(home, candidate) {
  const fallback = join(home, WORKSPACE_DIR_NAME)
  const wanted = typeof candidate === 'string' ? candidate.trim() : ''
  if (wanted === '') return { path: fallback, fellBack: false }

  if (!isAbsolute(wanted)) {
    return { path: fallback, fellBack: true, reason: `不是绝对路径：${wanted}` }
  }
  try {
    mkdirSync(wanted, { recursive: true })
    // 建得出来不代表写得进去（只读盘、权限不足的目录）。真写一次才算数——
    // 而失败必须在这里暴露，不能留到用户收附件的时候。
    const probe = join(wanted, `.dsh-qq-write-probe-${String(Date.now())}`)
    writeFileSync(probe, 'ok', 'utf8')
    rmSync(probe, { force: true })
  } catch (error) {
    return { path: fallback, fellBack: true, reason: `无法使用 ${wanted}：${describeError(error)}` }
  }
  return { path: wanted, fellBack: false }
}
