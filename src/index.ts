// host 半面入口：settings 播种器 + 百炼用量 API。
//
// 播种机制（写入路径迁自 dsh-plugin-raven v0.5.0+，策略为种子权威）：
// 本插件不拥有 `llm-pi-ai` 行（patch 层对目标行是整行替换 `config`，多个
// bundle 的 providers 无法合并），改在每次启动、全部条目挂载 settle 后读
// 生效配置，比对 bailian-token-plan 路由与种子：缺失或不一致即经 settings
// 服务把种子覆写进用户层（profile cordis.patch.yml）——与 Web Models 页
// 「自定义模型 API」完全同一条写入路径（update → mergeLayers，按 provider
// 键合并，只覆写本路由、不整段覆盖）。种子因此是该路由的唯一事实源：模型
// 上架 / 规格跟进只需改种子，重启即自动同步生效配置，无需手工编辑用户层；
// 代价是用户在 Models 页对该路由的编辑、以及 dsh-plugin-custom-providers
// 在 bundle 层的同名注册，都会在下次启动被种子覆平——要自定义或移除请
// 卸载本插件，或在 patch 中禁用本挂载行（disabled: true）。
//
// provider 定义迁自 dsh-plugin-custom-providers 的 cordis.patch.yml
// bailian-token-plan 段，逐字段一致（含 compat 段；`off:` 空值是
// llm-pi-ai 认可的「等级存在、线上不发送」写法）。
//
// 已知代价（与用户手动使用一次 Models 页相同）：播种会把当时生效的
// providers 全量快照进用户层；此后其他 bundle 层对该字典的更新被这份
// 快照遮蔽，直至用户手动编辑用户层文件。
//
// 凭证不落配置：路由经 apiKeyEnv 引用 BAILIAN_TOKEN_PLAN_API_KEY，由 harness
// 凭证机制按请求解析。
//
// 用量 API：直连百炼 console 网关（wire 协议出自 modelstudio-cli
// console/gateway.ts + usage/token-plan.ts，不派生 bl 子进程）；console
// access_token 现读 bl CLI 落盘的 ~/.bailian/config.json（可用 settings 的
// usage.cliConfigPath 覆盖路径），未登录/文件缺失 → unconfigured 态。用量经
// /api/bailian-usage/* 同源路由供给 client 半面的底部 pill。
// connection 为可选取用：组合缺 connection 时跳过路由注册（播种不受影响）。

import z from '@deepseek-ai/schemastery'
import { isDeepStrictEqual } from 'node:util'
import { fetchBailianUsage } from './bailian.ts'
import { UsageStore } from './store.ts'

/** The settings namespace (= profile entry id) of the pi-ai adapter row. */
const NS = 'llm-pi-ai'

/** The provider route this plugin seeds (exported for tests). */
export const ROUTE = 'bailian-token-plan'

/** One seeded model; fields follow PiAiProviderProfile's model entry. */
interface SeedModel {
  id: string
  name: string
  contextWindow: number
  input: string[]
  reasoningEfforts: Record<string, string | null>
}

/** The seeded provider profile; fields follow @deepseek-ai/dsh-llm-pi-ai's PiAiProviderProfile. */
interface SeedProfile {
  displayName: string
  apiKeyEnv: string
  api: string
  baseURL: string
  reasoning: string
  compat: {
    supportsDeveloperRole: boolean
    maxTokensField: string
  }
  models: SeedModel[]
}

