import { describe, expect, it, vi } from 'vitest'

vi.mock('../utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../config', () => ({
  getAppConfig: vi.fn(async () => ({}) as never)
}))

vi.mock('./mihomoApi', () => ({
  mihomoHotReloadConfig: vi.fn(),
  hasCoreProcess: vi.fn(() => false)
}))

vi.mock('./dns', () => ({
  getDefaultDevice: vi.fn()
}))

vi.mock('./factory', () => ({
  getRuntimeConfig: vi.fn(async () => ({}) as IMihomoConfig)
}))

import {
  parseDhcpDns,
  parseNetstatDefaultInterfaces,
  isVirtualNetworkInterface,
  parseOriginDnsList,
  replaceSystemInProxyServerNameserver,
  resolveDhcpUnderlayDnsWith,
  detectUnderlayInterfaceWith
} from './underlayDns'

describe('parseDhcpDns (ipconfig getpacket DHCP option 6)', () => {
  it('parses a single DHCP DNS server', () => {
    const packet = [
      'op = BOOTREPLY',
      'htype = 1',
      'router (ip): 192.168.2.1',
      'domain_name_server (ip_mult): {192.168.2.1}',
      'domain_name (string): home'
    ].join('\n')
    expect(parseDhcpDns(packet)).toEqual(['192.168.2.1'])
  })

  it('parses multiple DHCP DNS servers', () => {
    const packet = 'domain_name_server (ip_mult): {10.0.0.1, 10.0.0.2}'
    expect(parseDhcpDns(packet)).toEqual(['10.0.0.1', '10.0.0.2'])
  })

  it('returns empty when there is no domain_name_server option', () => {
    expect(parseDhcpDns('router (ip): 192.168.2.1\nclient_id (hex): 01')).toEqual([])
  })

  it('filters 0.0.0.0, loopback, IPv6 and garbage entries', () => {
    const packet =
      'domain_name_server (ip_mult): {0.0.0.0, 127.0.0.1, 8.8.8.8, fd00::1, not-an-ip, 192.168.2.1}'
    expect(parseDhcpDns(packet)).toEqual(['8.8.8.8', '192.168.2.1'])
  })
})

describe('parseNetstatDefaultInterfaces', () => {
  it('returns default-route interfaces in order, virtual ones excluded', () => {
    const netstat = [
      'Routing tables',
      '',
      'Internet:',
      'Destination        Gateway            Flags           Netif Expire',
      'default            192.168.2.1        UGScg             en7',
      'default            192.168.2.1        UGScIg            en0',
      'default            10.5.0.1           UGScIg          utun3',
      '127                127.0.0.1          UCS               lo0'
    ].join('\n')
    expect(parseNetstatDefaultInterfaces(netstat)).toEqual(['en7', 'en0'])
  })

  it('returns empty when only virtual default routes exist', () => {
    const netstat = 'default  10.5.0.1  UGScg  utun4'
    expect(parseNetstatDefaultInterfaces(netstat)).toEqual([])
  })
})

describe('isVirtualNetworkInterface', () => {
  it.each(['utun0', 'utun12', 'lo0', 'bridge100', 'llw0', 'awdl0', 'ipsec0', 'tap3', 'tun1'])(
    'treats %s as virtual',
    (name) => {
      expect(isVirtualNetworkInterface(name)).toBe(true)
    }
  )
  it.each(['en0', 'en7', 'en9', 'eth0'])('treats %s as physical', (name) => {
    expect(isVirtualNetworkInterface(name)).toBe(false)
  })
})

describe('parseOriginDnsList (pre-TUN saved system DNS)', () => {
  it('splits space separated servers', () => {
    expect(parseOriginDnsList('192.168.2.1 192.168.2.2')).toEqual(['192.168.2.1', '192.168.2.2'])
  })
  it('returns empty for Empty/undefined/garbage', () => {
    expect(parseOriginDnsList('Empty')).toEqual([])
    expect(parseOriginDnsList(undefined)).toEqual([])
    expect(parseOriginDnsList('not an ip 8.8.8.8')).toEqual(['8.8.8.8'])
  })
  it('rejects the Clash Party public DNS value', () => {
    expect(parseOriginDnsList('223.5.5.5')).toEqual([])
  })
})

