/**
 * Ingestion: every configured relay and jetstream at once, merged.
 *
 * Read-only and anonymous: we open public firehoses, never authenticate, never
 * create accounts. Two wire formats:
 *
 *   jetstream  JSON, already filtered to app.bsky.feed.post (cheap)
 *   firehose   com.atproto.sync.subscribeRepos: a CBOR header + CBOR body per
 *              frame, records inside a CAR. Decoded with @atcute/cbor + @atcute/car.
 *
 * Only `app.bsky.feed.post` creates matter. A post is kept when one of its
 * hashtags is followed by some community; the same post arriving from several
 * relays is stored once and remembers every relay that carried it.
 *
 * Each relay reconnects on its own with backoff, keeps a cursor where the relay
 * supports one, and sheds load rather than fall behind: when its events arrive
 * more than PIT_SOCIAL_MAX_LAG_S late for a while, we drop its backlog (forget
 * the cursor) and reconnect live. One bad relay never stops the others.
 *
 * Disabled with PIT_SOCIAL_INGEST=off (tests, a second web process).
 */
import { decode, decodeFirst, fromBytes, isBytes } from '@atcute/cbor'
import { fromUint8Array } from '@atcute/car'
import { toString as cidToString } from '@atcute/cid'
import type { Embed, NetworkPost, Store } from './db.js'
import { extractTags } from './tags.js'

export const DEFAULT_RELAYS = [
  'wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post',
  'wss://jetstream1.us-west.bsky.network/subscribe?wantedCollections=app.bsky.feed.post',
  'wss://atproto.africa',
  'wss://relay.fire.hose.cam',
  'wss://relay.upcloud.world',
  'wss://relay.waow.tech',
  'wss://bsky.network',
]

export const USER_AGENT = 'pit-social/0.1 (+https://github.com/moshcoder/pit-social; read-only)'

export type RelayKind = 'jetstream' | 'firehose'

export function relayKind(url: string): RelayKind {
  return new URL(url).pathname.startsWith('/subscribe') ? 'jetstream' : 'firehose'
}

/** The relay's subscription URL, with a cursor when we have one. */
export function subscribeUrl(url: string, cursor?: number | null): string {
  const u = new URL(url)
  if (relayKind(url) === 'firehose' && (u.pathname === '/' || u.pathname === '')) u.pathname = '/xrpc/com.atproto.sync.subscribeRepos'
  if (cursor != null) u.searchParams.set('cursor', String(cursor))
  return u.toString()
}

/** A short label for a relay: its host. */
export const relayLabel = (url: string) => new URL(url).host

export type IngestEvent =
  | { type: 'create'; uri: string; cid: string; did: string; record: any; time: number }
  | { type: 'delete'; uri: string; time: number }

const DID = /^did:(plc:[a-z2-7]{24}|web:[a-zA-Z0-9.%:-]{1,253})$/
const RKEY = /^[a-zA-Z0-9._:~-]{1,512}$/
const POST = 'app.bsky.feed.post'

/** One jetstream JSON message -> events, plus its cursor (time_us). */
export function parseJetstream(data: string): { events: IngestEvent[]; cursor: number | null; time: number } {
  const msg = JSON.parse(data)
  const cursor = typeof msg?.time_us === 'number' ? msg.time_us : null
  const time = cursor ? Math.floor(cursor / 1000) : Date.now()
  const c = msg?.kind === 'commit' ? msg.commit : null
  if (!c || c.collection !== POST || !DID.test(String(msg.did)) || !RKEY.test(String(c.rkey))) return { events: [], cursor, time }
  const uri = `at://${msg.did}/${POST}/${c.rkey}`
  if (c.operation === 'create' && c.record && typeof c.cid === 'string') return { events: [{ type: 'create', uri, cid: c.cid, did: msg.did, record: c.record, time }], cursor, time }
  if (c.operation === 'delete') return { events: [{ type: 'delete', uri, time }], cursor, time }
  return { events: [], cursor, time }
}

export class RelayError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const linkOf = (v: any): string | null => (v && typeof v.$link === 'string' ? v.$link : null)

/**
 * One subscribeRepos frame -> events, plus its seq and commit time. Commits with
 * no post creates or deletes are skipped before the CAR is opened, which is what
 * keeps a full relay cheap: most events are likes, follows and reposts.
 */
