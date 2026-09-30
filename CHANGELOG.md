# Changelog

本文件记录每个版本的改动。版本号遵循语义化版本（MAJOR.MINOR.PATCH），
每次发版请同步 `package.json` 的 `version` 并打一个 `git tag`（如 `v0.1.13`），
在 GitHub 创建 Release 时本文件即为更新说明来源。

## [0.1.25] - 2026-09-30

### Changed

- **面板文案统一成 `累计(本周)`**：0.1.24 面板正文写成「本周累计」、积分行写成
  「本周」，跟原来的「今日积分消耗 ｜ 累计：…」不连贯。现在所有出现「累计」的
  位置都用同一写法：
  - `今日：输入 … / 输出 … tokens（N 次请求）`（未变）
  - `累计(本周)：输入 … / 输出 … tokens（N 次请求）`
  - `今日积分消耗：86.36 ｜ 累计(本周)：1943.55`
  - `按模型明细(本周)：`
  - 备注句、⚙️ 菜单里 📊 用量的 title（`今日/累计(本周)`）、README 的接口表与
    「📊 用量」小节一并统一。

### Tests

- `test/client.test.mjs` 新增「用量面板文案」用例：喂一份 `{ today, week, byModel,
  total }` 响应，断言面板正文恰好包含
  `今日积分消耗：86.36 ｜ 累计(本周)：1943.55`、`累计(本周)：输入 … tokens（12 次请求）`
  与 `按模型明细(本周)：`，并且**不再出现裸「累计：」**、也不显示全量 `total`。

### Notes

- 0.1.24 已经发布到 npm（版本号不可复用），所以这次文案修正走 **0.1.25**。
- **改完必须重启 `dsh web`**：宿主把插件客户端 bundle 缓存在内存里
  （浏览器拿的是 `/plugins/??dsh-llm-workbuddy/client.js&rev=…`，rev 由文件元数据
  算出），宿主侧的 `lib/index.js` 同样只在进程启动时加载。实测：编辑后
  `/plugins/events` 里该插件的 `rev` 不变、`/api/workbuddy/usage` 也还是旧的
  字段（没有 `week`），**刷新浏览器没用**；重启 `dsh web` 后两者一起更新。
  README 排错表补了这条（含"怎么确认 rev/字段真的换了"的检查命令）。

## [0.1.24] - 2026-09-30

两件事：📊 用量面板的统计口径改成**今日 + 本周累计**——跨周不再看到一个不断变大、
没有参照的总数，本周数字从**周一 00:00（本地时间）**起算，历史记录照旧留在台账里；
以及新增模型 **GLM-5.3-Flash**。（面板上这两个词的写法在 0.1.25 统一成了
`累计(本周)`。）

### Added

- **新增模型 `glm-5.3-flash`（GLM-5.3-Flash）**：平台已经上线，但代理包内的模型
  快照还是旧的，`/v1/models` 不报它，选择器里自然也没有。条目取值来自 WorkBuddy
  应用的远程产品配置缓存 `~/.workbuddy/cache/acc-product-config-v3.json`，
  **不猜数字**：1M 输入 / 128k 输出、支持图片与工具调用、`x0.06` 倍率、默认推理
  `high`。
  - **代理侧**（`.workbuddy-src`）：`models_config.domestic.json` 补上该条目，根
    目录开发兼容副本同步为**字节一致**（有测试守着）。代理**每次请求都重新读这个
    资源**，所以改完立即生效，**不用重启代理**。
  - **插件侧**（`lib/index.js`）：内置目录 `DEFAULT_MODELS` 同步补上（代理不可达时
    兜底）。代理当前的 `/v1/models` **不透出 `credits` 字段**，倍率显示靠这份目录，
    所以这里必须写 `credits`。
  - 插件仓库副本 `dsh-workbuddy/models_config.json` 一并补条目，保持同步。

### Changed

- **面板**（`lib/client.js`）：「今日」保持不变，原来的「累计」一行改为**「本周累计」**，
  「按模型明细」改为**「本周按模型明细」**（与本周同一窗口，逐行相加等于本周累计）；
  积分行同样改为「今日积分消耗 ｜ 本周」。
- **接口**（`GET /api/workbuddy/usage`）：新增 `week` 字段（本周累计），`byModel` 的
  口径改为**本周**；`total` 字段**保留**为全量累计（仅兼容/自检用，面板不再显示），
  所以旧客户端、桌面端旧版本不会因为这次改动拿不到数字。
