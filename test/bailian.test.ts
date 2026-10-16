// 百炼用量适配器与 store 行为校验：
// 1. parseBailianUsage：DataV2 解包与窗口字段解析（fixtures 迁自
//    dsh-plugin-custom-providers 的 bailian-parse.test.ts，含 2026-09 线上
//    实测的 per1Month 形态）；
// 2. fetchBailianUsage：console 网关直连（URL/头/体与官方协议一致）、
//    登录态缺失/过期归类、网络/HTTP 失败归类、响应片段脱敏
//    （fetchImpl stub 不触网，bl 登录态用临时 config.json 注入）；
// 3. UsageStore：成功快照、失败保留 stale、未配置态、ensureFresh 幂等。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { AdapterError, AdapterUnconfiguredError } from '../src/model.ts'
import { fetchBailianUsage, parseBailianUsage } from '../src/bailian.ts'
import { UsageStore } from '../src/store.ts'

// 临时 bl 登录态文件放仓库 tmp/（.gitignore 已忽略），不用系统临时目录
const root = fileURLToPath(new URL('..', import.meta.url))
const TMP_ROOT = join(root, 'tmp')

// DataV2 双层包装工厂（与官方网关响应同构）
function wrapEnvelope(inner: unknown): Record<string, unknown> {
  return {
    code: 'OK',
    httpStatusCode: 200,
    requestId: 'req-test',
    successResponse: true,
    data: { success: true, DataV2: { data: { data: inner } } },
  }
}

// 2026-09 线上实测形态：仅 per1Month 窗口（官方 CLI 丢弃的字段组）
const OK_MONTHLY = wrapEnvelope({ per1MonthPercentage: 0.013459777911111113, per1MonthResetTime: 1792512000000 })

// ---------------------------------------------------------------------------
// parseBailianUsage
// ---------------------------------------------------------------------------

test('parseBailianUsage maps per1Month-only live form (2026-09) to monthly, [0,1] ratio → 0–100', () => {
  const r = parseBailianUsage(OK_MONTHLY)
  assert.equal(r.quotas.length, 1)
  assert.equal(r.quotas[0].kind, 'monthly')
  assert.equal(r.quotas[0].label, '月度')
  assert.equal(r.quotas[0].percentUsed, 1.3) // Math.round(0.013459…×1000)/10
  assert.equal(r.quotas[0].resetAt, new Date(1792512000000).toISOString())
})

test('parseBailianUsage maps per5Hour + per1Week (official CLI form) to window-5h + weekly', () => {
  const r = parseBailianUsage(
    wrapEnvelope({
      per5HourPercentage: 0.5,
      per5HourResetTime: 1_786_000_000_000,
      per1WeekPercentage: 0.25,
      per1WeekResetTime: 1_786_100_000_000,
    }),
  )
  assert.equal(r.quotas.length, 2)
  assert.equal(r.quotas[0].kind, 'window-5h')
  assert.equal(r.quotas[0].percentUsed, 50)
  assert.equal(r.quotas[1].kind, 'weekly')
  assert.equal(r.quotas[1].percentUsed, 25)
})

test('parseBailianUsage keeps reset-only window (zero usage) without percentUsed', () => {
  const r = parseBailianUsage(wrapEnvelope({ per5HourResetTime: 1_786_000_000_000 }))
  assert.equal(r.quotas.length, 1)
  assert.equal(r.quotas[0].kind, 'window-5h')
  assert.equal(r.quotas[0].percentUsed, undefined)
  assert.ok(r.quotas[0].resetAt)
})

test('parseBailianUsage parses the full three-window set', () => {
  const r = parseBailianUsage(
    wrapEnvelope({
      per5HourPercentage: 0.1,
      per5HourResetTime: 1_786_000_000_000,
      per1WeekPercentage: 0.2,
      per1WeekResetTime: 1_786_100_000_000,
      per1MonthPercentage: 0.3,
      per1MonthResetTime: 1_786_200_000_000,
    }),
  )
  assert.deepEqual(r.quotas.map((q) => q.kind), ['window-5h', 'weekly', 'monthly'])
  assert.deepEqual(r.quotas.map((q) => q.percentUsed), [10, 20, 30])
})

test('parseBailianUsage accepts empty data (possibly unlimited) as ok with no quotas; rejects non-object', () => {
  assert.deepEqual(parseBailianUsage(wrapEnvelope({})).quotas, [])
  assert.throws(() => parseBailianUsage('nope'), AdapterError)
})

// ---------------------------------------------------------------------------
// fetchBailianUsage（fetchImpl stub 不触网；登录态用临时 config.json 注入）
// ---------------------------------------------------------------------------

const TOKEN = 'probe-token-abcdef123456'
let dir: string | undefined

/** 每用例写一份临时 bl CLI config.json（替代 ~/.bailian/config.json 注入） */
async function writeConfig(cfg: Record<string, unknown>): Promise<string> {
  await mkdir(TMP_ROOT, { recursive: true })
  dir = await mkdtemp(join(TMP_ROOT, 'bailian-usage-test-'))
  const configPath = join(dir, 'config.json')
  await writeFile(configPath, JSON.stringify(cfg), 'utf8')
  return configPath
}