export function parseFirehose(frame: Uint8Array): { events: IngestEvent[]; cursor: number | null; time: number } {
  const [header, rest] = decodeFirst(frame)
  if (header?.op === -1) {
    const body = decode(rest)
    throw new RelayError(String(body?.error ?? 'Error'), String(body?.message ?? 'relay error'))
  }
  const body = decode(rest)
  const cursor = typeof body?.seq === 'number' ? body.seq : null
  const time = typeof body?.time === 'string' ? Date.parse(body.time) || Date.now() : Date.now()
  if (header?.t !== '#commit' || !Array.isArray(body?.ops) || !DID.test(String(body.repo))) return { events: [], cursor, time }
  const events: IngestEvent[] = []
  const wanted = new Map<string, string>()
  for (const op of body.ops) {
    const path = String(op?.path ?? '')
    if (!path.startsWith(POST + '/')) continue
    const rkey = path.slice(POST.length + 1)
    if (!RKEY.test(rkey)) continue
    const uri = `at://${body.repo}/${path}`
    if (op.action === 'delete') events.push({ type: 'delete', uri, time })
    else if (op.action === 'create') {
      const cid = linkOf(op.cid)
      if (cid) wanted.set(cid, uri)
    }
  }
  if (wanted.size && isBytes(body.blocks)) {
    for (const entry of fromUint8Array(fromBytes(body.blocks), { verifyBlocks: false })) {
      const cid = cidToString(entry.cid)
      const uri = wanted.get(cid)
      if (!uri) continue
      events.push({ type: 'create', uri, cid, did: body.repo, record: decode(entry.bytes), time })
    }
  }
  return { events, cursor, time }
}

/** Embed summary: link title and URL, image count, quote URI. We never download media. */
export function summarizeEmbed(embed: any): Embed | null {
  if (!embed || typeof embed !== 'object') return null
  const out: Embed = {}
  const media = embed.$type === 'app.bsky.embed.recordWithMedia' ? embed.media : embed
  if (media?.$type === 'app.bsky.embed.external' && typeof media.external?.uri === 'string' && /^https?:\/\//i.test(media.external.uri)) out.external = { uri: media.external.uri.slice(0, 1000), title: String(media.external.title ?? '').slice(0, 300) }
  if (media?.$type === 'app.bsky.embed.images' && Array.isArray(media.images)) out.images = Math.min(media.images.length, 10)
  if (media?.$type === 'app.bsky.embed.video') out.video = true
  const quote = embed.$type === 'app.bsky.embed.record' ? embed.record?.uri : embed.$type === 'app.bsky.embed.recordWithMedia' ? embed.record?.record?.uri : null
  if (typeof quote === 'string' && quote.startsWith('at://')) out.quote = quote.slice(0, 500)
  return Object.keys(out).length ? out : null
}

export function toNetworkPost(e: Extract<IngestEvent, { type: 'create' }>, tags: string[], relay: string, now = Date.now()): NetworkPost {
  const r = e.record ?? {}
  return {
    uri: e.uri,
    cid: e.cid,
    did: e.did,
    text: typeof r.text === 'string' ? r.text.slice(0, 3000) : '',
    tags,
    langs: Array.isArray(r.langs) ? r.langs.filter((l: unknown) => typeof l === 'string' && l.length <= 20).slice(0, 3) : [],
    created_at: typeof r.createdAt === 'string' ? r.createdAt.slice(0, 40) : new Date(e.time).toISOString(),
    indexed_at: now,
    relays: [relay],
    embed: summarizeEmbed(r.embed),
    reply_parent: typeof r.reply?.parent?.uri === 'string' ? r.reply.parent.uri.slice(0, 500) : null,
  }
}

/** tag -> communities, rebuilt whenever a community's tags change. */
export class Matcher {
  private index = new Map<string, string[]>()
  constructor(private readonly load: () => Map<string, string[]>) {
    this.refresh()
  }
  refresh() {
    this.index = this.load()
  }
  get size() {
    return this.index.size
  }
  match(tags: string[]): string[] {
    const out = new Set<string>()
    for (const t of tags) for (const c of this.index.get(t) ?? []) out.add(c)
    return [...out]
  }
}

/** Least-recently-used set with a value, for dedupe across relays. */
class Lru<V> {
  private map = new Map<string, V>()
  constructor(private readonly max: number) {}
  get(key: string) {
    return this.map.get(key)
  }
  set(key: string, value: V) {
    this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!)
  }
}

