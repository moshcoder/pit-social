/**
 * Every page, server-rendered, no JavaScript. Everything from the network is
 * untrusted: it is escaped here, always, and links from it are nofollow.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Community, LocalPost, NetworkPost, RelayRow, User } from './db.js'
import { didFor, feedUriFor, originFor } from './names.js'
import { normalizeTag } from './tags.js'

export const VERSION = '0.1.0'

export const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

let cssVersion: string | null = null
export function cssHref(): string {
  if (!cssVersion) {
    try {
      cssVersion = createHash('sha256').update(readFileSync(new URL('../public/style.css', import.meta.url))).digest('hex').slice(0, 10)
    } catch {
      cssVersion = VERSION
    }
  }
  return `/style.css?v=${cssVersion}`
}

export type Ctx = { name: string; user: User | null; csrf: string; admin: boolean; flash?: string | null; error?: string | null; signInUrl: string }

export const csrfField = (ctx: Ctx) => `<input type="hidden" name="_csrf" value="${esc(ctx.csrf)}">`

export const shortSub = (sub: string) => sub.replace(/[^A-Za-z0-9._:-]/g, '').slice(-16)
export const displayName = (u: User | null | undefined) => (u ? u.name || u.username || 'member ' + shortSub(u.sub).slice(-6) : 'someone')

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return s + 's'
  if (s < 3600) return Math.floor(s / 60) + 'm'
  if (s < 86400) return Math.floor(s / 3600) + 'h'
  if (s < 86400 * 30) return Math.floor(s / 86400) + 'd'
  return new Date(ms).toISOString().slice(0, 10)
}

/** Escaped text with #tags linked to /t/<tag> and line breaks kept. */
export function richText(text: string): string {
  return esc(text)
    .replace(/(^|[\s(])[#＃]([^\s#＃<&]+)/gu, (all, pre: string, raw: string) => {
      const tag = normalizeTag(raw)
      return tag ? `${pre}<a class="tag" href="/t/${encodeURIComponent(tag)}">#${raw}</a>` : all
    })
    .replace(/\n/g, '<br>')
}

export function layout(ctx: Ctx, title: string, body: string, opts: { head?: string } = {}): string {
  const user = ctx.user
  const auth = user
    ? `<a href="/settings">${esc(displayName(user))}</a>${ctx.admin ? '<a href="/admin">Admin</a>' : ''}<form method="post" action="/signout" class="inline">${csrfField(ctx)}<button class="link">Sign out</button></form>`
    : `<a class="btn small" href="${esc(ctx.signInUrl)}">Sign in with pit.world</a>`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(`The ${ctx.name} community on pit.world: members' posts and the hashtags it follows from the AT Protocol network.`)}">
<meta name="color-scheme" content="light dark">
<link rel="stylesheet" href="${cssHref()}">
<link rel="alternate" type="application/rss+xml" title="${esc(ctx.name)} feed" href="/feed.xml">${opts.head ?? ''}
</head>
<body>
<header class="top">
  <a class="brand" href="/"><span class="dot"></span>${esc(ctx.name)}<span class="muted"> social</span></a>
  <nav><a href="/">Feed</a><a href="https://bbs.${esc(ctx.name)}.pit.world">Board</a><a href="/about">About</a>${auth}</nav>
</header>
<main>
${ctx.flash ? `<p class="flash">${esc(ctx.flash)}</p>` : ''}${ctx.error ? `<p class="flash error">${esc(ctx.error)}</p>` : ''}
${body}
</main>
<footer class="foot">
  <p>Your pit.world account: one sign-in for every *.pit.world site (Sign in with CoinPay). <a href="https://pit.world/account">Manage it at pit.world/account</a>.</p>
  <p class="muted">pit-social ${VERSION} · open source (MIT) · <a href="https://github.com/moshcoder/pit-social">code</a> · <a href="/status">relay status</a> · <a href="/feed.xml">RSS</a></p>
</footer>
</body>
</html>`
}

export function messagePage(ctx: Ctx, title: string, message: string, extra = ''): string {
  return layout(ctx, title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>${extra}`)
}

