# dsh-llm-workbuddy

[![npm version](https://img.shields.io/npm/v/dsh-llm-workbuddy.svg)](https://www.npmjs.com/package/dsh-llm-workbuddy)
[![license](https://img.shields.io/npm/l/dsh-llm-workbuddy.svg)](https://github.com/zdk119746/dsh-llm-workbuddy/blob/main/LICENSE)

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
   无需再回到终端手动跑登录脚本。

---

## 架构一览

```
┌──────────────────────────── DeepSeek Harness Web GUI ───────────────────────────┐
│                                                                                  │
│   [ 模型选择器 (WorkBuddy 分组) ]            [ WorkBuddy 状态胶囊 (右下角) ]      │
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
  双端机制在 `window.__DSH_BOOT__` 中注入，serve 于
  `/plugins/dsh-llm-workbuddy/client.js`。
- **登录脚本**（`login_workbuddy.py`，仓库根）实现与官方 CodeBuddy 插件一致的
  device flow（`platform=CLI` + codebuddy.cn 请求头）。

---

## 前置条件（重要）

1. **代理必须独立安装并运行**：本插件**不打包**第三方代理 workbuddy2api。
   请在你的机器上单独安装并启动它（见下方「安装代理」），它把 WorkBuddy/CodeBuddy
   的私有协议转成标准 OpenAI chat-completions 格式。
2. 代理必须跑在 **workbuddy2api 主分支源码**上，不能用 PyPI 的 2.0.3：
   旧版缺少 `X-Product-Code` / Genie-IDE 等请求头，登录会在最后一步 401。
3. 登录使用**插件内置的 `login_workbuddy.py`**（本包自带，依赖系统 `python3`，
   纯标准库，Python 3.7+ 即可），**不需要**代理自带的 `--login`（VSCode platform
   会 401）。
4. 插件装入 profile 后需要**重启 `dsh web`** 才能加载新的 bundle（包括本小部件）。

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

别人或你自己在**新机器**上用 npm 版插件时，按以下 3 步装代理：

```sh
# 1. 安装 uv（本机 Python 工具，若已装可跳过）
curl -LsSf https://astral.sh/uv/install.sh | sh

# 2. 拉取 workbuddy2api 主分支源码
git clone https://github.com/hawklithm/workbuddy2api.git
cd workbuddy2api

# 3. 启动代理（监听 127.0.0.1:8787；先完成下方「登录」后再真正调用模型）
uv run python -u -m codebuddy_proxy --desensitize \
  --session-file ~/.codebuddy-session.json \
  --log-file ~/.codebuddy-proxy.jsonl
```

> 之后任何时候想重启代理，就在 `workbuddy2api` 目录里重跑上面第 3 条命令。
> 若提示 `address already in use`，先停掉旧代理：
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
5. 胶囊会自动从每 5 秒轮询加快到每 2 秒（最多 30 次），一旦检测到
   `.workbuddy/session.json` 的 `auth.expiresAt` 未过期且含 `accessToken`，
   就切回 🟢 绿态，显示账号昵称。

整个过程**不需要离开浏览器、不需要回终端**。

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
| `GET /api/workbuddy/status` | 读取会话文件（默认 `~/.codebuddy-session.json`，或配置的 `sessionFile`）的 `auth.expiresAt` 判断会话是否有效，并 `fetch` 代理 `/health` 判断 `proxyUp`；返回 JSON：`{ sessionFile, authenticated, expiresAt, account, proxyUp, tokenValid, loginScriptAvailable }`；非 GET 返回 405 |
| `POST /api/workbuddy/login` | 若已有有效会话则直接返回 `alreadyLoggedIn`；否则用系统 `python3` `spawn` 包内 `login_workbuddy.py --session-file <sessionFile>`，从子进程 stdout 解析出 `authUrl` 立即返回 `{ authUrl, pending:true }`（设备流在后台继续，前端轮询 status 感知完成）；非 POST 返回 405 |
| `POST /api/workbuddy/diagnose` | **一键诊断**：真实探测健康状态，返回 `{ ok, session, health, chat, loginScriptAvailable, restartCommand }`。与 `/status` 不同，它除了探 `/health`，还会**真实发一次最小模型请求**（`chat.chatWorking`），能戳穿"胶囊显示成功但模型全 500"的假象；`ok:false` 时附带 `restartCommand`（自动区分本地 monorepo 布局与标准安装）；非 POST 返回 405 |

> 会话文件与登录脚本路径的解析顺序：
> 1. 配置里显式指定的 `sessionFile` / `loginScript`；
> 2. 包内 `login_workbuddy.py` + `~/.codebuddy-session.json`；
> 3. 旧仓库布局（向上两级 `dsh-workbuddy/` 的 `.workbuddy/session.json`）自动兼容。

### 前端胶囊（`lib/client.js`）

- 作为经典 `<script>` 被 DSH 注入页面，IIFE 内直接操作 DOM，**零依赖**。
- 启动时在 `document.body` 末尾挂一个 `position:fixed` 的胶囊（右下角）。
- 每 **5 秒** `GET /api/workbuddy/status`；点「登录」后加快到每 **2 秒**轮询、
  最多 30 次，直到 `authenticated:true`。
- 胶囊里有个 **🔍 诊断** 按钮：点它 `POST /api/workbuddy/diagnose`，弹出一个面板
  显示**真实健康状态**（登录、会话文件、代理进程、登录令牌、模型能否出字），
  发现问题时附带**可复制的重启命令**（一键复制到终端执行）。
- 状态映射：
  - `authenticated && proxyUp` → 🟢 绿，显示 `WorkBuddy · <昵称>`
  - 否则 → 🔴 红，显示「登录」按钮；`proxyUp` 为 false 时额外提示 `代理未运行`

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
    # loginScript: ''                   # 登录脚本绝对/相对路径；默认用包内 login_workbuddy.py
    # sessionFile: ~/.codebuddy-session.json  # 会话文件路径；默认同上
```

模型列表默认取插件内置目录；代理可达时改为实时拉取 `/v1/models`（支持
`{"models": [...]}` / `{"data": [...]}` 两种返回），未列出的模型 id 仍可原样
传递。每个模型的推理等级（`reasoningEffort`）默认来自内置目录，代理可达时优先
沿用目录值（代理 `/v1/models` 当前只上报 `High`，不区分模型）。

---

## 排错

| 现象 | 可能原因 / 解决 |
|---|---|
| 右下角没有胶囊 | `dsh web` 没重启加载新 bundle → 重启 `dsh web`；或 `curl /plugins/dsh-llm-workbuddy/client.js` 应返回 200 |
| 胶囊一直 `…`（加载中） | `GET /api/workbuddy/status` 失败 → 确认 `dsh web` 在跑、端口正确 |
| 胶囊红 + `代理未运行` | workbuddy2api 代理没起或挂了 → 按「安装代理」章节启动 |
| 胶囊显示登录成功但模型用不了 | 典型的"代理进程活着但指向旧路径/文件缺失"假象（`/health` 仍显示 ok）。点胶囊 **🔍 诊断**，看 `模型出字` 是否失败；按面板给出的重启命令重启代理 |
| 点「登录」没反应 / 按钮灰 | `loginScriptAvailable:false` → 包内 `login_workbuddy.py` 缺失或系统无 `python3`；检查安装 |
| 新标签页打开后登录完成，胶囊仍是红 | 会话文件（默认 `~/.codebuddy-session.json`）未刷新或 `expiresAt` 已过期 → 刷新页面或重跑登录 |
| 启动 `dsh web` 报 `EPERM ... cordis.yml` | `.dsh` 所在系统卷受保护（`/System/Volumes/Data` 带 `protect`）。解决：`sudo chown -R $(whoami) /Users/jiyunyang/.dsh`，或 `export DSH_HOME=$HOME/dsh-home` 后重新 `dsh plugin --profile web add` 并把插件链接进新 home |
| 模型请求 `TRANSPORT` 错误 | 代理未运行或端口不对（连接被拒绝） |

---

## 限制

- 当前为纯文本适配器：图片输入会以 `UNSUPPORTED_CONTENT` 拒绝（后续可加）。
- 推理等级（reasoning effort）：支持推理的模型（如 DeepSeek-V4、GLM、Kimi、MiniMax、
  Hy3 等）会显示推理等级下拉（Low / Medium / High），默认值取平台默认强度。`reasoning_effort`
  会透传给代理；若某模型平台侧只接受平台默认、忽略该参数，则退化为平台默认强度，不影响出字。
- 代理未运行时，模型请求会以 `TRANSPORT` 错误快速失败（连接被拒绝）；但状态
  小组件本身不依赖代理——代理挂了它仍能显示「代理未运行」并允许触发登录。
- 登录态有效期由 WorkBuddy 云端决定；过期后胶囊变红，重新点「登录」即可，
  代理无需重启。

---

## 文件索引

| 路径 | 作用 |
|---|---|
| `lib/index.js` | Cordis 插件主体：LLM 适配器 `WorkBuddyAdapter` + `/api/workbuddy/*` 路由（status / login / **diagnose**） |
| `lib/client.js` | 零依赖浏览器小部件（状态胶囊 + 登录流程 + **🔍 诊断**），被 `dsh.client` 注入 |
| `login_workbuddy.py` | 设备流登录脚本（随包发布，被后端路由用系统 `python3` spawn） |
| `cordis.patch.yml` | 本包的 Cordis bundle 挂载声明（`id: llm-workbuddy`） |
| `package.json` | 包元数据、`dsh.client` 浏览器入口声明、`llm-workbuddy` peer 依赖 |

> 第三方 workbuddy2api 代理**不在包内**，需单独安装（见「安装代理」章节）。
> 仓库根目录的 `start-workbuddy.sh` / `login-workbuddy.sh` / `.workbuddy/` 是本地
> 开发用的配套文件，不随 npm 包发布。