export type RelayStats = {
  url: string
  label: string
  kind: RelayKind
  state: 'idle' | 'connecting' | 'open' | 'backoff' | 'stopped'
  events: number
  posts: number
  matched: number
  firstSeen: number
  bytes: number
  eps: number
  decodeMsPerSec: number
  lagMs: number | null
  lastEventAt: number | null
  connectedAt: number | null
  reconnects: number
  sheds: number
  errors: number
  lastError: string | null
  cursor: number | null
}

export type IngestOptions = {
  store: Store
  relays?: string[]
  log?: (msg: string) => void
  /** Shed a relay's backlog when its events are this late for `shedAfterMs`. Default 120 s. */
  maxLagMs?: number
  shedAfterMs?: number
  /** After a shed, do not shed the same relay again for this long. Default 10 min. */
  shedCooldownMs?: number
  /** A stored cursor older than this is not replayed. Default 10 min. */
  maxBackfillMs?: number
  /** Close a connection that has said nothing for this long. Default 90 s. */
  idleMs?: number
  flushMs?: number
  backoffMaxMs?: number
}

class RelayConnection {
  stats: RelayStats
  private ws: WebSocket | null = null
  private backoff = 1000
  private timer: ReturnType<typeof setTimeout> | null = null
  private behindSince: number | null = null
  private lastShedAt = 0
  private windowStart = Date.now()
  private windowEvents = 0
  private windowCpu = 0
  private lastMessageAt = 0
  private cursorTime = 0
  private stopped = false

  constructor(
    readonly url: string,
    private readonly ing: Ingestor,
  ) {
    this.stats = { url, label: relayLabel(url), kind: relayKind(url), state: 'idle', events: 0, posts: 0, matched: 0, firstSeen: 0, bytes: 0, eps: 0, decodeMsPerSec: 0, lagMs: null, lastEventAt: null, connectedAt: null, reconnects: 0, sheds: 0, errors: 0, lastError: null, cursor: null }
  }

  start() {
    this.stopped = false
    const saved = this.ing.store.cursor(this.url)
    if (saved && Date.now() - saved.event_time < this.ing.opts.maxBackfillMs) {
      this.stats.cursor = saved.cursor
      this.cursorTime = saved.event_time
    }
    this.connect()
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.stats.state = 'stopped'
    try {
      this.ws?.close()
    } catch {}
    this.ws = null
  }

