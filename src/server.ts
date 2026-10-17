/**
 * pit-social: the service behind social.<name>.pit.world, one process for every name.
 *
 *   bun src/server.ts     PORT (8794), HOST (127.0.0.1), PIT_SOCIAL_DATA_DIR,
 *                         PIT_BRIDGE_KEY, PIT_SOCIAL_ADMINS, PIT_SOCIAL_RELAYS,
 *                         PIT_SOCIAL_INGEST=off, PIT_SOCIAL_RETENTION_DAYS, PIT_SOCIAL_CAP
 */
import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Store, newId, type Community, type LocalPost, type User } from './db.js'
import { Bridges, bridgeConfigFromEnv } from './bridge.js'
import { Ingestor, relaysFromEnv, relayLabel } from './ingest.js'
import { HandleResolver, fetchListing, type Listing } from './lookup.js'
import { didFor, feedUriFor, originFor, resolveRequest } from './names.js'
import { defaultTags, normalizeTag, parseTagList, tagFacets, tagsInText } from './tags.js'
import * as html from './html.js'

export const SESSION_COOKIE = 'ps_session'
export const CSRF_COOKIE = 'ps_csrf'
export const STATE_COOKIE = 'ps_bridge_state'
export const SKIP_COOKIE = 'ps_bridge_skip'
export const MAX_POST = 3000
const SESSION_TTL = 30 * 24 * 60 * 60_000
const LISTING_REFRESH = 7 * 24 * 60 * 60_000

type Vars = { name: string; community: Community; user: User | null; via: 'session' | 'token' | null; csrf: string; ip: string; https: boolean; form: Record<string, unknown> | null }
type Env = { Bindings: { peer?: string }; Variables: Vars }
type C = Context<Env>

export type AppOptions = {
  store: Store
  bridges?: Bridges | null
  /** Bridge subs who are admins of every community (PIT_SOCIAL_ADMINS). */
  admins?: string[]
  ingest?: Ingestor | null
  relays?: string[]
  listing?: (name: string) => Promise<Listing | null>
  handles?: HandleResolver
  /** Try silent sign-in once per browser session (default on). */
  autoSignIn?: boolean
  /** Posts per user per hour (default 30). */
  postsPerHour?: number
}

/** A local path to come back to, or "/". */
export const safeReturn = (value: unknown): string => {
  const v = String(value ?? '')
  return v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') && v.length <= 500 && !/[\r\n]/.test(v) ? v : '/'
}

const BOT = /bot|crawl|spider|slurp|feed|rss|curl|wget|python|go-http|monitor|preview|facebookexternalhit|embed/i