/** The bailian-token-plan route (migrated from dsh-plugin-custom-providers, compat section included; models kept in sync with the Bailian Token Plan lineup). */
const PROFILE: SeedProfile = {
  displayName: 'Bailian Token Plan',
  apiKeyEnv: 'BAILIAN_TOKEN_PLAN_API_KEY',
  api: 'openai-completions',
  baseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  reasoning: 'high',
  compat: {
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
  },
  models: [
    // Qwen4-Max 正式版（2026-11 上架，规格据百炼官方文档 qwen4-max 页：
    // 1M 上下文、文本/图像/视频输入、思考等级 low/high/xhigh 默认 high，
    // 沿用 Qwen 系列映射 off→null / low→low / high→medium / max→xhigh）
    {
      id: 'qwen4-max',
      name: 'Qwen-4-Max',
      contextWindow: 1000000,
      input: ['text', 'image'],
      reasoningEfforts: { off: null, low: 'low', high: 'medium', max: 'xhigh' },
    },
    {
      id: 'qwen3.8-flash',
      name: 'Qwen-3.8-Flash',
      contextWindow: 1000000,
      input: ['text', 'image'],
      reasoningEfforts: { off: null, low: 'low', high: 'medium', max: 'xhigh' },
    },
    {
      id: 'deepseek-v4.1-flash',
      name: 'DeepSeek-V4.1-Flash',
      contextWindow: 1000000,
      input: ['text', 'image'],
      reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' },
    },
    {
      id: 'deepseek-v4-pro-0813',
      name: 'DeepSeek-V4-Pro',
      contextWindow: 1000000,
      input: ['text'],
      reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' },
    },
    {
      id: 'glm-5.3',
      name: 'GLM-5.3',
      contextWindow: 1000000,
      input: ['text'],
      reasoningEfforts: { high: 'high', max: 'max' },
    },
  ],
}

/**
 * 播种判定：生效 providers 里本路由缺失、或与种子不深度一致（无论来自哪个
 * 层：滞后快照缺新模型、用户在 Models 页的编辑、其他 bundle 的同名注册）
 * 即需要覆写；写入按 provider 键合并，只影响 bailian-token-plan 这一个路由。
 * @param providers 生效配置的 providers 字典（describe().value.providers）。
 * @returns 是否需要播种/覆写。
 */
export function shouldSeed(providers: unknown): boolean {
  const route =
    typeof providers === 'object' && providers !== null
      ? (providers as Record<string, unknown>)[ROUTE]
      : undefined
  return !isDeepStrictEqual(route, PROFILE)
}

/**
 * 种子 profile 的深拷贝（导出供测试断言形状；调用方拿到独立副本）。
 * @returns bailian-token-plan 的 PiAiProviderProfile。
 */
export function seedProfile(): SeedProfile {
  return structuredClone(PROFILE)
}

// ---------------------------------------------------------------------------
// Config（usage 子树；行 config 经 cordis.patch.yml 传入）
// ---------------------------------------------------------------------------

const UsageSettings = z.object({
  // bl CLI 登录态文件路径（空串 = 默认 ~/.bailian/config.json）；
  // 用量查询不派生 bl 子进程，仅现读该文件里的 console access_token
  cliConfigPath: z.string().default(''),
  pollIntervalMs: z.number().default(0),
  requestTimeoutMs: z.number().default(10000),
})

export const Config = z.object({
  usage: UsageSettings.default({}),
})

export type PluginConfig = z.infer<typeof Config>

export const name = 'dsh-aliyun-bailian-provider'

