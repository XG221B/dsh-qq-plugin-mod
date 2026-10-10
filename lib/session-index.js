/**
 * 会话索引：读 DSH 会话存储，判断会话属于哪个工作区。
 *
 * 从 `dsh-wechat/packages/core/src/session-index.ts` **逐函数移植**（同版本、已在生产验证）。
 * 保留原文的注释与全部防御逻辑——那些都是踩出来的：
 *
 * - `encodeWorkspaceDir` 的编码是**有损的**（`a\b` 与 `a-b` 会撞），所以它只用来**缩小搜索范围**，
 *   真正的判据是每条会话自己记录的 `cwd`。
 * - `indexNamesFor` 要试两种文件名：经工作区注册表创建的会话记在裸 uuid 下，
 *   频道自己创建的记在完整 `session-<uuid>` 下。猜错会静默产生"标题全空"的列表。
 * - 大小写只在文件系统忽略大小写的平台上归一（Windows/macOS），Linux 不能归一——
 *   否则会把 `/home/me/Projects` 和 `/home/me/projects` 当成同一个目录。
 *
 * 会话**只从磁盘读**，不依赖 `sessionController.list()`——后者在作者机器上永远返回空数组。
 *
 * @module dsh-qq/session-index
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 把工作目录编码成存储使用的文件夹名。
 *
 * 连续分隔符折叠成一个短横，因此 `C:\Users\me\.dsh\dsh_qq` 变成 `--C-Users-me-.dsh-dsh_qq--`。
 * 点与下划线保留；`C:` 与随后的 `\` 共享一个短横。先去掉首尾分隔符，
 * 这样 Unix 路径不会多出一个短横。
 *
 * @param cwd - 绝对工作目录。
 * @returns 存储会使用的文件夹名。
 */
export function encodeWorkspaceDir(cwd) {
  const trimmed = cwd.replace(/[\\/]+$/, '').replace(/^[\\/]+/, '')
  return `--${trimmed.replace(/[\\/:]+/g, '-')}--`
}

/**
 * 本平台的文件系统在路径上是否忽略大小写。
 *
 * Windows 总是忽略，macOS 默认装载的是大小写不敏感的 APFS/HFS+。
 * Linux 不忽略——而那一个才要紧：在那里做小写归一，会把两个真实不同的目录当成同一个。
 */
export const CASE_INSENSITIVE_PATHS = process.platform === 'win32' || process.platform === 'darwin'

/**
 * 某条记录的 `cwd` 是否属于给定工作区。
 *
 * 分隔符一律归一，因为同一个目录可能被写成 `C:\Users\me\x` 或 `C:/Users/me/x`。
 * 大小写只在文件系统忽略大小写的平台上归一。
 *
 * @param recorded - 会话索引里的 `cwd`。
 * @param workspace - 工作区目录。
 * @param caseInsensitive - 覆盖平台默认，便于两种行为都可测。
 */
export function isSameWorkspace(recorded, workspace, caseInsensitive = CASE_INSENSITIVE_PATHS) {
  const normalise = (value) => {
    const withSlashes = value.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
    return caseInsensitive ? withSlashes.toLowerCase() : withSlashes
  }
  return normalise(recorded) === normalise(workspace)
}

/**
 * 去掉 `session-` 前缀，得到索引归档用的键。
 *
 * @param sessionId - 频道使用的会话 id。
 */
export function indexKeyFor(sessionId) {
  return sessionId.replace(/^session-/, '')
}

/**
 * 一条会话可能的索引文件名，最可能的在前。
 *
 * @param sessionId - 频道使用的会话 id。
 */
export function indexNamesFor(sessionId) {
  const bare = indexKeyFor(sessionId)
  return bare === sessionId ? [`${sessionId}.json`] : [`${sessionId}.json`, `${bare}.json`]
}

/**
 * 读一条会话的索引条目。
 *
 * 索引按行带版本（`{ver, seq, val}`），取 `val`。文件缺失或不可读时返回空字段而不是失败：
 * 一条坏记录不该把其余所有对话都藏起来。
 *
 * @param storeDir - 索引存储根目录。
 * @param sessionId - 目标会话。
 * @returns `{ title, cwd }`，都可能为空串。
 */