export function createApp(o: AppOptions) {
  const { store } = o
  const admins = new Set(o.admins ?? [])
  const relays = o.relays ?? relaysFromEnv()
  const handles = o.handles ?? new HandleResolver(store)
  const listing = o.listing ?? ((name: string) => fetchListing(name))
  const postsPerHour = o.postsPerHour ?? 30
  const autoSignIn = o.autoSignIn ?? true
  const app = new Hono<Env>()

  const refreshListing = (name: string) =>
    listing(name)
      .then((l) => {
        store.setListing(name, l?.description ?? null)
        const c = store.community(name)
        if (c && c.tags_source === 'auto') store.setTags(name, defaultTags(name, l), 'auto')
      })
      .catch(() => {})

  // Health answers for any Host: install.sh checks it on 127.0.0.1.
  app.get('/health', (c) => c.json({ ok: true, version: html.VERSION }))

  app.get('/style.css', async () => {
    const file = Bun.file(join(import.meta.dir, '..', 'public', 'style.css'))
    return new Response(file, { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable' } })
  })

  app.use('*', async (c, next) => {
    const r = resolveRequest(c.req.raw.headers, c.env?.peer, c.req.url)
    if (!r) return c.text('not found', 404)
    c.set('name', r.name)
    c.set('ip', r.ip)
    c.set('https', r.proto === 'https')
    const { community, created } = store.ensureCommunity(r.name, () => defaultTags(r.name))
    if (created || (community.tags_source === 'auto' && Date.now() - (community.listing_checked_at ?? 0) > LISTING_REFRESH)) {
      store.setListing(r.name, community.description)
      void refreshListing(r.name)
    }
    c.set('community', store.community(r.name) ?? community)

    const bearer = c.req.header('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1]
    const tokenUser = bearer ? store.tokenUser(bearer) : null
    const sessionUser = tokenUser ? null : store.sessionUser(getCookie(c, SESSION_COOKIE), r.name)
    c.set('user', tokenUser ?? sessionUser)
    c.set('via', tokenUser ? 'token' : sessionUser ? 'session' : null)
    c.set('form', null)

    let csrf = getCookie(c, CSRF_COOKIE)
    if (!csrf || !/^[A-Za-z0-9_-]{16,64}$/.test(csrf)) {
      csrf = newId(16)
      setCookie(c, CSRF_COOKIE, csrf, { path: '/', httpOnly: true, sameSite: 'Lax', secure: c.get('https'), maxAge: 60 * 60 * 24 * 365 })
    }
    c.set('csrf', csrf)

    // Cross-site writes are refused. A bearer token is never sent by a browser on its own, so it is exempt.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.get('via') !== 'token') {
      const fetchSite = c.req.header('sec-fetch-site')
      if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return c.text('cross-site request refused', 403)
      const type = c.req.header('content-type') ?? ''
      if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
        const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>
        c.set('form', body)
        if (body._csrf !== csrf) return c.html(html.messagePage(ctx(c), 'That form expired', 'Go back, reload the page and try again.'), 403)
      } else {
        const origin = c.req.header('origin')
        let originHost: string | null = null
        try {
          originHost = origin ? new URL(origin).host : null
        } catch {}
        if (!origin || originHost !== new URL(originFor(r.name)).host) return c.json({ error: 'cross-site request refused' }, 403)
      }
    }

    // Silent sign-in, once per browser session, for people who navigate to a page.
    if (shouldTrySilent(c)) return c.redirect('/auth/bridge?prompt=none&returnTo=' + encodeURIComponent(safeReturn(new URL(c.req.url).pathname + new URL(c.req.url).search)))

    await next()
    c.header('x-content-type-options', 'nosniff')
    c.header('referrer-policy', 'strict-origin-when-cross-origin')
    if ((c.res.headers.get('content-type') ?? '').includes('text/html')) {
      c.header('x-frame-options', 'DENY')
      c.header('content-security-policy', "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
      c.header('cache-control', 'no-store')
    }
  })

  function shouldTrySilent(c: C): boolean {
    if (!autoSignIn || !o.bridges || c.get('user') || c.req.method !== 'GET') return false
    if (getCookie(c, SKIP_COOKIE)) return false
    const path = new URL(c.req.url).pathname
    if (!(path === '/' || path === '/about' || /^\/(t|p|u)\//.test(path))) return false
    if (!(c.req.header('accept') ?? '').includes('text/html')) return false
    const mode = c.req.header('sec-fetch-mode')
    if (mode && mode !== 'navigate') return false
    return !BOT.test(c.req.header('user-agent') ?? '')
  }

  const ctx = (c: C, extra: Partial<html.Ctx> = {}): html.Ctx => ({
    name: c.get('name'),
    user: c.get('user'),
    csrf: c.get('csrf'),
    admin: isAdmin(c),
    flash: c.req.query('ok') ?? null,
    signInUrl: '/auth/bridge?returnTo=' + encodeURIComponent(safeReturn(new URL(c.req.url).pathname)),
    ...extra,
  })
  const isGlobalAdmin = (c: C) => !!c.get('user') && admins.has(c.get('user')!.sub)
  const isAdmin = (c: C) => isGlobalAdmin(c) || (!!c.get('user') && store.membership(c.get('name'), c.get('user')!.sub)?.role === 'admin')
  const form = async (c: C): Promise<Record<string, any>> => (c.get('form') as any) ?? ((await c.req.parseBody().catch(() => ({}))) as any)
  const skip = (c: C) => setCookie(c, SKIP_COOKIE, '1', { path: '/', httpOnly: true, sameSite: 'Lax', secure: c.get('https') })
  const needUser = (c: C) => (c.get('user') ? null : c.redirect('/auth/bridge?returnTo=' + encodeURIComponent(safeReturn(c.req.header('referer') ? new URL(c.req.header('referer')!).pathname : '/'))))

  // ---- sign in with pit.world ---------------------------------------------------

  app.get('/auth/bridge', async (c) => {
    if (!o.bridges) return c.html(html.messagePage(ctx(c), 'Sign-in is not set up', 'This server has no PIT_BRIDGE_KEY yet.'), 503)
    const prompt = c.req.query('prompt') === 'none' ? 'none' : 'login'
    const returnTo = safeReturn(c.req.query('returnTo'))
    const begun = await o.bridges.forName(c.get('name')).begin({ returnTo, prompt })
    setCookie(c, STATE_COOKIE, begun.cookie, { path: '/auth/bridge', httpOnly: true, secure: true, sameSite: 'Lax', maxAge: begun.maxAge })
    if (prompt === 'none') skip(c)
    return c.redirect(begun.url)
  })

  app.get('/auth/bridge/callback', async (c) => {
    if (!o.bridges) return c.text('sign-in is not set up', 503)
    const result = await o.bridges.forName(c.get('name')).complete(new URL(c.req.url).searchParams, getCookie(c, STATE_COOKIE))
    deleteCookie(c, STATE_COOKIE, { path: '/auth/bridge', secure: true })
    if (result.ok) {
      const user = store.upsertUser(result.user)
      setCookie(c, SESSION_COOKIE, store.createSession(user.sub, c.get('name'), SESSION_TTL), { path: '/', httpOnly: true, secure: c.get('https'), sameSite: 'Lax', maxAge: SESSION_TTL / 1000 })
      return c.redirect(safeReturn(result.returnTo))
    }
    if (result.prompt === 'none' || result.error === 'login_required') {
      skip(c)
      return c.redirect(safeReturn(result.returnTo))
    }
    return c.html(html.messagePage(ctx(c), 'Sign-in did not finish', `pit.world said: ${result.error}.`, `<p><a class="btn" href="/auth/bridge?returnTo=${encodeURIComponent(safeReturn(result.returnTo))}">Try again</a></p>`), 400)
  })

  app.post('/signout', (c) => {
    store.endSession(getCookie(c, SESSION_COOKIE))
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: c.get('https') })
    skip(c)
    return c.redirect('/')
  })

  // ---- posting ---------------------------------------------------------------------

  type PostResult = { post: LocalPost; error?: undefined; status?: undefined } | { error: string; status: 400 | 404 | 429; post?: undefined }
  function createPost(c: C, user: User, rawText: unknown, parentId: unknown): PostResult {
    const text = String(rawText ?? '').replace(/\r\n/g, '\n').trim()
    if (!text) return { error: 'write something first', status: 400 }
    if (text.length > MAX_POST) return { error: `posts are at most ${MAX_POST} characters`, status: 400 }
    let parent: LocalPost | null = null
    if (parentId) {
      parent = store.localPost(String(parentId))
      if (!parent || parent.community !== c.get('name') || parent.deleted) return { error: 'that post is gone', status: 404 }
      if (parent.parent_id) parent = store.localPost(parent.parent_id) ?? parent
    }
    if (store.postsSince(user.sub, Date.now() - 60 * 60_000) >= postsPerHour) return { error: `slow down: ${postsPerHour} posts an hour`, status: 429 }
    store.join(c.get('name'), user.sub)
    const now = Date.now()
    const facets = tagFacets(text)
    const post = store.createLocalPost({
      id: newId(9),
      community: c.get('name'),
      sub: user.sub,
      parent_id: parent?.id ?? null,
      // Shaped like app.bsky.feed.post so a later version can publish it from a PDS.
      record: { $type: 'app.bsky.feed.post', text, ...(facets.length ? { facets } : {}), createdAt: new Date(now).toISOString() },
      text,
      tags: tagsInText(text),
      created_at: now,
    })
    return { post }
  }

  app.post('/posts', async (c) => {
    const user = c.get('user')
    if (!user) return needUser(c)!
    const body = await form(c)
    const r = createPost(c, user, body.text, body.parent || null)
    if (!r.post) return c.html(html.messagePage(ctx(c), 'Not posted', r.error, '<p><a class="btn" href="/">Back to the feed</a></p>'), r.status)
    return c.redirect(r.post.parent_id ? `/p/${r.post.parent_id}` : `/p/${r.post.id}`)
  })

  app.post('/p/:id/delete', (c) => {
    const user = c.get('user')
    const p = store.localPost(c.req.param('id'))
    if (!user || !p || p.community !== c.get('name')) return c.html(html.messagePage(ctx(c), 'Not found', 'No such post.'), 404)
    if (p.sub !== user.sub && !isAdmin(c)) return c.html(html.messagePage(ctx(c), 'Not allowed', 'You can delete only your own posts.'), 403)
    store.deleteLocalPost(p.id)
    return c.redirect(p.parent_id ? `/p/${p.parent_id}?ok=Deleted` : '/?ok=Deleted')
  })

  app.post('/p/:id/report', async (c) => {
    const user = c.get('user')
    const p = store.localPost(c.req.param('id'))
    if (!user || !p || p.community !== c.get('name')) return c.html(html.messagePage(ctx(c), 'Not found', 'No such post.'), 404)
    store.report(p.id, user.sub, String((await form(c)).reason ?? '') || null)
    return c.redirect(`/p/${p.parent_id ?? p.id}?ok=${encodeURIComponent('Reported. An admin will look at it.')}`)
  })

  // ---- pages -----------------------------------------------------------------------

  const intParam = (v: string | undefined) => (v && /^\d{1,16}$/.test(v) ? Number(v) : null)

  function feedItems(c: C, tab: 'all' | 'network' | 'members', tag: string | null, limit = 30) {
    const name = c.get('name')
    const before = intParam(c.req.query('before'))
    const cursor = intParam(c.req.query('cursor'))
    let items: html.FeedItem[] = []
    let more: string | null = null
    const q = (extra: Record<string, string>) => '?' + new URLSearchParams({ ...(tab === 'all' ? {} : { tab }), ...extra }).toString()
    if (tab === 'network') {
      const posts = store.networkFeed(name, { before: cursor, tag, limit })
      items = posts.map((p) => ({ kind: 'network', at: p.indexed_at, post: p }))
      if (posts.length === limit) more = q({ cursor: String(posts.at(-1)!.seq) })
    } else if (tab === 'members') {
      const posts = store.localFeed(name, { before, tag, limit, all: isAdmin(c) })
      items = posts.map((p) => ({ kind: 'local', at: p.created_at, post: p }))
      if (posts.length === limit) more = q({ before: String(posts.at(-1)!.created_at) })
    } else {
      const net = store.networkFeed(name, { beforeTime: before, tag, limit })
      const loc = store.localFeed(name, { before, tag, limit, all: isAdmin(c) })
      items = [...net.map((p) => ({ kind: 'network' as const, at: p.indexed_at, post: p })), ...loc.map((p) => ({ kind: 'local' as const, at: p.created_at, post: p }))].sort((a, b) => b.at - a.at).slice(0, limit)
      if (items.length === limit) more = q({ before: String(items.at(-1)!.at) })
    }
    return { items, more }
  }

  const tabOf = (c: C) => (['network', 'members'].includes(c.req.query('tab') ?? '') ? (c.req.query('tab') as 'network' | 'members') : 'all')

  function renderFeed(c: C, tag: string | null) {
    const tab = tabOf(c)
    const { items, more } = feedItems(c, tab, tag)
    const dids = items.flatMap((i) => (i.kind === 'network' ? [i.post.did] : []))
    return c.html(html.feedPage(ctx(c), c.get('community'), { tab, tag, items, handles: handles.lookup(dids), more: more && (tag ? `/t/${encodeURIComponent(tag)}${more}` : `/${more}`) }))
  }

  app.get('/', (c) => renderFeed(c, null))
  app.get('/t/:tag', (c) => {
    const tag = normalizeTag(decodeURIComponent(c.req.param('tag')))
    return tag ? renderFeed(c, tag) : c.html(html.messagePage(ctx(c), 'Not a tag', 'That is not a hashtag we can follow.'), 404)
  })

  app.get('/p/:id', (c) => {
    const p = store.localPost(c.req.param('id'))
    if (!p || p.community !== c.get('name') || p.deleted || (p.hidden && !isAdmin(c))) return c.html(html.messagePage(ctx(c), 'Not found', 'That post is not here, or it was deleted.'), 404)
    const parent = p.parent_id ? store.localPost(p.parent_id) : null
    return c.html(html.postPage(ctx(c), p, store.replies(p.id), parent))
  })

  app.get('/u/:short', (c) => {
    const u = store.userByShort(c.req.param('short'))
    if (!u) return c.html(html.messagePage(ctx(c), 'Not found', 'Nobody by that id here.'), 404)
    return c.html(html.userPage(ctx(c), u, store.localFeed(c.get('name'), { sub: u.sub, limit: 50 }), store.membership(c.get('name'), u.sub)?.role ?? null))
  })

  app.get('/about', (c) => c.html(html.aboutPage(ctx(c), c.get('community'), relays)))

  const statusData = (c: C): html.StatusData => {
    const configured = new Set(relays)
    return {
      ingest: !!o.ingest,
      relays: store.relayState().filter((r) => configured.has(r.url)),
      tags: c.get('community').tags,
      networkPosts: store.networkCount(c.get('name')),
      localPosts: store.localCount(c.get('name')),
    }
  }
  app.get('/status', (c) => c.html(html.statusPage(ctx(c), statusData(c))))

  // ---- admin -----------------------------------------------------------------------

  const needAdmin = (c: C) => (!c.get('user') ? needUser(c) : isAdmin(c) ? null : c.html(html.messagePage(ctx(c), 'Not allowed', 'Only this community\'s admins can do that.'), 403))

  app.get('/admin', (c) => needAdmin(c) ?? c.html(html.adminPage(ctx(c), c.get('community'), { queue: store.moderationQueue(c.get('name')), members: store.members(c.get('name')), global: isGlobalAdmin(c) })))
  app.post('/admin/tags', async (c) => {
    const denied = needAdmin(c)
    if (denied) return denied
    store.setTags(c.get('name'), parseTagList((await form(c)).tags), 'admin')
    return c.redirect('/admin?ok=Tags%20saved')
  })
  app.post('/admin/tags/reset', async (c) => {
    const denied = needAdmin(c)
    if (denied) return denied
    store.setTags(c.get('name'), defaultTags(c.get('name')), 'auto')
    await refreshListing(c.get('name'))
    return c.redirect('/admin?ok=Tags%20reset')
  })
  app.post('/admin/hide', async (c) => {
    const denied = needAdmin(c)
    if (denied) return denied
    const body = await form(c)
    const p = store.localPost(String(body.id ?? ''))
    if (!p || p.community !== c.get('name')) return c.html(html.messagePage(ctx(c), 'Not found', 'No such post.'), 404)
    store.setHidden(p.id, body.hidden !== '0')
    return c.redirect('/admin?ok=Saved')
  })
  app.post('/admin/role', async (c) => {
    if (!isGlobalAdmin(c)) return c.html(html.messagePage(ctx(c), 'Not allowed', 'Only global admins can make community admins.'), 403)
    const body = await form(c)
    const sub = String(body.sub ?? '').trim()
    if (!sub || sub.length > 300) return c.redirect('/admin')
    store.upsertUser({ sub })
    store.setRole(c.get('name'), sub, body.role === 'member' ? 'member' : 'admin')
    return c.redirect('/admin?ok=Saved')
  })

  // ---- settings: API tokens ----------------------------------------------------------

  app.get('/settings', (c) => {
    const user = c.get('user')
    if (!user) return c.redirect('/auth/bridge?returnTo=%2Fsettings')
    return c.html(html.settingsPage(ctx(c), store.tokens(user.sub), null))
  })
  app.post('/settings/tokens', async (c) => {
    const user = c.get('user')
    if (!user || c.get('via') !== 'session') return c.redirect('/auth/bridge?returnTo=%2Fsettings')
    if (store.tokens(user.sub).length >= 20) return c.html(html.settingsPage(ctx(c, { error: 'At most 20 tokens; revoke one first.' }), store.tokens(user.sub), null), 400)
    const { token } = store.createToken(user.sub, String((await form(c)).label ?? '') || null)
    return c.html(html.settingsPage(ctx(c), store.tokens(user.sub), token))
  })
  app.post('/settings/tokens/:id/revoke', (c) => {
    const user = c.get('user')
    if (!user) return c.redirect('/auth/bridge?returnTo=%2Fsettings')
    store.revokeToken(user.sub, c.req.param('id'))
    return c.redirect('/settings?ok=Revoked')
  })

  // ---- AT Protocol: this community as a feed generator --------------------------------

  const open = (c: C) => c.header('access-control-allow-origin', '*')

  app.get('/.well-known/did.json', (c) => {
    open(c)
    return c.json({ '@context': ['https://www.w3.org/ns/did/v1'], id: didFor(c.get('name')), service: [{ id: '#bsky_fg', type: 'BskyFeedGenerator', serviceEndpoint: originFor(c.get('name')) }] })
  })
  app.get('/xrpc/app.bsky.feed.describeFeedGenerator', (c) => {
    open(c)
    return c.json({ did: didFor(c.get('name')), feeds: [{ uri: feedUriFor(c.get('name')) }], links: { privacyPolicy: originFor(c.get('name')) + '/about', termsOfService: originFor(c.get('name')) + '/about' } })
  })
  app.get('/xrpc/app.bsky.feed.getFeedSkeleton', (c) => {
    open(c)
    if (c.req.query('feed') !== feedUriFor(c.get('name'))) return c.json({ error: 'UnsupportedAlgorithm', message: 'this host serves one feed: ' + feedUriFor(c.get('name')) }, 400)
    const limitRaw = Number(c.req.query('limit') ?? 50)
    const limit = Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 100 ? limitRaw : 50
    const cursorRaw = c.req.query('cursor')
    if (cursorRaw !== undefined && !/^\d{1,16}$/.test(cursorRaw)) return c.json({ error: 'InvalidRequest', message: 'bad cursor' }, 400)
    const posts = store.networkFeed(c.get('name'), { before: cursorRaw ? Number(cursorRaw) : null, limit })
    return c.json({ feed: posts.map((p) => ({ post: p.uri })), ...(posts.length === limit ? { cursor: String(posts.at(-1)!.seq) } : {}) })
  })

  // ---- RSS + API -----------------------------------------------------------------------

  const itemJson = (i: html.FeedItem, handleMap: Map<string, string>) =>
    i.kind === 'network'
      ? { kind: 'network', id: i.post.uri, uri: i.post.uri, cid: i.post.cid, text: i.post.text, author: { did: i.post.did, handle: handleMap.get(i.post.did) ?? null }, createdAt: i.post.created_at, indexedAt: new Date(i.post.indexed_at).toISOString(), tags: i.post.tags, langs: i.post.langs, relays: i.post.relays, embed: i.post.embed, url: html.bskyUrl(i.post.uri), cursor: String(i.post.seq ?? '') }
      : { kind: 'local', id: i.post.id, text: i.post.text, author: { sub: i.post.sub, name: html.displayName(i.post.author) }, createdAt: new Date(i.post.created_at).toISOString(), tags: i.post.tags, replies: i.post.replies ?? 0, record: i.post.record, url: originFor(i.post.community) + '/p/' + i.post.id }

  app.get('/feed.xml', (c) => {
    const { items } = feedItems(c, 'all', normalizeTag(c.req.query('tag') ?? ''), 50)
    const handleMap = handles.lookup(items.flatMap((i) => (i.kind === 'network' ? [i.post.did] : [])))
    const origin = originFor(c.get('name'))
    const x = html.esc
    const entries = items
      .map((i) => {
        const j = itemJson(i, handleMap) as any
        const who = j.kind === 'network' ? (j.author.handle ? '@' + j.author.handle : j.author.did) : j.author.name
        const title = (who + ': ' + j.text.replace(/\s+/g, ' ')).slice(0, 120)
        return '<item><title>' + x(title) + '</title><link>' + x(j.url) + '</link><guid isPermaLink="false">' + x(j.id) + '</guid><pubDate>' + new Date(i.at).toUTCString() + '</pubDate><description>' + x(j.text) + '</description></item>'
      })
      .join('\n')
    const body = '<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0"><channel><title>' + x(c.get('name')) + ' social</title><link>' + x(origin) + '/</link><description>' + x('Members and the AT Protocol network on ' + c.get('community').tags.map((t) => '#' + t).join(' ')) + '</description>\n' + entries + '\n</channel></rss>\n'
    return new Response(body, { headers: { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'public, max-age=120' } })
  })

  app.get('/api/v1/feed', (c) => {
    open(c)
    const tab = tabOf(c)
    const limit = Math.max(1, Math.min(Number(c.req.query('limit') ?? 30) || 30, 100))
    const tag = c.req.query('tag') ? normalizeTag(c.req.query('tag')) : null
    const { items, more } = feedItems(c, tab, tag, limit)
    const handleMap = handles.lookup(items.flatMap((i) => (i.kind === 'network' ? [i.post.did] : [])))
    return c.json({ community: c.get('name'), tab, tag, tags: c.get('community').tags, items: items.map((i) => itemJson(i, handleMap)), next: more ? '/api/v1/feed' + more + (c.req.query('limit') ? '&limit=' + limit : '') : null })
  })
  app.get('/api/v1/tags', (c) => {
    open(c)
    return c.json({ community: c.get('name'), tags: c.get('community').tags, source: c.get('community').tags_source })
  })
  app.get('/api/v1/status', (c) => {
    open(c)
    const s = statusData(c)
    return c.json({ community: c.get('name'), version: html.VERSION, ingest: s.ingest, tags: s.tags, networkPosts: s.networkPosts, localPosts: s.localPosts, relays: s.relays.map((r) => ({ url: r.url, label: relayLabel(r.url), kind: r.kind, state: r.state, updatedAt: new Date(r.updated_at).toISOString(), ...r.stats })) })
  })
  app.get('/api/v1/me', (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'sign in first, or send Authorization: Bearer ps_...' }, 401)
    return c.json({ sub: user.sub, name: user.name, username: user.username, community: c.get('name'), member: !!store.membership(c.get('name'), user.sub), admin: isAdmin(c) })
  })
  app.post('/api/v1/posts', async (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'send Authorization: Bearer ps_... (make one at /settings)' }, 401)
    const body = (await c.req.json().catch(() => ({}))) as any
    const r = createPost(c, user, body.text, body.reply_to ?? body.parent ?? null)
    if (!r.post) return c.json({ error: r.error }, r.status)
    return c.json(itemJson({ kind: 'local', at: r.post.created_at, post: r.post }, new Map()), 201)
  })
  app.get('/api/v1/posts/:id', (c) => {
    const p = store.localPost(c.req.param('id'))
    if (!p || p.community !== c.get('name') || p.deleted || p.hidden) return c.json({ error: 'not found' }, 404)
    return c.json({ ...itemJson({ kind: 'local', at: p.created_at, post: p }, new Map()), replies: store.replies(p.id).map((r) => itemJson({ kind: 'local', at: r.created_at, post: r }, new Map())) })
  })
  app.delete('/api/v1/posts/:id', (c) => {
    const user = c.get('user')
    const p = store.localPost(c.req.param('id'))
    if (!user) return c.json({ error: 'unauthorized' }, 401)
    if (!p || p.community !== c.get('name') || p.deleted) return c.json({ error: 'not found' }, 404)
    if (p.sub !== user.sub && !isAdmin(c)) return c.json({ error: 'you can delete only your own posts' }, 403)
    store.deleteLocalPost(p.id)
    return c.json({ ok: true })
  })

  app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /auth/\nDisallow: /admin\nDisallow: /settings\n'))

  app.notFound((c) => (c.req.path.startsWith('/api/') || c.req.path.startsWith('/xrpc/') ? c.json({ error: 'not found' }, 404) : c.html(html.messagePage(ctx(c as C), 'Not found', 'Nothing at this address.'), 404)))

  return app
}