// ---- posts -------------------------------------------------------------------

export const bskyUrl = (uri: string) => {
  const m = uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/)
  return m ? `https://bsky.app/profile/${encodeURIComponent(m[1]!)}/post/${encodeURIComponent(m[2]!)}` : 'https://bsky.app'
}

export function networkPostHtml(p: NetworkPost, handles: Map<string, string>): string {
  const handle = handles.get(p.did)
  const who = handle ? '@' + handle : p.did.slice(0, 24) + '…'
  const created = Date.parse(p.created_at)
  const when = Number.isFinite(created) && created < Date.now() + 60_000 ? created : p.indexed_at
  const e = p.embed
  const embed = [
    e?.external ? `<a class="embed" rel="nofollow noopener ugc" href="${esc(e.external.uri)}">${esc(e.external.title || e.external.uri)}<span class="muted small"> ${esc(safeHost(e.external.uri))}</span></a>` : '',
    e?.images ? `<span class="muted small">${e.images} image${e.images === 1 ? '' : 's'} (open on the network to see)</span>` : '',
    e?.video ? '<span class="muted small">video (open on the network to see)</span>' : '',
    e?.quote ? `<a class="muted small" rel="nofollow noopener" href="${esc(bskyUrl(e.quote))}">quotes a post</a>` : '',
  ].filter(Boolean)
  return `<article class="post network">
  <header><span class="who">${esc(who)}</span> <span class="badge net">network</span> <time datetime="${esc(new Date(when).toISOString())}">${ago(when)}</time></header>
  <div class="text">${richText(p.text)}</div>
  ${embed.length ? `<div class="embeds">${embed.join(' ')}</div>` : ''}
  <footer class="muted small">From the AT Protocol network, via ${esc(p.relays.join(', '))} · <a rel="nofollow noopener" href="${esc(bskyUrl(p.uri))}">view on bsky.app</a>${p.reply_parent ? ' · a reply' : ''}</footer>
</article>`
}

const safeHost = (u: string) => {
  try {
    return new URL(u).host
  } catch {
    return ''
  }
}

export function localPostHtml(ctx: Ctx, p: LocalPost, opts: { link?: boolean } = {}): string {
  const mine = ctx.user?.sub === p.sub
  const actions = ctx.user
    ? [
        mine ? `<form method="post" action="/p/${esc(p.id)}/delete" class="inline">${csrfField(ctx)}<button class="link">delete</button></form>` : `<form method="post" action="/p/${esc(p.id)}/report" class="inline">${csrfField(ctx)}<button class="link">report</button></form>`,
        ctx.admin ? `<form method="post" action="/admin/hide" class="inline">${csrfField(ctx)}<input type="hidden" name="id" value="${esc(p.id)}"><input type="hidden" name="hidden" value="${p.hidden ? '0' : '1'}"><button class="link">${p.hidden ? 'unhide' : 'hide'}</button></form>` : '',
      ].join(' ')
    : ''
  return `<article class="post local${p.hidden ? ' hidden' : ''}">
  <header><a class="who" href="/u/${esc(shortSub(p.sub))}">${esc(displayName(p.author))}</a> <span class="badge">member</span> <a class="muted" href="/p/${esc(p.id)}"><time datetime="${new Date(p.created_at).toISOString()}">${ago(p.created_at)}</time></a>${p.hidden ? ' <span class="badge warn">hidden</span>' : ''}</header>
  <div class="text">${richText(p.text)}</div>
  <footer class="muted small">Posted here by a member${opts.link !== false ? ` · <a href="/p/${esc(p.id)}">${p.replies ? `${p.replies} repl${p.replies === 1 ? 'y' : 'ies'}` : 'reply'}</a>` : ''} ${actions}</footer>
</article>`
}

