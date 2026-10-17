/**
 * Which community a request is for.
 *
 * pit.world (the front door) forwards `social.<name>.pit.world` to us over
 * loopback, keeping Host and adding X-Pit-Name, X-Real-IP and X-Forwarded-Proto.
 * Those headers are believed only from a loopback peer; from anywhere else the
 * name comes from Host, and anything that is not `social.<name>.pit.world` with a
 * name of two or more DNS labels is a 404.
 */

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

/** A Moshpit name: two or more lowercase DNS labels, at most 200 characters. Null if not. */
export function normalizeName(value: unknown): string | null {
  const name = String(value ?? '').trim().toLowerCase().replace(/\.$/, '')
  if (!name || name.length > 200) return null
  const labels = name.split('.')
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null
  return name
}

/** `social.family.ancestry.pit.world` (port allowed) -> `family.ancestry`. */
export function nameFromHost(host: string | null | undefined): string | null {
  const h = String(host ?? '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')
  if (!h.startsWith('social.') || !h.endsWith('.pit.world')) return null
  return normalizeName(h.slice('social.'.length, -'.pit.world'.length))
}

export const hostFor = (name: string) => `social.${name}.pit.world`
export const originFor = (name: string) => `https://${hostFor(name)}`
export const didFor = (name: string) => `did:web:${hostFor(name)}`
export const feedUriFor = (name: string) => `at://${didFor(name)}/app.bsky.feed.generator/niche`

/** 127.0.0.0/8, ::1 and IPv4-mapped loopback. */
export function isLoopback(ip: string | null | undefined): boolean {
  const a = String(ip ?? '').toLowerCase()
  return a === '::1' || /^127\.\d+\.\d+\.\d+$/.test(a) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(a)
}

export type Resolved = { name: string; ip: string; proto: 'http' | 'https'; viaFrontDoor: boolean }

/**
 * The community for a request, or null (404). `peer` is the TCP peer address.
 * `url` is the request URL, used for the protocol when we are reached directly.
 */
export function resolveRequest(headers: Headers, peer: string | null | undefined, url: string): Resolved | null {
  const trusted = isLoopback(peer)
  const fromHeader = trusted ? normalizeName(headers.get('x-pit-name')) : null
  const name = fromHeader ?? nameFromHost(headers.get('host') ?? new URL(url).host)
  if (!name) return null
  const ip = (trusted ? headers.get('x-real-ip')?.trim() : null) || String(peer ?? '') || 'unknown'
  const forwarded = trusted ? headers.get('x-forwarded-proto') : null
  const proto = forwarded === 'https' || forwarded === 'http' ? forwarded : new URL(url).protocol === 'https:' ? 'https' : 'http'
  return { name, ip, proto, viaFrontDoor: !!fromHeader }
}
