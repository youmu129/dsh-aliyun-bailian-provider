// 百炼 Token Plan 用量适配器：console 网关直连，不派生 bl 子进程。
//
// wire 协议复刻自 modelstudio-cli（官方 bailian-cli 源码）：
//   packages/core/src/console/gateway.ts（callConsoleGateway / buildGatewayParams /
//   REGION_GATEWAYS）与 packages/commands/src/commands/usage/token-plan.ts
//   （TOKEN_PLAN_USAGE_API、窗口字段读取）：
//   POST https://{csGateway}/cli/api.json?action={action}&product=sfm_bailian&api={api}
//   body: params=<JSON>&region=<region>；Authorization: Bearer {access_token}
// access_token 由官方 CLI `bl auth login --console` 落盘 ~/.bailian/config.json
// （顶层 access_token / console_region / console_site / console_switch_agent）。
// 登录仍归 bl CLI：插件不经手登录、不存储凭证，仅每次查询现读现用。
//
// 响应为 DataV2 双层包装（与官方 unwrapResponse 同款顺序解包）。实测（2026-09）：
// {"per1MonthPercentage":0.0134…,"per1MonthResetTime":1792512000000}。percentage 为
// [0,1] 已用比例（官方 QuotaSection 注释语义，渲染时 ×100）；窗口字段有 per5Hour*/
// per1Week*/per1Month* 三组——官方 CLI 只回显前两组并丢弃月度窗口（此前
// `bl usage token-plan --output json` 实测返回 {"data":[]} 的原因），直连按
// "有哪些读哪些"宽容解析，可取全三组。
//
// 迁移来源：dsh-plugin-custom-providers 的 src/providers/bailian.ts（接口契约与
// 解析逻辑逐段一致；BailianUsage 类型在本文件本地定义，单平台版不依赖 PlatformId）。

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  AdapterError,
  AdapterUnconfiguredError,
  type QuotaEntry,
  isRecord,
  redact,
  toIsoTime,
  toNumber,
} from './model.ts'

/** 个人 Token Plan 用量的 console 网关 API 名（官方 CLI 同款） */
export const BAILIAN_USAGE_API = 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage'

/** bl CLI 登录态默认落盘路径（`bl auth login --console` 写入） */
export function defaultBailianConfigPath(): string {
  return join(homedir(), '.bailian', 'config.json')
}

/** 百炼 Token Plan 用量（仅窗口配额；接口不提供套餐名） */
export interface BailianUsage {
  quotas: QuotaEntry[]
}

// console 网关寻址表（与官方 REGION_GATEWAYS 一致；未知 region 回落 cn-beijing）
const GATEWAY_PRODUCT = 'sfm_bailian'

interface GatewayInfo {
  csGateway: string
  action: string
}

type ConsoleSite = 'domestic' | 'international'

const REGION_GATEWAYS: Record<string, Record<ConsoleSite, GatewayInfo>> = {
  'cn-beijing': {
    domestic: { csGateway: 'bailian-cs.console.aliyun.com', action: 'BroadScopeAspnGateway' },
    international: { csGateway: 'bailian-cs.console.alibabacloud.com', action: 'BroadScopeAspnGateway' },
  },
  'ap-southeast-1': {
    domestic: { csGateway: 'modelstudio-cs.console.aliyun.com', action: 'IntlBroadScopeAspnGateway' },
    international: { csGateway: 'bailian-singapore-cs.alibabacloud.com', action: 'IntlBroadScopeAspnGateway' },
  },
}

function resolveGateway(region: string, site: ConsoleSite): GatewayInfo {
  return (REGION_GATEWAYS[region] ?? REGION_GATEWAYS['cn-beijing']!)[site]
}

/** 网关 params 载荷（与官方 buildGatewayParams 逐字一致；usage 查询 data 为空对象） */
function buildGatewayParams(api: string, switchAgent?: number): string {
  return JSON.stringify({
    Api: api,
    V: '1.0',
    Data: {
      cornerstoneParam: {
        protocol: 'V2',
        console: 'ONE_CONSOLE',
        productCode: 'p_efm',
        switchUserType: 3,
        consoleSite: 'BAILIAN_ALIYUN',
        ...(switchAgent != null ? { switchAgent } : {}),
      },
    },
  })
}

/** DataV2 双层包装解包（与官方 unwrapResponse 同款顺序） */
function unwrapEnvelope(result: Record<string, unknown>): Record<string, unknown> {
  const data = isRecord(result.data) ? result.data : undefined
  if (!data) return result
  const dataV2 = isRecord(data.DataV2) ? data.DataV2 : undefined
  if (dataV2) {
    const inner = isRecord(dataV2.data) ? dataV2.data : undefined
    const innerData = isRecord(inner?.data) ? inner!.data : undefined
    return innerData ?? inner ?? dataV2
  }
  return isRecord(data.data) ? data.data : data
}

// 窗口字段 → 统一配额语义（per1Month 为直连独有：官方 CLI 不回显该窗口）
const WINDOWS: Array<{ prefix: string; kind: QuotaEntry['kind']; label: string }> = [
  { prefix: 'per5Hour', kind: 'window-5h', label: '5 小时窗口' },
  { prefix: 'per1Week', kind: 'weekly', label: '每周' },
  { prefix: 'per1Month', kind: 'monthly', label: '月度' },
]

