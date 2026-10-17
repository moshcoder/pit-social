import { describe, expect, test } from 'bun:test'
import { isLoopback, nameFromHost, normalizeName, resolveRequest } from '../src/names.ts'

const h = (o: Record<string, string>) => new Headers(o)

describe('names', () => {
  test('name from Host', () => {
    expect(nameFromHost('social.family.ancestry.pit.world')).toBe('family.ancestry')
    expect(nameFromHost('SOCIAL.seo.rank.pit.world:443')).toBe('seo.rank')
    expect(nameFromHost('social.a.b.c.pit.world')).toBe('a.b.c')
    expect(nameFromHost('social.ancestry.pit.world')).toBeNull() // one label
    expect(nameFromHost('family.ancestry.pit.world')).toBeNull() // no social.
    expect(nameFromHost('social.family.ancestry.pit.world.evil.com')).toBeNull()
    expect(nameFromHost('social.-bad.name.pit.world')).toBeNull()
    expect(nameFromHost('social.fam_ily.x.pit.world')).toBeNull()
    expect(nameFromHost('')).toBeNull()
    expect(normalizeName('Family.Ancestry.')).toBe('family.ancestry')
  })

  test('loopback detection', () => {
    expect(isLoopback('127.0.0.1')).toBe(true)
    expect(isLoopback('::1')).toBe(true)
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopback('10.0.0.1')).toBe(false)
    expect(isLoopback(undefined)).toBe(false)
  })

  test('X-Pit-Name and X-Real-IP are trusted from loopback only', () => {
    const url = 'http://127.0.0.1:8794/'
    const fromFrontDoor = resolveRequest(h({ host: 'social.seo.rank.pit.world', 'x-pit-name': 'seo.rank', 'x-real-ip': '198.51.100.7', 'x-forwarded-proto': 'https' }), '127.0.0.1', url)
    expect(fromFrontDoor).toEqual({ name: 'seo.rank', ip: '198.51.100.7', proto: 'https', viaFrontDoor: true })

    // A stranger claiming another name gets the name of the Host they sent, and their own IP.
    const spoof = resolveRequest(h({ host: 'social.family.ancestry.pit.world', 'x-pit-name': 'seo.rank', 'x-real-ip': '1.2.3.4', 'x-forwarded-proto': 'https' }), '203.0.113.5', 'http://social.family.ancestry.pit.world/')
    expect(spoof).toEqual({ name: 'family.ancestry', ip: '203.0.113.5', proto: 'http', viaFrontDoor: false })

    // ...and with a Host that is not a social name, nothing at all.
    expect(resolveRequest(h({ host: 'example.com', 'x-pit-name': 'seo.rank' }), '203.0.113.5', 'http://example.com/')).toBeNull()
    // A bad X-Pit-Name from loopback falls back to Host.
    expect(resolveRequest(h({ host: 'social.seo.rank.pit.world', 'x-pit-name': 'nope' }), '127.0.0.1', url)?.name).toBe('seo.rank')
  })
})
