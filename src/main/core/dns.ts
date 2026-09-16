import { exec, execFile } from 'child_process'
import { promisify } from 'util'
import { net } from 'electron'
import axios from 'axios'
import { getAppConfig, patchAppConfig } from '../config/app'
import { createLogger } from '../utils/logger'
import {
  mergeLegacyOriginDNS,
  parseNetworkServiceOrder,
  parseNetworkSetupDnsOutput,
  pickPhysicalServices,
  planTakeOver,
  PUBLIC_DNS,
  tunDnsTransition
} from './dnsPlan'

export {
  mergeLegacyOriginDNS,
  parseNetworkServiceOrder,
  parseNetworkSetupDnsOutput,
  pickPhysicalServices,
  planTakeOver,
  PUBLIC_DNS,
  tunDnsTransition
}
export type { NetworkServiceDevice, TakeOverPlan } from './dnsPlan'
import type { NetworkServiceDevice } from './dnsPlan'

const execPromise = promisify(exec)
const dnsLogger = createLogger('DNS')
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

// ---------- 纯决策函数在 ./dnsPlan（零依赖，便于测试） ----------

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

// 双连接（有线 + Wi-Fi）时对全部活跃物理服务接管。对照实际 DNS 幂等：
// 已是 223.5.5.5 的服务跳过，其余（含 map 有记录但值漂移的）重新套用。
async function takeOverPublicDNS(): Promise<void> {
  const map = await readOriginMap()
  const services = await getActivePhysicalServices()
  const currentDns: { [service: string]: string } = {}
  for (const service of services) {
    currentDns[service] = await getOriginDNSForService(service)
  }

  const plan = planTakeOver(services, map, (service) => currentDns[service])
  for (const { service } of plan.toSet) {
    await setDNS(service, PUBLIC_DNS)
  }
  if (plan.toSet.length > 0) {
    await writeOriginMap(plan.map)
    dnsLogger.info(
      `System DNS takeover applied to ${plan.toSet.length} service(s): ${plan.toSet
        .map((t) => t.service)
        .join(', ')}`
    )
  } else {
    dnsLogger.debug('System DNS takeover: all active services already on public DNS')
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