/**
 * 解析百炼 console 网关的 usage 响应（原始 envelope，内含解包）。
 * 窗口字段缺失跳过（官方语义：无数据 = 可能无限额度）；全空 = 成功但无配额数据
 * （ok + 空 quotas，UI 显示暂无数据）。
 */
export function parseBailianUsage(json: unknown): BailianUsage {
  if (!isRecord(json)) throw new AdapterError('parse', '百炼网关响应不是 JSON 对象')
  const usage = unwrapEnvelope(json)

  const quotas: QuotaEntry[] = []
  for (const w of WINDOWS) {
    const ratio = toNumber(usage[`${w.prefix}Percentage`])
    const resetAt = toIsoTime(usage[`${w.prefix}ResetTime`])
    if (ratio === undefined && resetAt === undefined) continue
    quotas.push({
      kind: w.kind,
      label: w.label,
      // [0,1] 已用比例 → percentUsed（0–100，0.1% 精度，与官方 formatPercentage 同口径）
      percentUsed:
        ratio !== undefined ? Math.round(Math.min(Math.max(ratio, 0), 1) * 1000) / 10 : undefined,
      resetAt,
    })
  }
  return { quotas }
}

export interface FetchBailianOptions {
  /** bl CLI config.json 路径（默认 ~/.bailian/config.json；测试注入） */
  configPath?: string
  timeoutMs: number
  fetchImpl?: typeof fetch
}

export async function fetchBailianUsage(opts: FetchBailianOptions): Promise<BailianUsage> {
  const cfg = await readCliConfig(opts.configPath ?? defaultBailianConfigPath())
  const token = typeof cfg.access_token === 'string' ? cfg.access_token.trim() : ''
  if (!token) {
    throw new AdapterUnconfiguredError(
      '百炼 console 未登录：请先执行 bl auth login --console（登录态由 bl CLI 持久化）',
    )
  }

  const region =
    typeof cfg.console_region === 'string' && cfg.console_region.trim() !== ''
      ? cfg.console_region.trim()
      : 'cn-beijing'
  const site: ConsoleSite = cfg.console_site === 'international' ? 'international' : 'domestic'
  const switchAgent = toNumber(cfg.console_switch_agent)
  const gw = resolveGateway(region, site)

  const params = buildGatewayParams(BAILIAN_USAGE_API, switchAgent)
  const endpoint = `https://${gw.csGateway}/cli/api.json?action=${gw.action}&product=${GATEWAY_PRODUCT}&api=${encodeURIComponent(BAILIAN_USAGE_API)}`

  const fetchImpl = opts.fetchImpl ?? fetch
  let res: Response
  try {
    res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Accept: '*/*',
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${token}`,
      },
      body: new URLSearchParams({ params, region }).toString(),
      redirect: 'manual', // 不跟随重定向，防 token 泄漏
      signal: AbortSignal.timeout(opts.timeoutMs),
    })
  } catch (err) {
    throw mapFetchError(err)
  }
  if (res.status >= 300 && res.status < 400) {
    throw new AdapterError('network', `百炼网关发生重定向（${res.status}），已按安全策略拒绝跟随`)
  }
  if (!res.ok) {
    const snippet = redact(await safeText(res), [token])
    throw new AdapterError('unknown', `百炼网关请求失败（HTTP ${res.status}）：${snippet}`)
  }

  let json: unknown
  try {
    json = await res.json()
  } catch {
    throw new AdapterError('parse', '百炼网关响应不是合法 JSON')
  }
  if (!isRecord(json)) throw new AdapterError('parse', '百炼网关响应不是 JSON 对象')

  // 业务错误面与官方 callConsoleGateway 一致：data.success === false && data.errorCode
  const data = isRecord(json.data) ? json.data : undefined
  if (data?.success === false && data.errorCode != null && data.errorCode !== '') {
    const errorCode =
      typeof data.errorCode === 'string' ? data.errorCode : JSON.stringify(data.errorCode)
    if (errorCode.includes('NotLogined')) {
      // 官方 CLI 仅在存有 AK/SK 时才能静默刷新（GenerateCLIAccessToken），直连不复刻。
      // 「登录已过期」≠「未配置」：按 auth 错误上抛（红点 + 面板保留重登指引），
      // 不折叠成无差异的 unconfigured 淡点（2026-10 实测：过期被误读为"空数据"无从排查）
      throw new AdapterError('auth', '百炼 console 登录已过期：请重新执行 bl auth login --console')
    }
    throw new AdapterError('auth', `百炼 console 网关错误：${errorCode.slice(0, 200)}`)
  }

  return parseBailianUsage(json)
}

/** 读取 bl CLI 落盘的登录态（不校验具体字段，调用方按需取用） */
async function readCliConfig(path: string): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      throw new AdapterUnconfiguredError(
        '未找到 bl CLI 登录态（~/.bailian/config.json）：请安装 bailian-cli 并执行 bl auth login --console',
      )
    }
    throw new AdapterError('unknown', `读取 bl CLI 登录态失败：${err instanceof Error ? err.message : String(err)}`)
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isRecord(parsed)) throw new Error('not an object')
    return parsed
  } catch {
    throw new AdapterError('parse', 'bl CLI config.json 不是合法 JSON 对象')
  }
}

function mapFetchError(err: unknown): AdapterError {
  const name = err instanceof Error ? err.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new AdapterError('network', '百炼网关请求超时')
  }
  return new AdapterError('network', `百炼网关网络请求失败：${err instanceof Error ? err.message : String(err)}`)
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200)
  } catch {
    return ''
  }
}
