# dsh-qq-plugin

[![CI](https://github.com/xcisxc29/dsh-qq-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/xcisxc29/dsh-qq-plugin/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-qq-plugin.svg)](https://www.npmjs.com/package/dsh-qq-plugin)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

Drive the DeepSeek Harness agent on this computer from your phone, in QQ.

It goes through **Tencent's official QQ bot platform** (`api.bot.qq.com`, bound by scanning a QR
code), so there is **no public IP to expose, no reverse proxy, and no third-party protocol client**
in the middle. Bind once, and it keeps working.

**Runs on the current DSH desktop app** — developed and tested against DSH `0.2.0-rc.2`.

This is the QQ counterpart of [dsh-wechat-plugin](https://github.com/xcisxc29/dsh-wechat). It is
feature-aligned with it, with a few deliberate departures where the QQ protocol makes the WeChat
machinery unnecessary — see [Differences from the WeChat version](#differences-from-the-wechat-version).

[中文说明](README.zh.md)

## Features

- **Text both ways.** A QQ message becomes a DSH prompt, and the reply comes back to QQ.
- **Images, files and voice in; images, videos and files out.** Attachments are saved into the
  session workspace and handed to the agent; the agent sends files back with `send_to_qq`.
- **One QQ chat, many DSH conversations.** `/new`, `/list`, `/switch`, `/current`, `/cancel` — or
  just say "switch to the other one".
- **Answer permission prompts and questions from your phone.** Approvals and multiple-choice
  questions are delivered to QQ and answered by replying, so being away from the desk does not stall
  the agent.
- **Proactive push.** `notify_qq` lets any session on this machine message you — that is what makes
  "tell me when it is done" work.
- **Settings page** under **Settings → QQ**.

## Install

**For the DSH desktop app** on a machine that stays on. It needs DSH's workspace, tool and UI
services — the standard desktop composition.

| | |
|---|---|
| DSH desktop | `@deepseek-ai/dsh-desktop` `0.2.0-rc.2` or newer |
| Phone | mobile QQ, to scan one QR code |
| QQ bot | **nothing to register in advance.** The bot application is created by that scan; you do not need an AppID/AppSecret beforehand |
| Tencent's rules | an **uncertified** bot is usable only by its administrator — that is, only by you, which is exactly what a personal remote control wants |

Open the **plugin** entry in the sidebar and choose **添加插件** (add plugin). The field takes a
package name, a Git URL, a tarball, or a local path.

> ### The name to install is `dsh-qq-plugin`
>
> The repository and the package share one name, so there is nothing to reconcile — but the
> `-plugin` suffix is easy to drop by accident. **Copy `dsh-qq-plugin` rather than typing it.** The
> install command has to match the package name exactly.

<details open>
<summary><b>From npm</b> — nothing to configure</summary>

```
dsh-qq-plugin
```

Add a version if you need one: `dsh-qq-plugin@1.0.1`.
</details>

<details>
<summary><b>From a local checkout</b> — there is no build step to wait for</summary>

```
C:\path\to\dsh-qq
```

Point it at the directory that holds `package.json` — the folder is `dsh-qq`, the package it
declares is `dsh-qq-plugin`.
</details>

<details>
<summary><b>From a tarball</b></summary>

```bash
npm pack
# → dsh-qq-plugin-1.0.1.tgz
```

Paste the absolute path to that `.tgz` into **添加插件**.
</details>

<details>
<summary>Install from a terminal instead</summary>

The app drives `pnpm` underneath, so the same thing headlessly:

```bash
dsh plugin --profile desktop add dsh-qq-plugin
dsh plugin --profile desktop add C:\path\to\dsh-qq
```

You then have to enable the bundle yourself — which is what **立即启用** does for you — in
`~/.dsh/profiles/desktop/package.json`:

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

Wait for the install to finish, click **立即启用** (enable now), and restart DSH.

### Getting started

After restarting DSH, open **Settings → QQ** and click **开始扫码** (start the QR bind). Scan the
code with mobile QQ and confirm on the phone.

The credentials land straight in **DSH's credential store** — the plugin's own state file records
only the AppID, never the AppSecret. The channel connects by itself once bound: send any message to
the bot in QQ and you should get a reply.

## Usage

Just send a message and it reaches the agent:

```
你好
```

Type these to control which DSH conversation you are talking to:

| Command | What it does |
|---|---|
| `/new [title]` | Start a fresh conversation. Anything after it becomes the title: `/new 修复登录` starts a conversation called 「修复登录」 |
| `/list` | Go straight to this workspace's conversations (ten per screen) |
| `/list all` | List the **session folders** (workspaces) on this machine, one per line with its conversation count; reply with a number or a name to enter |
| `/switch 3` | Move to the 3rd row **of that screen** |
| `/switch e716f0` | Move by the **short id at the end of the row** — unrelated to numbering, and it never expires |
| Reply 「查看其余」 | Walk down ten rows (both levels, all the way to the end). Numbering runs on across screens (1–10, then 11–20) |
| Reply `3`, a name, or a trailing id | No need to type `/switch` while the list is on screen |
| Quote a list message → `/switch 3` | Numbered by **that screen**; the numbering is frozen inside that message |
| `/model` | Which models there are, and each one's **reasoning levels**, with the one in use marked |
| `/model 2` | Switch to the 2nd one; a model name works too |
| `/model 等级 high` | Change the reasoning level of the current model (the level names are the ones the list prints) |
| `/model 2 等级 high` | Change the model and the level together |
| `/current` | Which conversation you are in |
| `/cancel` | Stop the task that is running |
| `/help` | This list |

**Spaces are optional**: `/switch3`, `/switch 3` and `/switch:3` all work — these commands get typed
on a phone keyboard, where a dropped space is normal. A word that merely *starts* with a command is
not one, so `/news` is not `/new`.

**Numbering expires**: sessions run while you are reading the list, so by the time you reply "3" the
3rd row may be someone else. Every row therefore ends with a short id of **at most 6 characters** —
reply with that, or **quote that screen's list message** and the number is read as that message
printed it.

**The list has two levels, ten rows per screen**: `/list` opens this workspace's conversations;
`/list all` lists the **session folders** (workspaces), which you enter by number or name. Both
levels walk down ten rows with 「查看其余」, and **numbering runs on across screens**. When you reach
the end it says so instead of inviting you to keep going. **Entering a folder only moves where you
are browsing, not which conversation you are bound to** — to actually switch you still pick a
conversation inside it.

> **Reasoning levels come from the host adapter.** The bundled DeepSeek adapter publishes
> `off` / `low` / `high` / `max` (printed as `Off` / `Low` / `High` / `Max`), and those are the names
> `/model 等级` accepts, case-insensitively. There is no separate Chinese spelling — the level names
> are the ones the list prints, exactly as the WeChat channel does it.

**Plain language works too** — "switch to the other one", "what conversations do I have", "stop".
The agent judges the intent rather than matching fixed rules, and a switch tells you whether it
succeeded or failed.

### Tools the agent can use

| Tool | What it does |
|---|---|
| `send_to_qq` | Send a file from this machine to **the conversation that asked**. Images arrive as photos, videos as playable clips, everything else as a file attachment |
| `notify_qq` | Push to your current QQ conversation from **any session**. This is what "tell me when it is done" is built on |
| `qq_session_control` | Look at, switch, create or interrupt conversations; list (or switch) models and their reasoning levels |

> The `qq_` / `_qq` in those names is deliberate: **tool names are unique across the whole host
> scope**, and the WeChat plugin already occupies `session_control`. Two plugins claiming the same
> name means whichever registers second fails silently.

### Settings

**Settings → QQ**, in six groups, in the order the page renders them:

- **帮助 (Help)** — the one button on the page that opens the user handbook
  (`docs/HANDBOOK-USER.md`, the file that lists every command and every setting)
- **连接 (Connection)** — channel on/off, the QR bind, the bound account, unbind
- **权限 (Permissions)** — the permission preset for QQ conversations (only `auto` and
  «Follow the DSH setting, same as the desktop» can still show approval prompts)
- **行为设置 (Behaviour)** — the table below
- **指令 (Commands)** — the slash-command reference the page prints (`/help`, `/new`, `/list`,
  `/switch`, `/current`, `/cancel`, `/model`)
- **诊断 (Diagnostics)** — log tail, workspace path, conversation count, pending interactions

Nine settings in total:

| Setting | Default | What it does |
|---|---|---|
| `permissionPreset` | `danger-full-access` | Permission preset for QQ conversations. A permission prompt that arrives on a phone stalls the task until you answer it, so the default keeps the gate open — see [Security](#security) |
| `requireConfirmation` | on | Whether the agent asks you once before it performs a conversation operation |
| `allowCrossSessionNotify` | on | Turn it off and `notify_qq` may only push to the caller's own conversation (the stricter posture) |
| `mergeWindowMs` | 10000 | How long an attachment-only message waits for you to add an instruction. **0 = do not wait** |
| `autoReplyAttachments` | on | Whether the attachments are handed to the agent when no instruction arrives inside that window. Off does **not** mean "ignore the attachments" — it means "wait for the user to say something" |
| `maxReplyChars` | 4000 | Above this, the reply is sent as a `.md` file. **0 = no limit** |
| `settleMs` | 1200 | How long the stream must go quiet before the reply is sent |
| `presenceNote` | a short Chinese note | Sent to the agent with every message: you are on a phone, you cannot see this computer's screen, and if it wants you to look at something it should just send it |
| `workspacePath` | empty = `$DSH_HOME\dsh_qq` | The conversation folder. **Must be an absolute path**; a bad value only means "did not take effect", never "the plugin will not start" |

Settings are **persisted** and survive a restart. An older state file (one with no `settings`
block) still reads fine.

Every setting is defined in exactly one place — `lib/settings.js`'s `SETTINGS_SCHEMA`, one
validator plus one `default` per entry. Loading, saving, the settings page and the round-trip test
are all derived from it, so adding a setting is one line there and nothing else can drift out of
step. Plain JavaScript has no compiler to catch a forgotten setting, so
`scripts/verify.mjs` asserts that the schema's key set, the key set the runtime actually holds, and
the key set written to disk are the same set — that assertion is the compiler we do not have.

Next to `workspacePath`, the **currently in effect** line shows the path actually in use, while the
box holds the text you typed. Keeping the two apart is deliberate: when a path is wrong you can see
what you wrote and change it, while still knowing which folder is really being used.

> ⚠️ **Changing the path does not move existing conversations.** They stay in the old folder; only
> conversations created afterwards use the new path. That is the only safe behaviour — the host
> compares `cwd` when it adopts an existing conversation, and a mismatch raises
> `ApiSessionCwdConflict`, after which that conversation can never be picked up again.

### Where files land

| What | Path |
|---|---|
| Conversation workspace (shown in the desktop app as 「QQ 会话」) | `$DSH_HOME\dsh_qq` (changeable with `workspacePath`) |
| Inbound media and long replies as `.md` | `<conversation workspace>\媒体` |
| Plugin state and log | `$DSH_HOME\qq\state.json`, `$DSH_HOME\qq\boot.log` |

### If something does not work

| Symptom | Where to look first |
|---|---|
| No QQ block in the settings page | The client plugin did not load. Look at the **renderer console** section of `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log` |
| The whole app will not start | Same file. The fatal error itself says very little; the real cause is in the renderer console |
| The bot does not reply | `boot.log` for `入站`; the `errors` array of `GET /.dsh-qq-plugin/status` |
| Images or voice do nothing | `boot.log` for `附件下载失败` or `附件已停靠` |
| "It will not send" | `boot.log` for `待发已入队` — proactive push has a quota, and the queue is flushed the next time you speak |

The debugging HTTP endpoints all live under `/.dsh-qq-plugin/`: `status`, `log`, `settings`,
`permission-presets`, `accounts`, `login`, `start`, `stop` and a few more.

### Differences from the WeChat version

Feature-aligned, but a few things differ **on purpose**, because the QQ protocol hands us something
the WeChat one does not:

| | |
|---|---|
| Quoted messages | QQ's `msg_elements` **carry the quoted text directly**, so WeChat's `quoteHistory` cache is not needed |
| Voice | The QQ service returns `voice_wav_url` plus `asr_refer_text`, so there is **no SILK decoding** step and none of its caveats |
| Send queue | WeChat has to queue because iLink forbids unsolicited sends; QQ allows proactive push, so the queue here is only a **fallback for when the quota runs out** |
| Tool names | See above — global uniqueness across the host scope |
| Installation | There is no build step and no `allowBuilds` prompt: the plugin is plain JavaScript, so a Git install packs and runs it as-is |

## Security

**Only you can reach it.** The channel talks to Tencent's official QQ bot service and nothing else —
no third-party service, no self-hosted relay in the middle. The bot is a **separate application**
whose administrator is your QQ account, and it was created by your own scan; an uncertified bot is
limited to its administrator. It is not a QQ contact you can hand out: nothing searches for it and
nobody can add it. There is no "someone else could message it" surface, which is why no allowlist
exists: the platform's own rules already are one.

**The AppSecret is a long-lived key, and it is treated as one.** It is written to DSH's credential
store as a `grant` record rather than into the plugin's plaintext state file, which keeps only the
AppID. Rotating it means binding again from the settings page.

Three things are still true and worth knowing:

**Conversations from QQ run with full permissions by default** — the agent does not ask before it
acts. That is deliberate: a permission prompt is delivered to QQ and the task then waits there, so
on a phone every command would stall until you answered a conversation you had walked away from. Set
**Permission preset for QQ conversations** to `auto` (or to the profile's own policy) in the settings
page if you want the same guardrails you have at the desk.

**The agent runs as you.** It can execute commands and read and write files, with your user's
permissions — that is what it is for, and it means anything you can do on this machine, it can do.
So: skim what you asked for before walking away, and **lock the screen** when you leave. Locking does
not stop the agent, and it keeps anyone passing by out of your desktop.

**Any session on this machine can push to your QQ by default.** That is what makes "tell me when it
is done" work: the session doing the work is usually not the one your QQ conversation is bound to,
and without this it could not report its own result. Turn off **allowCrossSessionNotify** to restore
the stricter rule, where only the bound session may send.

## Documentation

| | |
|---|---|
| [docs/HANDBOOK-USER.md](docs/HANDBOOK-USER.md) | The user handbook — what the page's one help button opens, and the file that lists every command and every setting (Chinese) |
| [docs/POSTMORTEM.md](docs/POSTMORTEM.md) | Every real failure met while building this — each one cost something, and each one is why a checker exists (Chinese) |
| [docs/SETTINGS-CONTRACT.md](docs/SETTINGS-CONTRACT.md) | The host/client route contract behind the settings page, read off the actual call sites (Chinese) |
| [docs/RELEASING.md](docs/RELEASING.md) | How a version gets published: the tag, OIDC, and the one-time Trusted Publisher setup (Chinese) |
| [docs/STEP3-能力调研与实现规格.md](docs/STEP3-能力调研与实现规格.md) | QQ interactive-message and streaming research. **Status: paused, not implemented** — no buttons and no streaming exist in this code today; the measurements are real and are kept for whenever that work resumes (Chinese) |

## Development

Plain JavaScript, no build step, no transpiler. CI runs Node 24; the manifest declares no `engines`
range, because the plugin only has to run inside the DSH host that is already there.

```bash
npm ci

node scripts/verify.mjs          # host side
node scripts/verify-client.mjs   # client registration shape (not a visual check)
node scripts/verify-send-path.mjs  # the send path, against a fake SDK
```

**782** host checks, **108** client checks, **60** send-path checks.

Those three numbers are **read out of the runs above, not typed by hand**: `tools/check-doc-counts.mjs`
compares them against what the scripts actually print, and the CI job fails naming the file if any of
them disagrees. Change a test and the number here, or the gate stops the build.

### Standing checkers

Four checkers live in `tools/`. Each one corresponds to a real incident, so run them before
committing:

```bash
node tools/check-unbound.mjs .          # used but never imported
node tools/check-unused-imports.mjs .   # imported but never used
node tools/check-doc-counts.mjs --run   # the documented counts, and the repository name in publish.yml
node tools/check-cross-plugin.mjs <profileDir>   # shared resources across plugins
```

`check-doc-counts.mjs` reads the three numbers out of the **actual output** of the three suites and
compares them against this file, `README.zh.md` and `docs/RELEASING.md`, naming the file, the number
written and the number measured when they disagree. In CI it reads the output the three test steps
captured, so it costs a second rather than a second full run. `--run` is the local form: it runs the
suites once itself.

It carries a second job, for the same reason: the four Trusted Publisher fields in
`publish.yml`'s header are typed by hand and a typo in them shows up as **a 403 at publish time and
as nothing else**, so the checker compares that block against `package.json` (organization and
repository), the workflow's own filename and its `name:`, and both READMEs' CI badges. The
repository it names was once `dsh-qq` while every other copy said `dsh-qq-plugin` — that is the
failure this half exists to catch.

`check-cross-plugin.mjs` is a **local check and does not run in CI**: it reads a real DSH profile —
the `dsh.profile.bundles` list and the plugins installed under that profile's `node_modules` — and a
CI runner has neither. It checks the two things every plugin shares: the client plugin **top-level
scope** (the shell concatenates every enabled `client.js` into one script, so a top-level `const` in
one plugin collides with another's) and **host tool names**, which are globally unique.

**Each checker carries a reverse control**: it has to catch the failure it was written for, or it is
declared untrustworthy and exits non-zero. A checker that always prints "pass" is worse than no
checker at all — it makes people believe something was verified.

Two probes under `smoke/` (`step3-probe.mjs` and `step4-probe.mjs`) talk to Tencent's live service
and need real bot credentials; the other two (`step4-surface.mjs` and `check-sdk-surface.mjs`) are
offline surface checks that need neither credentials nor a network. None of the four is **in CI** —
the two probes because credentials do not belong in a public repository's CI, the two surface
checks because they are one-off research probes that print observations rather than assert
pass/fail.

## Licence

MIT — see [LICENSE](LICENSE).