export function composeForm(ctx: Ctx, opts: { parent?: string; placeholder?: string } = {}): string {
  if (!ctx.user) return `<p class="panel">Members can post here. <a href="${esc(ctx.signInUrl)}">Sign in with pit.world</a>: the one account for every *.pit.world site.</p>`
  return `<form class="panel compose" method="post" action="/posts">${csrfField(ctx)}
  ${opts.parent ? `<input type="hidden" name="parent" value="${esc(opts.parent)}">` : ''}
  <label for="text" class="sr">Post</label>
  <textarea id="text" name="text" rows="3" maxlength="3000" required placeholder="${esc(opts.placeholder ?? 'Write something. #hashtags work.')}"></textarea>
  <div class="row"><span class="muted small">Up to 3000 characters. Posts stay on this site for now.</span><button>${opts.parent ? 'Reply' : 'Post'}</button></div>
</form>`
}

export type FeedItem = { kind: 'network'; at: number; post: NetworkPost } | { kind: 'local'; at: number; post: LocalPost }

export function feedPage(ctx: Ctx, c: Community, opts: { tab: 'all' | 'network' | 'members'; tag: string | null; items: FeedItem[]; handles: Map<string, string>; more: string | null }): string {
  const base = opts.tag ? `/t/${encodeURIComponent(opts.tag)}` : '/'
  const tab = (id: string, label: string) => `<a class="${opts.tab === id ? 'on' : ''}" href="${base}${id === 'all' ? '' : '?tab=' + id}">${label}</a>`
  const chips = c.tags.map((t) => `<a class="chip${opts.tag === t ? ' on' : ''}" href="/t/${encodeURIComponent(t)}">#${esc(t)}</a>`).join('')
  const list = opts.items.length
    ? opts.items.map((i) => (i.kind === 'network' ? networkPostHtml(i.post, opts.handles) : localPostHtml(ctx, i.post))).join('\n')
    : `<p class="empty">Nothing here yet. ${opts.tab === 'members' ? 'Be the first member to post.' : 'Posts from the network appear as soon as someone uses one of these tags.'}</p>`
  return layout(
    ctx,
    opts.tag ? `#${opts.tag} · ${ctx.name}` : `${ctx.name} social`,
    `<section class="intro"><h1>${opts.tag ? '#' + esc(opts.tag) : esc(ctx.name)}</h1>
<p class="muted">${opts.tag ? `In the ${esc(ctx.name)} community.` : `Members of ${esc(ctx.name)}, plus what the AT Protocol network is saying under the tags this community follows.`}</p>
<nav class="chips">${opts.tag ? '<a class="chip" href="/">all tags</a>' : ''}${chips}</nav></section>
${composeForm(ctx)}
<nav class="tabs">${tab('all', 'All')}${tab('network', 'Network')}${tab('members', 'Members')}</nav>
<section class="feed">${list}</section>
${opts.more ? `<p class="more"><a class="btn" href="${esc(opts.more)}">Older</a></p>` : ''}`,
  )
}

export function postPage(ctx: Ctx, p: LocalPost, replies: LocalPost[], parent: LocalPost | null): string {
  return layout(
    ctx,
    `${displayName(p.author)} · ${ctx.name}`,
    `${parent ? `<p class="muted small">In reply to <a href="/p/${esc(parent.id)}">${esc(displayName(parent.author))}</a></p>` : ''}
${localPostHtml(ctx, p, { link: false })}
<h2>Replies</h2>
<section class="feed replies">${replies.map((r) => localPostHtml(ctx, r, { link: false })).join('\n') || '<p class="empty">No replies yet.</p>'}</section>
${composeForm(ctx, { parent: p.id, placeholder: 'Reply…' })}`,
  )
}

export function userPage(ctx: Ctx, u: User, posts: LocalPost[], role: string | null): string {
  return layout(
    ctx,
    `${displayName(u)} · ${ctx.name}`,
    `<h1>${esc(displayName(u))}</h1>
<p class="muted">${u.username ? '@' + esc(u.username) + ' · ' : ''}${role ? (role === 'admin' ? 'community admin' : 'member') : 'not a member here yet'} · pit.world account since ${new Date(u.created_at).toISOString().slice(0, 10)}</p>
<section class="feed">${posts.map((p) => localPostHtml(ctx, p)).join('\n') || '<p class="empty">No posts here yet.</p>'}</section>`,
  )
}

// ---- status, about, admin, settings -----------------------------------------------