- 客户端对**尚未重启的服务端**做了兜底：拿不到 `week` 时回落到 `total`，面板不会空白。
- 本周窗口由 `startOfWeekMs()` 计算（`getDay()` 的周日基准换算成**周一起算**），
  与 `today` 一样走本地时区，不引入任何日期库。

### Tests

- `test/usage-ledger.test.mjs` 新增第 8 个用例：本周窗口确实从**周一 00:00** 开始、
  今日包含在本周内；往台账追加一条**上周**的记录后，`week` / `byModel` 不涨、
  `today` 不涨，而 `total` 照旧加一（证明历史没丢，只是不在本周口径里）。
- `test/adapter.test.mjs`：模型发现用例断言 `glm-5.3-flash` 在内置目录里、显示名带
  倍率（`GLM-5.3-Flash ×0.06`）、支持图片；`resolveModel` 用例断言平台声明的容量
  （1M 上下文 / 131072 输出）；代理不可达的兜底用例断言新模型仍在静态目录里。
- 代理侧 `pytest test_backend_profiles.py test_models_endpoint.py`（含根副本与包内
  资源**字节一致**的断言）通过。

### Verified

- 用量口径：合成台账（上周 1000/2000、昨天 10/20、今天 5/7）下 `week` 只算本周
  两条、`today` 只算今天、`total` 仍是全量三条，`byModel` 相加等于 `week`。
- 新模型用**真实上游**验证过（不是只看配置）：`POST /v1/chat/completions` 带
  `model: glm-5.3-flash` 返回 200；经插件的 `stream()` 跑完整链路拿到正文
  （`1+1=2`）、usage 与 `finish: stop`；`/v1/models` 立刻多出该模型，
  `listModels()` 显示 `GLM-5.3-Flash ×0.06`。

## [0.1.23] - 2026-09-30

修掉用量台账的**跨进程竞态**与**每请求整文件重写**——这两个问题在 Web 版和桌面版
同时跑（共用一个 `$DSH_HOME`）时才会暴露出来。

### 症状

平时看不出来，只有在"两个 harness 同时跑任务"时才会：

- 用量面板上的累计 token / 积分**偶尔少几条**（丢的是另一个进程刚追加的记录）；
- 台账涨到上限之后，**每一次请求**都会同步重写整个台账文件（约 2.5 MB），
  请求路径上白挨一次大文件读写；
- 极端情况下，正在截断重写的瞬间去读台账，`GET /api/workbuddy/usage` 会读到
  一个空文件或半截文件——面板上的今日用量会瞬间跳成 0（下一次刷新又恢复）。

### 根因

旧实现是"**读全文 → 截掉旧行 → 原地重写**"：

```js
appendFileSync(file, line);                       // 追加（这步本来是安全的）
if (size > USAGE_MAX_LINES) {                     // 20000 行
  const lines = readFileSync(file)…slice(-20000);
  const fd = openSync(file, "w");                 // ← 立刻截断
  writeSync(fd, lines.join("\n") + "\n");         // ← 整文件重写
}
```

三个问题：

1. **无锁读-改-写**：A 读完、还没截断时，B 追加的那一行会被 A 的截断吃掉；
2. **判据是 `> 20000` 而裁完正好剩 20000 行**：于是越过 2 万行之后，**每一次追加**
   都会触发一次全文重写；
3. **`openSync(file, "w")` 会先把文件清零**：并发的读者能观察到一个空台账。

### Fixed

- **改成"轮转"而不是"原地重写"**：live 文件超过 `USAGE_ROTATE_AFTER_BYTES`
  （1.5 MB，约 1.2 万次请求）时，用一次 `renameSync` 原子改名成 `usage.jsonl.1`，
  下一次追加自然重建 live 文件。
  - 已经打开了旧文件的追加者，它的行落进**归档**里，而读取端把归档一起算，
    所以**一行都不会丢**；
  - 读者永远看不到被清零/半截的台账（改名前后的文件都是完整的）；
  - 触发条件改为文件大小，每次追加只多一次 `statSync`（O(1)），
    取代了原来那次 O(n) 的全文读取。
- **轮转加跨进程锁**（`usage.jsonl.lock`，`openSync(..., "wx")` 原子创建）：
  两个 harness 不会同时轮转而互相覆盖归档；拿锁后**再复查一次大小**，避免
  "另一个进程刚轮转完，我接着把新的空 live 文件改名过去、把刚归档的历史覆盖掉"。
  持锁进程崩溃留下的死锁会被识别（超过 30 秒视为遗弃）并接管，不会永久卡住轮转。
