# Changelog

本文件记录每个版本的改动。版本号遵循语义化版本（MAJOR.MINOR.PATCH），
每次发版请同步 `package.json` 的 `version` 并打一个 `git tag`（如 `v0.1.13`），
在 GitHub 创建 Release 时本文件即为更新说明来源。

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
[0.1.13]: https://github.com/zdk119746/dsh-llm-workbuddy/compare/v0.1.12...v0.1.13
[0.1.12]: https://github.com/zdk119746/dsh-llm-workbuddy/compare/v0.1.11...v0.1.12
[0.1.11]: https://github.com/zdk119746/dsh-llm-workbuddy/releases/tag/v0.1.11
