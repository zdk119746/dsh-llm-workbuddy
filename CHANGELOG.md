# Changelog

本文件记录每个版本的改动。版本号遵循语义化版本（MAJOR.MINOR.PATCH），
每次发版请同步 `package.json` 的 `version` 并打一个 `git tag`（如 `v0.1.13`），
在 GitHub 创建 Release 时本文件即为更新说明来源。

## [0.1.18] - 2026-09-22

修复「任务跑着跑着就死、显示得像断联、之后再怎么重试也起不来」这一类问题。
根因是三条，都只在 WorkBuddy 这条链路上（原生 DeepSeek 不受影响）。

> **改动范围**：`[插件]` 的随本包发布，装了就生效；`[本地代理]` 的在本机
> `.workbuddy-src`（`start-workbuddy.sh` 用的那份源码）里，使用 PyPI 版
> `workbuddy2api` 的用户不受影响。不过 `[插件]` 的错误帧解析对任何代理都有效，
> 所以"一次 429 就让整场任务死掉"这个问题对所有用户都修好了。

### Fixed
- **[插件] 上游的 HTTP 错误被吞掉，任务当场死亡且不可重试（主因）**。
  代理在**流式**请求里先发 200 响应头、之后才知道上游状态，于是上游的
  `429 / 400 / 5xx` 只能作为 `data: {"error": …}` 事件写进 SSE，而且**写完直接
  return，不补 `[DONE]`**。适配器只看到"流结束了却没有 [DONE]"，抛出
  `STREAM_CLOSED`；而 `STREAM_CLOSED` 不在 harness 的重试策略里
  （`EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`）—— 一次限流
  就让整个任务终结，且同样的请求下次还是被拒，用户看到的就是"卡死、无法继续"。
  实测证据：09-16 上游 4 次 `429 code 6004 您的使用量已超出频率限制（含重置时间）`
  ↔ 会话记录里 5 次 `STREAM_CLOSED`；09-04 上游 6 次 `400 code 11133`。
  现在：
  1. 适配器把 `error` 帧翻成真正的 `LlmError`：配额类（`6004` / "使用量已超出"
     / `quota`）→ `QUOTA`，429 → `RATE_LIMIT`，400 → `INVALID_REQUEST` /
     `CONTEXT_WINDOW_EXCEEDED`，5xx → `SERVER`，并把上游原文（含"将在 … 重置"）
     带进错误信息；
  2. 代理在**所有**结束路径（含错误、超时、内部异常）都补 `data: [DONE]`，
     并给错误帧带上 `code` / `type` / 可读原因；
  3. "一个字节都没收到就断开"映射为可重试的 `EMPTY_RESPONSE`，已经有内容再断开
     仍保持 `STREAM_CLOSED`（截断的回答不能当完整回答用）。
- **[本地代理] 60 个工具被静默砍到 30 个（上下文自相矛盾）**。DSH 一次发 60 个工具，代理
  硬编码 `MAX_TOOLS = 30` 且**按顺序**截断；DSH 的工具表是字母序，前 30 个恰好
  全是 `ego_*` 浏览器工具，被丢掉的正是 `read` / `write` / `grep` / `glob` /
  `todo_write` / `web_search` / `subagent` / `present` …，而 system prompt 里
  仍然写着这些工具。模型于是调用"没声明"的工具、或者干脆长时间只出推理不出
  工具调用（实测一次卡住的 step：9727 字符推理、116 秒、无工具调用，最后被用户
  中止）。**实测上游接受 60 个工具（HTTP 200）**，所以默认上限提到 64，可用
  `--max-tools` 调整，真发生截断时会把被丢掉的工具名写进日志（不再静默）。
- **[插件] 探测抖动被当成掉登录（胶囊假红）**。状态胶囊的判定是
  `status.authenticated && status.proxyUp`，而 `proxyUp` 来自一次
  **2 秒硬超时、只试一次** 的 `/health` 探测 —— 本机任何一次短暂卡顿都会让
  胶囊直接显示 `WorkBuddy · 未登录`，哪怕会话文件完全有效。现改为：
  每次探测 8 秒、失败重试 1 次、**连续 2 次失败**才报告 `proxyUp: false`
  （连接被拒绝时立即判定，因为那确实说明代理没了）；`/status` 与诊断面板
  额外返回 `lastProbeError` / `consecutiveProbeFailures` / `degraded`。
