import { execFile } from 'child_process'
import { promisify } from 'util'
import { isIP } from 'net'
import { getAppConfig } from '../config'
import { createLogger } from '../utils/logger'

const execFilePromise = promisify(execFile)
const underlayDnsLogger = createLogger('DNS')

// Clash Party 把系统 DNS 改成 223.5.5.5 后，mihomo 的 system 解析器读到的是修改值
// 而不是物理网络 DHCP 下发的 DNS。Effective System DNS ≠ Underlay DNS：
// 这里只针对 dns.proxy-server-nameserver 的 "system" 做 runtime 转换（darwin 专用）。
export interface UnderlayDns {
  interface: string
  dns: string[]
  source: 'dhcp' | 'origin'
}

// ---------- 纯函数：DHCP / 路由 / origin DNS 解析 ----------

function isValidIpv4Dns(value: string): boolean {
  return isIP(value) === 4 && value !== '0.0.0.0' && !value.startsWith('127.')
}

// macOS 上的虚拟接口前缀：TUN(utun)、回环、桥接、Wi-Fi 直连、VPN、tap 等。
const VIRTUAL_INTERFACE_PATTERN =
  /^(utun|lo|bridge|llw|awdl|anpi|ipsec|tap|tun|vlan|vether|gif|stf|pktap)\d*$/

export function isVirtualNetworkInterface(name: string): boolean {
  return VIRTUAL_INTERFACE_PATTERN.test(name.trim())
}

// 解析 `ipconfig getpacket <iface>` 输出中的 DHCP Option 6（domain_name_server）。
// 输入形如：domain_name_server (ip_mult): {192.168.2.1} 或 {10.0.0.1, 10.0.0.2}
export function parseDhcpDns(packetOutput: string): string[] {
  const match = packetOutput.match(/domain_name_server\s*\(ip_mult\):\s*\{([^}]*)\}/)
  if (!match) return []
  return match[1]
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => isValidIpv4Dns(entry))
}

// 解析 `netstat -rn -f inet` 的 default 路由，返回按出现顺序排列的物理接口，
// 排除 utun 等虚拟接口（TUN 启用后默认路由可能指向 utun）。
export function parseNetstatDefaultInterfaces(netstatOutput: string): string[] {
  return netstatOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.split(/\s+/)[0] === 'default')
    .map((line) => line.split(/\s+/).pop() ?? '')
    .filter((iface) => /^[a-zA-Z]+\d+$/.test(iface) && !isVirtualNetworkInterface(iface))
}

// 解析 Clash Party 保存的 pre-TUN 系统 DNS（networksetup 输出，空格分隔；'Empty' 表示未设置）。
// 223.5.5.5 是应用自己写入的公共 DNS，不能当作原始值回退。
export function parseOriginDnsList(originDNS: string | undefined): string[] {
  if (!originDNS) return []
  return originDNS
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => isValidIpv4Dns(entry) && entry !== '223.5.5.5')
}

// 仅替换 dns.proxy-server-nameserver 中的字面量 "system" 为 underlay DNS（第一个有效值）。
// 其他字段、显式 IP、DoH URL 一律不动；underlay 不可用时保留 "system"。
// 返回是否发生了替换。
export function replaceSystemInProxyServerNameserver(
  dns: IMihomoConfig['dns'],
  underlay: string[] | null
): boolean {
  const list = dns?.['proxy-server-nameserver']
  if (!dns || !Array.isArray(list) || !underlay || underlay.length === 0) return false

  const replacement = underlay[0]
  let changed = false
  dns['proxy-server-nameserver'] = list.map((entry) => {
    if (typeof entry === 'string' && entry.trim() === 'system') {
      changed = true
      return replacement
    }
    return entry
  })
  return changed
}

// ---------- 接口检测与 DHCP 读取（执行器可注入，便于测试） ----------

export async function detectUnderlayInterfaceWith(
  runRouteGetDefault: () => Promise<string>,
  runNetstat: () => Promise<string>
): Promise<string | null> {
  // 首选默认路由接口；TUN 未接管时 route get default 直接给出物理口。
  try {
    const routeOut = await runRouteGetDefault()
    const iface = routeOut.match(/interface:\s*(\S+)/)?.[1] ?? ''
    if (iface && !isVirtualNetworkInterface(iface)) return iface
  } catch {
    // fall through to netstat
  }
  // TUN 接管默认路由（得到 utun）时，从完整路由表里找非虚拟的 default 接口。
  try {
    const netstatOut = await runNetstat()
    return parseNetstatDefaultInterfaces(netstatOut)[0] ?? null
  } catch {
    return null
  }
}

export async function resolveDhcpUnderlayDnsWith(
  runGetpacket: (iface: string) => Promise<string>,
  runDetectInterface: () => Promise<string | null>
): Promise<UnderlayDns | null> {
  const iface = await runDetectInterface()
  if (!iface) return null

  try {
    const packet = await runGetpacket(iface)
    const dnsList = parseDhcpDns(packet)
    if (dnsList.length === 0) return null
    return { interface: iface, dns: dnsList, source: 'dhcp' }
  } catch {
    return null
  }
}