export function apply(ctx: any, config: PluginConfig): void {
  // 与播种同一条 settle 等待：apply 期 connection 服务尚未 ACTIVE，
  // ctx.get（strict）只返回 ACTIVE 实现，立即取会拿到 undefined 而误判缺组合
  // （dsh-plugin-raven v0.6.0 首版即此缺陷：路由未注册，pill 取数 404）。
  void ctx.loader.await().then(() => setupUsageApi(ctx, config)).catch(reportUsageApi)

  // 等 loader settle 再读生效配置：apply 时 llm-pi-ai 可能尚未 ACTIVE，
  // describe() 会过滤非 ACTIVE 条目导致误判「组合里没有该适配器」。
  void ctx.loader.await().then(seed).catch(report)

  async function seed(): Promise<void> {
    // settings 为可选依赖（组合里可能没有 dsh-settings），缺失时告警跳过
    const settings = ctx.get('settings')
    if (settings === undefined) {
      ctx.logger.warn('dsh-aliyun-bailian-provider: settings 服务不可用，跳过 provider 播种（需要 dsh-base 组合）')
      return
    }
    const descriptor = settings.describe().find((row: { ns: string }) => row.ns === NS)
    if (descriptor === undefined) {
      ctx.logger.warn(`dsh-aliyun-bailian-provider: 组合中没有活跃的 ${NS} 条目，跳过 provider 播种`)
      return
    }
    if (!shouldSeed((descriptor.value ?? {}).providers)) return
    // 无 expectedRevision：启动期没有交互写入方，last-write-wins 即正确语义
    await settings.update(NS, { providers: { [ROUTE]: seedProfile() } })
    ctx.logger.info(`dsh-aliyun-bailian-provider: ${ROUTE} 缺失或与种子不一致，已覆写为种子到用户层（profile cordis.patch.yml）`)
  }

  function report(error: unknown): void {
    // 播种失败不阻断启动：路由缺失的后果（UNKNOWN_MODEL）比整进程退出轻
    ctx.logger.warn('dsh-aliyun-bailian-provider: provider 播种失败')
    ctx.logger.warn(error)
  }

  function reportUsageApi(error: unknown): void {
    // 同上：用量 API 失败不阻断启动，pill 侧会呈现查询失败态
    ctx.logger.warn('dsh-aliyun-bailian-provider: 用量 API 初始化失败')
    ctx.logger.warn(error)
  }
}

// ---------------------------------------------------------------------------
// 用量 API：/api/bailian-usage/usage | /api/bailian-usage/refresh
// ---------------------------------------------------------------------------

function setupUsageApi(ctx: any, config: PluginConfig): void {
  // 本函数在 loader settle 后调用：此时组合里要挂载的条目均已 ACTIVE，
  // ctx.get('connection') 能真实反映组合是否含 Web connection 服务。
  const connection = ctx.get('connection')
  if (connection === undefined) {
    ctx.logger.warn('dsh-aliyun-bailian-provider: connection 服务不可用，跳过用量 API（需要 Web 组合）')
    return
  }

  try {
    registerUsageRoutes(ctx, config, connection)
  } catch (error) {
    // 路由注册失败（如 live reload 重挂载冲突）只告警，不影响播种与其他功能
    ctx.logger.warn('dsh-aliyun-bailian-provider: 用量路由注册失败')
    ctx.logger.warn(error)
  }
}

function registerUsageRoutes(ctx: any, config: PluginConfig, connection: any): void {
  // 每次刷新现读 bl CLI 登录态文件（重新登录即时生效，无需重启）；
  // 文件缺失/未登录 → unconfigured 快照
  const store = new UsageStore(async () =>
    fetchBailianUsage({
      configPath: config.usage.cliConfigPath.trim() === '' ? undefined : config.usage.cliConfigPath,
      timeoutMs: config.usage.requestTimeoutMs,
    }),
  )

  // --- 轮询（默认关闭，手动/面板刷新为主） ---
  let disposePolling: (() => void) | undefined
  const armPolling = () => {
    disposePolling?.()
    disposePolling = undefined
    if (config.usage.pollIntervalMs > 0) {
      disposePolling = ctx.interval(() => void store.refresh(), config.usage.pollIntervalMs)
    }
  }
  armPolling()
  ctx.effect(() => () => disposePolling?.(), 'dsh-aliyun-bailian-provider: usage polling dispose')

  // --- /api 路由（认证由 Connection 统一负责） ---
  connection.fetch.register({
    path: '/api/bailian-usage/usage',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      await store.ensureFresh()
      return Response.json({ snapshot: store.snapshot() })
    },
  })

  connection.fetch.register({
    path: '/api/bailian-usage/refresh',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => {
      await store.refresh()
      return Response.json({ snapshot: store.snapshot() })
    },
  })
}
