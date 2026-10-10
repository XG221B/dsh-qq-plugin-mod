# 发布流程

面向维护者。用户安装看 [README](../README.zh.md)。

## 一次版本发布

```bash
# 1. 改版本号（这是唯一需要手改的地方）
#    package.json -> version
#    package-lock.json 里也有同一处 version（两处：顶层和 packages[""] 里），顺手同步——
#    npm ci 不比对它，但两份不一致的文件会误导下一个读它的人
#    顺便把 README.md / README.zh.md 里的测试数量同步一下（改过测试的话）

# 2. 本地先过一遍 CI 的全部步骤
npm ci
node scripts/verify.mjs
node scripts/verify-client.mjs
node tools/check-unbound.mjs .
node tools/check-unused-imports.mjs .

# 3. 看一眼真的会被装出去的是什么
npm pack --dry-run

# 4. 提交并打 tag
git add -A && git commit -m "1.0.0：<改了什么>"
git tag v1.0.0
git push origin main --tags
```

推 tag 会触发 `.github/workflows/publish.yml`：它先跑一遍完整校验，**核对 tag 与 manifest 版本一致**，
`npm pack` 出一个 tarball，然后发布**那个已经验证过的 tarball**（不是重新打一次包），带
`--provenance` 签名。

> ⚠️ **`package.json` 里不能有 `private: true`。** 它会直接让 `npm publish` 拒绝。本包的这一项
> 在准备发布时就删掉了；如果哪天为了别的原因加回来，记得一起删。

## QQ 没有构建步骤，所以这里和微信版不一样

| 微信那边有 | QQ 这边 |
|---|---|
| `pnpm build` / `pnpm run dist` | **没有**。本插件就是普通 JavaScript，仓库里的文件就是装出去的文件 |
| `pnpm run pack` + `pnpm run verify-pack` | 换成 `npm pack --dry-run`：同样能列出实际进包的文件，而且不需要额外的打包脚本 |
| `ERR_PNPM_PACKAGE_VERSION_NOT_FOUND` 这个坑 | **不存在**。那是 `pnpm pack` 在 private workspace 根目录上的行为；本包是单包、有 `version`，`npm pack` 也没有歧义 |
| Git 安装要过 `allowBuilds` 询问 | **不用**。没有 `prepare` 脚本要跑，装下来直接能用 |
| `matrix` 跑两个 Node 版本 | 只跑 Node 24。没有转译，也就没有"某个 Node 版本上的语法/行为差异"这类风险 |

## 认证方式：OIDC，不用 token

工作流**不含任何密钥**。它用 GitHub 签发的 OIDC 身份向 npm 证明"我确实是这个仓库的这条工作流"，
npm 拿它跟包上配置的 **Trusted Publisher** 核对。

**这是一次性配置**，在 npmjs.com 上：

```
包页面 → Settings → Trusted Publisher → GitHub Actions
```

四个字段**逐字匹配**，填错的表现**只是发布时 403**——不会有别的提示，也不会有更早的警告：

| 字段 | 值 |
|---|---|
| Organization or user | `xcisxc29` |
| Repository | `dsh-qq-plugin` |
| Workflow filename | **`publish.yml`** ← 是文件名，不是路径 |
| Environment | **留空**（本工作流没有 environment） |

**为什么不用 token**（这段是历史，别再走回去）：

npm 在 2025-12 吊销了**全部经典 token**；替代它们的 granular token 带的"绕过 2FA"能力正在被限制——
包页面顶部的横幅写着 direct publishing 到 **2027-01** 就不允许了。**Trusted Publisher 是 npm 自己推荐的
替代方案**，而且更彻底：**没有密钥可以泄漏、轮换或过期**。

> 所以：**不需要创建任何 secret。** 如果你看到旧文档说要配 `NPM_TOKEN`，那是过期信息。

## 其他前提

| 项 | 位置 | 说明 |
|---|---|---|
| 仓库为 public | 仓库 Settings | `--provenance` 需要公开仓库才能生成可信签名 |
| `id-token: write` | 已在工作流里 | OIDC 握手用；删了它发布必然失败，而且**没有别的凭据可以退回去** |
| 仓库名是 `dsh-qq-plugin` | 仓库 Settings | Trusted Publisher 的 Repository 字段和它逐字一致 |

**先干跑一次**：Actions → Publish → Run workflow，`dry-run` 默认 true，会把所有校验跑一遍但不发布。

干跑从**分支**触发时，"核对 tag 与 manifest 一致"这一步会被跳过——那一步只在 `github.ref_type == 'tag'`
时执行。理由是干跑时 `GITHUB_REF_NAME` 是分支名（`main`），拿它去比版本号必然不等，而那不代表任何问题。

## 为什么发布这件事要单独一条流程

**npm 的版本号不可复用。** 发错了可以 deprecate，但那个版本号永远回不来——所以这里用 tag 而不是合并来触发，
且发布前把 CI 全套再跑一遍。发一个没验证过的产物，等于把一个坏版本永久留在 registry 上。

用 tag 而不是合并，还有一层说起来很平常但很关键的意思：合并说的是"这份代码够格进 main"，
tag 说的是"**这个**就是 1.0.0"。发布需要后者。

发布的是 `npm pack` 出来的**那个文件**，不是让 `npm publish` 再打一次包：重新打包可能打到另一棵树，
那样上面所有校验就都白做了。

## 版本号该改哪里

只有 `package.json` 的 `version` 是权威，CI 与工作流都从它读。`package-lock.json` 里那两处是副本，
同步是为了不误导人，没有任何程序依赖它们。

README 里的测试数量（宿主侧 293 / 客户端 41 / 发送路径 60）不是从任何地方读出来的，是手写的。
改过测试就顺手改它们；**不要为了对上文档去改测试**。

## 出问题怎么查

| 现象 | 原因 |
|---|---|
| 发布时 **403**，且信息提到 trusted publisher | npm 那四个字段有拼写不符（最常见：把 workflow 写成路径 `.github/workflows/publish.yml`） |
| 发布时 403，且提到 2FA | Trusted Publisher 没配上，npm 退回到了"要求 2FA"的老路径 |
| `npm publish` 直接说包是 private | `package.json` 里的 `private: true` 没删 |
| provenance 报错 | 仓库是 private，或 workflow 缺 `id-token: write` |
| 发布后 npm 页面还是旧版本，且注册表报 404 | **首次发布新版本要人工审核**，几分钟后自动上线。`npm view dsh-qq-plugin versions` 里没出现就是还在审 |
| tag 与版本不一致 | 忘了改 `package.json` 的 `version`。失败信息会把两个值都打出来 |
| 干跑打印了 "dry run: everything above passed" 之后什么都没发生 | **这是预期**：`dry-run` 默认 true，只跑校验不发布。真要发就推 tag |
| 发布成功但用户装不了 | 少了 `files` 条目。先跑 `npm pack --dry-run` 看实际清单——它列出什么，用户就装到什么 |
| 用户装到旧版本 | profile 的 `package.json` 里**锁了精确版本**。写 `^x.y.z` 才会跟着升 |
| 改完 `files` 本地一切正常，CI 却红了 | 反过来也成立：CI 的检查跑在 checkout 里，看不见"装出来的包少了目录"。`npm pack --dry-run` 是唯一在本地就能看见它的东西 |
