import { describe, expect, test } from 'bun:test'
import { Store } from '../src/db.ts'
import { Ingestor, Matcher, parseFirehose, parseJetstream, relayKind, subscribeUrl, summarizeEmbed, toNetworkPost, RelayError } from '../src/ingest.ts'
import { DID_A, DID_B, cidOf, errorFrame, fakeRelay, firehoseCommit, jetstreamCreate, jetstreamDelete, post } from './fake-relays.ts'

const until = async (fn: () => boolean, ms = 4000) => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await Bun.sleep(20)
  }
}

describe('wire formats', () => {
  test('relay kinds and subscribe URLs', () => {
    expect(relayKind('wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post')).toBe('jetstream')
    expect(relayKind('wss://bsky.network')).toBe('firehose')
    expect(subscribeUrl('wss://bsky.network')).toBe('wss://bsky.network/xrpc/com.atproto.sync.subscribeRepos')
    expect(subscribeUrl('wss://bsky.network', 42)).toBe('wss://bsky.network/xrpc/com.atproto.sync.subscribeRepos?cursor=42')
    expect(subscribeUrl('wss://j.example/subscribe?wantedCollections=app.bsky.feed.post', 7)).toBe('wss://j.example/subscribe?wantedCollections=app.bsky.feed.post&cursor=7')
  })

  test('jetstream create and delete', async () => {
    const rec = post('hello #seo')
    const out = parseJetstream(jetstreamCreate(DID_A, '3kabc', rec, await cidOf(rec), 1_700_000_000_000_000))
    expect(out.cursor).toBe(1_700_000_000_000_000)
    expect(out.events).toEqual([{ type: 'create', uri: `at://${DID_A}/app.bsky.feed.post/3kabc`, cid: await cidOf(rec), did: DID_A, record: rec, time: 1_700_000_000_000 }])
    expect(parseJetstream(jetstreamDelete(DID_A, '3kabc')).events[0]).toMatchObject({ type: 'delete', uri: `at://${DID_A}/app.bsky.feed.post/3kabc` })
    expect(parseJetstream(JSON.stringify({ did: 'not-a-did', kind: 'commit', commit: { collection: 'app.bsky.feed.post', operation: 'create', rkey: 'x', record: {} } })).events).toEqual([])
  })

  test('firehose commit: only post creates are decoded', async () => {
    const rec = post('a #genealogy find')
    const frame = await firehoseCommit(99, DID_B, [
      { path: 'app.bsky.feed.like/3klike', record: { $type: 'app.bsky.feed.like' } },
      { path: 'app.bsky.feed.post/3kpost', record: rec },
      { path: 'app.bsky.feed.post/3kgone', action: 'delete' },
    ])
    const out = parseFirehose(frame)
    expect(out.cursor).toBe(99)
    expect(out.events).toHaveLength(2)
    expect(out.events.find((e) => e.type === 'create')).toMatchObject({ uri: `at://${DID_B}/app.bsky.feed.post/3kpost`, cid: await cidOf(rec), record: { text: 'a #genealogy find' } })
    expect(out.events.find((e) => e.type === 'delete')).toMatchObject({ uri: `at://${DID_B}/app.bsky.feed.post/3kgone` })
    expect(() => parseFirehose(errorFrame('FutureCursor', 'cursor in the future'))).toThrow(RelayError)
  })

  test('embed summary never keeps media', () => {
    expect(summarizeEmbed({ $type: 'app.bsky.embed.images', images: [{}, {}] })).toEqual({ images: 2 })
    expect(summarizeEmbed({ $type: 'app.bsky.embed.external', external: { uri: 'javascript:alert(1)', title: 'x' } })).toBeNull()
    expect(summarizeEmbed({ $type: 'app.bsky.embed.recordWithMedia', record: { record: { uri: 'at://did:plc:x/app.bsky.feed.post/1' } }, media: { $type: 'app.bsky.embed.external', external: { uri: 'https://ex.test/a', title: 'A' } } })).toEqual({ external: { uri: 'https://ex.test/a', title: 'A' }, quote: 'at://did:plc:x/app.bsky.feed.post/1' })
  })

  test('matcher maps tags to communities', () => {
    const m = new Matcher(() => new Map([['seo', ['seo.rank']], ['genealogy', ['family.ancestry', 'gen.club']]]))
    expect(m.match(['genealogy', 'seo', 'cats']).sort()).toEqual(['family.ancestry', 'gen.club', 'seo.rank'])
    expect(m.match(['cats'])).toEqual([])
  })
})