  private connect() {
    if (this.stopped) return
    this.stats.state = 'connecting'
    let ws: WebSocket
    try {
      ws = new (WebSocket as any)(subscribeUrl(this.url, this.stats.cursor), { headers: { 'user-agent': USER_AGENT } })
    } catch (error) {
      this.fail(`connect: ${(error as Error).message}`)
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = () => {
      this.stats.state = 'open'
      this.stats.connectedAt = Date.now()
      this.lastMessageAt = Date.now()
    }
    ws.onmessage = (ev) => this.onMessage(ev.data)
    ws.onerror = (ev: any) => {
      this.stats.errors++
      this.stats.lastError = String(ev?.message ?? 'websocket error').slice(0, 200)
    }
    ws.onclose = (ev) => {
      if (this.ws !== ws) return
      this.ws = null
      if (this.stopped) return
      if (ev.code !== 1000 && !this.stats.lastError) this.stats.lastError = `closed ${ev.code} ${ev.reason}`.trim().slice(0, 200)
      this.scheduleReconnect()
    }
  }

  private fail(message: string) {
    this.stats.errors++
    this.stats.lastError = message.slice(0, 200)
    this.scheduleReconnect()
  }

  private scheduleReconnect() {
    if (this.stopped || this.timer) return
    // A connection that held for a minute was healthy: start backoff over.
    if (this.stats.connectedAt && Date.now() - this.stats.connectedAt > 60_000) this.backoff = 1000
    this.stats.state = 'backoff'
    const wait = Math.min(this.backoff, this.ing.opts.backoffMaxMs) * (0.75 + Math.random() * 0.5)
    this.backoff = Math.min(this.backoff * 2, this.ing.opts.backoffMaxMs)
    this.timer = setTimeout(() => {
      this.timer = null
      this.stats.reconnects++
      this.connect()
    }, wait)
  }

  /** Close now and come back with no cursor: we would rather miss events than serve them late. */
  shed(reason: string) {
    this.stats.sheds++
    this.lastShedAt = Date.now()
    this.ing.log(`[ingest] ${this.stats.label}: shedding backlog (${reason}); resuming live`)
    this.stats.cursor = null
    this.cursorTime = 0
    this.ing.store.setCursor(this.url, null)
    this.behindSince = null
    const ws = this.ws
    this.ws = null
    try {
      ws?.close()
    } catch {}
    this.backoff = 1000
    if (!this.stopped) {
      this.stats.reconnects++
      this.connect()
    }
  }

  private onMessage(data: unknown) {
    const t0 = performance.now()
    const now = Date.now()
    this.lastMessageAt = now
    this.stats.events++
    this.windowEvents++
    let parsed: ReturnType<typeof parseJetstream>
    try {
      if (typeof data === 'string') {
        this.stats.bytes += data.length
        parsed = parseJetstream(data)
      } else {
        const bytes = new Uint8Array(data as ArrayBuffer)
        this.stats.bytes += bytes.length
        parsed = parseFirehose(bytes)
      }
    } catch (error) {
      if (error instanceof RelayError) {
        this.stats.lastError = `${error.code}: ${error.message}`.slice(0, 200)
        // A cursor the relay will not honour: forget it and start live.
        if (/cursor|ConsumerTooSlow/i.test(error.code + error.message)) this.shed(error.code)
        return
      }
      this.stats.errors++
      this.stats.lastError = `decode: ${(error as Error).message}`.slice(0, 200)
      this.windowCpu += performance.now() - t0
      return
    }
    if (parsed.cursor != null) {
      this.stats.cursor = parsed.cursor
      this.cursorTime = parsed.time
    }
    const lag = Math.max(0, now - parsed.time)
    this.stats.lagMs = this.stats.lagMs == null ? lag : Math.round(this.stats.lagMs * 0.98 + lag * 0.02)
    this.stats.lastEventAt = now
    for (const e of parsed.events) this.ing.accept(this, e)
    this.windowCpu += performance.now() - t0
    if (lag > this.ing.opts.maxLagMs) {
      this.behindSince ??= now
      if (now - this.behindSince >= this.ing.opts.shedAfterMs) {
        // Shedding helps when the backlog is ours. If we already came back live and are still
        // this late, the relay itself is behind: say so and leave it be for a while.
        if (now - this.lastShedAt > this.ing.opts.shedCooldownMs) this.shed(`${Math.round(lag / 1000)}s behind`)
        else this.stats.lastError = `relay is ${Math.round(lag / 1000)}s behind upstream`
        this.behindSince = now
      }
    } else this.behindSince = null
  }

  tick(now: number) {
    const elapsed = (now - this.windowStart) / 1000
    if (elapsed >= 1) {
      const eps = this.windowEvents / elapsed
      this.stats.eps = Math.round((this.stats.eps ? this.stats.eps * 0.5 + eps * 0.5 : eps) * 10) / 10
      this.stats.decodeMsPerSec = Math.round((this.windowCpu / elapsed) * 10) / 10
      this.windowStart = now
      this.windowEvents = 0
      this.windowCpu = 0
    }
    if (this.stats.state === 'open' && now - this.lastMessageAt > this.ing.opts.idleMs) {
      this.stats.lastError = 'idle: no events'
      const ws = this.ws
      this.ws = null
      try {
        ws?.close()
      } catch {}
      this.scheduleReconnect()
    }
    if (this.stats.cursor != null) this.ing.store.setCursor(this.url, this.stats.cursor, this.cursorTime)
  }
}

export class Ingestor {
  readonly store: Store
  readonly opts: Required<Omit<IngestOptions, 'store' | 'relays' | 'log'>>
  readonly matcher: Matcher
  readonly connections: RelayConnection[]
  readonly log: (msg: string) => void
  private seen = new Lru<Set<string>>(100_000)
  private deleted = new Lru<true>(20_000)
  private pending: { post: NetworkPost; communities: string[] }[] = []
  private pendingDeletes: string[] = []
  private timers: ReturnType<typeof setInterval>[] = []
  private unsubscribe: (() => void) | null = null
  totals = { matched: 0, stored: 0, duplicates: 0, deleted: 0 }

