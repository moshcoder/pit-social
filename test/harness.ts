import { createBridgeHost } from '@profullstack/bridges'
import { Store } from '../src/db.ts'
import { Bridges, bridgeSecret } from '../src/bridge.ts'
import { HandleResolver } from '../src/lookup.ts'
import { createApp, CSRF_COOKIE } from '../src/server.ts'

export const KEY = 'test-bridge-key-0123456789abcdef'
export const AUTHORIZE = 'https://pit.world/bridge/authorize'
export const TOKEN = 'https://pit.world/bridge/token'

/** pit.world, in process: a bridge host that knows every social.* client by the derived secret. */
export function fakePitWorld(names: string[]) {
  const signedIn = new Map<string, { sub: string; name?: string; email?: string }>()
  const clients: Record<string, { secret: string; redirectUris: string[] }> = {}
  for (const n of names) {
    const id = `social.${n}.pit.world`
    clients[id] = { secret: bridgeSecret(KEY, id), redirectUris: [`https://${id}/auth/bridge/callback`] }
  }
  const host = createBridgeHost({
    clients,
    async getUser(req) {
      const sid = req.headers.get('cookie')?.match(/pw=([^;]+)/)?.[1]
      const u = sid ? signedIn.get(sid) : null
      return u ? { ...u, email_verified: false } : null
    },
    loginUrl: (returnTo) => `https://pit.world/signin?next=${encodeURIComponent(returnTo)}`,
  })
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as any, init)
    if (req.url.startsWith(TOKEN)) return host.token(req)
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return { host, signedIn, fetch: fetchImpl }
}

export function harness(opts: { name?: string; admins?: string[]; postsPerHour?: number; autoSignIn?: boolean; peer?: string } = {}) {
  const name = opts.name ?? 'family.ancestry'
  const store = new Store(':memory:')
  const pit = fakePitWorld([name, 'seo.rank'])
  const bridges = new Bridges({ key: KEY, authorizeUrl: AUTHORIZE, tokenUrl: TOKEN, fetch: pit.fetch })
  const app = createApp({
    store,
    bridges,
    admins: opts.admins ?? [],
    relays: ['wss://bsky.network'],
    listing: async () => null,
    handles: new HandleResolver(store, (async () => new Response('{}')) as any, 'http://plc.invalid', false),
    autoSignIn: opts.autoSignIn ?? false,
    postsPerHour: opts.postsPerHour,
  })
  const origin = `https://social.${name}.pit.world`
  const jar = new Map<string, string>()
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
  const keep = (res: Response) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const i = pair!.indexOf('=')
      const k = pair!.slice(0, i)
      const v = pair!.slice(i + 1)
      if (v && !/max-age=0/i.test(c)) jar.set(k, v)
      else jar.delete(k)
    }
    return res
  }
  const req = async (path: string, init: RequestInit = {}, peer = opts.peer ?? '203.0.113.9') => keep(await app.request(path.startsWith('http') ? path : origin + path, { ...init, headers: { cookie: cookie(), ...(init.headers as Record<string, string>) } }, { peer }))
  const formPost = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) => req(path, { method: 'POST', body: new URLSearchParams({ _csrf: jar.get(CSRF_COOKIE) ?? '', ...fields }), headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } })

  /** The whole Sign in with pit.world dance. Returns the final redirect. */
  async function signIn(sub = 'did:key:z6MkAlice', who: { name?: string; email?: string } = { name: 'Alice' }, returnTo = '/') {
    const sid = 'sid-' + sub
    pit.signedIn.set(sid, { sub, ...who })
    const begin = await req('/auth/bridge?returnTo=' + encodeURIComponent(returnTo))
    if (begin.status !== 302) throw new Error('begin ' + begin.status)
    const atHost = await pit.host.authorize(new Request(begin.headers.get('location')!, { headers: { cookie: `pw=${sid}` } }))
    const callback = atHost.headers.get('location')!
    return req(callback)
  }
  return { store, app, pit, req, formPost, signIn, jar, origin, name }
}