- **读取端把归档 + live 一起统计**：所以轮转**不会**让 `total` 归零。
- 顺带清理：`USAGE_MAX_LINES` 换成 `USAGE_ROTATE_AFTER_BYTES`，删掉不再使用的
  `writeSync` / `truncateSync` 导入。

台账总占用因此稳定在约 3 MB（live + 归档各最多 1.5 MB），语义上保留的是
**最近约 2.4 万次请求**（旧实现是最近 2 万行）。

### Tests

开发测试套件新增 `usage-ledger` 用例（与既有 `test/*.test.mjs` 并列，**不随包发布**）：
7 个用例覆盖"缺文件读成 0"、"轮转不丢行且归档保留历史"、"轮转后继续追加仍计入累计"、
"半截行被跳过而不是抛错"、"死锁被接管"、"持锁时读取不阻塞也不清锁"，以及最关键的
**两个真实子进程跨轮转边界各写 9000 条、合计 18000 条一条不少**（按模型分别精确校验，
丢失和串行错乱都能抓出来）。

### Docs

- README 新增「多个 harness 同时用（Web 版 + 桌面版）」小节：说明两个实例哪些是
  完全隔离的、哪些是共享的（代理、用量台账、签到标记），以及唯一需要注意的硬耦合
  （从任一侧重启代理/重新登录会打断另一侧进行中的流）。
- README「用量」小节补充台账轮转与多实例合并统计的说明。

## [0.1.22] - 2026-09-30

适配 **DeepSeek Harness 0.2.0-rc.2（桌面端）**。

### 症状：在 0.2.0 上根本装不上

```
dsh: installation rejected: Plugin dsh-llm-workbuddy@0.1.21 is incompatible with
dsh 0.2.0-rc.2: peerDependencies {"@deepseek-ai/dsh-llm":"^0.1.1-rc.2 || ^0.1.5-rc.1",
"@deepseek-ai/dsh-settings":"…","@deepseek-ai/dsh-timeout":"…"}.
Running it may cause crashes or data loss.
```

### 根因

DSH 从 0.2.0 起在安装与启动两条路径上都会校验插件声明的 `@deepseek-ai/dsh*`
peer 范围（`@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility`，判定式为
`semver.satisfies(runtimeVersion, range, { includePrerelease: true })`），不满足就
以 `incompatible-version` **拒绝安装/拒绝启动**。

本插件当时的范围 `^0.1.1-rc.2 || ^0.1.5-rc.1` 上界是 `<0.2.0`，于是运行时
`0.2.0-rc.2` 落在范围外 → 被判定不兼容。registry 规格是**装前判**（直接拒绝，不下载），
而 **GitHub / tarball 规格是装完再判**，所以从 GitHub 安装的表现是"pnpm 装好了、
随后被回滚"，最容易被误读成网络或插件本身的问题。

### Changed

- `peerDependencies` 里的 `@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-settings` /
  `@deepseek-ai/dsh-timeout` 各追加 `|| ^0.2.0-rc.2`，并**保留**原来的
  `^0.1.1-rc.2 || ^0.1.5-rc.1`——两头的运行时都还在支持范围内，不是"只支持新版"。
  `@deepseek-ai/cordis`（运行时 4.0.4）与 `@deepseek-ai/schemastery`（3.18.4）
  的原有范围已覆盖 0.2.0 运行时，未改。

### 为什么只动范围：0.2.0 并没有破坏本插件用到的 API

逐字节比对了 npm 上 `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-settings`、
`@deepseek-ai/dsh-timeout` 的 `0.1.7-rc.2` 与 `0.2.0-rc.2`：**除
`dsh-llm/lib/typert.host.js` 里多了一条 `user-question-reply` 的类型声明
（本插件不 import 该文件）外，其余文件完全相同**，版本号之外没有 API 变化。

插件实际依赖的宿主扩展点在 0.2.0 中也逐一确认仍然存在且签名未变：

- `ctx.llm.registerAdapter` / `ctx.llm.registerConfigurableProviders`（`@deepseek-ai/dsh-llm`）；
- `ctx.inject(["settings"], …)` + `installSettingsSection`（`@deepseek-ai/dsh-settings`）；
- `webServer.register({ kind, path, handler }) → disposer`（`@deepseek-ai/dsh-host-webserver`）；
- `package.json` 的 `dsh.bundle.patch` 与 `dsh.client.platform: "web"` 两个声明；
- 客户端 `window.__ModuleLoader__.load({ id, factory })` 注册契约
  （`@deepseek-ai/dsh-client-modules`）。

