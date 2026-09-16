// DNS 接管/恢复的纯决策与解析函数（零依赖，便于测试）
export const PUBLIC_DNS = '223.5.5.5'

export interface NetworkServiceDevice {
  service: string
  device: string
}

export interface TakeOverPlan {
  toSet: { service: string; origin: string }[]
  map: { [service: string]: string }
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

// 接管计划：对照服务的**实际 DNS**决策，而不是信任 origin map——
// map 有记录但实际值漂移（如恢复后 map 未同步）时必须重新套用，否则接管永久静默失效。
// origin 永不记录 223.5.5.5 自身，避免恢复时把公共 DNS 当原值写回。
export function planTakeOver(
  activeServices: string[],
  map: { [service: string]: string },
  getCurrentDns: (service: string) => string
): TakeOverPlan {
  const nextMap = { ...map }
  const toSet: { service: string; origin: string }[] = []
  for (const service of activeServices) {
    const current = getCurrentDns(service)
    if (current === PUBLIC_DNS) continue
    if (!(service in nextMap)) nextMap[service] = current
    toSet.push({ service, origin: nextMap[service] })
  }
  return { toSet, map: nextMap }
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

// TUN 状态迁移方向：开→接管系统 DNS，关→恢复。状态未变化返回 null。
// 核心运行中开关 TUN 走热更新路径（PATCH /configs），不经过核心重启的
// recoverDNS/setPublicDNS，必须在配置补丁处补齐这两个方向的系统 DNS 副作用。
export function tunDnsTransition(
  prevEnable: boolean | undefined,
  nextEnable: boolean | undefined
): 'takeover' | 'recover' | null {
  // undefined（未配置 TUN）视同关闭
  const prev = prevEnable === true
  const next = nextEnable === true
  if (prev === next) return null
  return next ? 'takeover' : 'recover'
}