const runRouteGetDefault = async (): Promise<string> =>
  (await execFilePromise('route', ['-n', 'get', 'default'])).stdout
const runNetstatInet = async (): Promise<string> =>
  (await execFilePromise('netstat', ['-rn', '-f', 'inet'])).stdout
const runGetpacket = async (iface: string): Promise<string> =>
  (await execFilePromise('/usr/sbin/ipconfig', ['getpacket', iface])).stdout

// ---------- runtime 组合：缓存 + fallback 链 + 网络变化刷新 ----------

// DHCP Option 6 → pre-TUN originDNS → null（保留 system）
// 解析结果缓存到下次网络变化，避免每次配置生成都执行子进程。
let cachedUnderlayDns: { first: string | null } | null = null
// 上一次写入 runtime config 的值与"是否使用了 system"，用于变化检测。
let lastRuntimeUnderlayDns: string | null = null
let lastProfileUsesSystem = false
let resolveInflight: Promise<string | null> | null = null
let refreshInflight: Promise<void> | null = null

async function resolveFirstUnderlayDns(): Promise<string | null> {
  const dhcp = await resolveDhcpUnderlayDnsWith(runGetpacket, () =>
    detectUnderlayInterfaceWith(runRouteGetDefault, runNetstatInet)
  )
  if (dhcp) {
    underlayDnsLogger.info(`DHCP-provided DNS on ${dhcp.interface}: ${dhcp.dns[0]}`)
    return dhcp.dns[0]
  }

  const { originDNS } = await getAppConfig()
  const origin = parseOriginDnsList(originDNS)
  if (origin.length > 0) {
    underlayDnsLogger.warn(
      `Unable to obtain DHCP DNS for underlay interface, falling back to original system DNS: ${origin[0]}`
    )
    return origin[0]
  }

  underlayDnsLogger.warn(
    'Unable to obtain DHCP DNS or original system DNS, keeping "system" for proxy-server-nameserver'
  )
  return null
}

export async function getUnderlayDnsForRuntime(): Promise<string[] | null> {
  if (process.platform !== 'darwin') return null
  if (cachedUnderlayDns) return cachedUnderlayDns.first === null ? null : [cachedUnderlayDns.first]
  if (resolveInflight) {
    const first = await resolveInflight
    return first === null ? null : [first]
  }

  resolveInflight = resolveFirstUnderlayDns().finally(() => {
    resolveInflight = null
  })
  const first = await resolveInflight
  cachedUnderlayDns = { first }
  return first === null ? null : [first]
}

// factory 在 merge 完成后调用：把最终 runtime 配置里的 "system" 解析为 underlay DNS。
// 不修改用户持久化配置，只转换提交给核心的 runtime 对象。
export async function applyUnderlayDnsToProfile(profile: IMihomoConfig): Promise<boolean> {
  lastProfileUsesSystem =
    Array.isArray(profile.dns?.['proxy-server-nameserver']) &&
    profile.dns!['proxy-server-nameserver']!.some(
      (entry) => typeof entry === 'string' && entry.trim() === 'system'
    )
  if (process.platform !== 'darwin' || !lastProfileUsesSystem) return false

  const underlay = await getUnderlayDnsForRuntime()
  const replaced = replaceSystemInProxyServerNameserver(profile.dns, underlay)
  if (replaced && underlay) {
    lastRuntimeUnderlayDns = underlay[0]
    underlayDnsLogger.info(
      `proxy-server-nameserver "system" resolved to underlay DNS: ${underlay[0]}`
    )
  } else {
    lastRuntimeUnderlayDns = null
  }
  return replaced
}

// 网络变化（ssid.ts 的 scutil 监听，已 debounce）后刷新 underlay DNS。
// 仅当解析结果真正变化且 runtime 使用了 "system" 时才触发热重载，避免 reload loop：
// 本流程从不修改系统 DNS，数据源是 DHCP lease，与应用的 DNS 设置互不影响。
export function refreshUnderlayDnsOnNetworkChange(): Promise<void> {
  if (refreshInflight) return refreshInflight

  refreshInflight = (async (): Promise<void> => {
    if (process.platform !== 'darwin') return

    cachedUnderlayDns = null
    const next = await getUnderlayDnsForRuntime()
    const nextFirst = next === null ? null : next[0]

    if (!lastProfileUsesSystem) return
    if (nextFirst === lastRuntimeUnderlayDns) return

    const format = (value: string | null): string => value ?? 'system'
    underlayDnsLogger.info(
      `Underlay DNS changed: ${format(lastRuntimeUnderlayDns)} -> ${format(nextFirst)}`
    )
    lastRuntimeUnderlayDns = nextFirst

    const { hasCoreProcess } = await import('./manager')
    if (!hasCoreProcess()) return
    const { mihomoHotReloadConfig } = await import('./mihomoApi')
    await mihomoHotReloadConfig()
  })().finally(() => {
    refreshInflight = null
  })
  return refreshInflight
}