async function cleanup(): Promise<void> {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
}

test('fetchBailianUsage posts the official gateway wire format and parses windows', async () => {
  const path = await writeConfig({
    api_key: 'sk-xxx',
    access_token: TOKEN,
    console_region: 'cn-beijing',
    console_site: 'domestic',
    console_switch_agent: 10766636,
  })
  let capturedUrl = ''
  let capturedInit: RequestInit | undefined
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    capturedUrl = String(url)
    capturedInit = init
    return new Response(JSON.stringify(wrapEnvelope({ per1MonthPercentage: 0.5 })), {
      status: 200,
    })
  }) as typeof fetch

  const r = await fetchBailianUsage({ configPath: path, timeoutMs: 5000, fetchImpl })
  await cleanup()

  // URL：api 参数需 urlencode（路径含 /）
  const api = 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage'
  assert.equal(
    capturedUrl,
    `https://bailian-cs.console.aliyun.com/cli/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api=${encodeURIComponent(api)}`,
  )
  // 头：Bearer access_token（不落日志，此处仅断言前缀形态）
  const headers = capturedInit?.headers as Record<string, string>
  assert.equal(headers.Authorization, `Bearer ${TOKEN}`)
  assert.equal(headers['Content-Type'], 'application/x-www-form-urlencoded')
  // 体：params JSON 含官方固定 cornerstoneParam + switchAgent；region 直传
  const body = String(capturedInit?.body)
  assert.match(body, /region=cn-beijing/)
  const params = JSON.parse(new URLSearchParams(body).get('params')!)
  assert.equal(params.Api, api)
  assert.equal(params.Data.cornerstoneParam.productCode, 'p_efm')
  assert.equal(params.Data.cornerstoneParam.switchAgent, 10766636)
  // 结果
  assert.equal(r.quotas.length, 1)
  assert.equal(r.quotas[0].percentUsed, 50)
})

test('fetchBailianUsage resolves gateway by region and site (international ap-southeast-1)', async () => {
  const path = await writeConfig({
    access_token: TOKEN,
    console_region: 'ap-southeast-1',
    console_site: 'international',
  })
  let capturedUrl = ''
  const fetchImpl = (async (url: string | URL) => {
    capturedUrl = String(url)
    return new Response(JSON.stringify(wrapEnvelope({})), { status: 200 })
  }) as typeof fetch
  await fetchBailianUsage({ configPath: path, timeoutMs: 5000, fetchImpl })
  await cleanup()
  assert.ok(capturedUrl.startsWith('https://bailian-singapore-cs.alibabacloud.com/cli/api.json'))
  assert.ok(capturedUrl.includes('action=IntlBroadScopeAspnGateway'))
})

test('fetchBailianUsage maps missing config file (ENOENT) to unconfigured', async () => {
  await assert.rejects(
    () => fetchBailianUsage({ configPath: join(TMP_ROOT, 'bailian-nope-xyz', 'config.json'), timeoutMs: 5000 }),
    AdapterUnconfiguredError,
  )
})

test('fetchBailianUsage maps config without access_token to unconfigured', async () => {
  const path = await writeConfig({ api_key: 'sk-xxx' })
  await assert.rejects(
    () => fetchBailianUsage({ configPath: path, timeoutMs: 5000 }),
    AdapterUnconfiguredError,
  )
  await cleanup()
})

test('fetchBailianUsage maps NotLogined errorCode to auth (expired ≠ unconfigured)', async () => {
  const path = await writeConfig({ access_token: TOKEN })
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ code: 'OK', data: { success: false, errorCode: 'BailianGateway.Workspace.NotLogined' } }),
      { status: 200 },
    )) as typeof fetch
  try {
    await fetchBailianUsage({ configPath: path, timeoutMs: 5000, fetchImpl })
    assert.fail('应抛 AdapterError')
  } catch (e) {
    assert.ok(e instanceof AdapterError)
    assert.equal(e.kind, 'auth')
    assert.ok(!(e instanceof AdapterUnconfiguredError), '过期不得折叠为 unconfigured（否则 UI 无差异淡点）')
    assert.ok(e.message.includes('bl auth login --console'), '错误信息保留重登指引')
  }
  await cleanup()
})

test('fetchBailianUsage maps other gateway errorCode to auth error', async () => {
  const path = await writeConfig({ access_token: TOKEN })
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ code: 'OK', data: { success: false, errorCode: 'SomeGateway.Denied' } }),
      { status: 200 },
    )) as typeof fetch
  await assert.rejects(
    () => fetchBailianUsage({ configPath: path, timeoutMs: 5000, fetchImpl }),
    (e: unknown) => e instanceof AdapterError && e.kind === 'auth',
  )
  await cleanup()
})