async function readIndex(storeDir, sessionId) {
  for (const name of indexNamesFor(sessionId)) {
    try {
      const raw = await readFile(join(storeDir, name), 'utf-8')
      const parsed = JSON.parse(raw)
      const title = parsed.record?.rows?.title?.val
      const cwd = parsed.record?.identity?.cwd
      return {
        title: typeof title === 'string' ? title : '',
        cwd: typeof cwd === 'string' ? cwd : '',
      }
    } catch {
      // 试下一个拼法。
    }
  }
  return { title: '', cwd: '' }
}

/**
 * 会话目录最后被写入的时间。
 *
 * 用它排序是因为会话正文是压缩的，为了取时间戳去读它不划算。
 *
 * @param dir - 会话目录。
 * @returns 毫秒时间戳；读不到时 0。
 */
async function newestMtime(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    let newest = 0
    for (const entry of entries) {
      const info = await stat(join(dir, entry.name))
      const at = info.mtimeMs
      if (Number.isFinite(at) && at > newest) newest = at
    }
    return newest
  } catch {
    return 0
  }
}

/** 列目录，失败返回空数组（权限、不存在都不该致命）。 */
async function listDirs(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

/**
 * 列出属于**某一个工作区**的会话，最新的在前。
 *
 * @param home - DSH 主目录。
 * @param workspace - 工作区目录。
 * @returns 真正能切换过去的会话。
 */
export async function listStoredSessions(home, workspace) {
  const sessionsRoot = join(home, 'sessions')
  const indexDir = join(home, 'storages', 'session_projcache', 'sessions')

  const exact = encodeWorkspaceDir(workspace)
  const wanted = (await listDirs(sessionsRoot)).filter((name) => name === exact)

  const sessions = []
  for (const folder of wanted) {
    const ids = (await listDirs(join(sessionsRoot, folder))).filter((name) => name.startsWith('session-'))
    for (const sessionId of ids) {
      const [index, updatedAt] = await Promise.all([
        readIndex(indexDir, sessionId),
        newestMtime(join(sessionsRoot, folder, sessionId)),
      ])
      // 文件夹名是有损编码，所以只有当会话自己的记录说它属于这里时才提供它。
      if (index.cwd !== '' && !isSameWorkspace(index.cwd, workspace)) continue
      sessions.push({ sessionId, title: index.title, updatedAt, cwd: index.cwd })
    }
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * 列出本机**全部**会话，按所属工作区路径分组。
 *
 * 用户要求看本频道之外的对话时用它：存储里有全部会话，且每条记录都写明自己的工作目录，
 * 所以分组是**读出来的**，不是推断的。
 *
 * @param home - DSH 主目录。
 * @returns `Map<工作区路径, StoredSession[]>`，每个列表最新在前。
 */
export async function listAllStoredSessions(home) {
  const sessionsRoot = join(home, 'sessions')
  const indexDir = join(home, 'storages', 'session_projcache', 'sessions')

  const byWorkspace = new Map()
  for (const folder of await listDirs(sessionsRoot)) {
    const ids = (await listDirs(join(sessionsRoot, folder))).filter((name) => name.startsWith('session-'))
    for (const sessionId of ids) {
      const [index, updatedAt] = await Promise.all([
        readIndex(indexDir, sessionId),
        newestMtime(join(sessionsRoot, folder, sessionId)),
      ])
      // 按记录分组，而不是按文件夹：文件夹名有损，会把无关目录并到一起。
      const key = index.cwd
      const entry = { sessionId, title: index.title, updatedAt, cwd: index.cwd }
      const list = byWorkspace.get(key)
      if (list === undefined) byWorkspace.set(key, [entry])
      else list.push(entry)
    }
  }
  for (const list of byWorkspace.values()) list.sort((a, b) => b.updatedAt - a.updatedAt)
  return byWorkspace
}

/**
 * 一条会话属于哪个工作目录。
 *
 * 采纳**别的**工作区的会话时必需：宿主钉死会话的 `cwd`，
 * 所以恢复一条会话意味着要指名**它自己**的工作区，而不是本插件的。
 *
 * @param home - DSH 主目录。
 * @param sessionId - 目标会话。
 * @returns 记录下来的目录；存储不认识该会话时 `undefined`。
 */
export async function storedSessionWorkspace(home, sessionId) {
  const index = await readIndex(join(home, 'storages', 'session_projcache', 'sessions'), sessionId)
  return index.cwd === '' ? undefined : index.cwd
}