### 验证方式（在真实 0.2.0-rc.2 运行时上实测）

用**桌面端自带的那份运行时**（走
`…/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/…`，`DSH_HOME` 指向临时目录，
全程没有碰本机 `~/.dsh`）：

- `dsh plugin --profile compat add <本目录>` → ✅ 通过兼容性校验，bundle 行写入
  `dsh.profile.bundles`（改之前同一条命令稳定复现上面的 rejected 报错）；
- 启动该 profile → ✅ 插件加载无任何报错；
- `GET /api/workbuddy/status` ✅ 返回真实登录态；`GET /api/workbuddy/usage` ✅；
  `POST /api/workbuddy/refresh-models` ✅ 返回 18 个模型且 `announced:true`
  （说明适配器注册与 `adapters-updated` 广播都正常）；
- 浏览器引导清单里出现 `dsh-llm-workbuddy/client.js`，combo 资源请求 200 ✅；
- 用 `workbuddy/auto` 跑了一轮真实的 headless 生成 ✅ 端到端可用。

## [0.1.21] - 2026-09-29

修复"回答卡在半句话上 / 一直等 / 没报错就突然结束"。

**重要更正**：这条 DSML 扣留正文的 bug，**上游代理已经在 `2.0.4` 修掉了**
（commit "修复 DSML 流式缓冲器吞掉含 '<' 的残留内容导致输出截断"，2026-08-22 合入
`hawklithm/workbuddy2api`，PyPI 目前 2.0.6）。踩到它的机器是**从源码启动的旧
checkout**（本地 `.workbuddy-src` 停在 `57f6b03`，恰好是该修复的**父提交**），
而按 README 用 PyPI `>= 2.0.4` 的用户本来就没这个问题。

所以本版本的定位是：**把"代理版本"这件事变得可检测、可执行**，并顺手修掉一个上游
还没修、插件侧能独立修的问题（中途断流被整轮静默重试）。DSML 那条修复在插件里是
**修不了的**——它必须由代理提供。

### 根因（一句话）

代理的 DSML 流式缓冲器收尾判断是 `if '<' in self.buffer: return "", None`：缓冲区
里只要出现过**任意一个 `<`** 就永久拒绝输出。`<` 在正常正文里极常见——
Kotlin/Java 泛型 `BaseMapper<User>`、`List<String>`、HTML 标签、`a < b` 都算。
于是从那个字符起，代理**再也不向客户端输出正文**（chunk 照发，`content` 全是空串），
流正常收尾时把扣留的正文直接丢掉。实测（server 工作区）：

- step 5：客户端只收到 401 字、结尾停在 `interface UserMapper : BaseMapper`，
  之后 **313.1 秒零可见输出**，直到用户手动中止；
- step 4：同样在 178 字后静默 **205.5 秒**，随后上游 `ReadError`，整轮被重写。

`<` 恰好出现在 Kotlin/Java/Spring 场景里，所以"server 工作区"感觉最明显；
WorkBuddy 官方客户端直连上游、没有这层改写，所以同一个模型在里面完全正常。

### Fixed

- **插件侧（本版本真正新增的修复）：中途断流不再整轮静默重试**。已经流出内容之后
  才断的流（代理 502 `transport_error`、空闲超时等）以前落在 harness 的默认可重试
  集合（`EMPTY_RESPONSE|RATE_LIMIT|SERVER|TIMEOUT|TRANSPORT`）里，会**重跑整轮生成
  并丢掉用户已经看到的内容**。现在报不可重试的 `STREAM_TRUNCATED`，保留已显示内容
  并明确告知"回答被截断"，由用户决定继续还是重发。一个字节都没拿到时的
  `EMPTY_RESPONSE` 重试行为不变。
- **升级要求写清楚并尽量可检测**：README 的"代理 >= 2.0.4"从"登录 headers 需要"
  升级为**硬性内容要求**（2.0.4 同时修掉了正文截断），建议直接 `>= 2.0.6`。

### Added