export function statusPage(ctx: Ctx, s: StatusData): string {
  const rows = s.relays
    .map((r) => {
      const st = r.stats as any
      return `<tr><td><code>${esc(st.label ?? r.url)}</code><div class="muted small">${esc(r.kind)}</div></td><td><span class="state ${esc(r.state)}">${esc(r.state)}</span></td><td>${esc(st.eps ?? 0)}</td><td>${st.lagMs == null ? '–' : esc(Math.round(st.lagMs / 100) / 10) + 's'}</td><td>${st.lastEventAt ? ago(st.lastEventAt) + ' ago' : '–'}</td><td>${esc(st.matched ?? 0)}</td><td>${esc(st.reconnects ?? 0)} / ${esc(st.sheds ?? 0)}</td><td class="small">${esc(st.lastError ?? '')}</td></tr>`
    })
    .join('')
  return layout(
    ctx,
    `Status · ${ctx.name}`,
    `<h1>Relay status</h1>
<p>${s.ingest ? 'Ingestion is running.' : 'Ingestion is not running in this process; the last known state is shown.'} This community follows ${s.tags.length} tags and holds ${s.networkPosts} network posts and ${s.localPosts} member posts.</p>
<div class="scroll"><table class="status"><thead><tr><th>Relay</th><th>State</th><th>Events/s</th><th>Lag</th><th>Last event</th><th>Matched</th><th>Reconnects / sheds</th><th>Last error</th></tr></thead><tbody>${rows || '<tr><td colspan="8">No relay has reported yet.</td></tr>'}</tbody></table></div>
<p class="muted small">Matched counts posts carrying any community's tags, across every community on this server. JSON: <a href="/api/v1/status">/api/v1/status</a>.</p>`,
  )
}

export type StatusData = { ingest: boolean; relays: RelayRow[]; tags: string[]; networkPosts: number; localPosts: number }