test('fetchBailianUsage maps network failure to network error; HTTP 500 to unknown with redaction', async () => {
  const path = await writeConfig({ access_token: TOKEN })
  const netFail = (async () => {
    throw new Error('connect ECONNREFUSED')
  }) as typeof fetch
  await assert.rejects(
    () => fetchBailianUsage({ configPath: path, timeoutMs: 5000, fetchImpl: netFail }),
    (e: unknown) => e instanceof AdapterError && e.kind === 'network',
  )

  const httpFail = (async () =>
    new Response(`upstream exploded with ${TOKEN} inside`, { status: 500 })) as typeof fetch
  try {
    await fetchBailianUsage({ configPath: path, timeoutMs: 5000, fetchImpl: httpFail })
    assert.fail('应抛 AdapterError')
  } catch (e) {
    assert.ok(e instanceof AdapterError)
    assert.equal(e.kind, 'unknown')
    assert.ok(!e.message.includes(TOKEN), '错误信息不得包含 token')
  }
  await cleanup()
})

test('fetchBailianUsage maps timeout to network error', async () => {
  const path = await writeConfig({ access_token: TOKEN })
  const fetchImpl = (async () => {
    throw Object.assign(new Error('aborted'), { name: 'TimeoutError' })
  }) as typeof fetch
  await assert.rejects(
    () => fetchBailianUsage({ configPath: path, timeoutMs: 5000, fetchImpl }),
    (e: unknown) => e instanceof AdapterError && e.kind === 'network',
  )
  await cleanup()
})

test('fetchBailianUsage refuses to follow redirects (token leak guard)', async () => {
  const path = await writeConfig({ access_token: TOKEN })
  const fetchImpl = (async () => new Response(null, { status: 302 })) as typeof fetch
  await assert.rejects(
    () => fetchBailianUsage({ configPath: path, timeoutMs: 5000, fetchImpl }),
    (e: unknown) => e instanceof AdapterError && e.kind === 'network',
  )
  await cleanup()
})

test('fetchBailianUsage maps malformed JSON and non-object JSON to parse error', async () => {
  const path = await writeConfig({ access_token: TOKEN })
  const badJson = (async () => new Response('not json', { status: 200 })) as typeof fetch
  await assert.rejects(
    () => fetchBailianUsage({ configPath: path, timeoutMs: 5000, fetchImpl: badJson }),
    (e: unknown) => e instanceof AdapterError && e.kind === 'parse',
  )
  const arrayJson = (async () => new Response('[1,2]', { status: 200 })) as typeof fetch
  await assert.rejects(
    () => fetchBailianUsage({ configPath: path, timeoutMs: 5000, fetchImpl: arrayJson }),
    (e: unknown) => e instanceof AdapterError && e.kind === 'parse',
  )
  await cleanup()
})

// ---------------------------------------------------------------------------
// UsageStore
// ---------------------------------------------------------------------------

test('UsageStore keeps ok snapshot with quotas', async () => {
  const store = new UsageStore(async () => parseBailianUsage(OK_MONTHLY))
  await store.refresh()
  const snap = store.snapshot()
  assert.equal(snap?.status, 'ok')
  assert.equal(snap?.quotas.length, 1)
  assert.ok(snap?.fetchedAt)
})

test('UsageStore keeps ok snapshot with empty quotas (unlimited plan form)', async () => {
  const store = new UsageStore(async () => parseBailianUsage(wrapEnvelope({})))
  await store.refresh()
  const snap = store.snapshot()
  assert.equal(snap?.status, 'ok')
  assert.deepEqual(snap?.quotas, [])
})

test('UsageStore preserves last ok data with stale flag on later failure', async () => {
  let fail = false
  const store = new UsageStore(async () => {
    if (fail) throw new AdapterError('network', '百炼网关请求超时')
    return parseBailianUsage(OK_MONTHLY)
  })
  await store.refresh()
  fail = true
  await store.refresh()
  const snap = store.snapshot()
  assert.equal(snap?.status, 'error')
  assert.equal(snap?.stale, true)
  assert.equal(snap?.quotas.length, 1)
  assert.equal(snap?.error?.kind, 'network')
})

test('UsageStore maps unconfigured error without error field', async () => {
  const store = new UsageStore(async () => {
    throw new AdapterUnconfiguredError('百炼 console 未登录')
  })
  await store.refresh()
  const snap = store.snapshot()
  assert.equal(snap?.status, 'unconfigured')
  assert.equal(snap?.error, undefined)
})

test('UsageStore ensureFresh only refreshes once when a snapshot exists', async () => {
  let calls = 0
  const store = new UsageStore(async () => {
    calls += 1
    return parseBailianUsage(OK_MONTHLY)
  })
  await store.ensureFresh()
  await store.ensureFresh()
  assert.equal(calls, 1)
  assert.equal(store.snapshot()?.status, 'ok')
})

test('UsageStore ensureFresh surfaces error snapshot from a failing adapter', async () => {
  const store = new UsageStore(async () => {
    throw new AdapterError('parse', '百炼网关响应不是合法 JSON')
  })
  await store.ensureFresh()
  assert.equal(store.snapshot()?.status, 'error')
  assert.equal(store.snapshot()?.error?.kind, 'parse')
})
