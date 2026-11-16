# dsh-aliyun-bailian-provider

DSH（DeepSeek Harness）插件：为 Web GUI 接入阿里云百炼 Token Plan（OpenAI 兼容端点），并附带用量展示。

## 功能

- **provider 播种（种子权威）**：每次启动把生效配置中的 `bailian-token-plan` 路由与种子比对，缺失或不一致即覆写进 `llm-pi-ai` 用户设置层——与 Models 页「自定义模型 API」卡片同一条写入路径，按 provider 键合并、只覆写本路由；模型上架 / 规格跟进只需更新种子，重启即自动同步。注意：对该路由的手工编辑（Models 页或用户层文件）会在下次启动被种子还原，要自定义请卸载本插件或禁用其挂载行。模型选择器随即出现 `qwen4-max` / `qwen4-max-preview` / `qwen3.8-max` / `qwen3.8-flash` / `deepseek-v4.1-flash` / `deepseek-v4-pro-0813` / `glm-5.3` / `glm-5.2`。
- **用量 pill**：会话选用百炼模型时，输入卡片下方显示用量 pill——摘要为 5 小时窗口 / 每周配额百分比（≥90% 标红），点击弹出面板查看 5 小时 / 每周 / 月度配额的已用百分比、进度条与重置时间。数据直连百炼 console 网关 API（协议复刻自官方 CLI），不派生 `bl` 子进程。

## 用法

```powershell
dsh plugin --profile web add https://github.com/youmu129/dsh-aliyun-bailian-provider
```

1. 配置凭证：
   - 推理 key：在设置页录入，或设置环境变量 `BAILIAN_TOKEN_PLAN_API_KEY`（与 `dsh-plugin-custom-providers` 的百炼路由同一把钥匙）；
   - 用量查询：执行 `bl auth login --console`（安装：`npm i -g bailian-cli`），插件现读其落盘的 `~/.bailian/config.json`，不经手存储凭证；
2. 重启 `dsh web`，选用百炼模型即见 pill；未登录 bl 时 pill 显示「未登录」并给出指引。

可选设置（覆盖 schema 默认值）：`cliConfigPath`（空 = `~/.bailian/config.json`）、`usage.pollIntervalMs` / `usage.requestTimeoutMs`（默认 0，关闭自动轮询，以手动刷新为主）。

## 开发

```powershell
pnpm install
pnpm run build
pnpm test
```

> API Key 只存放于 DSH 凭证机制或 `apiKeyEnv` 引用的环境变量；console access_token 只现读 bl CLI 落盘的 `~/.bailian/config.json`。凭证不入库、不写入日志与文档。
