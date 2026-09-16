import { exec, execFile } from 'child_process'
import { promisify } from 'util'
import { net } from 'electron'
import axios from 'axios'
import { getAppConfig, patchAppConfig } from '../config'

const execPromise = promisify(exec)
const execFilePromise = promisify(execFile)
const helperSocketPath = '/tmp/mihomo-party-helper.sock'

let setPublicDNSTimer: NodeJS.Timeout | null = null
let recoverDNSTimer: NodeJS.Timeout | null = null

interface DNSOperationOptions {
  force?: boolean
  timeout?: number
}

export async function getDefaultDevice(): Promise<string> {
  const { stdout: deviceOut } = await execPromise(`route -n get default`)
  let device = deviceOut.split('\n').find((s) => s.includes('interface:'))
  device = device?.trim().split(' ').slice(1).join(' ')
  if (!device) throw new Error('Get device failed')
  return device
}

// ---------- 纯函数：服务枚举解析与接管/恢复决策 ----------

export interface NetworkServiceDevice {
  service: string
  device: string
}

// 解析 `networksetup -listnetworkserviceorder`：服务名与设备交替出现
//   (1) USB 10/100/1000 LAN
//   (Hardware Port: USB 10/100/1000 LAN, Device: en7)
export function parseNetworkServiceOrder(output: string): NetworkServiceDevice[] {
  const list: NetworkServiceDevice[] = []
  let pendingService: string | null = null
  for (const line of output.split('\n')) {
    const serviceMatch = line.match(/^\(\d+\)\s+(.+)$/)
    if (serviceMatch) {
      pendingService = serviceMatch[1].trim()
      continue
    }
    const deviceMatch = line.match(/Device:\s*(\S+)\s*\)/)
    if (deviceMatch && pendingService) {
      list.push({ service: pendingService, device: deviceMatch[1] })
      pendingService = null
    }
  }
  return list
}

// 只保留物理网络服务（en* 有线/Wi-Fi/USB 网卡/手机共享），
// 排除 bridge、utun 等——TUN/VPN/桥接不应被写入公共 DNS。
export function pickPhysicalServices(list: NetworkServiceDevice[]): NetworkServiceDevice[] {
  return list.filter((item) => /^en\d+$/.test(item.device))
}

// `networksetup -getdnsservers` 输出 → 存储值：未设置记 'Empty'，多值合并为一行
export function parseNetworkSetupDnsOutput(output: string): string {
  if (output.startsWith("There aren't any DNS Servers set on")) return 'Empty'
  return output.trim().replace(/\n/g, ' ')
}

// 需要接管的服务 = 当前活跃服务中尚未记录 origin 的（记录过的已是 223.5.5.5）
export function servicesToTakeOver(
  activeServices: string[],
  originMap: { [service: string]: string }
): string[] {
  return activeServices.filter((service) => !(service in originMap))
}

// 兼容旧版单值 originDNS：map 为空且存在待恢复的旧值时，归并到默认服务名下
export function mergeLegacyOriginDNS(
  map: { [service: string]: string },
  legacyOriginDNS: string | undefined,
  defaultService: string
): { [service: string]: string } {
  if (Object.keys(map).length > 0 || !legacyOriginDNS) return map
  return { [defaultService]: legacyOriginDNS }
}

// ---------- 执行器 ----------

async function listPhysicalNetworkServices(): Promise<NetworkServiceDevice[]> {
  const { stdout } = await execFilePromise('networksetup', ['-listnetworkserviceorder'])
  return pickPhysicalServices(parseNetworkServiceOrder(stdout))
}

