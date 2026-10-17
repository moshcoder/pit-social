/**
 * A small client for one community's /api/v1, used by the CLI and the MCP server.
 *
 * By default it talks to https://social.<name>.pit.world. PIT_SOCIAL_URL (or
 * `url`) points it at one server for every name instead, e.g. your own
 * http://127.0.0.1:8794, and the name travels as X-Pit-Name (believed from loopback only).
 */
import { normalizeName, originFor } from './names.js'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export type ClientOptions = { url?: string; token?: string; fetch?: typeof fetch }

export class SocialClient {
  private readonly url?: string
  private readonly token?: string
  private readonly fetchImpl: typeof fetch
  constructor(o: ClientOptions = {}) {
    this.url = (o.url ?? process.env.PIT_SOCIAL_URL)?.replace(/\/+$/, '') || undefined
    this.token = o.token ?? process.env.PIT_SOCIAL_TOKEN ?? undefined
    this.fetchImpl = o.fetch ?? fetch
  }

  private async call<T>(name: string, path: string, init: RequestInit = {}): Promise<T> {
    const n = normalizeName(name)
    if (!n) throw new ApiError(400, `not a Moshpit name: ${name} (two or more labels, like family.ancestry)`)
    const base = this.url ?? originFor(n)
    const headers: Record<string, string> = { accept: 'application/json', 'x-pit-name': n, ...(init.headers as Record<string, string>) }
    if (this.token) headers.authorization = 'Bearer ' + this.token
    const res = await this.fetchImpl(base + path, { ...init, headers, signal: AbortSignal.timeout(20_000) })
    const body = (await res.json().catch(() => null)) as any
    if (!res.ok) throw new ApiError(res.status, body?.error ?? `HTTP ${res.status}`)
    return body as T
  }

  feed(name: string, opts: { tag?: string; tab?: 'all' | 'network' | 'members'; limit?: number } = {}) {
    const q = new URLSearchParams()
    if (opts.tag) q.set('tag', opts.tag)
    if (opts.tab && opts.tab !== 'all') q.set('tab', opts.tab)
    if (opts.limit) q.set('limit', String(opts.limit))
    return this.call<{ community: string; tags: string[]; items: any[]; next: string | null }>(name, '/api/v1/feed' + (q.size ? '?' + q : ''))
  }
  tags(name: string) {
    return this.call<{ community: string; tags: string[]; source: string }>(name, '/api/v1/tags')
  }
  status(name: string) {
    return this.call<{ community: string; ingest: boolean; tags: string[]; networkPosts: number; localPosts: number; relays: any[] }>(name, '/api/v1/status')
  }
  me(name: string) {
    return this.call<{ sub: string; name: string | null }>(name, '/api/v1/me')
  }
  post(name: string, text: string, replyTo?: string) {
    if (!this.token) throw new ApiError(401, 'posting needs a token: make one at https://social.<name>.pit.world/settings and pass --token or PIT_SOCIAL_TOKEN')
    return this.call<any>(name, '/api/v1/posts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, ...(replyTo ? { reply_to: replyTo } : {}) }) })
  }
}

/** One feed item as a few lines of text. */
export function formatItem(i: any): string {
  const who = i.kind === 'network' ? (i.author.handle ? '@' + i.author.handle : i.author.did) + ' (network)' : i.author.name + ' (member)'
  const when = String(i.createdAt ?? '').replace('T', ' ').slice(0, 16)
  return `${who} · ${when}\n${String(i.text).trim()}\n${i.url}`
}

export function formatStatus(s: Awaited<ReturnType<SocialClient['status']>>): string {
  const lines = [`${s.community}: ingest ${s.ingest ? 'on' : 'off'}, ${s.networkPosts} network posts, ${s.localPosts} member posts`, `tags: ${s.tags.map((t) => '#' + t).join(' ')}`, '']
  for (const r of s.relays) lines.push(`${String(r.label ?? r.url).padEnd(36)} ${String(r.state).padEnd(10)} ${String(r.eps ?? 0).padStart(7)} ev/s  lag ${r.lagMs == null ? '-' : Math.round(r.lagMs / 1000) + 's'}  matched ${r.matched ?? 0}${r.lastError ? '  (' + r.lastError + ')' : ''}`)
  return lines.join('\n')
}
