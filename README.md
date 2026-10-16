# dsh-aliyun-bailian-provider

DSH（DeepSeek Harness）插件（双半面 bundle）：把 **bailian-token-plan**（阿里云百炼 Token Plan，OpenAI 兼容端点）播种注册为 DSH 自定义模型供应商，并在 Web GUI 提供套餐用量 pill（5 小时窗口 / 每周 / 月度配额）。用量查询直连百炼 console 网关 API（wire 协议出自 modelstudio-cli），不派生 `bl` 子进程。

## 状态

仓库基线已建立，插件实现进行中（详见 `workbenches/dsh-dev` 工作台 `workspaces/bailian-provider-plugin/` 工作区）。

## 凭证纪律

百炼 API Key 只存放于 DSH 凭证机制或 `apiKeyEnv` 引用的环境变量；console access_token 只现读 bl CLI 落盘的 `~/.bailian/config.json`。凭证不入库、不写入日志与文档。