export function aboutPage(ctx: Ctx, c: Community, relays: string[]): string {
  const origin = originFor(ctx.name)
  return layout(
    ctx,
    `About · ${ctx.name}`,
    `<h1>About ${esc(ctx.name)} social</h1>
<p>This is the social side of <b>${esc(ctx.name)}</b>, a name on the <a href="https://pit.world">Moshpit network</a>. It does two things:</p>
<ul>
<li><b>Members post here.</b> Sign in with your pit.world account, the same one for every *.pit.world site (it is Sign in with CoinPay underneath). No new account, no password.</li>
<li><b>It follows the AT Protocol network</b> (the open network Bluesky runs on) for the hashtags this community cares about, reading every public relay below at once and keeping one copy of each post. We read the public firehose anonymously: no account on Bluesky or anywhere else.</li>
</ul>
<h2>Tags followed</h2>
<p class="chips">${c.tags.map((t) => `<a class="chip" href="/t/${encodeURIComponent(t)}">#${esc(t)}</a>`).join('') || 'none yet'}</p>
<p class="muted small">${c.tags_source === 'admin' ? 'Chosen by this community\'s admins.' : 'Chosen automatically from the name and its pit.world listing, until an admin edits them.'}</p>
<h2>Relays</h2>
<ul>${relays.map((r) => `<li><code>${esc(r)}</code></li>`).join('')}</ul>
<p>Live health: <a href="/status">/status</a>.</p>
<h2>Read it anywhere</h2>
<ul>
<li>RSS: <a href="/feed.xml">${esc(origin)}/feed.xml</a> · JSON: <a href="/api/v1/feed">/api/v1/feed</a></li>
<li>AT Protocol feed generator: <code>${esc(feedUriFor(ctx.name))}</code>, served by <code>${esc(didFor(ctx.name))}</code> (<a href="/.well-known/did.json">did.json</a>). An AT Protocol client or AppView can call <code>app.bsky.feed.getFeedSkeleton</code> on this host directly.</li>
<li>Terminal: <code>bunx pitsocial feed ${esc(ctx.name)}</code>; AI assistants: <code>pitsocial mcp</code>.</li>
</ul>
<h2>Elsewhere</h2>
<ul><li>The board: <a href="https://bbs.${esc(ctx.name)}.pit.world">bbs.${esc(ctx.name)}.pit.world</a></li><li>Your account: <a href="https://pit.world/account">pit.world/account</a></li></ul>
<p class="muted small">Posts from the network belong to their authors; deletes on the network delete them here. Member posts stay on this site for now.</p>`,
  )
}

export function adminPage(ctx: Ctx, c: Community, opts: { queue: LocalPost[]; members: (User & { role: string })[]; global: boolean }): string {
  return layout(
    ctx,
    `Admin · ${ctx.name}`,
    `<h1>Admin</h1>
<form class="panel" method="post" action="/admin/tags">${csrfField(ctx)}
<h2>Tags this community follows</h2>
<p class="muted small">Up to 30, one per line or separated by commas. Network posts carrying any of these are pulled in. Avoid words everyone uses (#family) unless you want everything.</p>
<textarea name="tags" rows="8">${esc(c.tags.join('\n'))}</textarea>
<div class="row"><span class="muted small">${c.tags_source === 'admin' ? 'Edited by an admin.' : 'Automatic.'}</span><button>Save tags</button></div>
</form>
<form class="panel" method="post" action="/admin/tags/reset">${csrfField(ctx)}<div class="row"><span>Go back to the automatic tags (from the name and the pit.world listing).</span><button class="secondary">Reset</button></div></form>
<h2>Reported and hidden posts</h2>
<section class="feed">${opts.queue.map((p) => localPostHtml(ctx, p) + `<p class="muted small">${p.reports} report${p.reports === 1 ? '' : 's'}</p>`).join('\n') || '<p class="empty">Nothing to look at.</p>'}</section>
<h2>Members (${opts.members.length})</h2>
<ul class="members">${opts.members.map((m) => `<li><a href="/u/${esc(shortSub(m.sub))}">${esc(displayName(m))}</a> <span class="muted small"><code>${esc(m.sub)}</code> · ${esc(m.role)}</span></li>`).join('') || '<li class="muted">No members yet.</li>'}</ul>
${
  opts.global
    ? `<form class="panel" method="post" action="/admin/role">${csrfField(ctx)}<h2>Community admins</h2><p class="muted small">Global admins (PIT_SOCIAL_ADMINS) can make anyone an admin of this community by their pit.world sub.</p>
<label>sub<input name="sub" required maxlength="300" placeholder="did:key:..."></label>
<div class="row"><select name="role"><option value="admin">make admin</option><option value="member">make member</option></select><button>Save</button></div></form>`
    : ''
}`,
  )
}

export function settingsPage(ctx: Ctx, tokens: { id: string; label: string | null; created_at: number; last_used_at: number | null }[], fresh: string | null): string {
  const u = ctx.user!
  return layout(
    ctx,
    'Settings',
    `<h1>Settings</h1>
<p>Signed in as <b>${esc(displayName(u))}</b> through pit.world. Your id is <code>${esc(u.sub)}</code>; it is the same on every social.*.pit.world site. Name, email and sign-in are managed at <a href="https://pit.world/account">pit.world/account</a>.</p>
<h2>API tokens</h2>
<p class="muted small">For the <code>pitsocial</code> CLI, MCP and scripts: <code>Authorization: Bearer ps_...</code>. A token can post as you on any social.* site.</p>
${fresh ? `<p class="flash">New token (shown once): <code class="token">${esc(fresh)}</code></p>` : ''}
<ul class="tokens">${tokens.map((t) => `<li><b>${esc(t.label ?? 'token')}</b> <span class="muted small">made ${ago(t.created_at)} ago${t.last_used_at ? ', used ' + ago(t.last_used_at) + ' ago' : ', never used'}</span> <form method="post" action="/settings/tokens/${esc(t.id)}/revoke" class="inline">${csrfField(ctx)}<button class="link">revoke</button></form></li>`).join('') || '<li class="muted">None yet.</li>'}</ul>
<form class="panel" method="post" action="/settings/tokens">${csrfField(ctx)}<label>Label<input name="label" maxlength="80" placeholder="laptop CLI"></label><button>Make a token</button></form>`,
  )
}
