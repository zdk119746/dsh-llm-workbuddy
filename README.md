# dsh-llm-workbuddy

[![npm version](https://img.shields.io/npm/v/dsh-llm-workbuddy.svg)](https://www.npmjs.com/package/dsh-llm-workbuddy)
[![license](https://img.shields.io/npm/l/dsh-llm-workbuddy.svg)](https://github.com/zdk119746/dsh-llm-workbuddy/blob/main/LICENSE)
[![Changelog](https://img.shields.io/badge/changelog-CHANGELOG-blue)](./CHANGELOG.md)

在 DeepSeek Harness 中使用你的 **WorkBuddy / CodeBuddy** 账号模型的 LLM 适配器插件。

它把 `workbuddy` 这个 provider 路由指向本地运行的
[workbuddy2api](https://github.com/hawklithm/workbuddy2api) 代理
（默认 `http://127.0.0.1:8787/v1`）。workbuddy2api 把 CodeBuddy/WorkBuddy 的
私有协议转成标准 OpenAI chat-completions 格式，并用本地保存的登录态完成认证，
因此本插件**不需要任何 API Key**。

装好并启动后提供两件事：

1. **模型能力**：Web 界面的模型选择器（composer 模型菜单或 `/model` 命令）会多出
   一个 **WorkBuddy** 分组，模型（DeepSeek-V4、GLM-5.x、Kimi-K2.x、MiniMax-M3、
   Hy3、Hunyuan…）随账号可用列表实时同步，点一下即可切换；支持推理的模型还会
   显示**推理等级**选择器（Low / Medium / High）。
2. **Web 登录状态小组件**：在 Web GUI 右下角常驻一个状态胶囊，**实时显示登录/
   代理状态**，未登录时一键在新标签页打开 WorkBuddy 登录页，登录完成后自动变绿。
   无需再回到终端手动跑登录脚本。胶囊**可以拖到页面任意位置**（刷新后回到右下角）。

---

## 架构一览

```
┌──────────────────────────── DeepSeek Harness Web GUI ───────────────────────────┐
│                                                                                  │
│   [ 模型选择器 (WorkBuddy 分组) ]        [ WorkBuddy 状态胶囊 (默认右下角·可拖动) ] │
│        │                                            │                            │
│        │ GET /v1/models (代理发现)                  │ GET  /api/workbuddy/status │
│        ▼                                            │ POST /api/workbuddy/login │
│   lib/index.js (WorkBuddyAdapter)                  ▼                            │
│        │ fetch                                       lib/index.js               │
│        ▼  POST /chat/completions                     (registerWorkbuddyRoutes)  │
│   workbuddy2api 代理 (127.0.0.1:8787)  ──health──▶   ├─ 读 .workbuddy/session.json│
│        │                                            ├─ 探测代理 /health          │
│        ▼                                            └─ spawn login_workbuddy.py │
│   WorkBuddy / CodeBuddy 云端                                            │        │
│                                                                          ▼        │
│                                                       login_workbuddy.py ──▶ 写回 │
│                                                            (设备流)        session │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- **后端路由**（`lib/index.js` 的 `registerWorkbuddyRoutes`）运行在 `dsh web` 的
  HTTP 服务上，通过 Cordis 的 `webServer` 服务注册（用 `ctx.get("webServer")`
  探测，`webServer` 不列入 `inject`），headless profile 下自动跳过。
- **前端胶囊**（`lib/client.js`）是零依赖的原生浏览器 JS，由 DSH 的 `dsh.client`
  双端机制注入（client-modules 的 `/plugins/??…/client.js` combo 路由下发）。
  宿主每 500ms 轮询 bundle 元数据，文件一改就推送 `rebuilt` 帧，浏览器端
  `client-hmr` 会**热重载本插件并重新 `apply()`**——所以改完 `lib/client.js`
  不用重启 `dsh web`，页面上的胶囊会自己换新（靠 `ctx.effect` 的卸载函数清干净）。
- **登录脚本**（`login_workbuddy.py`，仓库根）实现与官方 CodeBuddy 插件一致的
  device flow（`platform=CLI` + codebuddy.cn 请求头）。

---

## 前置条件（重要）

1. **代理必须独立安装并运行**：本插件**不打包**第三方代理 workbuddy2api。
   请在你的机器上单独安装并启动它（见下方「安装代理」），它把 WorkBuddy/CodeBuddy
   的私有协议转成标准 OpenAI chat-completions 格式。
2. 代理版本需 **`workbuddy2api >= 2.0.4`**（推荐直接从 PyPI 装，
   见下方「安装代理」）：
   - **2.0.3 及更早不可用**：缺少 `X-Product-Code` / Genie-IDE 等请求头与
     企业认证头（`_enterprise_headers` / `X-Domain`），登录会在最后一步 401；
   - **2.0.4 已包含该修复**（"修复登录账户轮询与企业认证 headers 传递"），
     登录成功；GitHub `main` 当前与 2.0.4 内容一致，两者皆可。
3. 登录使用**插件内置的 `login_workbuddy.py`**（本包自带，依赖系统 `python3`，
   纯标准库，Python 3.7+ 即可），**不需要**代理自带的 `--login`（VSCode platform
   会 401）。
4. 插件装入 profile 后需要**重启 `dsh web`** 才能加载新的 bundle（包括本小部件）。

> **关于「🎁 签到」**：该功能依赖代理提供 `/v1/checkin-status` 与 `/v1/checkin`
> 转发。截至 `workbuddy2api` 2.0.4，**代理并未实现这两个端点**（任何分支/PyPI
> 版本都没有）。插件会自动探测：探测到 404 时隐藏签到入口、并且不再每天自动
> 尝试，因此不会产生无效的失败记录。若将来代理补齐了这两个端点，签到入口会
> 自动重新出现，无需升级插件。

---

## 安装插件

在插件包目录（本仓库 `dsh-llm-workbuddy/`）执行：

```sh
dsh plugin --profile web add ./dsh-llm-workbuddy
```

从 npm 发布版安装（正式发布后，朋友或你自己在任何机器上）：

```sh
dsh plugin add dsh-llm-workbuddy
```

CLI 会把依赖写进 profile 并把 `dsh-llm-workbuddy` 追加到 `dsh.profile.bundles`，
同时在 `package.json` 的 `dsh.client` 声明里登记浏览器入口（见下文「Web 小部件
工作原理」）。然后**重启** `dsh web`。

> 本插件**没有构建步骤**：`lib/client.js` 是浏览器原生 JS 直接被 serve；登录脚本
> `login_workbuddy.py` 已打进包内，用系统 `python3` 运行（纯标准库，无需 uv）。
> 唯一需要自己装的是第三方代理 workbuddy2api。

---

## 安装代理（先决条件，第三方）

插件只提供模型路由与登录；真正的协议转换由 **workbuddy2api**（第三方开源项目）完成。
它**不在本插件包里**，需要单独安装并启动在 `127.0.0.1:8787`。分两种情况：

### 全新机器 / 标准安装（任何能跑 Python 的机器）

别人或你自己在**新机器**上用 npm 版插件时，推荐直接用 PyPI 装（版本 `>= 2.0.4`）：

```sh
# 1. 安装 uv（本机 Python 工具，若已装可跳过）
curl -LsSf https://astral.sh/uv/install.sh | sh

# 2. 安装代理（PyPI，需 >= 2.0.4；2.0.3 及更早缺登录所需请求头）
uv tool install -U workbuddy2api

# 3. 启动代理（监听 127.0.0.1:8787；先完成下方「登录」后再真正调用模型）
workbuddy2api --desensitize \
  --session-file ~/.codebuddy-session.json \
  --log-file ~/.codebuddy-proxy.jsonl
```

<details>
<summary>或者：从 GitHub 源码运行（等价，main 与 2.0.4 内容一致）</summary>

```sh
git clone https://github.com/hawklithm/workbuddy2api.git
cd workbuddy2api
uv run python -u -m codebuddy_proxy --desensitize \
  --session-file ~/.codebuddy-session.json \
  --log-file ~/.codebuddy-proxy.jsonl
```
</details>

> 之后任何时候想重启代理，重跑上面第 3 条命令即可（用 `uv tool` 安装时直接跑
> `workbuddy2api ...`）。若提示 `address already in use`，先停掉旧代理：
> `lsof -tiTCP:8787 -sTCP:LISTEN | xargs kill`，再重跑。

### 本仓库本地开发（可选快捷方式）

仓库根目录提供 `start-workbuddy.sh`，它会用仓库固定的 `main` 分支源码 + 本地
`.tools/uv` 工具链 + 仓库内的 `.workbuddy/session.json` 启动代理。它**不随 npm
包发布**，仅面向本仓库开发时方便：

```sh
cd /path/to/dsh-workbuddy
./start-workbuddy.sh
```

### 验证代理是否真的能用

```sh
curl http://127.0.0.1:8787/health    # {"status":"ok","authenticated":true,...}
curl http://127.0.0.1:8787/v1/models # 模型列表（含 glm-5.2 / deepseek-v4-pro ...）
```

> ⚠️ `/health` 只证明**代理进程活着**，不能证明模型能真正出字（代理进程指向旧
> 路径/文件缺失时 `/health` 仍返回 `authenticated: true`，但所有模型请求 500）。
> 想确认"模型真能用"，用右下角胶囊的 **🔍 诊断** 按钮，它会真实发一次模型请求。

> 登录态过期时 `authenticated` 变回 `false`，重跑登录即可，代理无需重启
> （会话按请求读取）。

---

## 登录：两种方式

### 方式 A（推荐）：在 Web GUI 里点一下

1. 浏览器打开 `dsh web`（默认 `http://127.0.0.1:3080`）。
2. 看**右下角**的状态胶囊：
   - 🟢 `WorkBuddy · <账号昵称>` —— 已登录，无需操作。
   - 🔴 `WorkBuddy · 未登录` 或带 `代理未运行` 提示 —— 点胶囊里的 **「登录」** 按钮。
3. 点击后，后端 `POST /api/workbuddy/login` 会 `spawn` 运行 `login_workbuddy.py`，
   解析它打印的设备流链接（`authUrl`）返回给前端；前端用 `window.open` 在**新标签页**
   打开该登录页。
4. 在新标签页用 WorkBuddy / CodeBuddy 账号（腾讯账号）完成扫码/授权。
5. 胶囊会自动从每 5 秒轮询加快到每 2 秒（最多 30 次），一旦会话的过期时间
   （见下方「登录态判定」）显示仍有效且含 `accessToken`，就切回绿态，
   显示账号昵称。

整个过程**不需要离开浏览器、不需要回终端**。

> **🔑 重新登录（强制重登）**：胶囊 **⚙️ → 🔑 重新登录** 会带 `?force=1` 调用
> 登录接口，**忽略本地会话判定**直接重跑设备流。该入口**始终可用**：本地判定
> 依赖从会话文件推导的过期时间，只是启发式（见下），token 被提前吊销时它仍会
> 显示"有效"，此时普通「登录」只会拿到 `alreadyLoggedIn`。不做条件显示是为了
> 避免"判定错误 → 无法恢复"的耦合；判定不可靠时 title 会提示"当前建议执行"。

### 登录态判定（插件如何判断"是否已登录"）

代理写入的 `~/.codebuddy-session.json` **没有 `expiresAt` 字段**，所以插件按以下
优先级推导过期时间，而不是把"字段缺失"当作"永不过期"：

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | `auth.expiresAt` | 本插件自带 `login_workbuddy.py` 写入；秒/毫秒都会归一化 |
| 2 | `refreshToken` 的 JWT `exp` | 代理会自动 refresh accessToken，因此 **refreshToken 的有效期才是会话真正的边界** |
| 3 | `accessToken` 的 JWT `exp` | 解码 JWT payload（不校验签名，只读声明） |
| 4 | `auth.expiresIn` + 会话文件 mtime | 兜底；只会低估有效期，不会高估 |

若以上都无法得出结果，接口会返回 `expiryKnown: false` 并给出
`reloginRecommended: true`（而不是假装有效）；`expiresAtSource` 会说明用的是
哪一来源，🔍 诊断面板里也会显示。

### 方式 B（传统）：在终端手动跑

使用本包内置的登录脚本（纯标准库，依赖系统 `python3`）：

```sh
python3 node_modules/dsh-llm-workbuddy/login_workbuddy.py --session-file ~/.codebuddy-session.json
# 浏览器打开打印的链接，用 WorkBuddy/CodeBuddy 账号登录
# 完成后自动保存会话到 ~/.codebuddy-session.json
```

> 仓库根目录也有 `./login-workbuddy.sh` 包装脚本（面向本地开发，走 `.tools/uv`）；
> 发布版插件直接用系统 `python3` 运行同款脚本即可。

两种方式写的是同一个会话文件，可混用：终端登录后 Web 胶囊会自动变绿，
Web 登录后终端脚本也读得到同一份会话。

---

## Web 小部件工作原理

### 后端路由（`lib/index.js`）

插件在 `apply(ctx, config)` 里用 `ctx.get("webServer")` 探测 HTTP 服务（不在
`inject` 里，headless profile 无 `webServer` 时返回 `undefined`、自动跳过），
然后通过 `webServer.register({ kind: 'exact', path, handler })` 注册两条精确
路由，并用 `ctx.effect` 包裹以便热重载自动清理。HTTP 方法过滤在 handler 内自行
判断（`req.method`），因为路由 API 本身不含方法字段：

| 方法 + 路径 | 行为 |
|---|---|
| `GET /api/workbuddy/status` | 读取会话文件（默认 `~/.codebuddy-session.json`，或配置的 `sessionFile`），**多源推导**会话过期时间（`expiresAt` → refreshToken/accessToken 的 JWT `exp` → `expiresIn`+mtime）判断会话是否有效，并 `fetch` 代理 `/health` 判断 `proxyUp`；返回 `{ sessionFile, authenticated, expiresAt, expiresAtSource, expiryKnown, expired, tokenPresent, reloginRecommended, account, proxyUp, tokenValid, loginScriptAvailable, checkin: { supported, autoEnabled, handledToday, lastResult } }`；非 GET 返回 405 |
| `POST /api/workbuddy/login` | 已有有效会话且未指定 `?force=1` 时直接返回 `alreadyLoggedIn`；否则用系统 `python3` `spawn` 包内 `login_workbuddy.py --session-file <sessionFile>`，等它打印出设备流链接后返回 `{ authUrl, pending:true }`（最长等 15 秒，超时/脚本早退返回 `{ error }`）；设备流在后台继续，前端轮询 status 感知完成。`?force=1` 强制重跑登录（见「🔑 重新登录」）；非 POST 返回 405 |
| `POST /api/workbuddy/diagnose` | **一键诊断**：真实探测健康状态，返回 `{ ok, session, health, chat, loginScriptAvailable, restartCommand, terminalCommand }`。与 `/status` 不同，它除了探 `/health`，还会**真实发一次最小模型请求**（`chat.chatWorking`），能戳穿"胶囊显示成功但模型全 500"的假象；`session` 里带 `expiresAtSource` / `expiryKnown` / `reloginRecommended`；`ok:false` 时附带两份重启命令——`restartCommand`（多行、带注释，给人看/复制）与 `terminalCommand`（**单行、无注释、无续行**，供面板的「▶ 在终端执行」直接敲进内置终端）；两者由同一份定义生成，自动区分本地 monorepo 布局与标准安装；非 POST 返回 405 |
| `GET /api/workbuddy/usage` | **用量统计**：读取本地 token 用量台账（`$DSH_HOME/llm-workbuddy/usage.jsonl`），返回 `{ today, byModel, total }`（今日/按模型/累计的 input/output tokens、请求次数，以及**积分消耗 `credit`**）；非 GET 返回 405 |
| `GET /api/workbuddy/checkin` | **签到状态**：返回 `{ supported, handledToday, lastResult, official }`；`supported` 为三态——`true`（代理有签到接口）/ `false`（探测到 404/405，代理未实现）/ `null`（尚未探测出结论）。探测结果缓存 30 分钟；非 GET/POST 返回 405 |
| `POST /api/workbuddy/checkin` | **立即签到**：透传代理 `/v1/checkin`（幂等，官方对已签到返回业务拒绝）。代理未实现签到接口时返回 `{ ok:false, supported:false, message }` 且**不写入任何失败记录** |
| `POST /api/workbuddy/refresh-models` | 清空模型发现缓存并重读代理 `/v1/models`，同时发布 `llm/adapters-updated` 让模型选择器立即重载；返回 `{ ok, announced, count, models }` |

> 会话文件与登录脚本路径的解析顺序：
> 1. 配置里显式指定的 `sessionFile` / `loginScript`；
> 2. 包内 `login_workbuddy.py` + `~/.codebuddy-session.json`；
> 3. 旧仓库布局（向上两级 `dsh-workbuddy/` 的 `.workbuddy/session.json`）自动兼容。

### 前端胶囊（`lib/client.js`）

- 作为经典 `<script>` 被 DSH 注入页面，IIFE 内直接操作 DOM，**零依赖**。
- 启动时在 `document.body` 末尾挂一个 `position:fixed` 的胶囊，**默认停在右下角**
  （CSS 的 `right/bottom`）。
- **可拖动**：按住胶囊主体（**按钮除外**，按钮是点击目标）拖到任意位置，浮层会跟着
  胶囊走并自动夹在视口内；缩窗口也会被拉回来。移动不足 4px 仍按点击处理，不会把手抖
  变成拖动。位置**刻意不持久化**（不写 `localStorage`）——**刷新页面即回到右下角**，
  这是需求而不是遗漏。
- 每 **5 秒** `GET /api/workbuddy/status`；点「登录」后加快到每 **2 秒**轮询、
  最多 30 次，直到 `authenticated:true`。
- 胶囊外面只显示一个 **⚙️ 设置** 按钮（带 title「WorkBuddy 设置」）。点击展开菜单，
  内含 **🔍 诊断 / 📊 用量 / 🎁 签到（按条件）/ 🔄 刷新模型 / 🔑 重新登录**；
  点击页面空白或选中某项后菜单自动收起。
- **🎁 签到**：**仅当代理真的实现了签到接口时才出现**（`checkin.supported === true`）。
  `workbuddy2api` 至今没有 `/v1/checkin-status` / `/v1/checkin`，此时入口不显示，
  也不会每天自动尝试——避免"点了必然 404"和长期挂着的失败记录。
- **🔑 重新登录**：**始终显示**，点击后带 `?force=1` 强制重跑设备流，忽略本地
  会话判定（详见「登录态判定」）。
- **🔍 诊断**：点它 `POST /api/workbuddy/diagnose`，弹出一个面板
  显示**真实健康状态**（登录、会话文件、代理进程、登录令牌、模型能否出字），
  发现问题时给出两份重启命令：
  - **复制重启命令**：把多行（含注释）的 `restartCommand` 放进剪贴板；
  - **▶ 在终端执行**（DSH >= 0.1.7 的内置终端）：调 `ctx.get("sidebarRight")` /
    `ctx.get("webTerminals")` 开一个右侧栏终端标签页，**等它连上并拿到输入控制权**
    后，把单行的 `terminalCommand` 敲进去并回车。终端命令会先把 8787 上的旧代理
    停掉再重启；标准安装布局下**不会**顺手跑 `uv tool install -U`（升级是有意留给人
    手动做的一步）。界面里没有终端插件时按钮不退化成死路：提示原因并把命令复制到
    剪贴板。
- **📊 用量**：点它 `GET /api/workbuddy/usage`，弹出一个面板
  显示**今日/累计 token 用量**、**积分消耗**（上游每次返回的 `credit` 累加）与
  **按模型明细**（数据来自本地台账 `$DSH_HOME/llm-workbuddy/usage.jsonl`）。
  注：代理不暴露余额/剩余积分接口，只能统计**已消耗**积分，无法显示账户剩余。
- 诊断 / 用量浮层**右上角都有 ✕ 关闭按钮**，也可点击浮层外区域或按 Esc 关闭；
  浮层默认贴在胶囊上方（上方放不下就放到下方）。
- 挂载/卸载都登记在 `ctx.effect` 上：客户端热重载会卸掉旧胶囊（含轮询定时器、
  全局监听、打开的浮层），不会叠出第二个。
- 状态映射（三态，避免把"探测失败"误报成"掉登录"）：
  - `authenticated && proxyUp` → 🟢 绿，显示 `WorkBuddy · <昵称>`
  - `authenticated && !proxyUp` → 🟡 黄，显示「代理未响应」（登录态仍有效，
    不提示点登录，避免白占一次上游）
  - `!authenticated` → 🔴 红，显示「登录」按钮

> **关于 UI 挂载位置（临时做法说明）**
>
> 当前状态胶囊用 `position:fixed` 直接注入 `document.body`。DSH 官方的 UI
> 组合机制是 **slot 系统**（`@deepseek-ai/dsh-client-ui-slots`，`ctx.slots.register`
> 注册 React 组件进声明的 slot）。按官方「组合优先、不要假设/覆盖其他插件内部实现」
> 的原则，理想做法是注册进官方 slot，而非直接改产品外壳。
>
> 评估结论：**当前 shell 声明的 slot 里没有专门的「右下角状态位」**；最接近的
> `sidebar.footer.action`、`conversation.session.header.actions`、
> `conversation.input.overlay` 都是 **React 组件位**，迁移意味着要把本插件从
> 「零依赖原生 JS」改造成 **React + 构建流程**，并依赖 shell 暴露 `ctx.slots`
> 服务。因此现阶段保留 DOM 注入（机制允许），**待官方 shell 提供合适的状态胶囊
> slot 后再迁移**。以下是已知的迁移路径（供后续参考）：
>
> ```js
> ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
>   name: "sidebar.footer.action",
>   id: "workbuddy-status",
>   locale: NS,
>   inject: () => ({ /* 轮询句柄 / 登录回调 */ })
> }, WorkBuddyStatusPill /* React 组件 */));
> ```

### 为什么不需要构建

DSH 的 `dsh.client` 机制只要求 `package.json` 里：

```json
{
  "dsh": { "client": { "platform": "web" } },
  "exports": { "./client": "./lib/client.js" }
}
```

`dsh web` 会自动把 `exports["./client"]` 指向的文件 serve 到
`/plugins/<package-name>/client.js` 并注入引导清单，**不要求打包器**。

---

## 配置

插件入口配置（profile 的 `cordis.patch.yml` 或用户设置文档的 `llm-workbuddy:`
分节）。注意：状态小组件使用的代理地址取自这里的 `baseURL`（去掉 `/v1` 后探
`/health`）。

```yaml
- id: llm-workbuddy
  name: 'dsh-llm-workbuddy'
  config:
    baseURL: http://127.0.0.1:8787/v1   # workbuddy2api 端点（小组件据此探 /health）
    # apiKey: ''                        # 代理一般不需要；如代理以 --api-key 启动则填写
    # maxTokens: 32000                  # 单请求输出上限
    # defaultContextWindow: 200000      # 未在目录中标明容量的模型使用
    # discovery: true                   # 实时拉取代理的 /v1/models（30s 缓存）
    # models: [...]                     # 静态目录（代理不可达时的兜底）
    #   每个条目可带 reasoningEffort: 'low'|'medium'|'high'（默认推理等级）
    #   以及 credits: 'x0.06 credits'（显示为模型名后的 ×0.06）
    # loginScript: ''                   # 登录脚本绝对/相对路径；默认用包内 login_workbuddy.py
    # sessionFile: ~/.codebuddy-session.json  # 会话文件路径；默认同上
```

模型列表默认取插件内置目录；代理可达时改为实时拉取 `/v1/models`（支持
`{"models": [...]}` / `{"data": [...]}` 两种返回），未列出的模型 id 仍可原样
传递。**内置目录不再是白名单**：平台新上架的模型刷新后即出现在选择器里，
无需等插件发版；只有已下架/不可用的模型 id（`RETIRED_MODEL_IDS`，上游返回
`service info not found`）会被隐藏。每个模型的推理等级（`reasoningEffort`）
默认来自内置目录，代理可达时优先沿用目录值（代理 `/v1/models` 当前只上报
`High`，不区分模型）。

**积分倍率**：模型名后面会拼上平台声明的积分倍率，例如
`Deepseek-V4-Flash ×0.06`。倍率来自代理 `/v1/models` 的 `credits` 字段
（`"x0.06 credits"`，平台写在 WorkBuddy 应用 `product.json` /
`models_config.json` 里），实时值优先、内置目录兜底；平台没声明的模型
（如个别新模型尚未写入 `product.json`）只显示模型名，不会猜一个数字。

**刷新模型**：⚙️ 设置 → 🔄 刷新模型 会清掉插件的 30s 发现缓存并重新拉取
代理列表。注意代理自身的模型清单来自本机 WorkBuddy 应用的 `product.json`
与 `models_config.json`——两者都没有的模型，刷新也不会出现，需先更新应用或
把模型补进代理配置。

---

## 排错

| 现象 | 可能原因 / 解决 |
|---|---|
| 右下角没有胶囊（也没有黄色/红色胶囊） | 先刷新页面；宿主每 500ms 轮询 bundle，改动会经 `/plugins/events` 热重载。若刷新后仍没有，看浏览器控制台是否有 `client-modules` 报错，并确认插件在 profile 的 bundles 里 |
| 点「▶ 在终端执行」提示"当前界面没有内置终端" | 这个界面没装/没启用官方终端插件（`@deepseek-ai/dsh-client-ui-sidebar-terminal` + `dsh-api-terminal-controller`），或当前没选中任何会话。命令已自动复制到剪贴板，可手动粘贴执行 |
| 胶囊一直 `…`（加载中） | `GET /api/workbuddy/status` 失败 → 确认 `dsh web` 在跑、端口正确 |
| 胶囊红 + `代理未运行` | workbuddy2api 代理没起或挂了 → 按「安装代理」章节启动（新版胶囊对"代理未响应"显示黄色，不再报成"未登录"） |
| **另一个 workspace 在跑任务时胶囊显示「未登录」，结束任务后过一会儿又恢复** | 这是**误报**，不是掉登录。整台机器只有一个代理进程（`127.0.0.1:8787`）和一份会话（`.workbuddy/session.json`），所有 workspace 共用：一边在长任务里占用模型时，`/health` 探测可能短暂失败，旧版胶囊会直接把"探测失败"画成"未登录"。新版：探测 8 秒 + 重试 + 连续两次失败才算掉线，并且显示为黄色「代理未响应」；`GET /api/workbuddy/status` 会带 `lastProbeError` / `consecutiveProbeFailures` 说明真实原因。要并行跑两个 workspace 的 WorkBuddy 任务，需要**第二份会话 + 第二个代理端口 + 第二个 profile**（`baseURL`/`sessionFile` 是 profile 级配置，同一个 profile 里改不隔离） |
| 胶囊显示登录成功但模型用不了 | 典型的"代理进程活着但指向旧路径/文件缺失"假象（`/health` 仍显示 ok）。点胶囊 **🔍 诊断**，看 `模型出字` 是否失败；按面板给出的重启命令重启代理 |
| 点「登录」没反应 / 按钮灰 | `loginScriptAvailable:false` → 包内 `login_workbuddy.py` 缺失或系统无 `python3`；检查安装。若返回了 `error`（脚本 15 秒内没打印授权链接、或退出码非 0），页面会弹出具体原因 |
| 点「登录」弹出 `alreadyLoggedIn`，但 token 实际已失效 | 本地判定是启发式（会话文件可能没有 `expiresAt`）→ 用 **⚙️ → 🔑 重新登录** 强制重跑登录 |
| 胶囊绿但所有模型 401 | accessToken/refreshToken 都已过期但判定未察觉 → **⚙️ → 🔑 重新登录**；或先 **🔍 诊断** 看「令牌过期」一行 |
| 设置菜单里没有「🎁 签到」 | **正常现象**：该代理未实现 `/v1/checkin-status` / `/v1/checkin`（`workbuddy2api` 至今未提供），插件探测到 404 后自动隐藏入口并停止每日自动尝试 |
| 设置菜单里的「🔑 重新登录」 | 该入口**始终可用**；判定结果不可靠时 title 会提示"当前建议执行" |
| 新标签页打开后登录完成，胶囊仍是红 | 会话文件（默认 `~/.codebuddy-session.json`）未刷新或已过期 → 刷新页面或点「🔑 重新登录」 |
| 代理版本报错 / 登录最后一步 401 | 代理过旧（< 2.0.4，缺 `X-Product-Code`、`_enterprise_headers` 等）→ `uv tool install -U workbuddy2api` 升级到 >= 2.0.4 |
| 启动 `dsh web` 报 `EPERM ... cordis.yml` | `.dsh` 所在系统卷受保护（`/System/Volumes/Data` 带 `protect`）。解决：`sudo chown -R $(whoami) /Users/jiyunyang/.dsh`，或 `export DSH_HOME=$HOME/dsh-home` 后重新 `dsh plugin --profile web add` 并把插件链接进新 home |
| 模型请求 `TRANSPORT` 错误 | 代理未运行或端口不对（连接被拒绝） |
| **任务跑着跑着就死了 / 之后怎么重试都起不来** | 上游 `429 / 400 / 5xx` 以前被代理包成 `200 + SSE error 帧` 且不补 `[DONE]`，客户端只看到 `STREAM_CLOSED`（不在 harness 重试策略里）→ 任务当场终结。新版会翻成 `QUOTA` / `RATE_LIMIT` / `INVALID_REQUEST` / `SERVER` 并带上游原文（如"您的使用量已超出频率限制，将在 … 重置"）。若报 `QUOTA`：等重置或换模型 |
| 报错 `WorkBuddy SSE stream ended without [DONE]` | 旧版代理的同一个问题（现在只会在"已经输出了一部分内容后连接被切断"时出现，这是真实的截断，应当重试整个请求） |
| 模型长时间只推理、不调用工具，像是卡住 | 检查代理日志里有没有 `tools_truncated`：旧版把 DSH 的 60 个工具按顺序砍到 30 个（`read`/`write`/`grep`/`web_search` 等全被丢掉，system prompt 里却还写着）。实测上游接受 60 个，默认上限已提到 64；也可用 `--max-tools N` 调整 |
| 中止任务后 WorkBuddy 要过一会儿才恢复 | 中止后上游请求可能仍在生成，账号一直被占着 → 适配器现在监听中止信号、立刻 abort 上游请求；代理也会记录 `client_disconnected` |
| 模型请求立刻返回 401 `auth_error`（以前是长时间无响应后所有模型一起卡） | 代理不再在请求路径里同步跑交互式登录（那会冻住整个事件循环）；token 刷新失败就快速 401 → **⚙️ → 🔑 重新登录** 后重试 |

---

## 限制

- 图片输入：声明支持图片的模型（`inputModalities: ["text", "image"]`，如 deepseek-v4-pro、
  glm-5.2、kimi-k2.x、hy3 等）可附带图片，适配器会通过 DSH 的附件服务把图片编码为
  `data:<mime>;base64,<bytes>` 以 OpenAI `image_url` 格式透传给代理。若附件服务不可用
  （headless 等无附件场景），图片输入会以 `UNSUPPORTED_CONTENT` 稳定报错。
- 推理等级（reasoning effort）：支持推理的模型（如 DeepSeek-V4、GLM、Kimi、MiniMax、
  Hy3 等）会显示推理等级下拉（Low / Medium / High），默认值取平台默认强度。`reasoning_effort`
  会透传给代理；若某模型平台侧只接受平台默认、忽略该参数，则退化为平台默认强度，不影响出字。
- 代理未运行时，模型请求会以 `TRANSPORT` 错误快速失败（连接被拒绝）；但状态
  小组件本身不依赖代理——代理挂了它仍能显示「代理未运行」并允许触发登录。
- 登录态有效期由 WorkBuddy 云端决定。插件会尽力从会话文件推导过期时间
  （见「登录态判定」），但**推导不出时只能标记为"未知"而不是失败**；真正的
  失效检测以一次真实模型请求（🔍 诊断的「模型出字」）为准，恢复手段是
  **🔑 重新登录**，代理无需重启。
- **签到功能依赖代理实现 `/v1/checkin-status` 与 `/v1/checkin`**；截至
  `workbuddy2api` 2.0.4（含 GitHub `main`、`dsh`、`codex` 各分支）均未提供，
  因此默认不显示签到入口。代理侧补齐后无需升级插件，入口会自动出现。

---

## 文件索引

| 路径 | 作用 |
|---|---|
| `lib/index.js` | Cordis 插件主体：LLM 适配器 `WorkBuddyAdapter` + `/api/workbuddy/*` 路由（status / login / **diagnose**） |
| `lib/client.js` | 零依赖浏览器小部件（**可拖动**状态胶囊 + 登录流程 + **🔍 诊断**（含**在终端执行**）/ 📊 用量），被 `dsh.client` 注入 |
| `login_workbuddy.py` | 设备流登录脚本（随包发布，被后端路由用系统 `python3` spawn） |
| `cordis.patch.yml` | 本包的 Cordis bundle 挂载声明（`id: llm-workbuddy`） |
| `package.json` | 包元数据、`dsh.client` 浏览器入口声明、`llm-workbuddy` peer 依赖 |

> 第三方 workbuddy2api 代理**不在包内**，需单独安装（见「安装代理」章节）。
> 仓库根目录的 `start-workbuddy.sh` / `login-workbuddy.sh` / `.workbuddy/` 是本地
> 开发用的配套文件，不随 npm 包发布。

## 更新日志 / Changelog

每次发版的改动记录见 [CHANGELOG.md](./CHANGELOG.md)。

### 发版流程（确保 GitHub 有更新说明）

1. 改完代码后，在 `package.json` 里 `version` 自增（语义化版本）。
2. 在 `CHANGELOG.md` 顶部补一段本次版本（`## [x.y.z] - 日期`）的 Added / Fixed / Changed。
3. 提交并打 tag：`git commit -am "release: x.y.z"` 然后 `git tag vx.y.z`。
4. `git push origin main --tags`，到 GitHub 用该 tag 创建 **Release**——
   Release 的描述直接引用 CHANGELOG 对应段落，仓库页面就有了「改了啥」的说明。

> 注意：本机 `dsh web` 通过符号链接直接加载本地目录，因此**本地改动能立刻重启生效**，
> GitHub 上的版本只影响通过 `dsh plugin add dsh-llm-workbuddy` 安装的其他用户。