- **代理能力探测**：`/health` 若提供 `version` / `features`，插件据此判断代理是否
  过旧，胶囊显示黄色**「代理过旧」**、🔍 一键诊断给出升级命令。判定规则：
  `features` 里缺 `dsml-holdback-fixed` → 过旧；只报 `version` 时 < `2.0.4` → 过旧；
  **两者都没有（上游 2.0.4~2.0.6 就是这样）→ 保持沉默**，不误报。
  `/api/workbuddy/status` 与 `/api/workbuddy/diagnose` 新增 `proxyVersion` /
  `proxyFeatures` / `proxyOutdated` / `proxyMissingFeatures` / `proxyOutdatedReason` /
  `proxyUpgradeCommand` / `proxyVersionKnown` 字段。
- **（本地源码分支，不属于本 npm 包）** 给自建代理补了两处上游尚缺的东西：`/health`
  返回 `version` + `features`；空闲/总时长超时改用真实计时器（`asyncio.wait_for`），
  不再"下一行到达时才判定"。

### 发布检查（维护者）

1. **用户侧什么都不用做**：只要代理是 PyPI `>= 2.0.4`（当前 2.0.6），正文截断的
   根因已经没了。本插件版本只是让"版本不够"这件事**可见**，并把截断的中途断流
   变成不再自动重试。
2. 想让"代理过旧"在**所有**用户机器上都能自动识别，需要上游 `/health` 暴露
   `version`（或 `features`）——这是可选的增强，可以提 PR；在它落地前，插件对
   没有这两个字段的代理保持沉默，靠 README + 升级命令提示。
3. 若继续用**本地源码**方式启动代理：不要再停在 `57f6b03`，`git pull` 到
   `>= 2.0.4` 的提交（当前 main = 2.0.6）；本地那两处补丁（DSML 扣留、flush 补发）
   与上游重复，应丢弃后只保留 `/health` 能力位与空闲计时器两处，避免与上游冲突。

## [0.1.20] - 2026-09-28

这个版本里有一次**必须升级的修复**，外加两个新功能。

修复：升级到 DSH 0.1.7 后，**所有带工具调用的会话都会报 11148**（"工具记录不完整，
请新建任务"）——同一段历史每次原样重发，所以换模型、重试、重启都无效，只有新建
会话才能继续。如果你在用 workbuddy provider，请务必升到这个版本。

新功能：状态胶囊可以拖到任意位置了；诊断面板多了一个「▶ 在终端执行」，直接借用
DSH 0.1.7 的内置终端把代理重启起来，不用再复制命令、切窗口、粘贴。

### Added
- **胶囊支持拖动到任意位置**。默认仍在右下角（CSS 的 `right/bottom`），按住胶囊
  主体拖走后改为固定 `left/top` 定位；**位置刻意不持久化**（不写 `localStorage`），
  所以**刷新页面就回到右下角**——这是需求，不是遗漏。细节：
  - 拖动阈值 4px：小于它仍按点击处理，手抖不会把"点一下"变成拖动；
  - **按钮不是拖动手柄**（从 `button` 上按下直接退出拖动），否则"点登录"会被吃掉；
  - 拖动/缩窗口都会被夹在视口内，松手后清掉 `wb-host--dragging` 状态类；
  - 诊断/用量浮层改为**跟着胶囊走**：优先贴在胶囊上方，上方放不下就放到下方，
    内容异步变高后重新贴一次（避免面板长高压住胶囊）。
