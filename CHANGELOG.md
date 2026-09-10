# Changelog

本文件记录每个版本的改动。版本号遵循语义化版本（MAJOR.MINOR.PATCH），
每次发版请同步 `package.json` 的 `version` 并打一个 `git tag`（如 `v0.1.13`），
在 GitHub 创建 Release 时本文件即为更新说明来源。

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
[0.1.15]: https://github.com/zdk119746/dsh-llm-workbuddy/compare/v0.1.14...v0.1.15
[0.1.14]: https://github.com/zdk119746/dsh-llm-workbuddy/compare/v0.1.13...v0.1.14
[0.1.13]: https://github.com/zdk119746/dsh-llm-workbuddy/compare/v0.1.12...v0.1.13
[0.1.12]: https://github.com/zdk119746/dsh-llm-workbuddy/compare/v0.1.11...v0.1.12
[0.1.11]: https://github.com/zdk119746/dsh-llm-workbuddy/releases/tag/v0.1.11
