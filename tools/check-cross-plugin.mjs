/**
 * 跨插件"共享资源"冲突检查。
 *
 * 有两类东西在 DSH 里是**所有插件共用**的，而任何一份插件各自的测试都发现不了冲突
 * ——冲突只在**别人也在场**时才存在：
 *
 * 1. **客户端插件的顶层作用域**（见下）
 * 2. **宿主作用域的工具名**（`ctx.tools.register` 的名字全局唯一）
 *
 * 两类都已经真实踩过，代价分别是"整个应用起不来"和"功能静默不可用"。
 *
 * ## 一、客户端顶层作用域
 *
 * shell 会把**每个已启用 bundle 的 `client.js` 拼进同一个脚本**（页面一次请求
 * `plugins/??a/client.js,b/client.js,…`），所以任意一份 `client.js` 在顶层声明的
 * `const` / `function` 都是**所有其它插件文件共享的顶层声明**。
 *
 * 已经踩过一次，代价是**整个应用起不来**：
 *
 * ```
 * Uncaught SyntaxError: Identifier 'PREFIX' has already been declared
 * error: web boot: 1 entry did not activate
 *        dsh-qq-plugin: import failed (see console for the import error)
 * ```
 *
 * `dsh-wechat-plugin/client.js` 与 `dsh-qq-plugin/client.js` 都在顶层声明了
 * `PREFIX` / `HANDBOOK_URL` / `reportFailure`。**各自单独存在时都正常**，
 * 一起加载就是 SyntaxError——而且报错不指名任何文件、行号或插件。
 *
 * ## 二、工具重名
 *
 * `ctx.tools.register` 在宿主作用域下名字全局唯一，重名会抛
 * `tool "X" is already registered`，那次注册失败且**只留一行错误**。
 *
 * 实测：`dsh-wechat-plugin` 注册了 `session_control`，而 QQ 插件最初也叫这个名字。
 * 因为微信的 bundle 排在前面，**QQ 的自然语言会话控制从来没有生效过**。
 *
 * ## 用法
 *
 * **这是本地检查，不进 CI。** 它要读一个真实的 DSH profile 目录
 * （profile 的 `package.json` 里 `dsh.profile.bundles`，以及 `node_modules` 下已安装的
 * 那些插件），CI 的 runner 上两样都没有。
 *
 * ```
 * node tools/check-cross-plugin.mjs <profileDir> <额外 client.js…>
 * ```
 *
 * 官方插件的客户端入口在 `app.asar` 里（`…/<pkg>/lib/client.js`），
 * 所以要覆盖它们，先用 `qq-plugin/tools/asar-extract-fixed.mjs`（**留在应用侧，
 * 没有随本检查器一起搬进 `dsh-qq/tools/`**）导出，再当作额外文件传进来：
 *
 * ```
 * node ../tools/asar-extract-fixed.mjs <app.asar> "@deepseek-ai/dsh-<name>/lib/client.js" <outDir>
 * node tools/check-cross-plugin.mjs <profileDir> (Get-ChildItem -Recurse <outDir>\client.js).FullName
 * ```
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const profileDir = process.argv[2] ?? 'C:\\Users\\XCISXC\\.dsh\\profiles\\desktop'
/** 额外的 client.js 路径（通常是从 asar 里导出的官方插件）。 */
const extraFiles = process.argv.slice(3)

/**
 * 取某个包声明的客户端入口。
 *
 * 优先 `exports["./client"]`（其余插件都用这个），退回 `dsh.client.entry`。
 */
function clientEntryOf(packageDir) {
  const manifestPath = join(packageDir, 'package.json')
  if (!existsSync(manifestPath)) return { error: '没有 package.json' }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return { error: `package.json 解析失败：${error.message}` }
  }
  const exported = manifest.exports?.['./client']
  const relative = typeof exported === 'string' ? exported : exported?.default
  if (typeof relative !== 'string') return { error: '没有声明 ./client 导出' }
  const file = resolve(packageDir, relative)
  if (!existsSync(file)) return { error: `声明的入口不存在：${relative}` }
  return { file, name: manifest.name }
}

/**
 * 提取顶层声明。
 *
 * 只认**第 0 列**开头的 `const`/`let`/`var`/`function`/`class`——
 * 缩进的声明在某个块或闭包里，不污染共享作用域。这对本项目足够：
 * 冲突的写法正是第 0 列那种。
 */