- **诊断面板新增「▶ 在终端执行」按钮**（DSH >= 0.1.7）。点击后：
  1. 通过客户端服务 `sidebarRight` / `webTerminals`（都走 `ctx.get` 惰性读取）
     打开一个右侧栏终端标签页；
  2. 等这个终端**连上并拿到输入控制权**（`state.phase === "connected" &&
     state.writable`）——刚 `openTab` 时 `writable` 还是 false，此时 `write()`
     会被静默丢弃，所以必须等；
  3. 把命令敲进去并回车。
  终端命令与面板显示的文本**同源生成**（`diagnoseRestartPlan()` 返回
  `{ display, exec }`），接口新增 `terminalCommand` 字段：
  - `display` 仍是多行、带注释，给人看/复制（`restartCommand`，行为不变）；
  - `exec` 是**单行、无注释、无 `\` 续行**（换行会让终端执行半条命令，注释会吞掉
    后半句），并且先停掉 8787 上的旧代理（`xargs kill 2>/dev/null`，无进程时
    不报错也不中断重启）；
  - 标准安装布局下**不**把 `uv tool install -U` 塞进单行命令：升级是有意留给人手动
    做的一步，塞进去会让一次"重启"变成一次慢且难归因的升级。
  - 界面里没有终端插件（或没选中会话）时按钮不是死路：提示原因并**自动把命令复制
    到剪贴板**，可以自己粘进任意终端。

### Fixed
- **工具结果被当成用户消息发出去，上游拒收整段历史（升级 DSH 0.1.7 后所有带工具
  调用的会话都报 11148 的主因）**。
  DSH 从 `0.1.7-rc.1` 起把工具结果改成了**一等公民消息**：新增 `role: "tool"`
  消息（带 `toolCallId` / `isError`），不再在 user 消息里放 `tool-result`
  内容块；`developer` 消息也开始出现。适配器只认旧模型，于是所有工具结果都
  落进了「其它角色按 user 处理」的分支，被序列化成 `{role: "user", content: …}`。
  上游看到的是一串**有 `tool_calls` 但没有对应工具结果**的 assistant 轮次，于是
  整段请求被拒：

  > `HTTP 400 code 11148` — tool calls and tool results do not match,
  > please start a new conversation and retry（"工具记录不完整，请新建任务"）

  这是**不可重试**的失败：同一段历史每次都会原样重发，所以换个模型、重试、
  重启都无效，只有新建会话才能继续。

  实测证据（同一条链路三层对上）：
  1. 会话记录里工具结果是 `role: "tool"` 消息 —— 09-28 那次失败的会话里有
     **71 条** `"role":"tool"`，`tool-result` 块 **0 条**；
  2. 本地代理日志里，失败请求的消息序列是
     `system → user → user → assistant(tool_calls) → user`，**一条 `role: "tool"`
     都没有**（对比 09-24 及以前：每天几百条 `role: "tool"`，09-25 之后为 0）；
  3. 用同一条历史直接打上游：结果以 `role: "user"` 发出 → 稳定复现 `11148`；
     以 `role: "tool"` 发出 → `HTTP 200` 正常作答。

  现在适配器同时支持两种模型：
  - `role: "tool"` 消息 → `{role: "tool", tool_call_id, content}`（新模型）；
  - user 消息里的 `tool-result` 内容块 → 同样映射为 `role: "tool"`（旧模型，
    兼容 0.1.6 及更早）；
  - 工具结果为空时仍写 `"(no output)"` —— 空 body 会让上游同样判为配对缺失；
  - `developer` 消息（工具增删记账）不再被当成空 user 消息发出：OpenAI 兼容
    上游用 `tools` 数组表达工具集，这类记账没有对应的线上表示（该角色本来也
    会被 harness 在声明 `toolUpdate` 之前剥掉，这里只是兜底）；
  - 内容为空的 user 消息（无文本、无图片）不再发出（与官方适配器一致）。
- **客户端插件挂载没有清理，热重载会叠出第二个胶囊**。`dsh-client-hmr` 每 500ms
  轮询客户端 bundle，改动后会在浏览器里**热重载插件并重新 `apply()`**；而原来的
  `apply()` 只往 `document.body` 追加节点，没有任何卸载路径，重载一次就多一个胶囊、
  多一个 5 秒轮询定时器、多一份全局监听。现在：
  - `apply` 把挂载注册进 `ctx.effect(...)`，卸载函数会停掉轮询、摘掉
    `document`/`window` 监听、关掉所有打开的浮层、移除胶囊与样式；
  - 挂载前先清掉同名的残留节点（`#wb-status-host` / `#wb-status-style`），
    对旧版本留下的孤儿节点也有效。
- **测试补上回归防线**：
  - `test/adapter.test.mjs` 新增 2c 组：直接断言线上报文的角色序列必须是
    `user → assistant(tool_calls) → tool`，并覆盖新旧两种消息模型与空工具输出；
  - `test/tool-match-e2e.mjs`（新增）：对真实代理的对照实验——同一条历史，
    结果以 `role: "user"` 发出会稳定复现 `11148`，以 `role: "tool"` 发出则
    `HTTP 200` 正常作答；需要已登录的本地代理才能跑；
  - `test/client.test.mjs`（新增）：用最小 DOM 桩跑真实 `lib/client.js`，覆盖
    初始定位、拖动阈值、跟手与夹取、浮层跟随、按钮不触发拖动、「在终端执行」的
    完整时序（未 `writable` 时不得写入）、没有终端服务时退回剪贴板、以及
    重复挂载不叠影 + 卸载清理；
  - `test/routes.test.mjs` 新增 ROUTE 6：断言诊断接口同时给出可读的
    `restartCommand`（多行、带注释）与单行的 `terminalCommand`（无换行/注释/续行、
    先停 8787、与前者指向同一个启动器）。

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
