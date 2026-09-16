import { describe, expect, it } from 'vitest'
import {
  parseNetworkServiceOrder,
  pickPhysicalServices,
  parseNetworkSetupDnsOutput,
  planTakeOver,
  PUBLIC_DNS,
  mergeLegacyOriginDNS,
  tunDnsTransition
} from './dnsPlan'

describe('parseNetworkServiceOrder', () => {
  const output = [
    'An asterisk (*) denotes that a network service is disabled.',
    '(1) USB 10/100/1000 LAN',
    '(Hardware Port: USB 10/100/1000 LAN, Device: en7)',
    '',
    '(2) Wi-Fi',
    '(Hardware Port: Wi-Fi, Device: en0)',
    '',
    '(3) Thunderbolt Bridge',
    '(Hardware Port: Thunderbolt Bridge, Device: bridge0)',
    '',
    '(4) VPN (Cisco)',
    '(Hardware Port: IPSec, Device: utun5)'
  ].join('\n')

  it('pairs each service with its device in order', () => {
    expect(parseNetworkServiceOrder(output)).toEqual([
      { service: 'USB 10/100/1000 LAN', device: 'en7' },
      { service: 'Wi-Fi', device: 'en0' },
      { service: 'Thunderbolt Bridge', device: 'bridge0' },
      { service: 'VPN (Cisco)', device: 'utun5' }
    ])
  })

  it('returns empty for empty output', () => {
    expect(parseNetworkServiceOrder('')).toEqual([])
  })
})

describe('pickPhysicalServices', () => {
  it('keeps only en* devices, excluding bridges/utuns (multi-link scenario)', () => {
    const list = parseNetworkServiceOrder(
      [
        '(1) USB 10/100/1000 LAN',
        '(Hardware Port: USB 10/100/1000 LAN, Device: en7)',
        '(2) Wi-Fi',
        '(Hardware Port: Wi-Fi, Device: en0)',
        '(3) Thunderbolt Bridge',
        '(Hardware Port: Thunderbolt Bridge, Device: bridge0)',
        '(4) VPN (Cisco)',
        '(Hardware Port: IPSec, Device: utun5)'
      ].join('\n')
    )
    expect(pickPhysicalServices(list)).toEqual([
      { service: 'USB 10/100/1000 LAN', device: 'en7' },
      { service: 'Wi-Fi', device: 'en0' }
    ])
  })
})

describe('parseNetworkSetupDnsOutput', () => {
  it('maps "no DNS servers" output to Empty', () => {
    expect(parseNetworkSetupDnsOutput("There aren't any DNS Servers set on Wi-Fi.")).toBe('Empty')
  })

  it('joins multiple servers into one space separated line', () => {
    expect(parseNetworkSetupDnsOutput('192.168.2.1\n192.168.2.2')).toBe('192.168.2.1 192.168.2.2')
  })
})

describe('mergeLegacyOriginDNS', () => {
  it('adopts the legacy single-service value when the map is empty (upgrade mid-session)', () => {
    const map = mergeLegacyOriginDNS({}, '192.168.2.1', 'USB 10/100/1000 LAN')
    expect(map).toEqual({ 'USB 10/100/1000 LAN': '192.168.2.1' })
  })

  it('keeps an existing map untouched', () => {
    const existing = { 'Wi-Fi': '192.168.2.1' }
    expect(mergeLegacyOriginDNS(existing, '10.0.0.1', 'USB LAN')).toBe(existing)
  })

  it('ignores missing legacy values', () => {
    expect(mergeLegacyOriginDNS({}, undefined, 'USB LAN')).toEqual({})
  })
})

describe('tunDnsTransition', () => {
  it('returns takeover when TUN is turned on', () => {
    expect(tunDnsTransition(false, true)).toBe('takeover')
    expect(tunDnsTransition(undefined, true)).toBe('takeover')
  })

  it('returns recover when TUN is turned off', () => {
    expect(tunDnsTransition(true, false)).toBe('recover')
  })

  it('returns null when TUN state did not change', () => {
    expect(tunDnsTransition(true, true)).toBeNull()
    expect(tunDnsTransition(false, false)).toBeNull()
    expect(tunDnsTransition(undefined, false)).toBeNull()
  })
})

describe('planTakeOver (reality-based takeover)', () => {
  const svc = ['USB LAN', 'Wi-Fi']

  it('records origin and sets services never taken over', () => {
    const plan = planTakeOver(svc, {}, () => 'Empty')
    expect(plan.toSet).toEqual([
      { service: 'USB LAN', origin: 'Empty' },
      { service: 'Wi-Fi', origin: 'Empty' }
    ])
    expect(plan.map).toEqual({ 'USB LAN': 'Empty', 'Wi-Fi': 'Empty' })
  })

  it('skips services already at the public DNS', () => {
    const map = { 'USB LAN': 'Empty', 'Wi-Fi': 'Empty' }
    const plan = planTakeOver(svc, map, (s) => (s === 'USB LAN' ? PUBLIC_DNS : 'Empty'))
    expect(plan.toSet).toEqual([{ service: 'Wi-Fi', origin: 'Empty' }])
    expect(plan.map).toEqual(map)
  })

  it('heals the stuck state: map covered but actual DNS drifted away', () => {
    const map = { 'USB LAN': 'Empty', 'Wi-Fi': 'Empty' }
    const plan = planTakeOver(svc, map, () => 'Empty')
    expect(plan.toSet.map((t) => t.service)).toEqual(svc)
    expect(plan.map).toEqual(map)
  })

  it('never poisons the origin with the public DNS value', () => {
    const plan = planTakeOver(['NewSvc'], {}, () => PUBLIC_DNS)
    expect(plan.toSet).toEqual([])
    expect(plan.map).toEqual({})
  })
})