function topLevelNames(source) {
  const names = []
  source.split('\n').forEach((line, index) => {
    const match = /^(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/.exec(line)
    if (match) names.push({ name: match[1], line: index + 1 })
    // `const a = 1, b = 2` 这种少见但要认。
    // 只在**方括号深度为 0** 处切逗号——否则 `const X = ['a','b']` 会被切成两个名字。
    const multi = /^(?:const|let|var)\s+(.+)$/.exec(line)
    if (multi && multi[1].includes(',')) {
      const declaration = multi[1]
      let depth = 0
      let segment = ''
      const parts = []
      for (const character of declaration) {
        if ('([{'.includes(character)) depth += 1
        else if (')]}'.includes(character)) depth -= 1
        if (character === ',' && depth === 0) {
          parts.push(segment)
          segment = ''
          continue
        }
        segment += character
      }
      parts.push(segment)
      // 只有一个第 0 层逗号段时说明逗号全在括号里，不属于多变量声明。
      if (parts.length > 1) {
        for (const part of parts) {
          const one = /^\s*([A-Za-z_$][\w$]*)\s*=/.exec(part)
          if (one) names.push({ name: one[1], line: index + 1 })
        }
      }
    }
  })
  return names
}

const profileManifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
const bundles = profileManifest.dsh?.profile?.bundles ?? []
console.log(`profile: ${profileDir}`)
console.log(`已启用 bundle ${bundles.length} 个\n`)

const plugins = []
for (const bundle of bundles) {
  const packageDir = join(profileDir, 'node_modules', ...bundle.split('/'))
  const entry = clientEntryOf(packageDir)
  if (entry.error !== undefined) {
    console.log(`  [跳过] ${bundle} —— ${entry.error}`)
    continue
  }
  plugins.push({ bundle, file: entry.file, source: readFileSync(entry.file, 'utf8') })
}
console.log(`其中带客户端入口的 ${plugins.length} 个：`)
for (const plugin of plugins) console.log(`  ${plugin.bundle}  →  ${plugin.file}`)

for (const extra of extraFiles) {
  const file = resolve(extra)
  if (!existsSync(file)) {
    console.log(`  [额外] 找不到 ${file}`)
    continue
  }
  // 用所在包名当标签，便于读产出。
  const parts = file.split(/[\\/]/)
  const label = parts[parts.length - 3] ?? file
  plugins.push({ bundle: `${label} (asar)`, file, source: readFileSync(file, 'utf8') })
}
if (extraFiles.length > 0) console.log(`另加 ${extraFiles.length} 份官方客户端入口，共检查 ${plugins.length} 份`)

// ---- 1. 跨插件重复的顶层标识符（**仅供参考的线索**）----
//
// ⚠️ 这一节是启发式的，会**误报**：它按"第 0 列"判断顶层声明，而一份整体包在
// IIFE 里、但 body 没有缩进的文件，其内部名字仍然在第 0 列。所以它只用来提示
// "哪里可能有重复"，**不作为判定依据**。
//
// 判定依据是下面第 2 节的解析结果：那才是 shell 实际会遇到的错误。
console.log('\n=== 跨插件重复的第 0 列标识符（线索，非判定）===')
const owner = new Map()
const collisions = []
for (const plugin of plugins) {
  for (const { name, line } of topLevelNames(plugin.source)) {
    if (owner.has(name)) collisions.push({ name, first: owner.get(name), second: { bundle: plugin.bundle, line } })
    else owner.set(name, { bundle: plugin.bundle, line })
  }
}
if (collisions.length === 0) {
  console.log('  无重名 ✓')
} else {
  for (const hit of collisions) {
    console.log(`  · ${hit.name}  ${hit.first.bundle}:${hit.first.line}  /  ${hit.second.bundle}:${hit.second.line}`)
  }
  console.log('  （重复不一定是错误——两边都包在 IIFE 里就相安无事。看下面的解析判定。）')
}

// ---- 2. 按 shell 的方式拼起来真的解析一遍 ★ 这是判定依据 ----
console.log('\n=== 拼接后能否解析（复现 shell 的行为）===')
const combined = plugins.map((plugin) => `// ---- ${plugin.bundle} ----\n${plugin.source}`).join('\n')
let parseError
try {
  // 不执行，只让 V8 解析：语法错误在这一步就会抛出，
  // 与浏览器里那句 `Identifier 'X' has already been declared` 同源。
  // eslint-disable-next-line no-new-func
  new Function(combined)
} catch (error) {
  parseError = error
}
if (parseError === undefined) {
  console.log(`  ${plugins.length} 份 client.js 拼接后解析通过 ✓`)
} else {
  console.log(`  ✗ 拼接后无法解析 —— 这正是让 shell 报 "N entry did not activate" 的原因：`)
  console.log(`     ${parseError.name}: ${parseError.message}`)
}

// ---- 3. 我的插件是否单独泄漏到共享作用域（同样只是线索）----
const mine = plugins.find((plugin) => plugin.bundle === 'dsh-qq-plugin')
if (mine !== undefined) {
  const leaked = topLevelNames(mine.source)
  const wrapped = /(?:^|\n)\s*;?\(\(\)\s*=>\s*\{/.test(mine.source)
  console.log('\n=== dsh-qq-plugin/client.js 的自我保护 ===')
  console.log(`  整体包在 IIFE 里：${wrapped ? '是 ✓' : '否 —— 顶层声明会与其它插件共享作用域'}`)
  console.log(`  第 0 列名字 ${leaked.length} 个（若上面是"是"，这些都在 IIFE 内，不泄漏）`)
}

// ---- 4. 自检：这个检查器抓得住已知的那次故障吗 ----
//
// 一个永远通过的检查器毫无价值。所以这里把 dsh-qq-plugin 的 IIFE 拆掉，
// 复原成出错时的样子，再拼一次——**必须**解析失败。
// 抓不住就说明判定逻辑坏了，而不是"没问题"。
console.log('\n=== 自检：能否抓住已知故障（拆掉 IIFE 后必须失败）===')
let selfTestOk = false
if (mine === undefined) {
  console.log('  跳过（没有 dsh-qq-plugin 入口）')
} else {
  const stripped = mine.source
    .replace(/\n\s*;?\(\(\)\s*=>\s*\{\s*\n/, '\n')
    .replace(/\n\/\/ Closes the IIFE[\s\S]*?\n\}\)\(\)\s*$/, '\n')
  const anyStripped = stripped !== mine.source
  if (!anyStripped) {
    console.log('  ⚠ 没能拆掉 IIFE（包装形式变了？），自检无法执行')
  } else {
    const probe = plugins.map((p) => (p === mine ? `// ---- ${p.bundle} （拆掉 IIFE）----\n${stripped}` : p.source)).join('\n')
    let probeError
    try {
      // eslint-disable-next-line no-new-func
      new Function(probe)
    } catch (error) {
      probeError = error
    }
    if (probeError !== undefined) {
      console.log(`  拆掉 IIFE 后如预期失败 ✓  —— ${probeError.message}`)
      selfTestOk = true
    } else {
      console.log('  ✗ 拆掉 IIFE 后仍然解析通过 —— 说明本检查器抓不住跨插件顶层冲突，判定不可信')
    }
  }
}

// ---- 5. 工具重名（另一类共享资源）----
//
// `ctx.tools.register` 在宿主作用域下名字全局唯一。重名会让**后注册的那一份**
// 整个失败，而且只留一行错误——功能静默不可用。
//
// 要扫的是**宿主侧**的 JS，不是 client.js：工具名定义在 `exports["."]` 指向的那一侧，
// 而且可能散在多个 `lib/*.js` 里（本插件就是），所以按包目录遍历。
console.log('\n=== 工具重名（宿主作用域全局唯一）===')

/** 递归收集一个目录下的 .js 文件，跳过 node_modules。 */
function jsFilesUnder(dir, out = [], depth = 0) {
  if (depth > 5 || !existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) jsFilesUnder(full, out, depth + 1)
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

const toolOwners = new Map()
const toolClashes = []
const resolved = new Map()
let toolCount = 0
let unresolved = 0

for (const bundle of bundles) {
  const packageDir = join(profileDir, 'node_modules', ...bundle.split('/'))
  const files = jsFilesUnder(packageDir)
  if (files.length === 0) continue

  // 第一遍：收集 `export const NAME = 'value'`，好在第二遍解析标识符形式的工具名。
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/export\s+const\s+([A-Z_][A-Z0-9_]*)\s*=\s*'([^']+)'/g)) {
      resolved.set(`${bundle}:${match[1]}`, match[2])
    }
  }

  // 第二遍：找工具定义里的 name。要求文件确实提到 tools.register 或 *ToolDefinition，
  // 否则插槽名、投影名之类的字符串会被误当成工具名。
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    if (!/tools\s*\.\s*register|ToolDefinition\s*\(/.test(text)) continue
    for (const match of text.matchAll(/^[ \t]*name:\s*(?:'([a-z][a-z0-9_]*)'|([A-Z_][A-Z0-9_]*)),[ \t]*$/gm)) {
      const literal = match[1]
      const identifier = match[2]
      let name = literal
      if (name === undefined) {
        name = resolved.get(`${bundle}:${identifier}`)
        if (name === undefined) {
          unresolved += 1
          console.log(`  ? 无法解析 ${bundle} 里的 ${identifier}（文件 ${file.split(/[\\/]/).pop()}）`)
          continue
        }
      }
      toolCount += 1
      if (toolOwners.has(name)) toolClashes.push({ name, first: toolOwners.get(name), second: bundle })
      else toolOwners.set(name, bundle)
    }
  }
}

console.log(`  扫描到工具名 ${toolCount} 个（未能解析的标识符 ${unresolved} 个）`)
if (toolCount === 0) {
  console.log('  ⚠ 一个都没扫到 —— 检查器失效（假阴性），不能据此判定"无冲突"')
} else if (toolClashes.length === 0) {
  for (const [name, owner] of [...toolOwners].sort()) console.log(`    ${name}  ← ${owner}`)
} else {
  for (const hit of toolClashes) console.log(`  ✗ ${hit.name}  ${hit.first}  /  ${hit.second}`)
}

const failed =
  parseError !== undefined ||
  (mine !== undefined && !selfTestOk) ||
  toolClashes.length > 0 ||
  toolCount === 0
console.log(
  `\n${
    failed
      ? '有问题 ✗'
      : `拼接解析通过 ✓，检查器自检通过 ✓，工具名无冲突 ✓（${toolCount} 个）`
  }`,
)
process.exit(failed ? 1 : 0)