describe('replaceSystemInProxyServerNameserver', () => {
  const dns = (): IMihomoConfig['dns'] => ({
    'default-nameserver': ['tls://223.5.5.5'],
    'proxy-server-nameserver': ['system'],
    nameserver: ['https://doh.pub/dns-query']
  })

  it('replaces system with the first underlay DNS (Test 3)', () => {
    const config = dns()
    const replaced = replaceSystemInProxyServerNameserver(config, ['192.168.2.1', '192.168.2.2'])
    expect(replaced).toBe(true)
    expect(config!['proxy-server-nameserver']).toEqual(['192.168.2.1'])
  })

  it('keeps every other dns field untouched', () => {
    const config = dns()
    replaceSystemInProxyServerNameserver(config, ['192.168.2.1'])
    expect(config!['default-nameserver']).toEqual(['tls://223.5.5.5'])
    expect(config!.nameserver).toEqual(['https://doh.pub/dns-query'])
  })

  it('keeps an explicit IP untouched (Test 4)', () => {
    const config: IMihomoConfig['dns'] = { 'proxy-server-nameserver': ['8.8.8.8'] }
    expect(replaceSystemInProxyServerNameserver(config, ['192.168.2.1'])).toBe(false)
    expect(config!['proxy-server-nameserver']).toEqual(['8.8.8.8'])
  })

  it('keeps DoH URLs untouched (Test 5)', () => {
    const config: IMihomoConfig['dns'] = {
      'proxy-server-nameserver': ['https://dns.example.com/dns-query']
    }
    expect(replaceSystemInProxyServerNameserver(config, ['192.168.2.1'])).toBe(false)
    expect(config!['proxy-server-nameserver']).toEqual(['https://dns.example.com/dns-query'])
  })

  it('keeps system when no underlay DNS resolved (fallback end of chain)', () => {
    const config = dns()
    expect(replaceSystemInProxyServerNameserver(config, null)).toBe(false)
    expect(config!['proxy-server-nameserver']).toEqual(['system'])
  })

  it('only replaces bare system entries, not system:// or subsystem (Test 6 scope)', () => {
    const config: IMihomoConfig['dns'] = {
      'proxy-server-nameserver': ['system', '8.8.8.8', 'systemd.local']
    }
    replaceSystemInProxyServerNameserver(config, ['10.0.0.1'])
    expect(config!['proxy-server-nameserver']).toEqual(['10.0.0.1', '8.8.8.8', 'systemd.local'])
  })
})

describe('detectUnderlayInterfaceWith', () => {
  it('uses the default-route interface when it is physical (Test 1/2)', async () => {
    const routeOut =
      '   route to: default\ndestination: default\n    gateway: 192.168.2.1\n  interface: en7\n      flags: <UP,GATEWAY,DONE>'
    const iface = await detectUnderlayInterfaceWith(
      async () => routeOut,
      async () => ''
    )
    expect(iface).toBe('en7')
  })

  it('falls back to netstat when the default route is a utun (TUN active)', async () => {
    const netstat = 'default  192.168.2.1  UGScg  en7\ndefault  10.5.0.1  UGScIg  utun3'
    const iface = await detectUnderlayInterfaceWith(
      async () => 'utun3',
      async () => netstat
    )
    expect(iface).toBe('en7')
  })

  it('returns null when nothing physical is found', async () => {
    const iface = await detectUnderlayInterfaceWith(
      async () => {
        throw new Error('no route')
      },
      async () => 'default 10.5.0.1 UGScg utun4'
    )
    expect(iface).toBeNull()
  })
})

describe('resolveDhcpUnderlayDnsWith', () => {
  it('resolves DHCP DNS from the physical interface (Test 2: still 192.168.2.1 under TUN)', async () => {
    const result = await resolveDhcpUnderlayDnsWith(
      async (iface) => {
        expect(iface).toBe('en7')
        return 'router (ip): 192.168.2.1\ndomain_name_server (ip_mult): {192.168.2.1}'
      },
      async () => 'en7'
    )
    expect(result).toEqual({ interface: 'en7', dns: ['192.168.2.1'], source: 'dhcp' })
  })

  it('returns null when the interface cannot be detected', async () => {
    const result = await resolveDhcpUnderlayDnsWith(
      async () => '',
      async () => null
    )
    expect(result).toBeNull()
  })
})
