/**
 * Lookups we make on the side, all tolerant of failure: did -> handle for display,
 * and the community's pit.world business listing for its starting tags.
 */
import type { Store } from './db.js'

const HANDLE = /^[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]$/i
const DAY = 24 * 60 * 60_000

/** did -> handle, cached in the database for a day (failures too). Never blocks a page. */
export class HandleResolver {
  private inflight = new Set<string>()
  private queue: string[] = []
  private active = 0
  constructor(
    private readonly store: Store,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly plc = process.env.PIT_SOCIAL_PLC_URL ?? 'https://plc.directory',
    private readonly enabled = process.env.PIT_SOCIAL_HANDLES !== 'off',
  ) {}

  /** What we know now; anything unknown or stale is looked up in the background. */
  lookup(dids: string[]): Map<string, string> {
    const known = this.store.handles(dids)
    const out = new Map<string, string>()
    for (const did of new Set(dids)) {
      const row = known.get(did)
      if (row?.handle) out.set(did, row.handle)
      if (!row || Date.now() - row.fetched_at > DAY) this.enqueue(did)
    }
    return out
  }

  private enqueue(did: string) {
    if (!this.enabled || this.inflight.has(did) || this.queue.length > 500) return
    this.inflight.add(did)
    this.queue.push(did)
    this.pump()
  }

  private pump() {
    while (this.active < 4 && this.queue.length) {
      const did = this.queue.shift()!
      this.active++
      this.resolve(did)
        .then((h) => this.store.setHandle(did, h))
        .catch(() => this.store.setHandle(did, null))
        .finally(() => {
          this.active--
          this.inflight.delete(did)
          this.pump()
        })
    }
  }

  async resolve(did: string): Promise<string | null> {
    let doc: any
    if (did.startsWith('did:plc:')) doc = await (await this.fetchImpl(`${this.plc}/${did}`, { signal: AbortSignal.timeout(5000) })).json()
    else if (did.startsWith('did:web:')) return did.slice('did:web:'.length).replace(/%3A/gi, ':')
    else return null
    const aka = Array.isArray(doc?.alsoKnownAs) ? doc.alsoKnownAs.find((a: unknown) => typeof a === 'string' && a.startsWith('at://')) : null
    const handle = aka ? aka.slice('at://'.length) : null
    return handle && HANDLE.test(handle) ? handle.toLowerCase() : null
  }
}

export type Listing = { name?: string; description?: string; services?: string[]; claimed?: boolean }

/** pit.world's public listing JSON for a name (GET /api/listing?domain=<name>), or null. */
export async function fetchListing(name: string, fetchImpl: typeof fetch = fetch, base = process.env.PIT_WORLD_URL ?? 'https://pit.world'): Promise<Listing | null> {
  try {
    const res = await fetchImpl(`${base.replace(/\/+$/, '')}/api/listing?domain=${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } })
    if (!res.ok) return null
    const body = (await res.json()) as any
    if (!body || typeof body !== 'object') return null
    return {
      name: typeof body.name === 'string' ? body.name.slice(0, 200) : undefined,
      description: typeof body.description === 'string' ? body.description.slice(0, 2000) : undefined,
      services: Array.isArray(body.services) ? body.services.filter((s: unknown) => typeof s === 'string').slice(0, 20) : [],
      claimed: !!body.claimed,
    }
  } catch {
    return null
  }
}
