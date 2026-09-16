import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  net: { isOnline: vi.fn(() => true) }
}))

vi.mock('axios', () => ({
  default: { post: vi.fn(async () => ({})) }
}))

vi.mock('../config/app', () => ({
  getAppConfig: vi.fn(async () => ({}) as never),
  patchAppConfig: vi.fn(async () => ({}))
}))

import {
  parseNetworkServiceOrder,
  pickPhysicalServices,
  parseNetworkSetupDnsOutput,
  servicesToTakeOver,
  mergeLegacyOriginDNS,
  tunDnsTransition
} from './dns'

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

describe('servicesToTakeOver', () => {
  it('returns active services not yet recorded in the origin map', () => {
    const map = { 'Wi-Fi': '192.168.2.1' }
    expect(servicesToTakeOver(['USB 10/100/1000 LAN', 'Wi-Fi'], map)).toEqual([
      'USB 10/100/1000 LAN'
    ])
  })

  it('returns empty when every active service is already ours', () => {
    const map = { 'Wi-Fi': '192.168.2.1', 'USB 10/100/1000 LAN': 'Empty' }
    expect(servicesToTakeOver(['Wi-Fi', 'USB 10/100/1000 LAN'], map)).toEqual([])
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