describe('ingestor', () => {
  test('two relays at once: matched once, deduped by at-uri, both relays recorded, deletes honoured', async () => {
    const store = new Store(':memory:')
    store.ensureCommunity('family.ancestry', () => ['genealogy', 'ancestry'])
    store.ensureCommunity('seo.rank', () => ['seo'])
    const shared = post('Found my great-grandmother! #Genealogy')
    const seoOnly = post('crawl budget tips', { facets: [{ index: { byteStart: 0, byteEnd: 5 }, features: [{ $type: 'app.bsky.richtext.facet#tag', tag: 'SEO' }] }] })
    const nobody = post('my lunch #sandwich')
    const doomed = post('oops #ancestry')
    const sharedCid = await cidOf(shared)

    const jet = fakeRelay(async () => [jetstreamCreate(DID_A, '3kshared', shared, sharedCid), jetstreamCreate(DID_B, '3knobody', nobody, await cidOf(nobody)), jetstreamCreate(DID_B, '3kdoomed', doomed, await cidOf(doomed))])
    const fire = fakeRelay(async () => [
      await firehoseCommit(1, DID_A, [{ path: 'app.bsky.feed.post/3kshared', record: shared }]),
      await firehoseCommit(2, DID_B, [{ path: 'app.bsky.feed.post/3kseo', record: seoOnly }, { path: 'app.bsky.graph.follow/3kf', record: { $type: 'app.bsky.graph.follow' } }]),
    ])
    const jetUrl = `ws://127.0.0.1:${jet.port}/subscribe?wantedCollections=app.bsky.feed.post`
    const fireUrl = `ws://127.0.0.1:${fire.port}`
    const ing = new Ingestor({ store, relays: [jetUrl, fireUrl], flushMs: 30, log: () => {} }).start()
    try {
      await until(() => store.networkPost(`at://${DID_A}/app.bsky.feed.post/3kshared`)?.relays.length === 2 && !!store.networkPost(`at://${DID_B}/app.bsky.feed.post/3kseo`))
      const p = store.networkPost(`at://${DID_A}/app.bsky.feed.post/3kshared`)!
      expect(p.relays.sort()).toEqual([`127.0.0.1:${fire.port}`, `127.0.0.1:${jet.port}`].sort())
      expect(p.tags).toEqual(['genealogy'])
      expect(p.cid).toBe(sharedCid)
      expect(store.networkFeed('family.ancestry').map((x) => x.uri)).toContain(p.uri)
      expect(store.networkFeed('family.ancestry').filter((x) => x.uri === p.uri)).toHaveLength(1)
      expect(store.networkFeed('seo.rank').map((x) => x.uri)).toEqual([`at://${DID_B}/app.bsky.feed.post/3kseo`])
      expect(store.networkPost(`at://${DID_B}/app.bsky.feed.post/3knobody`)).toBeNull()
      expect(fire.urls[0]).toContain('/xrpc/com.atproto.sync.subscribeRepos')
      const stats = ing.stats()
      expect(stats.every((s) => s.state === 'open')).toBe(true)
      expect(stats.reduce((n, s) => n + s.firstSeen, 0)).toBe(3) // shared, doomed, seo: each stored once
      expect(ing.totals.duplicates).toBe(1)

      // The author deletes a post: it goes here too.
      const doomedUri = `at://${DID_B}/app.bsky.feed.post/3kdoomed`
      await until(() => !!store.networkPost(doomedUri))
      ing.accept({ stats: stats[0]! } as any, { type: 'delete', uri: doomedUri, time: Date.now() })
      ing.flush()
      expect(store.networkPost(doomedUri)).toBeNull()
    } finally {
      ing.stop()
      jet.stop()
      fire.stop()
    }
  })

  test('a dead relay does not stop the others; tag edits take effect live', async () => {
    const store = new Store(':memory:')
    store.ensureCommunity('seo.rank', () => ['seo'])
    const rec = post('new #serp feature')
    const live = fakeRelay(async () => [jetstreamCreate(DID_A, '3kserp', rec, await cidOf(rec))])
    const ing = new Ingestor({ store, relays: ['ws://127.0.0.1:1/subscribe', `ws://127.0.0.1:${live.port}/subscribe`], flushMs: 30, backoffMaxMs: 200, log: () => {} })
    // #serp is not followed yet: the first connection's post is dropped.
    ing.start()
    try {
      await until(() => ing.stats()[1]!.events >= 1)
      ing.flush()
      expect(store.networkPost(`at://${DID_A}/app.bsky.feed.post/3kserp`)).toBeNull()
      store.setTags('seo.rank', ['seo', 'serp'], 'admin')
      expect(ing.matcher.match(['serp'])).toEqual(['seo.rank'])
      await until(() => ing.stats()[0]!.errors + ing.stats()[0]!.reconnects >= 1)
      expect(ing.stats()[1]!.state).toBe('open')
    } finally {
      ing.stop()
      live.stop()
    }
  })

  test('a relay far behind is shed: cursor dropped, reconnected live', async () => {
    const store = new Store(':memory:')
    store.ensureCommunity('seo.rank', () => ['seo'])
    store.setCursor('ws://127.0.0.1:0/x', 1, Date.now())
    const old = new Date(Date.now() - 3600_000).toISOString()
    const fire = fakeRelay(async () => [await firehoseCommit(500, DID_A, [{ path: 'app.bsky.feed.post/3kold', record: post('#seo') }], old), await firehoseCommit(501, DID_A, [{ path: 'app.bsky.feed.post/3kold2', record: post('#seo') }], old)])
    const url = `ws://127.0.0.1:${fire.port}`
    store.setCursor(url, 400, Date.now() - 1000)
    const ing = new Ingestor({ store, relays: [url], flushMs: 30, maxLagMs: 60_000, shedAfterMs: 0, log: () => {} }).start()
    try {
      await until(() => ing.stats()[0]!.sheds >= 1)
      expect(fire.urls[0]).toContain('cursor=400')
      await until(() => fire.urls.length >= 2)
      expect(fire.urls[1]).not.toContain('cursor=')
    } finally {
      ing.stop()
      fire.stop()
    }
  })
})

