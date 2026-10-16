# dsh-aliyun-bailian-provider

DSH（DeepSeek Harness）插件（双半面 bundle），一个包交付两件事：

1. **provider 播种**：启动时把本插件的 provider 路由 **`bailian-token-plan`**（阿里云百炼 Token Plan，OpenAI 兼容端点）**播种（seed）到 `llm-pi-ai` 的用户设置层**——与 Web Models 页「自定义模型 API」卡片完全同一条写入路径（按 provider 键合并，不整段覆盖），因此与其他拥有 `llm-pi-ai` patch 行的插件（如 `dsh-plugin-custom-providers`）**互不覆盖、bundle 层序不再敏感**。路由定义迁自 `dsh-plugin-custom-providers` 的 `bailian-token-plan` 段，逐字段一致（含 compat 段）。
2. **用量展示**：Web GUI 底部状态 pill（`conversation.composer.dock`，与官方「会话统计 / Token 用量」、plan-usage 套餐 pill、zhipu-usage / kimi-usage pill 同一座位链，order 17）——**仅当前会话选用 `bailian-token-plan` provider 时显示**；pill 显示配额百分比摘要，点击开面板展示 5 小时窗口 / 每周 / 月度配额明细与重置时间。数据经 host 半面 `/api/bailian-usage/*` 同源路由，**直连百炼 console 网关 API**（wire 协议复刻自 modelstudio-cli 的 `console/gateway.ts` 与 `usage/token-plan.ts`），**不派生 `bl` 子进程**。

## 用法

### 安装

```powershell
dsh plugin --profile web add ./dsh-aliyun-bailian-provider
```

`dsh plugin` 会把包 link 进 profile 并追加到 `dsh.profile.bundles`。host 半面模块代码变更需重启 `dsh web` 生效（模块 import 发生在启动时）；patch 结构变更走 `patchReload: live` 热重组。可用 `dsh --profile web --dump-config` 检查合成结果。

> **依赖必须在被 link 的目录内就位**：profile 记录的是 `link:<目录>` 规格，pnpm 只做目录软链，**不会安装该目录自身的依赖**。若本体目录（profile link 指向的那份 checkout，如 `repos/dsh-aliyun-bailian-provider`）没有 `node_modules`，启动时报 `dsh-aliyun-bailian-provider (dsh-aliyun-bailian-provider): failed to import`，直接导入产物可复现为 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'`。安装后在**该目录**执行一次 `pnpm install`（或 `npm install`）即可；`node_modules` 已被 `.gitignore` 忽略，不影响仓库干净度。开发用的 worktree 里的 `node_modules` 帮不到 profile —— 它按 link 目标解析依赖。

### 凭证配置

本插件涉及两把凭证，都不入库、不写入日志：

- **推理路由 key**：模型请求经 `apiKeyEnv` 引用 **`BAILIAN_TOKEN_PLAN_API_KEY`**（与 `dsh-plugin-custom-providers` 注册的路由同一把钥匙，零新增配置），在设置页录入或设置该环境变量；
- **用量查询 token**：百炼 console access_token，由 bl CLI 登录持久化——执行 `bl auth login --console`（安装：`npm i -g bailian-cli`），插件每次查询现读 `~/.bailian/config.json`，不经手登录、不存储凭证；未检测到登录态时 pill 显示「未登录」态并给出指引，登录过期时显示「查询失败」并保留重登指引。

### 使用

安装并重启 Web GUI 后：

- 模型选择器中可出现百炼的模型（`qwen3.8-max` / `qwen3.8-flash` / `deepseek-v4.1-flash` / `deepseek-v4-pro-0813` / `glm-5.3` / `glm-5.2`，providers 生效）；
- 会话选用百炼模型时，输入卡片下方出现百炼用量 pill：摘要段显示 5 小时窗口 / 每周配额百分比（达到 90% 阈值标红）；点击弹出面板查看各窗口的已用百分比、进度条与重置时间。

### 设置项

行 config（`cordis.patch.yml`）只传 `usage.pollIntervalMs` / `usage.requestTimeoutMs`；schema 默认值：`cliConfigPath: ''`（空串 = 默认 `~/.bailian/config.json`，bl CLI 以非默认配置目录登录时可覆盖）、`pollIntervalMs: 0`（默认关闭自动轮询，手动/面板刷新为主）、`requestTimeoutMs: 10000`。

## 工作机制

- **播种**：本插件不拥有 `llm-pi-ai` 的 patch 行（patch 对目标行是整行替换 `config`，多个 bundle 的 providers 字典无法在 patch 层合并）。宿主半面（`src/index.ts`）在 loader settle 后经 settings 服务 `describe()` 读生效配置，`bailian-token-plan` 路由不存在时 `settings.update('llm-pi-ai', { providers: { 'bailian-token-plan': … } })` 合并进用户层（幂等，二次启动不重写）；路由已存在（无论来自哪个层，含 custom-providers 的 bundle 层注册）即跳过，用户在 Models 页的编辑永不被覆盖。
- **用量数据流**：host 半面现读 bl CLI 落盘的 console access_token 与 region/site/switchAgent，直连 `POST https://{csGateway}/cli/api.json?action={action}&product=sfm_bailian&api=zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage`（`params` 载荷与官方 `buildGatewayParams` 逐字一致；响应按 DataV2 双层包装解包），把 `per5Hour*` / `per1Week*` / `per1Month*` 窗口的 [0,1] 已用比例归一化为统一配额模型（×100 得 0–100 百分比）缓存在内存；经 `/api/bailian-usage/*` 路由暴露；client 半面渲染 pill 与弹出面板。接口契约与解析逻辑迁自 `dsh-plugin-custom-providers` 的 `src/providers/bailian.ts`（含 2026-09 线上实测的 per1Month 窗口形态——官方 CLI 只回显前两组窗口，直连按「有哪些读哪些」取全三组）。
- **pill 显隐**：座位 inject 面绑定会话模型目录（官方 `ui-model-selection`），非百炼会话渲染 `null` 但组件保持挂载、取数保温，切到百炼即刻有数据（机制同 raven-usage / plan-usage）。

### 与 dsh-plugin-custom-providers 的关系

- 同一路由 id（`bailian-token-plan`）、同一把推理 key、同一套定义：两者可共存，播种对「路由已存在」自动让位；若先装本插件（用户层路由已播种），custom-providers 的 bundle 层注册被用户层遮蔽但语义一致；
- plan-usage（custom-providers 的三家套餐面板）仍可用；本插件的 pill 是百炼单平台的独立实现（同一座位 order 17，排 kimi-usage 右侧）。

## 构建与测试

```powershell
pnpm install
pnpm run build    # tsdown → lib/index.js + lib/client.cjs → 包装为 lib/client.js
pnpm test         # node --import tsx test/run-all.ts
```

沙箱等不允许派生 esbuild 服务进程的环境里，可改用 Node 原生 type-strip 跑法：`node test/run-all.ts`（Node ≥ 23.6）。

开发期：`pnpm run dev`（tsdown watch）+ `pnpm run dev:client`（跟随重建包装 client.js）。

## 凭证纪律

百炼 API Key 只存放于 DSH 凭证机制或 `apiKeyEnv` 引用的环境变量；console access_token 只现读 bl CLI 落盘的 `~/.bailian/config.json`。凭证不入库、不写入日志与文档。