- **[插件] 胶囊只有两态，把"代理没响应"也说成"未登录"**。现在三态：绿=已登录、
  黄=`代理未响应`（登录态仍有效，不提示点登录，避免多占一次上游）、
  红=`未登录`（只有会话真的无效时才出现）。
- **[插件] 中止任务后上游仍在生成，WorkBuddy 账号被继续占用**。适配器现在监听调用方
  的中止信号，用户一按停止就立刻 abort 上游请求（不再依赖 finally 的时机）；
  本地代理侧也新增客户端断开轮询与 `client_disconnected` 记录作为兜底。
- **[本地代理] 请求路径上的同步设备流登录会冻住整个代理**。代理原来在每个 chat 请求里
  同步调用 `ensure_authenticated()`，一旦判定 token 过期且刷新失败，就会在
  async handler 里跑 `login()`（内部 `time.sleep` 轮询、最多 300 秒），把
  uvicorn 单事件循环彻底冻住：所有工作区的模型请求一起卡死，`/health` 也
  不响应，于是胶囊同时显示"未登录"。现改为：认证检查/刷新放到
  `asyncio.to_thread` 里执行并加锁（refresh token 是轮换式的，并发刷新会
  互相作废），请求路径**绝不允许**触发交互式登录 —— 刷新失败就快速返回
  401 `auth_error`，交互式登录仍走 `POST /api/workbuddy/login`。
- **[本地代理] 手动启动与 launchd 抢 8787**。`start-workbuddy.sh` 增加端口占用护栏：
  手动执行时发现端口已占用就直接退出；launchd 用 `--wait` 驻留等待旧进程退出
  后再接管（配套 plist 加 `--wait` 与 `ThrottleInterval`），不再刷
  `address already in use`。

### Verified (not a bug)
- **DSH 的 system prompt 不会被压缩/裁剪**。代理的 `--desensitize` +
  `compact_harness` 只针对 Codex CLI / Claude Code 的模板（`Codex CLI`、
  `# How you work`、`<permissions instructions>` 等标记），实测拿 DSH 真实的
  6874 字符 system prompt 跑一遍：只多了 15 个零宽空格（敏感词表命中），
  长度与内容不变。所以"数据压缩把上下文搞坏"不成立。


## [0.1.17] - 2026-09-11