describe('retention', () => {
  test('prune by age and per-community cap', () => {
    const store = new Store(':memory:')
    store.ensureCommunity('a.b', () => ['x'])
    store.ensureCommunity('c.d', () => ['x'])
    const now = Date.now()
    const mk = (i: number, age: number) => toNetworkPost({ type: 'create', uri: `at://${DID_A}/app.bsky.feed.post/p${i}`, cid: 'bafy' + i, did: DID_A, record: post('#x ' + i), time: now }, ['x'], 'r', now - age)
    store.saveNetworkPosts([{ post: mk(0, 40 * 86_400_000), communities: ['a.b'] }])
    for (let i = 1; i <= 10; i++) store.saveNetworkPosts([{ post: mk(i, (10 - i) * 1000), communities: i <= 5 ? ['a.b', 'c.d'] : ['a.b'] }])
    expect(store.networkCount('a.b')).toBe(11)
    const { removed } = store.prune({ now, maxAgeMs: 30 * 86_400_000, cap: 4 })
    // a.b keeps its 4 newest (7..10); c.d keeps 2..5 (4 of its 5). p0 aged out, p1 is in no community any more.
    expect(store.networkFeed('a.b').map((p) => p.uri.split('/').pop())).toEqual(['p10', 'p9', 'p8', 'p7'])
    expect(store.networkFeed('c.d').map((p) => p.uri.split('/').pop())).toEqual(['p5', 'p4', 'p3', 'p2'])
    expect(store.networkPost(`at://${DID_A}/app.bsky.feed.post/p1`)).toBeNull()
    expect(store.networkPost(`at://${DID_A}/app.bsky.feed.post/p6`)).toBeNull()
    expect(removed).toBe(3)
  })
})