async function isDeviceActive(device: string): Promise<boolean> {
  try {
    const { stdout } = await execFilePromise('/usr/sbin/ipconfig', ['getifaddr', device])
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

async function getDefaultService(): Promise<string> {
  const device = await getDefaultDevice()
  const { stdout: order } = await execPromise(`networksetup -listnetworkserviceorder`)
  const block = order.split('\n\n').find((s) => s.includes(`Device: ${device}`))
  if (!block) throw new Error('Get networkservice failed')
  for (const line of block.split('\n')) {
    if (line.match(/^\(\d+\).*/)) {
      return line.trim().split(' ').slice(1).join(' ')
    }
  }
  throw new Error('Get service failed')
}

// 当前有 IPv4 地址的物理网络服务（有线 + Wi-Fi 同时连接时返回两者）
async function getActivePhysicalServices(): Promise<string[]> {
  const services = await listPhysicalNetworkServices()
  const active: string[] = []
  for (const { service, device } of services) {
    if (await isDeviceActive(device)) active.push(service)
  }
  return active
}

async function getOriginDNSForService(service: string): Promise<string> {
  const { stdout } = await execFilePromise('networksetup', ['-getdnsservers', service])
  return parseNetworkSetupDnsOutput(stdout)
}

async function setDNS(service: string, dns: string, timeout?: number): Promise<void> {
  try {
    await axios.post(
      'http://localhost/dns',
      { service, dns },
      {
        socketPath: helperSocketPath,
        ...(timeout === undefined ? {} : { timeout })
      }
    )
  } catch (error) {
    // 退出清理使用有界 helper 请求；此时不能再弹授权框或启动无界的 osascript fallback。
    if (timeout !== undefined) throw error
    // fallback to osascript if helper not available
    const shell = `networksetup -setdnsservers "${service}" ${dns}`
    const command = `do shell script "${shell}" with administrator privileges`
    await execPromise(`osascript -e '${command}'`)
  }
}

// ---------- originDNSMap 读写 ----------

async function readOriginMap(): Promise<{ [service: string]: string }> {
  const { originDNSMap, originDNS } = await getAppConfig()
  return mergeLegacyOriginDNS(originDNSMap ?? {}, originDNS, await getDefaultService())
}

async function writeOriginMap(map: { [service: string]: string }): Promise<void> {
  await patchAppConfig({ originDNSMap: map, originDNS: undefined })
}

// ---------- 公共 DNS 接管 / 恢复（多服务） ----------

// 双连接（有线 + Wi-Fi）时对全部活跃物理服务接管：首次触碰的服务先记录 origin，
// 已接管的服务跳过（幂等，不重复触发系统事件）。
async function takeOverPublicDNS(): Promise<void> {
  const map = await readOriginMap()
  const active = await getActivePhysicalServices()
  const pending = servicesToTakeOver(active, map)

  for (const service of pending) {
    map[service] = await getOriginDNSForService(service)
    await setDNS(service, '223.5.5.5')
  }
  if (pending.length > 0) {
    await writeOriginMap(map)
  }
}

export async function setPublicDNS(): Promise<void> {
  if (process.platform !== 'darwin') return
  if (net.isOnline()) {
    await takeOverPublicDNS()
  } else {
    if (setPublicDNSTimer) clearTimeout(setPublicDNSTimer)
    setPublicDNSTimer = setTimeout(() => setPublicDNS(), 5000)
  }
}

export async function recoverDNS(options: DNSOperationOptions = {}): Promise<void> {
  if (process.platform !== 'darwin') return
  if (options.force && setPublicDNSTimer) {
    clearTimeout(setPublicDNSTimer)
    setPublicDNSTimer = null
  }
  if (net.isOnline() || options.force) {
    const map = await readOriginMap()
    for (const [service, dns] of Object.entries(map)) {
      try {
        await setDNS(service, dns, options.timeout)
      } catch (error) {
        if (options.timeout !== undefined) throw error
      }
    }
    await patchAppConfig({ originDNSMap: {}, originDNS: undefined })
  } else {
    if (recoverDNSTimer) clearTimeout(recoverDNSTimer)
    recoverDNSTimer = setTimeout(() => recoverDNS(options), 5000)
  }
}

// 网络变化（ssid.ts scutil 监听）后补接管新活跃的物理服务：如拔掉有线后 Wi-Fi
// 成为唯一出口，此时也要把 223.5.5.5 写到 Wi-Fi。全量幂等：已在 map 中的服务
// 跳过，不会重复设置触发事件风暴；需要 TUN + 自动设置 DNS 且核心在运行。
export async function refreshSystemDnsOnNetworkChange(): Promise<void> {
  if (process.platform !== 'darwin') return

  const [{ tun }, appConfig] = await Promise.all([
    import('../config').then((m) => m.getControledMihomoConfig()),
    getAppConfig()
  ])
  const { autoSetDNS = true } = appConfig
  if (!tun?.enable || !autoSetDNS) return
  if (!net.isOnline()) return
  const { hasCoreProcess } = await import('./manager')
  if (!hasCoreProcess()) return

  await takeOverPublicDNS()
}
