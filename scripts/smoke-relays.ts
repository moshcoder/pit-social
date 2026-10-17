#!/usr/bin/env bun
/**
 * Live smoke test: join every relay at once for ~20 s through the real Ingestor
 * and print what each one delivered.
 *
 *   bun scripts/smoke-relays.ts [seconds] [relay ...]     (default: PIT_SOCIAL_RELAYS or the built-in list)
 *
 * Uses an in-memory database with a few sample communities; touches nothing on disk.
 */
import { Store } from '../src/db.ts'
import { Ingestor, relaysFromEnv } from '../src/ingest.ts'
import { defaultTags } from '../src/tags.ts'

const seconds = Number(process.argv[2] ?? 20) || 20
const relays = process.argv.length > 3 ? process.argv.slice(3) : relaysFromEnv()
const store = new Store(':memory:')
// Two real niches plus a busy one, so "matched" is visibly non-zero inside 20 seconds.
for (const name of ['family.ancestry', 'seo.rank', 'art.club']) store.ensureCommunity(name, () => defaultTags(name))
for (const c of store.communities()) console.log(`${c.name.padEnd(16)} ${c.tags.map((t) => '#' + t).join(' ')}`)
console.log(`\njoining ${relays.length} relays for ${seconds}s ...\n`)

const ing = new Ingestor({ store, relays, flushMs: 500, log: () => {} }).start()
const t0 = Date.now()
await Bun.sleep(seconds * 1000)
const elapsed = (Date.now() - t0) / 1000
const stats = ing.stats()
ing.stop()

const pad = (v: unknown, n: number) => String(v).padStart(n)
console.log(['relay'.padEnd(32), 'kind'.padEnd(9), pad('events', 8), pad('ev/s', 7), pad('posts', 6), pad('matched', 8), pad('first', 6), pad('MB', 6), pad('cpu ms/s', 9), pad('lag s', 6), '  error'].join(' '))
for (const s of stats) {
  const cpu = s.decodeMsPerSec
  console.log([s.label.padEnd(32), s.kind.padEnd(9), pad(s.events, 8), pad((s.events / elapsed).toFixed(1), 7), pad(s.posts, 6), pad(s.matched, 8), pad(s.firstSeen, 6), pad((s.bytes / 1e6).toFixed(1), 6), pad(cpu, 9), pad(s.lagMs == null ? '-' : (s.lagMs / 1000).toFixed(1), 6), '  ' + (s.lastError ?? '')].join(' '))
}
const per = store.communities().map((c) => `${c.name} ${store.networkCount(c.name)}`).join(', ')
console.log(`\n${ing.totals.matched} unique matched posts, ${ing.totals.duplicates} duplicate sightings merged across relays; stored per community: ${per}`)
const open = stats.filter((s) => s.events > 0).length
console.log(`${open}/${stats.length} relays delivered events`)
process.exit(open === stats.length ? 0 : 1)
