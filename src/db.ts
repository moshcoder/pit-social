/**
 * Everything pit-social keeps, in one SQLite file shared by every community.
 *
 * A person is one `users` row per bridge `sub` (their CoinPay DID) across every
 * social.* site; `members` says which communities they have joined. Network posts
 * are stored once and linked to each community whose tags they matched.
 *
 * Every SQL string here is a plain literal: no template literals, no concatenation.
 */
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

export const newId = (bytes = 9) => randomBytes(bytes).toString('base64url')
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

export type Community = { name: string; tags: string[]; tags_source: 'auto' | 'admin'; description: string | null; created_at: number; listing_checked_at: number | null }
export type User = { sub: string; name: string | null; username: string | null; picture: string | null; created_at: number }
export type Embed = { external?: { uri: string; title: string }; images?: number; quote?: string; video?: boolean }
export type NetworkPost = {
  uri: string
  cid: string
  did: string
  text: string
  tags: string[]
  langs: string[]
  created_at: string
  indexed_at: number
  relays: string[]
  embed: Embed | null
  reply_parent: string | null
  seq?: number
}
export type LocalPost = {
  id: string
  community: string
  sub: string
  parent_id: string | null
  record: { $type: 'app.bsky.feed.post'; text: string; facets?: unknown[]; createdAt: string; langs?: string[] }
  text: string
  tags: string[]
  created_at: number
  hidden: number
  deleted: number
  reports: number
  replies?: number
  author?: User | null
}
export type RelayRow = { url: string; kind: string; state: string; stats: Record<string, unknown>; updated_at: number }

const SCHEMA = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA busy_timeout = 5000',
  "CREATE TABLE IF NOT EXISTS communities (name TEXT PRIMARY KEY, tags TEXT NOT NULL DEFAULT '[]', tags_source TEXT NOT NULL DEFAULT 'auto', description TEXT, created_at INTEGER NOT NULL, listing_checked_at INTEGER)",
  "CREATE TABLE IF NOT EXISTS network_posts (uri TEXT PRIMARY KEY, cid TEXT NOT NULL, did TEXT NOT NULL, text TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', langs TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, indexed_at INTEGER NOT NULL, relays TEXT NOT NULL DEFAULT '[]', embed TEXT, reply_parent TEXT)",
  'CREATE INDEX IF NOT EXISTS network_posts_indexed ON network_posts(indexed_at)',
  'CREATE TABLE IF NOT EXISTS community_posts (seq INTEGER PRIMARY KEY AUTOINCREMENT, community TEXT NOT NULL, uri TEXT NOT NULL REFERENCES network_posts(uri) ON DELETE CASCADE, indexed_at INTEGER NOT NULL, UNIQUE(community, uri))',
  'CREATE INDEX IF NOT EXISTS community_posts_feed ON community_posts(community, seq)',
  'CREATE INDEX IF NOT EXISTS community_posts_uri ON community_posts(uri)',
  'CREATE TABLE IF NOT EXISTS users (sub TEXT PRIMARY KEY, name TEXT, username TEXT, picture TEXT, created_at INTEGER NOT NULL, last_seen_at INTEGER)',
  "CREATE TABLE IF NOT EXISTS members (community TEXT NOT NULL, sub TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE, role TEXT NOT NULL DEFAULT 'member', joined_at INTEGER NOT NULL, PRIMARY KEY (community, sub))",
  'CREATE TABLE IF NOT EXISTS local_posts (id TEXT PRIMARY KEY, community TEXT NOT NULL, sub TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE, parent_id TEXT, record TEXT NOT NULL, text TEXT NOT NULL, tags TEXT NOT NULL, created_at INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, reports INTEGER NOT NULL DEFAULT 0)',
  'CREATE INDEX IF NOT EXISTS local_posts_feed ON local_posts(community, created_at)',
  'CREATE INDEX IF NOT EXISTS local_posts_sub ON local_posts(sub, created_at)',
  'CREATE INDEX IF NOT EXISTS local_posts_parent ON local_posts(parent_id)',
  'CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id TEXT NOT NULL REFERENCES local_posts(id) ON DELETE CASCADE, sub TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL, UNIQUE(post_id, sub))',
  'CREATE TABLE IF NOT EXISTS sessions (id_hash TEXT PRIMARY KEY, sub TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE, community TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS api_tokens (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, sub TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE, label TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER)',
  'CREATE TABLE IF NOT EXISTS handles (did TEXT PRIMARY KEY, handle TEXT, fetched_at INTEGER NOT NULL)',
  "CREATE TABLE IF NOT EXISTS relay_state (url TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, stats TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL)",
  'CREATE TABLE IF NOT EXISTS relay_cursors (url TEXT PRIMARY KEY, cursor INTEGER NOT NULL, event_time INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
]