  constructor(o: IngestOptions) {
    this.store = o.store
    this.log = o.log ?? ((m) => console.log(m))
    this.opts = {
      maxLagMs: o.maxLagMs ?? 120_000,
      shedAfterMs: o.shedAfterMs ?? 30_000,
      shedCooldownMs: o.shedCooldownMs ?? 10 * 60_000,
      maxBackfillMs: o.maxBackfillMs ?? 10 * 60_000,
      idleMs: o.idleMs ?? 90_000,
      flushMs: o.flushMs ?? 1000,
      backoffMaxMs: o.backoffMaxMs ?? 60_000,
    }
    this.matcher = new Matcher(() => this.store.tagIndex())
    this.connections = [...new Set(o.relays ?? DEFAULT_RELAYS)].map((url) => new RelayConnection(url, this))
  }

  start() {
    this.unsubscribe = this.store.onTagsChanged(() => this.matcher.refresh())
    for (const c of this.connections) c.start()
    this.timers.push(setInterval(() => this.flush(), this.opts.flushMs))
    this.timers.push(
      setInterval(() => {
        const now = Date.now()
        for (const c of this.connections) c.tick(now)
        this.saveState()
      }, 5000),
    )
    // Another process (the web side) may have changed tags: look again now and then.
    this.timers.push(setInterval(() => this.matcher.refresh(), 60_000))
    this.log(`[ingest] connecting to ${this.connections.length} relays: ${this.connections.map((c) => c.stats.label).join(', ')}`)
    return this
  }

  stop() {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    this.unsubscribe?.()
    for (const c of this.connections) c.stop()
    this.flush()
    this.saveState()
  }

  /** One decoded event from one relay. */
  accept(conn: { stats: RelayStats }, e: IngestEvent) {
    const relay = conn.stats.label
    if (e.type === 'delete') {
      if (this.deleted.get(e.uri)) return
      this.deleted.set(e.uri, true)
      this.pendingDeletes.push(e.uri)
      return
    }
    conn.stats.posts++
    const prior = this.seen.get(e.uri)
    if (prior) {
      if (!prior.has(relay)) {
        prior.add(relay)
        conn.stats.matched++
        this.totals.duplicates++
        this.pending.push({ post: toNetworkPost(e, [], relay), communities: [] })
      }
      return
    }
    const tags = extractTags(e.record)
    if (!tags.length) return
    const communities = this.matcher.match(tags)
    if (!communities.length) return
    this.seen.set(e.uri, new Set([relay]))
    conn.stats.matched++
    conn.stats.firstSeen++
    this.totals.matched++
    this.pending.push({ post: toNetworkPost(e, tags, relay), communities })
  }

  flush() {
    if (this.pending.length) {
      const batch = this.pending
      this.pending = []
      try {
        this.store.saveNetworkPosts(batch)
        this.totals.stored += batch.filter((b) => b.communities.length).length
      } catch (error) {
        this.log(`[ingest] save failed: ${(error as Error).message}`)
      }
    }
    if (this.pendingDeletes.length) {
      const batch = this.pendingDeletes
      this.pendingDeletes = []
      try {
        this.store.deleteNetworkPosts(batch)
        this.totals.deleted += batch.length
      } catch {}
    }
  }

  stats(): RelayStats[] {
    return this.connections.map((c) => ({ ...c.stats }))
  }

  saveState() {
    try {
      this.store.saveRelayState(this.connections.map((c) => ({ url: c.url, kind: c.stats.kind, state: c.stats.state, stats: { ...c.stats } })))
    } catch {}
  }
}

/** PIT_SOCIAL_RELAYS (comma separated wss:// URLs), or the defaults. */
export function relaysFromEnv(value = process.env.PIT_SOCIAL_RELAYS): string[] {
  const list = String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^wss?:\/\/[^\s]+$/.test(s))
  return list.length ? [...new Set(list)] : DEFAULT_RELAYS
}
