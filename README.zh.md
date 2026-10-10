# dsh-qq-plugin

[![CI](https://github.com/xcisxc29/dsh-qq/actions/workflows/ci.yml/badge.svg)](https://github.com/xcisxc29/dsh-qq/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-qq-plugin.svg)](https://www.npmjs.com/package/dsh-qq-plugin)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

在 QQ 里用手机指挥这台电脑上的 DeepSeek Harness agent。

走**腾讯官方 QQ 机器人**通道（`api.bot.qq.com`，扫码绑定），**不需要公网 IP、不需要反向代理、
中间也没有第三方协议客户端**。绑定一次，之后一直有效。

**能在当前的 DSH 桌面端上跑** —— 针对 DSH `0.2.0-rc.2` 开发和实测。

这是 [dsh-wechat-plugin](https://github.com/xcisxc29/dsh-wechat) 的 QQ 版本，功能与它对齐；
有几处**有意不同**，因为 QQ 协议本来就不需要微信那套机器（见
[与微信版的差异](#与微信版的差异)）。

[English](README.md) | 中文

## 功能

- **文字双向**：QQ 消息变成 DSH 提示词，回复发回 QQ。
- **图片、文件、语音进来，图片、视频、文件出去**：收到的附件落盘到会话工作区并交给 agent；
  agent 用 `send_to_qq` 把本机文件发回来。
- **一个 QQ 对话，多个 DSH 会话**：`/new`、`/list`、`/switch`、`/current`、`/cancel`，
  或者直接说「换个对话」。
- **在手机上回答权限与提问**：权限提示和多选提问会发到 QQ，回一句就能回答——
  离开电脑时回合不会再卡住。
- **主动推送**：`notify_qq` 让这台机器上的**任意**会话都能给你发消息，
  这正是「干完了告诉我」的实现。
- **设置页**：**设置 → QQ**。

## 安装

**给 DSH 桌面端用的**，装在一台一直开着的机器上。它需要 DSH 的工作区、工具与 UI 服务——
也就是标准的桌面端组合。

| | |
|---|---|
| DSH 桌面端 | `@deepseek-ai/dsh-desktop` `0.2.0-rc.2` 或更高 |
| 手机 | 能装手机 QQ，用来扫一次二维码 |
| QQ 机器人 | **不需要事先注册**。机器人应用是那次扫码当场创建的，不必提前准备 AppID/AppSecret |
| 腾讯的规则 | **未认证**的机器人仅管理员可用——也就是只有你自己能用，这正是「私人遥控器」要的 |

打开侧边栏的 **plugin** 入口，选 **添加插件**。输入框接受包名、Git 地址、tarball 或本地路径。

> ### 要装的这个名字是 `dsh-qq-plugin`
>
> 仓库叫 `dsh-qq`，包不叫：**把 `dsh-qq-plugin` 复制过去，别手打，注意 `-plugin`。**
> 安装命令必须与包名逐字一致。

<details open>
<summary><b>从 npm 装</b> —— 不用配置任何东西</summary>

```
dsh-qq-plugin
```

需要指定版本就写 `dsh-qq-plugin@1.0.0`。
</details>

<details>
<summary><b>从本地目录装</b> —— 没有构建步骤要等</summary>

```
C:\path\to\dsh-qq
```

指到放着 `package.json` 的那个目录：文件夹叫 `dsh-qq`，它声明的包名是 `dsh-qq-plugin`。
</details>

<details>
<summary><b>从 tarball 装</b></summary>

```bash
npm pack
# → dsh-qq-plugin-1.0.0.tgz
```

把那个 `.tgz` 的绝对路径粘进 **添加插件**。
</details>

<details>
<summary>改用命令行安装</summary>

界面底下驱动的就是 `pnpm`，所以同样的事也能在终端里做：

```bash
dsh plugin --profile desktop add dsh-qq-plugin
dsh plugin --profile desktop add C:\path\to\dsh-qq
```

然后得自己启用这个 bundle——也就是 **立即启用** 替你做的事——改
`~/.dsh/profiles/desktop/package.json`：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-qq-plugin"
      ]
    }
  }
}
```
</details>

等安装结束，点 **立即启用**，重启 DSH。

### 开始使用

重启 DSH 后打开 **设置 → QQ**，点 **开始扫码**。用**手机 QQ** 扫二维码并在手机上确认。

凭据直接写进 **DSH 的凭据存储**——插件自己的状态文件里**只有 AppID，没有 AppSecret**。
绑定后通道会自动连接：在 QQ 里给机器人发消息即可开始对话。

## 使用

直接发消息就会到达 agent：

```
你好
```

用这些指令控制你在和哪个 DSH 会话说话：

| 指令 | 作用 |
|---|---|
| `/new [标题]` | 新建对话。后面跟的文字就是标题：`/new 修复登录` 会开一个叫「修复登录」的对话 |
| `/list` | 列出 QQ 工作区里的对话，最新在前 |
| `/list all` | 列出全部对话，含其它工作区 |
| `/switch <编号>` | 切到列表里的第 `n` 个。完整会话 id、`/list` 打印的短 id、精确标题也可以 |
| `/current` | 显示当前在哪个对话 |
| `/cancel` | 中断正在跑的任务 |
| `/help` | 显示这份列表 |

**空格是可选的**：`/switch3`、`/switch 3`、`/switch:3` 意思相同——这些指令是在手机键盘上敲的，
掉空格是常态。只是**以**指令名开头的词不算指令，所以 `/news` 不是 `/new`。

**也可以直接用大白话说**，例如「换个对话」「我有哪些对话」「停下」。agent 判的是意图而不是
匹配固定规则，而且切换会告诉你成功还是失败。

### agent 能用的三个工具

| 工具 | 作用 |
|---|---|
| `send_to_qq` | 把本机文件发到**提问的那个**对话。图片变照片、视频变可播放片段、其它变文件附件 |
| `notify_qq` | 从**任意会话**推送到你当前所在的 QQ 对话。这是「干完了告诉我」的实现 |
| `qq_session_control` | 查看／切换／新建／中断对话 |

> 名字里的 `qq_` / `_qq` 是有意的：**工具名在宿主作用域下全局唯一**，
> 而微信版已经占了 `session_control`。两个插件抢同一个名字，后注册的那一方会静默失败。

### 设置

**设置 → QQ**，分四个分组：

- **连接** —— 通道开关、扫码绑定、已绑定账号、解绑
- **权限** —— QQ 会话的权限预设（`auto` 是唯一还会弹审批提示的那个）
- **行为设置** —— 见下表
- **诊断** —— 日志尾、工作区路径、会话数、待处理交互

一共九个设置项：

| 设置 | 默认 | 说明 |
|---|---|---|
| `permissionPreset` | `danger-full-access` | QQ 会话的权限预设。权限提示发到手机上会让任务一直等你回答，所以默认不设闸——见[安全](#安全) |
| `requireConfirmation` | 开 | agent 执行会话操作前是否先问你一次 |
| `allowCrossSessionNotify` | 开 | 关掉后 `notify_qq` 只能推给调用者自己的会话（更严的姿态） |
| `mergeWindowMs` | 10000 | 纯附件消息先停这么久，等你补一句指令；**0 = 不等待** |
| `autoReplyAttachments` | 开 | 窗口内没等到指令时，是否把附件交给 agent。关掉**不是忽略附件**，而是等用户说话 |
| `maxReplyChars` | 4000 | 超过就作为 `.md` 文件发送；**0 = 不限制** |
| `settleMs` | 1200 | 连续流片段之间静默多久就发出去 |
| `presenceNote` | 一段中文说明 | 随每条消息交给 agent：你在手机上、看不到这台电脑的屏幕，要看东西就直接发 |
| `workspacePath` | 空 = `$DSH_HOME\dsh_qq` | 会话文件夹。**必须是绝对路径**；填错只会「没生效」，绝不会让插件起不来 |

设置**会持久化**，重启后仍是你选的那份。老状态文件（没有 `settings` 块）照常可读。

`workspacePath` 旁边显示的是**实际生效的路径**，而输入框里是你**填的原文**。两者分开是有意的：
填错时你能看到自己填了什么去改，同时知道现在实际在用哪个。

> ⚠️ **改路径不搬动已有的对话。** 它们留在原来的文件夹，只有之后新建的用新路径。
> 这是唯一安全的做法——宿主在采用已存在会话时比对 `cwd`，不一致会抛
> `ApiSessionCwdConflict`，那个会话就永远接不回来了。

### 文件夹布局

| 用途 | 路径 |
|---|---|
| 会话工作区（桌面端显示为「QQ 会话」） | `$DSH_HOME\dsh_qq`（可用 `workspacePath` 改） |
| 入站媒体 + 长回复 `.md` | `<会话工作区>\媒体` |
| 插件状态与日志 | `$DSH_HOME\qq\state.json`、`$DSH_HOME\qq\boot.log` |

### 出问题了看哪里

| 现象 | 先看哪里 |
|---|---|
| 设置页看不到 QQ 区块 | 客户端插件没加载。看 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log` 的 **renderer console** 段 |
| 整个应用起不来 | 同上。那条致命错误本身信息量很少，真正的原因在 renderer console 里 |
| 机器人不回消息 | `boot.log` 里有没有 `入站`；`GET /.dsh-qq-plugin/status` 的 `errors` 数组 |
| 图片/语音没反应 | `boot.log` 里找 `附件下载失败` 或 `附件已停靠` |
| 「发不出去」 | 看 `boot.log` 里有没有 `待发已入队`——主动推送有配额，队列会在你下次说话时补发 |