const json = <T>(value: unknown, fallback: T): T => {
  try {
    return value == null ? fallback : (JSON.parse(String(value)) as T)
  } catch {
    return fallback
  }
}

const toNetwork = (r: any): NetworkPost => ({ ...r, tags: json(r.tags, []), langs: json(r.langs, []), relays: json(r.relays, []), embed: json(r.embed, null) })
const toLocal = (r: any): LocalPost => ({ ...r, record: json(r.record, {} as any), tags: json(r.tags, []) })
const toCommunity = (r: any): Community => ({ ...r, tags: json(r.tags, []) })

export class Store {
  readonly db: Database
  private tagListeners = new Set<() => void>()

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
    for (const statement of SCHEMA) this.db.run(statement)
  }

  close() {
    this.db.close()
  }

  // ---- communities ---------------------------------------------------------

  community(name: string): Community | null {
    const row = this.db.query('SELECT * FROM communities WHERE name = ?').get(name)
    return row ? toCommunity(row) : null
  }

  /** The community, created on first sight with `tags` (launch automatically: no setup step). */
  ensureCommunity(name: string, tags: () => string[]): { community: Community; created: boolean } {
    const existing = this.community(name)
    if (existing) return { community: existing, created: false }
    this.db.query("INSERT OR IGNORE INTO communities (name, tags, tags_source, created_at) VALUES (?, ?, 'auto', ?)").run(name, JSON.stringify(tags()), Date.now())
    this.tagsChanged()
    return { community: this.community(name)!, created: true }
  }

  communities(): Community[] {
    return this.db.query('SELECT * FROM communities ORDER BY name').all().map(toCommunity)
  }

  setTags(name: string, tags: string[], source: 'auto' | 'admin') {
    this.db.query('UPDATE communities SET tags = ?, tags_source = ? WHERE name = ?').run(JSON.stringify(tags), source, name)
    this.tagsChanged()
  }

  setListing(name: string, description: string | null) {
    this.db.query('UPDATE communities SET description = ?, listing_checked_at = ? WHERE name = ?').run(description, Date.now(), name)
  }

  /** tag -> the communities that follow it. */
  tagIndex(): Map<string, string[]> {
    const index = new Map<string, string[]>()
    for (const c of this.communities()) for (const t of c.tags) index.set(t, [...(index.get(t) ?? []), c.name])
    return index
  }

  onTagsChanged(fn: () => void) {
    this.tagListeners.add(fn)
    return () => this.tagListeners.delete(fn)
  }

  private tagsChanged() {
    for (const fn of this.tagListeners) fn()
  }

  // ---- network posts -------------------------------------------------------

  /** Store a matched post for these communities. A post seen again from another relay just adds that relay. */
  saveNetworkPosts(items: { post: NetworkPost; communities: string[] }[]) {
    const insert = this.db.query('INSERT INTO network_posts (uri, cid, did, text, tags, langs, created_at, indexed_at, relays, embed, reply_parent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(uri) DO NOTHING')
    const relays = this.db.query('SELECT relays FROM network_posts WHERE uri = ?')
    const setRelays = this.db.query('UPDATE network_posts SET relays = ? WHERE uri = ?')
    const link = this.db.query('INSERT OR IGNORE INTO community_posts (community, uri, indexed_at) VALUES (?, ?, ?)')
    this.db.transaction(() => {
      for (const { post: p, communities } of items) {
        const changes = insert.run(p.uri, p.cid, p.did, p.text, JSON.stringify(p.tags), JSON.stringify(p.langs), p.created_at, p.indexed_at, JSON.stringify(p.relays), p.embed ? JSON.stringify(p.embed) : null, p.reply_parent).changes
        if (!changes) {
          const seen = json<string[]>((relays.get(p.uri) as any)?.relays, [])
          const merged = [...new Set([...seen, ...p.relays])]
          if (merged.length !== seen.length) setRelays.run(JSON.stringify(merged), p.uri)
        }
        for (const c of communities) link.run(c, p.uri, p.indexed_at)
      }
    })()
  }

  /** Authors delete posts; so do we. */
  deleteNetworkPosts(uris: string[]) {
    const del = this.db.query('DELETE FROM network_posts WHERE uri = ?')
    this.db.transaction(() => {
      for (const u of uris) del.run(u)
    })()
  }

  networkPost(uri: string): NetworkPost | null {
    const row = this.db.query('SELECT * FROM network_posts WHERE uri = ?').get(uri)
    return row ? toNetwork(row) : null
  }

  /** Newest first. `before` is a community_posts seq (the feed cursor); `beforeTime` an indexed_at in ms. */
  networkFeed(community: string, opts: { limit?: number; before?: number | null; beforeTime?: number | null; tag?: string | null } = {}): NetworkPost[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 30, 100))
    const rows = this.db
      .query('SELECT p.*, cp.seq AS seq FROM community_posts cp JOIN network_posts p ON p.uri = cp.uri WHERE cp.community = ? AND cp.seq < ? AND cp.indexed_at < ? AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(p.tags) WHERE json_each.value = ?)) ORDER BY cp.seq DESC LIMIT ?')
      .all(community, opts.before ?? Number.MAX_SAFE_INTEGER, opts.beforeTime ?? Number.MAX_SAFE_INTEGER, opts.tag ?? null, opts.tag ?? null, limit)
    return rows.map(toNetwork)
  }

  networkCount(community: string): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM community_posts WHERE community = ?').get(community) as any).n
  }

  /**
   * Retention: drop posts older than `maxAgeMs`, keep at most `cap` per community,
   * then drop posts no community links to any more.
   */
  prune(opts: { now?: number; maxAgeMs: number; cap: number }): { removed: number } {
    const now = opts.now ?? Date.now()
    const count = () => (this.db.query('SELECT COUNT(*) AS n FROM network_posts').get() as { n: number }).n
    const before = count()
    this.db.transaction(() => {
      this.db.query('DELETE FROM network_posts WHERE indexed_at < ?').run(now - opts.maxAgeMs)
      for (const c of this.db.query('SELECT community, COUNT(*) AS n FROM community_posts GROUP BY community').all() as { community: string; n: number }[]) {
        if (c.n <= opts.cap) continue
        this.db.query('DELETE FROM community_posts WHERE community = ? AND seq <= (SELECT seq FROM community_posts WHERE community = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)').run(c.community, c.community, opts.cap)
      }
      this.db.query('DELETE FROM network_posts WHERE NOT EXISTS (SELECT 1 FROM community_posts cp WHERE cp.uri = network_posts.uri)').run()
    })()
    const removed = before - count()
    this.db.query('DELETE FROM sessions WHERE expires_at < ?').run(now)
    return { removed }
  }

  // ---- users, members ------------------------------------------------------

  /** The one user for this bridge `sub`, created or refreshed. Only `sub` links accounts. */
  upsertUser(claims: { sub: string; name?: string; username?: string; picture?: string }): User {
    const now = Date.now()
    this.db
      .query('INSERT INTO users (sub, name, username, picture, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(sub) DO UPDATE SET name = COALESCE(excluded.name, users.name), username = COALESCE(excluded.username, users.username), picture = COALESCE(excluded.picture, users.picture), last_seen_at = excluded.last_seen_at')
      .run(claims.sub, claims.name?.slice(0, 120) ?? null, claims.username?.slice(0, 64) ?? null, claims.picture?.startsWith('https://') ? claims.picture.slice(0, 500) : null, now, now)
    return this.user(claims.sub)!
  }

  user(sub: string): User | null {
    return (this.db.query('SELECT sub, name, username, picture, created_at FROM users WHERE sub = ?').get(sub) as User) ?? null
  }

  /** `/u/<short>`: the last 16 characters of the sub, unique enough to find one person. */
  userByShort(short: string): User | null {
    if (!/^[A-Za-z0-9._:-]{6,64}$/.test(short)) return null
    return (this.db.query('SELECT sub, name, username, picture, created_at FROM users WHERE substr(sub, -length(?)) = ? LIMIT 1').get(short, short) as User) ?? null
  }

  join(community: string, sub: string) {
    this.db.query("INSERT OR IGNORE INTO members (community, sub, role, joined_at) VALUES (?, ?, 'member', ?)").run(community, sub, Date.now())
  }

  membership(community: string, sub: string): { role: string; joined_at: number } | null {
    return (this.db.query('SELECT role, joined_at FROM members WHERE community = ? AND sub = ?').get(community, sub) as any) ?? null
  }

  setRole(community: string, sub: string, role: 'member' | 'admin') {
    this.join(community, sub)
    this.db.query('UPDATE members SET role = ? WHERE community = ? AND sub = ?').run(role, community, sub)
  }

  members(community: string): (User & { role: string; joined_at: number })[] {
    return this.db.query('SELECT u.sub, u.name, u.username, u.picture, u.created_at, m.role, m.joined_at FROM members m JOIN users u ON u.sub = m.sub WHERE m.community = ? ORDER BY m.joined_at').all(community) as any
  }

  // ---- local posts ---------------------------------------------------------

  createLocalPost(p: Omit<LocalPost, 'hidden' | 'deleted' | 'reports'>): LocalPost {
    this.db.query('INSERT INTO local_posts (id, community, sub, parent_id, record, text, tags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(p.id, p.community, p.sub, p.parent_id, JSON.stringify(p.record), p.text, JSON.stringify(p.tags), p.created_at)
    return this.localPost(p.id)!
  }

  localPost(id: string): LocalPost | null {
    const row = this.db.query('SELECT * FROM local_posts WHERE id = ?').get(id)
    return row ? this.withAuthor(toLocal(row)) : null
  }

  private withAuthor(p: LocalPost): LocalPost {
    return { ...p, author: this.user(p.sub) }
  }

  /** Top-level member posts, newest first, without hidden or deleted ones (unless `all`). */
  localFeed(community: string, opts: { limit?: number; before?: number | null; tag?: string | null; sub?: string | null; all?: boolean } = {}): LocalPost[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 30, 100))
    const before = opts.before ?? Number.MAX_SAFE_INTEGER
    const rows = this.db
      .query('SELECT lp.*, (SELECT COUNT(*) FROM local_posts r WHERE r.parent_id = lp.id AND r.deleted = 0 AND r.hidden = 0) AS replies FROM local_posts lp WHERE lp.community = ? AND lp.parent_id IS NULL AND lp.deleted = 0 AND (lp.hidden = 0 OR ? = 1) AND lp.created_at < ? AND (? IS NULL OR lp.sub = ?) AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(lp.tags) WHERE json_each.value = ?)) ORDER BY lp.created_at DESC LIMIT ?')
      .all(community, opts.all ? 1 : 0, before, opts.sub ?? null, opts.sub ?? null, opts.tag ?? null, opts.tag ?? null, limit)
    return rows.map((r) => this.withAuthor(toLocal(r)))
  }

  replies(id: string): LocalPost[] {
    return this.db.query('SELECT * FROM local_posts WHERE parent_id = ? AND deleted = 0 AND hidden = 0 ORDER BY created_at').all(id).map((r) => this.withAuthor(toLocal(r)))
  }

  postsSince(sub: string, since: number): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM local_posts WHERE sub = ? AND created_at >= ?').get(sub, since) as any).n
  }

  deleteLocalPost(id: string) {
    this.db.query("UPDATE local_posts SET deleted = 1, text = '', record = '{}' WHERE id = ?").run(id)
  }

  setHidden(id: string, hidden: boolean) {
    this.db.query('UPDATE local_posts SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, id)
  }

  report(postId: string, sub: string, reason: string | null): boolean {
    const added = this.db.query('INSERT OR IGNORE INTO reports (post_id, sub, reason, created_at) VALUES (?, ?, ?, ?)').run(postId, sub, reason?.slice(0, 500) ?? null, Date.now()).changes
    if (added) this.db.query('UPDATE local_posts SET reports = reports + 1 WHERE id = ?').run(postId)
    return added > 0
  }

  /** Reported or hidden posts, for the admin page. */
  moderationQueue(community: string): LocalPost[] {
    return this.db.query('SELECT * FROM local_posts WHERE community = ? AND deleted = 0 AND (reports > 0 OR hidden = 1) ORDER BY created_at DESC LIMIT 200').all(community).map((r) => this.withAuthor(toLocal(r)))
  }

  localCount(community: string): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM local_posts WHERE community = ? AND deleted = 0').get(community) as any).n
  }

  // ---- sessions + tokens ---------------------------------------------------

  createSession(sub: string, community: string, ttlMs: number): string {
    const id = newId(24)
    this.db.query('INSERT INTO sessions (id_hash, sub, community, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(sha256(id), sub, community, Date.now(), Date.now() + ttlMs)
    return id
  }

  /** A session works only on the community it was made for. */
  sessionUser(id: string | undefined | null, community: string): User | null {
    if (!id || id.length > 100) return null
    const row = this.db.query('SELECT sub FROM sessions WHERE id_hash = ? AND community = ? AND expires_at > ?').get(sha256(id), community, Date.now()) as { sub: string } | null
    return row ? this.user(row.sub) : null
  }

  endSession(id: string | undefined | null) {
    if (id) this.db.query('DELETE FROM sessions WHERE id_hash = ?').run(sha256(id))
  }

  createToken(sub: string, label: string | null): { id: string; token: string } {
    const token = 'ps_' + newId(24)
    const id = newId(6)
    this.db.query('INSERT INTO api_tokens (id, token_hash, sub, label, created_at) VALUES (?, ?, ?, ?, ?)').run(id, sha256(token), sub, label?.slice(0, 80) || null, Date.now())
    return { id, token }
  }

  tokenUser(token: string | null | undefined): User | null {
    if (!token || !/^ps_[A-Za-z0-9_-]{20,64}$/.test(token)) return null
    const row = this.db.query('SELECT id, sub FROM api_tokens WHERE token_hash = ?').get(sha256(token)) as { id: string; sub: string } | null
    if (!row) return null
    this.db.query('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(Date.now(), row.id)
    return this.user(row.sub)
  }

  tokens(sub: string): { id: string; label: string | null; created_at: number; last_used_at: number | null }[] {
    return this.db.query('SELECT id, label, created_at, last_used_at FROM api_tokens WHERE sub = ? ORDER BY created_at DESC').all(sub) as any
  }

  revokeToken(sub: string, id: string) {
    this.db.query('DELETE FROM api_tokens WHERE sub = ? AND id = ?').run(sub, id)
  }

  // ---- handles -------------------------------------------------------------

  handles(dids: string[]): Map<string, { handle: string | null; fetched_at: number }> {
    const out = new Map<string, { handle: string | null; fetched_at: number }>()
    const q = this.db.query('SELECT handle, fetched_at FROM handles WHERE did = ?')
    for (const d of new Set(dids)) {
      const row = q.get(d) as any
      if (row) out.set(d, row)
    }
    return out
  }

  setHandle(did: string, handle: string | null) {
    this.db.query('INSERT INTO handles (did, handle, fetched_at) VALUES (?, ?, ?) ON CONFLICT(did) DO UPDATE SET handle = excluded.handle, fetched_at = excluded.fetched_at').run(did, handle, Date.now())
  }

  // ---- relays --------------------------------------------------------------

  saveRelayState(rows: { url: string; kind: string; state: string; stats: Record<string, unknown> }[]) {
    const q = this.db.query('INSERT INTO relay_state (url, kind, state, stats, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET kind = excluded.kind, state = excluded.state, stats = excluded.stats, updated_at = excluded.updated_at')
    this.db.transaction(() => {
      for (const r of rows) q.run(r.url, r.kind, r.state, JSON.stringify(r.stats), Date.now())
    })()
  }

  relayState(): RelayRow[] {
    return (this.db.query('SELECT * FROM relay_state ORDER BY url').all() as any[]).map((r) => ({ ...r, stats: json(r.stats, {}) }))
  }

  cursor(url: string): { cursor: number; event_time: number } | null {
    return (this.db.query('SELECT cursor, event_time FROM relay_cursors WHERE url = ?').get(url) as any) ?? null
  }

  setCursor(url: string, cursor: number | null, eventTime = 0) {
    if (cursor == null) this.db.query('DELETE FROM relay_cursors WHERE url = ?').run(url)
    else this.db.query('INSERT INTO relay_cursors (url, cursor, event_time, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET cursor = excluded.cursor, event_time = excluded.event_time, updated_at = excluded.updated_at').run(url, cursor, eventTime, Date.now())
  }
}
