import { describe, expect, test } from 'bun:test'
import { bridgeSecret } from '../src/bridge.ts'
import { SESSION_COOKIE, SKIP_COOKIE, STATE_COOKIE } from '../src/server.ts'
import { harness } from './harness.ts'

describe('bridge', () => {
  test('client secret derivation: base64url(HMAC-SHA256(key, clientId)), no padding', () => {
    // The vector pit.world checked in Bun and Python.
    expect(bridgeSecret('k', 'social.family.ancestry.pit.world')).toBe('PHm4YitxYG7pa8OtIg2tcoNANN-H1yNujUPpReOBO9A')
    expect(bridgeSecret('k', 'social.family.ancestry.pit.world')).not.toContain('=')
    expect(bridgeSecret('k', 'social.seo.rank.pit.world')).not.toBe(bridgeSecret('k', 'social.family.ancestry.pit.world'))
  })

  test('sign in end to end against an in-process bridge host', async () => {
    const h = harness()
    const begin = await h.req('/auth/bridge?returnTo=%2Fabout')
    expect(begin.status).toBe(302)
    const loc = new URL(begin.headers.get('location')!)
    expect(loc.origin + loc.pathname).toBe('https://pit.world/bridge/authorize')
    expect(loc.searchParams.get('client_id')).toBe('social.family.ancestry.pit.world')
    expect(loc.searchParams.get('redirect_uri')).toBe('https://social.family.ancestry.pit.world/auth/bridge/callback')
    const stateCookie = begin.headers.getSetCookie().find((c) => c.startsWith(STATE_COOKIE + '='))!
    expect(stateCookie).toMatch(/HttpOnly/i)
    expect(stateCookie).toMatch(/Secure/i)
    expect(stateCookie).toMatch(/SameSite=Lax/i)

    const done = await h.signIn('did:key:z6MkAlice', { name: 'Alice', email: 'a@example.com' }, '/about')
    expect(done.status).toBe(302)
    expect(done.headers.get('location')).toBe('/about')
    expect(h.jar.get(SESSION_COOKIE)).toBeTruthy()
    const me = await (await h.req('/api/v1/me')).json()
    expect(me).toMatchObject({ sub: 'did:key:z6MkAlice', name: 'Alice', community: 'family.ancestry' })
    expect(await (await h.req('/')).text()).toContain('Alice')

    // Signing out ends it, and does not silently sign back in.
    const out = await h.formPost('/signout', {})
    expect(out.status).toBe(302)
    expect(h.jar.get(SKIP_COOKIE)).toBe('1')
    expect((await h.req('/api/v1/me')).status).toBe(401)
  })

  test('one user per sub across communities; email never links', async () => {
    const a = harness()
    await a.signIn('did:key:z6MkBob', { name: 'Bob', email: 'shared@example.com' })
    await a.signIn('did:key:z6MkEve', { name: 'Eve', email: 'shared@example.com' })
    expect(a.store.user('did:key:z6MkBob')!.name).toBe('Bob')
    expect(a.store.user('did:key:z6MkEve')!.name).toBe('Eve')
    // A session made for one community does not work on another.
    const sid = a.jar.get(SESSION_COOKIE)!
    expect(a.store.sessionUser(sid, 'family.ancestry')?.sub).toBe('did:key:z6MkEve')
    expect(a.store.sessionUser(sid, 'seo.rank')).toBeNull()
  })

  test('a tampered code or missing state cookie does not sign in', async () => {
    const h = harness()
    h.pit.signedIn.set('s', { sub: 'did:key:z6MkMallory' })
    const begin = await h.req('/auth/bridge')
    const atHost = await h.pit.host.authorize(new Request(begin.headers.get('location')!, { headers: { cookie: 'pw=s' } }))
    const cb = new URL(atHost.headers.get('location')!)
    h.jar.delete(STATE_COOKIE)
    const res = await h.req(cb.pathname + cb.search)
    expect(res.status).toBe(400)
    expect(h.jar.get(SESSION_COOKIE)).toBeUndefined()
  })

  test('silent sign-in: tried once per browser session, login_required sets the skip cookie', async () => {
    const h = harness({ autoSignIn: true })
    const page = { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'user-agent': 'Mozilla/5.0' } }
    const first = await h.req('/t/genealogy', page)
    expect(first.status).toBe(302)
    expect(first.headers.get('location')).toBe('/auth/bridge?prompt=none&returnTo=%2Ft%2Fgenealogy')
    const begin = await h.req(first.headers.get('location')!, page)
    expect(new URL(begin.headers.get('location')!).searchParams.get('prompt')).toBe('none')
    expect(h.jar.get(SKIP_COOKIE)).toBe('1')
    // Signed out at pit.world: it answers login_required to our callback.
    const atHost = await h.pit.host.authorize(new Request(begin.headers.get('location')!))
    const cb = new URL(atHost.headers.get('location')!)
    expect(cb.searchParams.get('error')).toBe('login_required')
    const back = await h.req(cb.pathname + cb.search, page)
    expect(back.status).toBe(302)
    expect(back.headers.get('location')).toBe('/t/genealogy')
    // No loop: the next page just renders.
    expect((await h.req('/t/genealogy', page)).status).toBe(200)
    // Bots and API calls are never bounced.
    const bot = harness({ autoSignIn: true })
    expect((await bot.req('/', { headers: { accept: 'text/html', 'user-agent': 'Googlebot/2.1' } })).status).toBe(200)
    expect((await bot.req('/api/v1/feed')).status).toBe(200)
  })

  test('silent sign-in succeeds when signed in at pit.world', async () => {
    const h = harness({ autoSignIn: true })
    h.pit.signedIn.set('s', { sub: 'did:key:z6MkSilent', name: 'Quiet' })
    const page = { headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0' } }
    const begin = await h.req((await h.req('/', page)).headers.get('location')!, page)
    const atHost = await h.pit.host.authorize(new Request(begin.headers.get('location')!, { headers: { cookie: 'pw=s' } }))
    const cb = new URL(atHost.headers.get('location')!)
    expect((await h.req(cb.pathname + cb.search, page)).headers.get('location')).toBe('/')
    expect(await (await h.req('/', page)).text()).toContain('Quiet')
  })
})
