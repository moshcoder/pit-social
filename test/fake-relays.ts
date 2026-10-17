/** In-process fake relays: a jetstream (JSON) and a subscribeRepos firehose (CBOR + CAR). */
import { encode, toBytes } from '@atcute/cbor'
import { writeCarStream } from '@atcute/car'
import { create, toCidLink, toString as cidToString } from '@atcute/cid'

export const DID_A = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'
export const DID_B = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'

export const post = (text: string, extra: Record<string, unknown> = {}) => ({ $type: 'app.bsky.feed.post', text, createdAt: new Date().toISOString(), langs: ['en'], ...extra })

export async function cidOf(record: unknown) {
  return cidToString(await create(0x71, encode(record)))
}

export function jetstreamCreate(did: string, rkey: string, record: unknown, cid: string, timeUs = Date.now() * 1000) {
  return JSON.stringify({ did, time_us: timeUs, kind: 'commit', commit: { rev: 'r', operation: 'create', collection: 'app.bsky.feed.post', rkey, record, cid } })
}

export function jetstreamDelete(did: string, rkey: string) {
  return JSON.stringify({ did, time_us: Date.now() * 1000, kind: 'commit', commit: { rev: 'r', operation: 'delete', collection: 'app.bsky.feed.post', rkey } })
}

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** A #commit frame with the given records (path -> record), plus unrelated ops. */
export async function firehoseCommit(seq: number, repo: string, records: { path: string; record?: unknown; action?: 'create' | 'delete' }[], time = new Date().toISOString()) {
  const blocks: { cid: Uint8Array; data: Uint8Array }[] = []
  const ops = []
  for (const r of records) {
    if ((r.action ?? 'create') === 'delete') {
      ops.push({ action: 'delete', path: r.path, cid: null })
      continue
    }
    const data = encode(r.record)
    const cid = await create(0x71, data)
    blocks.push({ cid: cid.bytes, data })
    ops.push({ action: 'create', path: r.path, cid: toCidLink(cid) })
  }
  const chunks: Uint8Array[] = []
  const root = blocks[0] ? toCidLink(await create(0x71, blocks[0].data)) : toCidLink(await create(0x71, encode({})))
  for await (const chunk of writeCarStream([root], blocks)) chunks.push(chunk)
  const body = { seq, repo, rev: 'r', since: null, commit: root, ops, blocks: toBytes(concat(chunks)), time, rebase: false, tooBig: false, blobs: [] }
  return concat([encode({ op: 1, t: '#commit' }), encode(body)])
}

export function errorFrame(error: string, message: string) {
  return concat([encode({ op: -1 }), encode({ error, message })])
}

/** A WebSocket server that sends `frames` to each connection, then idles. */
export function fakeRelay(frames: () => Promise<(string | Uint8Array)[]> | (string | Uint8Array)[]) {
  const urls: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      urls.push(req.url)
      return srv.upgrade(req) ? undefined : new Response('upgrade', { status: 400 })
    },
    websocket: {
      async open(ws) {
        for (const f of await frames()) ws.send(f)
      },
      message() {},
    },
  })
  return { server, urls, port: server.port, stop: () => server.stop(true) }
}