调试用的 HTTP 端点都在 `/.dsh-qq-plugin/` 下：`status`、`log`、`settings`、
`permission-presets`、`accounts`、`login`、`start`、`stop` 等。

### 与微信版的差异

**功能上对齐**，但有几处是**有意不同**，因为 QQ 协议给了微信那边没有的东西：

| | |
|---|---|
| 引用消息 | QQ 的 `msg_elements` **直接给被引正文**，所以微信那套 `quoteHistory` 缓存**不需要** |
| 语音 | QQ 服务端直接给 `voice_wav_url` + `asr_refer_text`，**不需要 SILK 解码**，也没有随之而来的那句免责 |
| 待发队列 | 微信因为 iLink 不允许主动发而必须排队；QQ 主动推送可用，队列只作为**配额用尽时的兜底** |
| 工具名 | 见上文（宿主作用域全局唯一） |
| 安装 | 没有构建步骤，也没有 `allowBuilds` 询问：本插件就是普通 JavaScript，Git 安装直接打包就能跑 |

## 安全

**只有你能碰到它。** 通道只跟腾讯官方的 QQ 机器人服务说话，没有别的东西——
没有第三方服务，中间也没有自建中转。机器人是一个**独立的应用**，管理员是你的 QQ 账号，
而且是你自己扫码创建的；未认证的机器人仅管理员可用。它不是一个能发出去的 QQ 名片：
没有地方能搜到它，也没有人能加它。不存在「别人也能给它发消息」这个面，
所以这里没有白名单——平台自己的规则就是白名单。