修复社区反馈的两个 issue（[#3](https://github.com/zdk119746/dsh-llm-workbuddy/issues/3)、
[#4](https://github.com/zdk119746/dsh-llm-workbuddy/issues/4)）。

### Fixed
- **登录态永远判定为有效，且「登录」按钮无法恢复（issue #3）**。
  代理（workbuddy2api）写入的 `~/.codebuddy-session.json` 里**没有
  `auth.expiresAt`**，而插件把"字段缺失"当作"未过期"，于是：
  `authenticated` 恒为 `true`、`POST /api/workbuddy/login` 恒返回
  `alreadyLoggedIn`、诊断面板的「登录状态/登录令牌」恒显示"有效"；一旦 token
  真失效，用户点登录没有任何反应，只能回终端手跑脚本。
  现改为**多源推导过期时间**（按优先级）：
  1. `auth.expiresAt`（本插件脚本写入；秒/毫秒自动归一化）；
  2. `refreshToken` 的 JWT `exp`——代理会自动 refresh，所以 refreshToken 的
     有效期才是会话真正的边界；
  3. `accessToken` 的 JWT `exp`（解码 payload，不校验签名）；
  4. `auth.expiresIn` + 会话文件 mtime（兜底，只会低估、不会高估）。
  全部失败时返回 `expiryKnown: false` + `reloginRecommended: true`，
  **不再假装有效**。`/status` 与诊断面板都会带上 `expiresAtSource` 说明来源。
- **`authUrl` 永远为 `null`，点「登录」在新标签页打不开任何页面（issue #3 相关）**。
  登录路由 `spawn` 后**立刻** `res.end()`，而设备流链接是子进程稍后才打印到
  stdout 的，因此返回的 `authUrl` 恒为 `null`，Web 登录实际上从来没成功打开过
  授权页。现改为等待链接出现（或脚本早退/15 秒超时）再应答，失败时返回结构化
  `error`，前端弹窗提示而不是静默无反应。子进程 stdout 在应答后继续被 drain，
  避免缓冲写满阻塞。
- **「🎁 签到」必然 404，且每天写入一条失败记录（issue #4）**。
  插件请求代理的 `/checkin-status` 与 `/checkin`，但 workbuddy2api **从未实现**
  这两个端点（已核对 PyPI 2.0.0–2.0.4 与 `main` / `dsh` / `codex` 全部分支），
  且 `autoCheckin` 默认 `true`，于是每天 10 点后必然失败一次并把失败结果持久化。
  现改为**探测 + 优雅降级**：`/checkin-status` 返回 404/405 时判定该代理
  **不支持签到**，隐藏签到入口、自动签到直接跳过（**不写任何状态**）。探测结果
  缓存 30 分钟，`/status` 通过 `checkin.supported` 三态（`true`/`false`/`null`）
  暴露给胶囊。代理补齐端点后入口会自动出现，无需升级插件。

### Added
- **🔑 重新登录（强制重登）**：`POST /api/workbuddy/login?force=1` 忽略本地会话
  判定直接重跑设备流；胶囊**始终**提供该入口（不做条件显示），「判定错误 →
  无法恢复」的耦合从此断开。

### Changed
- 诊断面板新增「令牌过期」（含来源）与重新登录提示；`login` 失败会弹窗说明原因。
- **README 代理安装指引更正**：原先要求"必须用 GitHub 主分支源码、不能用 PyPI
  2.0.3"，实测 PyPI **2.0.4**（2026-09-10 发布）已包含该登录修复（
  `X-Product-Code` / `_enterprise_headers` / `X-Domain` 均在包内），且 GitHub
  `main` 与 2.0.4 **内容完全一致**；而 2.0.3 确实缺少该修复。现改为推荐
  `uv tool install -U workbuddy2api`（`>= 2.0.4`），源码方式作为等价备选。
- 诊断面板的「重启命令」同步改为 `uv tool install` 方式。
- README 补充「登录态判定」章节与签到依赖说明。

## [0.1.16] - 2026-09-10

### Fixed
- **适配 DeepSeek Harness `0.1.5-rc.1`（此前 0.1.15 在该版本上完全无法加载）**。
  0.1.5-rc.1 移动了两个导出符号，而具名导入一个已不存在的符号会触发 ESM
  **加载期 `SyntaxError`**，整个插件在 `import` 阶段即崩溃（provider、状态胶囊、
  用量面板全部消失），不是运行期告警。现改为经命名空间对象取值并带兜底：
  - `@deepseek-ai/dsh-llm`：`CallId` 在 0.1.5-rc.1 改名为 `ToolCallId`。
  - `@deepseek-ai/dsh-settings`：`settingsNamespace` 已移除（改由注册内部
    `parseSettingsNamespace` 校验，规则同为 `/^[a-z][a-z0-9-]*$/`），
    `installSettingsSection` 改为 settings 服务的 `installSection` 方法。
  - `settings` 分区改走 `ctx.inject(["settings"], (c) => c.settings.installSection(...))`，
    与官方 `dsh-llm-deepseek` / `dsh-llm-pi-ai` 在 0.1.5-rc.1 上的写法一致。

### Changed
- `peerDependencies` 放宽为 `^0.1.1-rc.2 || ^0.1.5-rc.1`（`dsh-llm` /
  `dsh-settings` / `dsh-timeout`），`@deepseek-ai/cordis` 放宽为 `^4.0.1 || ^4.0.2`，
  以显式声明对 0.1.5-rc.1 的支持。修复为运行时取值，**同一个包在
  0.1.1-rc.2 与 0.1.5-rc.1 上均可加载**。

## [0.1.15] - 2026-09-10

### Fixed
- **刷新模型看不到新上架模型**：内置目录此前同时充当白名单，代理
  `/v1/models` 里凡不在目录中的模型一律被丢弃，所以平台新上架的模型
  （如 `deepseek-v4.1-flash`）刷新多少次都不会出现。现改为**黑名单**
  `RETIRED_MODEL_IDS`：只隐藏实测不可用（上游 `service info not found`）的
  旧模型 id，其余照单显示。顺带放出 7 个别名仍在服务、却被旧白名单误藏的模型
  （`minimax-m2.7`、`glm-5.0-turbo`、`hy3-preview`、`deepseek-v3-1-lkeap`、
  `deepseek-v3-0324-lkeap`、`deepseek-r1-0528-lkeap`、`hunyuan-2.0-instruct`）。
- 内置目录新增 `deepseek-v4.1-flash`，并在代理不可达时作为兜底条目。
- 🔍 诊断的「模型出字」误报修复：探针用 `hy3` + `max_tokens: 4` 发一次请求，
  而推理模型会把这 4 个 token 全花在思考上、`content` 返回空串，于是
  "代理正常"被误判成「代理返回了空响应」。现承认"有计费 completion token +
  有 choice"即为正常。

### Added
- **模型名后显示积分消耗倍率**：读取代理 `/v1/models` 的 `credits` 字段
  （`"x0.06 credits"`）并拼成 `Deepseek-V4-Flash ×0.06`；实时值优先，内置目录
  `credits` 兜底。平台未声明倍率的模型只显示模型名——不会用 0 或猜测值冒充。
- 内置目录补齐各模型 `credits`（取自 WorkBuddy 应用 `product.json`）。

### Changed（代理侧，`.workbuddy-src` / workbuddy2api）
- `/v1/models` 透出 `credits` 字段（`model_to_codex_format`），倍率不再由各客户端
  各自维护。
- 官方应用 `product.json` 与本地 `models_config.json` 合并时倍率单独回填：官方
  条目为空则沿用本地倍率，避免官方合并把倍率抹平。
- `models_config.json` 补充 `deepseek-v4.1-flash`（1M 上下文 / 50k 输出）。

## [0.1.14] - 2026-08-28

### Changed
- 状态胶囊精简：外面只保留一个 **⚙️ 设置** 按钮，点击展开菜单显示原来的
  四个操作（🔍 诊断 / 📊 用量 / 🎁 签到 / 🔄 刷新模型），每个都带明确 title。
- 浮层（诊断 / 用量）统一加 **右上角 ✕ 关闭按钮**，并支持**点击浮层外区域**与
  **按 Esc** 关闭，不再只能"再点一次菜单项"才收起。
- 菜单交互修复（与本次功能一并发布）：
  - 点击设置按钮可正常展开/收起（解决 `render()` 重建 DOM 触发外部点击误关的问题，
    给设置按钮加 `stopPropagation()`）。
  - 点击菜单项后立即收起菜单（此前只改状态不重渲染，要等下次轮询才消失）。
  - 点击页面空白处亦可收起。

## [0.1.13] - 2026-08-28

### Added
- 用量面板新增**积分消耗**统计。WorkBuddy 上游在每次对话的 usage 中返回
  `credit` 字段（如 `deepseek-v4-pro` → `0.02`），插件此前丢弃了该字段；
  现将其写入本地台账，并在 📊 用量面板展示今日/累计/按模型的积分消耗。

### Notes
- 代理未暴露账户余额接口，因此只能统计**已消耗**积分，无法显示剩余余额。
- 免费/折扣档模型上游回报 `credit: 0`，面板会提示"当前模型积分为 0"。

## [0.1.12] - 2026-08-28

### Fixed
- 恢复模型目录即白名单的过滤逻辑，模型选择器不再显示已下架/不可用的
  老模型（`deepseek-v3-1`、`glm-4.6`、`kimi-k2`、`minimax-m2.5`、
  `kimi-k2-thinking`、`hunyuan-image-v3.0` 等）。

### Added（随此前未提交批次一并发布）
- 本地 token 用量台账（`$DSH_HOME/llm-workbuddy/usage.jsonl`）与
  `GET /api/workbuddy/usage` 接口，📊 用量面板展示今日/累计/按模型明细。
- 一键诊断端点 `POST /api/workbuddy/diagnose`，真实发请求探测模型能否出字。
- 请求图片压缩，确保上游接受多模态输入。

## [0.1.11] 及更早

- `0.1.11`：适配代理动态模型列表（product.json 透传）。
- `0.1.10`：过滤已下架模型（glm-5.0/4.7/4.6、minimax-m2.5 等）。
- `0.1.9` 及之前：见 git 提交历史（`git log`）。

---

<!-- 历史版本锚点（便于生成 Release 时对比区间） -->
[0.1.18]: https://github.com/zdk119746/dsh-llm-workbuddy/compare/v0.1.17...v0.1.18
[0.1.16]: https://github.com/zdk119746/dsh-llm-workbuddy/compare/v0.1.15...v0.1.16
[0.1.15]: https://github.com/zdk119746/dsh-llm-workbuddy/compare/v0.1.14...v0.1.15
[0.1.14]: https://github.com/zdk119746/dsh-llm-workbuddy/compare/v0.1.13...v0.1.14
[0.1.13]: https://github.com/zdk119746/dsh-llm-workbuddy/compare/v0.1.12...v0.1.13
[0.1.12]: https://github.com/zdk119746/dsh-llm-workbuddy/compare/v0.1.11...v0.1.12
[0.1.11]: https://github.com/zdk119746/dsh-llm-workbuddy/releases/tag/v0.1.11