export const dataDir = () => process.env.PIT_SOCIAL_DATA_DIR ?? join(homedir(), '.local', 'share', 'pit-social')

/** Run the server: one process for every social.<name>.pit.world. */
export function serve(opts: { port?: number; host?: string } = {}) {
  const store = new Store(join(dataDir(), 'pit-social.db'))
  const relays = relaysFromEnv()
  const config = bridgeConfigFromEnv()
  if (!config) console.warn('[pit-social] PIT_BRIDGE_KEY is not set: sign-in is off')
  const ingest = process.env.PIT_SOCIAL_INGEST === 'off' ? null : new Ingestor({ store, relays, maxLagMs: Number(process.env.PIT_SOCIAL_MAX_LAG_S ?? 120) * 1000 }).start()
  const app = createApp({
    store,
    bridges: config ? new Bridges(config) : null,
    admins: (process.env.PIT_SOCIAL_ADMINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    ingest,
    relays,
    autoSignIn: process.env.PIT_SOCIAL_BRIDGE_AUTO !== 'off',
    postsPerHour: Number(process.env.PIT_SOCIAL_POSTS_PER_HOUR ?? 30) || 30,
  })
  const retentionDays = Number(process.env.PIT_SOCIAL_RETENTION_DAYS ?? 30) || 30
  const cap = Number(process.env.PIT_SOCIAL_CAP ?? 20_000) || 20_000
  const prune = () => {
    try {
      const { removed } = store.prune({ maxAgeMs: retentionDays * 86_400_000, cap })
      if (removed) console.log(`[pit-social] pruned ${removed} network posts`)
    } catch (error) {
      console.error('[pit-social] prune failed', error)
    }
  }
  prune()
  setInterval(prune, 60 * 60_000)
  const port = opts.port ?? Number(process.env.PORT ?? 8794)
  const hostname = opts.host ?? process.env.HOST ?? '127.0.0.1'
  const server = Bun.serve({ port, hostname, fetch: (req, srv) => app.fetch(req, { peer: srv.requestIP(req)?.address }) })
  console.log(`[pit-social] ${html.VERSION} on http://${hostname}:${server.port}, data in ${dataDir()}, ingest ${ingest ? 'on' : 'off'}`)
  const shutdown = () => {
    ingest?.stop()
    server.stop()
    store.close()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  return { server, store, ingest }
}

if (import.meta.main) serve()