**AppSecret 是长期密钥，就按长期密钥对待。** 它以 `grant` 记录写进 DSH 的凭据存储，
而不是写进插件的明文状态文件（那里只有 AppID）。要轮换就回设置页重新绑定一次。

还有三件事是真的，值得知道：

**QQ 来的对话默认全权限运行**——agent 动手前不问。这是有意的：权限提示会发到 QQ，
然后任务就在那里等你，于是在手机上每条命令都会卡在你早已走开的那个对话里。
想要和坐在电脑前一样的护栏，就把设置页里的「QQ 会话的权限预设」改成 `auto`
（或改成跟随 profile 自己的策略）。

**agent 以你的身份运行。** 它能执行命令、读写文件，用的是你这个用户的权限——
它本来就是干这个的，也就是说这台机器上你能做的事它都能做。所以：走开之前扫一眼你让它干的
是什么，离开时**锁屏**。锁屏不会让 agent 停下来，但能挡住路过的人。

**默认任意会话都能推送到你的 QQ。** 这是「干完了告诉我」能成立的原因：干活的那个会话通常不是
你 QQ 对话绑定的那个，不放开这一条它就报不了自己的结果。关掉 **allowCrossSessionNotify**
就回到更严的规则：只有绑定的那个会话能发。

## 文档

| | |
|---|---|
| [docs/POSTMORTEM.md](docs/POSTMORTEM.md) | 每一个真实踩过的坑——每一条都付了代价，也每一条都是一个检查器存在的理由（中文） |
| [docs/SETTINGS-CONTRACT.md](docs/SETTINGS-CONTRACT.md) | 设置页背后的宿主／客户端路由契约，逐条读自真实调用点（中文） |
| [docs/RELEASING.md](docs/RELEASING.md) | 一次版本怎么发：tag、OIDC，以及一次性的 Trusted Publisher 配置（中文） |
| [docs/STEP3-能力调研与实现规格.md](docs/STEP3-能力调研与实现规格.md) | QQ 交互消息与流式的能力调研。**状态：暂缓，未实现**——当前代码里没有任何按钮、也没有流式；调研结论是真的，留着给将来重启这项工作用（中文） |

## 开发

普通 JavaScript，没有构建步骤，没有转译器。CI 跑 Node 24；manifest 里不写 `engines` 范围——
本插件只需要跑在已经在场的那个 DSH 宿主里。

```bash
npm ci

node scripts/verify.mjs          # 宿主侧
node scripts/verify-client.mjs   # 客户端注册形状（不是视觉验证）
node scripts/verify-send-path.mjs  # 发送路径，跑在假 SDK 上
```

**293** 项宿主侧检查、**41** 项客户端检查、**60** 项发送路径检查。

### 常设检查器

`tools/` 里有三个检查器，每一个都对应一次真实事故，改动前请先跑：

```bash
node tools/check-unbound.mjs .          # 用了但没导入
node tools/check-unused-imports.mjs .   # 导入了但没用
node tools/check-cross-plugin.mjs <profileDir>   # 跨插件共享资源
```

`check-cross-plugin.mjs` 是**本地检查，不进 CI**：它要读一个真实的 DSH profile——
`dsh.profile.bundles` 那份列表，以及该 profile `node_modules` 下已装好的插件——
CI 的 runner 上两样都没有。它查的是所有插件共用的两样东西：客户端插件的**顶层作用域**
（shell 会把每个已启用 bundle 的 `client.js` 拼进同一个脚本，一份文件顶层的 `const`
就会和别人的撞车），以及**宿主作用域的工具名**（全局唯一）。

**每个检查器都带反向对照**：它必须能抓住它为之而写的那次故障，抓不住就判定为不可信并以
非零码退出。一个永远报「通过」的检查器，比没有检查器更糟——它让人以为已经验过了。

`smoke/` 下的脚本需要真实凭据和真实机器人，所以同样**不进 CI**。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
