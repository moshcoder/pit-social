import { describe, expect, test } from 'bun:test'
import { toNetworkPost } from '../src/ingest.ts'
import { CSRF_COOKIE } from '../src/server.ts'
import { DID_A } from './fake-relays.ts'
import { harness } from './harness.ts'

const net = (rkey: string, text: string, tags: string[], at = Date.now()) => toNetworkPost({ type: 'create', uri: `at://${DID_A}/app.bsky.feed.post/${rkey}`, cid: 'bafy' + rkey, did: DID_A, record: { text, createdAt: new Date(at).toISOString() }, time: at }, tags, 'bsky.network', at)

describe('server', () => {
  test('health, lazy community creation, headers', async () => {
    const h = harness()
    expect(await (await h.app.request('http://127.0.0.1:8794/health')).json()).toMatchObject({ ok: true })
    expect(h.store.community('family.ancestry')).toBeNull()
    const home = await h.req('/')
    expect(home.status).toBe(200)
    expect(home.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(home.headers.get('x-frame-options')).toBe('DENY')
    const c = h.store.community('family.ancestry')!
    expect(c.tags).toContain('genealogy')
    const body = await home.text()
    expect(body).toContain('Sign in with pit.world')
    expect(body).toContain('https://pit.world/account')
    expect(body).toContain('https://bbs.family.ancestry.pit.world')
  })

  test('unknown hosts are 404; spoofed X-Pit-Name from a non-loopback peer is ignored', async () => {
    const h = harness()
    expect((await h.req('https://example.com/')).status).toBe(404)
    expect((await h.req('https://social.ancestry.pit.world/')).status).toBe(404)
    // A stranger asks for seo.rank through the family.ancestry host: they get family.ancestry.
    const spoof = await h.req('/api/v1/tags', { headers: { 'x-pit-name': 'seo.rank' } }, '198.51.100.20')
    expect((await spoof.json()).community).toBe('family.ancestry')
    expect(h.store.community('seo.rank')).toBeNull()
    // The same header from loopback (pit.world) is believed.
    const front = await h.req('http://127.0.0.1:8794/api/v1/tags', { headers: { 'x-pit-name': 'seo.rank', 'x-forwarded-proto': 'https' } }, '127.0.0.1')
    expect((await front.json()).community).toBe('seo.rank')
    // ...but not from a stranger with a bare IP host.
    expect((await h.req('http://127.0.0.1:8794/api/v1/tags', { headers: { 'x-pit-name': 'seo.rank' } }, '198.51.100.20')).status).toBe(404)
  })

  test('posting, replies, delete, rate limit', async () => {
    const h = harness({ postsPerHour: 3 })
    await h.req('/')
    expect((await h.formPost('/posts', { text: 'hi' })).status).toBe(302) // signed out: off to sign in
    expect(h.store.localCount('family.ancestry')).toBe(0)
    await h.signIn('did:key:z6MkAlice', { name: 'Alice' })
    const res = await h.formPost('/posts', { text: 'Found the 1880 census page! #Genealogy <script>x</script>' })
    expect(res.status).toBe(302)
    const id = res.headers.get('location')!.split('/p/')[1]!
    const p = h.store.localPost(id)!
    expect(p.tags).toEqual(['genealogy'])
    expect(p.record).toMatchObject({ $type: 'app.bsky.feed.post', text: 'Found the 1880 census page! #Genealogy <script>x</script>' })
    expect((p.record as any).facets[0].features[0]).toEqual({ $type: 'app.bsky.richtext.facet#tag', tag: 'Genealogy' })
    expect(h.store.membership('family.ancestry', 'did:key:z6MkAlice')?.role).toBe('member')
    const page = await (await h.req('/p/' + id)).text()
    expect(page).not.toContain('<script>x')
    expect(page).toContain('&lt;script&gt;')
    expect(page).toContain('href="/t/genealogy"')

    const reply = await h.formPost('/posts', { text: 'nice', parent: id })
    expect(reply.headers.get('location')).toBe('/p/' + id)
    expect(h.store.replies(id)).toHaveLength(1)
    expect((await h.formPost('/posts', { text: 'x'.repeat(3001) })).status).toBe(400)
    expect((await h.formPost('/posts', { text: 'third' })).status).toBe(302)
    expect((await h.formPost('/posts', { text: 'fourth, too many' })).status).toBe(429)

    // Only the author deletes.
    await h.signIn('did:key:z6MkBob', { name: 'Bob' })
    expect((await h.formPost(`/p/${id}/delete`, {})).status).toBe(403)
    await h.signIn('did:key:z6MkAlice', { name: 'Alice' })
    expect((await h.formPost(`/p/${id}/delete`, {})).status).toBe(302)
    expect((await h.req('/p/' + id)).status).toBe(404)
  })

  test('CSRF: missing token, cross-site fetch and foreign Origin are refused', async () => {
    const h = harness()
    await h.signIn()
    const noToken = await h.req('/posts', { method: 'POST', body: new URLSearchParams({ text: 'x' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    expect(noToken.status).toBe(403)
    const wrong = await h.req('/posts', { method: 'POST', body: new URLSearchParams({ text: 'x', _csrf: 'A'.repeat(22) }), headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    expect(wrong.status).toBe(403)
    expect((await h.formPost('/posts', { text: 'x' }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    const json = await h.req('/api/v1/posts', { method: 'POST', body: JSON.stringify({ text: 'x' }), headers: { 'content-type': 'application/json', origin: 'https://evil.example' } })
    expect(json.status).toBe(403)
    expect(h.store.localCount('family.ancestry')).toBe(0)
    expect(h.jar.get(CSRF_COOKIE)).toBeTruthy()
  })

  test('API tokens: made on /settings, hashed, post with Bearer', async () => {
    const h = harness()
    await h.signIn('did:key:z6MkAlice', { name: 'Alice' })
    const made = await (await h.formPost('/settings/tokens', { label: 'cli' })).text()
    const token = made.match(/ps_[A-Za-z0-9_-]+/)![0]
    expect(JSON.stringify(h.store.db.query('SELECT * FROM api_tokens').all())).not.toContain(token)
    const api = await h.app.request(h.origin + '/api/v1/posts', { method: 'POST', body: JSON.stringify({ text: 'from the CLI #seo' }), headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' } }, { peer: '203.0.113.1' })
    expect(api.status).toBe(201)
    const body = await api.json()
    expect(body).toMatchObject({ kind: 'local', text: 'from the CLI #seo', tags: ['seo'], author: { sub: 'did:key:z6MkAlice' } })
    expect((await h.app.request(h.origin + '/api/v1/posts', { method: 'POST', body: '{}', headers: { authorization: 'Bearer ps_nope_nope_nope_nope_nope', 'content-type': 'application/json' } }, { peer: '203.0.113.1' })).status).toBe(403)
  })

  test('feed mixes members and network posts, escapes the network, filters by tag and tab', async () => {
    const h = harness()
    await h.req('/')
    h.store.saveNetworkPosts([
      { post: net('n1', 'Old photo day #genealogy <img src=x onerror=alert(1)>', ['genealogy'], Date.now() - 5000), communities: ['family.ancestry'] },
      { post: net('n2', 'DNA results #ancestry', ['ancestry'], Date.now() - 4000), communities: ['family.ancestry'] },
    ])
    await h.signIn()
    await h.formPost('/posts', { text: 'member post #ancestry' })
    const all = await (await h.req('/')).text()
    expect(all).toContain('member post')
    expect(all).toContain('DNA results')
    expect(all).not.toContain('<img src=x')
    expect(all).toContain('From the AT Protocol network, via bsky.network')
    expect(all).toContain('https://bsky.app/profile/did%3Aplc%3Aaaaaaaaaaaaaaaaaaaaaaaaa/post/n2')
    const netTab = await (await h.req('/?tab=network')).text()
    expect(netTab).not.toContain('member post')
    const members = await (await h.req('/?tab=members')).text()
    expect(members).not.toContain('DNA results')
    const tag = await (await h.req('/t/genealogy')).text()
    expect(tag).toContain('Old photo day')
    expect(tag).not.toContain('DNA results')
    const api = await (await h.req('/api/v1/feed?tag=ancestry')).json()
    expect(api.items.map((i: any) => i.kind).sort()).toEqual(['local', 'network'])
    const rss = await (await h.req('/feed.xml')).text()
    expect(rss).toContain('<rss version="2.0">')
    expect(rss).not.toContain('<img')
  })

  test('feed generator: did.json, describeFeedGenerator, getFeedSkeleton with cursor', async () => {
    const h = harness()
    await h.req('/')
    for (let i = 1; i <= 5; i++) h.store.saveNetworkPosts([{ post: net('s' + i, '#genealogy ' + i, ['genealogy'], Date.now() + i), communities: ['family.ancestry'] }])
    const did = await (await h.req('/.well-known/did.json')).json()
    expect(did).toEqual({ '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:web:social.family.ancestry.pit.world', service: [{ id: '#bsky_fg', type: 'BskyFeedGenerator', serviceEndpoint: 'https://social.family.ancestry.pit.world' }] })
    const desc = await (await h.req('/xrpc/app.bsky.feed.describeFeedGenerator')).json()
    expect(desc.did).toBe('did:web:social.family.ancestry.pit.world')
    expect(desc.feeds).toEqual([{ uri: 'at://did:web:social.family.ancestry.pit.world/app.bsky.feed.generator/niche' }])
    const feed = encodeURIComponent(desc.feeds[0].uri)
    const page1 = await (await h.req(`/xrpc/app.bsky.feed.getFeedSkeleton?feed=${feed}&limit=2`)).json()
    expect(page1.feed).toEqual([{ post: `at://${DID_A}/app.bsky.feed.post/s5` }, { post: `at://${DID_A}/app.bsky.feed.post/s4` }])
    const page2 = await (await h.req(`/xrpc/app.bsky.feed.getFeedSkeleton?feed=${feed}&limit=2&cursor=${page1.cursor}`)).json()
    expect(page2.feed.map((f: any) => f.post.split('/').pop())).toEqual(['s3', 's2'])
    const page3 = await (await h.req(`/xrpc/app.bsky.feed.getFeedSkeleton?feed=${feed}&limit=2&cursor=${page2.cursor}`)).json()
    expect(page3.feed.map((f: any) => f.post.split('/').pop())).toEqual(['s1'])
    expect(page3.cursor).toBeUndefined()
    const wrong = await h.req('/xrpc/app.bsky.feed.getFeedSkeleton?feed=' + encodeURIComponent('at://did:web:social.seo.rank.pit.world/app.bsky.feed.generator/niche'))
    expect(wrong.status).toBe(400)
    expect((await wrong.json()).error).toBe('UnsupportedAlgorithm')
  })

  test('admin: env admins edit tags (max 30), hide reported posts, grant community admins; nobody else can', async () => {
    const h = harness({ admins: ['did:key:z6MkRoot'] })
    await h.signIn('did:key:z6MkAlice', { name: 'Alice' })
    const post = await h.formPost('/posts', { text: 'spam spam' })
    const id = post.headers.get('location')!.split('/p/')[1]!
    expect((await h.req('/admin')).status).toBe(403) // first sign-in is not admin
    expect((await h.formPost('/admin/tags', { tags: 'mine' })).status).toBe(403)
    await h.signIn('did:key:z6MkBob', { name: 'Bob' })
    await h.formPost(`/p/${id}/report`, { reason: 'spam' })
    expect(h.store.localPost(id)!.reports).toBe(1)

    await h.signIn('did:key:z6MkRoot', { name: 'Root' })
    const admin = await (await h.req('/admin')).text()
    expect(admin).toContain('spam spam')
    const many = Array.from({ length: 40 }, (_, i) => 'tag' + i).join('\n')
    await h.formPost('/admin/tags', { tags: '#Genealogy\n' + many })
    const c = h.store.community('family.ancestry')!
    expect(c.tags).toHaveLength(30)
    expect(c.tags[0]).toBe('genealogy')
    expect(c.tags_source).toBe('admin')
    await h.formPost('/admin/hide', { id, hidden: '1' })
    expect(h.store.localPost(id)!.hidden).toBe(1)
    expect(h.store.localFeed('family.ancestry')).toHaveLength(0)
    await h.formPost('/admin/role', { sub: 'did:key:z6MkAlice', role: 'admin' })
    await h.signIn('did:key:z6MkAlice', { name: 'Alice' })
    expect((await h.req('/admin')).status).toBe(200)
    expect((await h.formPost('/admin/role', { sub: 'did:key:z6MkBob', role: 'admin' })).status).toBe(403) // community admins cannot mint admins
  })

  test('status page and API', async () => {
    const h = harness()
    h.store.saveRelayState([{ url: 'wss://bsky.network', kind: 'firehose', state: 'open', stats: { label: 'bsky.network', eps: 412.5, matched: 3, lagMs: 800 } }])
    const s = await (await h.req('/api/v1/status')).json()
    expect(s.relays[0]).toMatchObject({ url: 'wss://bsky.network', state: 'open', eps: 412.5 })
    expect(await (await h.req('/status')).text()).toContain('bsky.network')
    expect(await (await h.req('/about')).text()).toContain('at://did:web:social.family.ancestry.pit.world/app.bsky.feed.generator/niche')
  })
})
