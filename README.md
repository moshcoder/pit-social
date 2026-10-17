# pit-social

The social side of every Moshpit name. One process serves **`social.<name>.pit.world`**
for every name: `social.family.ancestry.pit.world`, `social.seo.rank.pit.world`, and
whatever gets registered next. A community starts the first time someone visits. There is
no setup step. Open source (MIT).

Each community has two kinds of posts:

- **Members' posts.** People sign in with **pit.world**, the one account for every
  `*.pit.world` site (Sign in with CoinPay underneath), and write posts and replies. They
  don't make a new account or set a password.
- **The AT Protocol network, filtered to the niche.** One process reads every public relay
  and jetstream at the same time, merges them, keeps one copy of each post, and stores the
  posts that carry a hashtag one of the communities follows. The network posts are labelled
  with the relays that carried them and link to the post on bsky.app.

We read the public firehose anonymously and read-only. We don't create accounts on Bluesky
or any other service, and we don't authenticate to any relay.

## Every surface

| | |
|---|---|
| Web | `https://social.<name>.pit.world`: feed (All / Network / Members, tag chips), `/t/<tag>`, `/p/<id>`, `/u/<id>`, `/about`, `/status`, `/admin`, `/settings`. Server-rendered, no JavaScript, light and dark |
| API | `/api/v1/*` JSON, below |
| AT Protocol | a feed generator per name: `did:web:social.<name>.pit.world`, feed `at://did:web:social.<name>.pit.world/app.bsky.feed.generator/niche` |
| RSS | `/feed.xml` (`?tag=` works) |
| CLI | `bun add -g pitsocial`, then `pitsocial feed family.ancestry` |
| MCP | `claude mcp add pitsocial -- pitsocial mcp` |
| TUI | not in v0.1 (see the roadmap) |

### CLI

```sh
pitsocial feed family.ancestry               # members + network, newest first
pitsocial feed seo.rank --tag seo --tab network
pitsocial tags family.ancestry
pitsocial status family.ancestry             # every relay: state, events/s, lag, matched
pitsocial post family.ancestry "Found the 1880 census page! #genealogy" --token ps_...
pitsocial serve                              # run the server
pitsocial mcp                                # MCP server on stdio
```

`--json` prints JSON. `PIT_SOCIAL_TOKEN` saves passing `--token`; make a token at
`https://social.<name>.pit.world/settings`. `PIT_SOCIAL_URL=http://127.0.0.1:8794` sends
every name to one server. The name travels as `X-Pit-Name`, and the server believes that
header only from loopback.

### MCP tools

`read_feed`, `list_tags`, `relay_status`, `post`. `post` needs `PIT_SOCIAL_TOKEN` and posts
as the token's owner.

### API

| | |
|---|---|
| `GET /api/v1/feed?tab=all\|network\|members&tag=&limit=&before=&cursor=` | items, newest first, with a `next` link |
| `GET /api/v1/tags` | the tags this community follows |
| `GET /api/v1/status` | relay health and counts |
| `GET /api/v1/me` | who the session or token is |
| `POST /api/v1/posts` | `{text, reply_to?}` with `Authorization: Bearer ps_...` (30 an hour) |
| `GET /api/v1/posts/:id`, `DELETE /api/v1/posts/:id` | one member post with its replies; delete your own |
| `GET /.well-known/did.json` | `did:web` document with a `#bsky_fg` service |
| `GET /xrpc/app.bsky.feed.describeFeedGenerator` | the one feed |
| `GET /xrpc/app.bsky.feed.getFeedSkeleton?feed=&limit=&cursor=` | network post URIs, newest first |

## How it works

### Which community

pit.world is the front door. It forwards `social.<name>.pit.world` to `127.0.0.1:8794`,
keeps `Host`, and adds `X-Pit-Name`, `X-Real-IP` and `X-Forwarded-Proto`. Those headers are
believed only when the TCP peer is loopback. From any other peer the name comes from
`Host`: a `social.` prefix, a `.pit.world` suffix, and two or more DNS labels in between.
Anything else gets a 404. pit.world forwards only names that exist, so the community row
is created on first request.

### Tags

A new community starts with tags derived from its name:

- the labels joined (`#familyancestry`)
- each label, unless it is too generic to follow alone (`#family` is everyone's dinner)
- synonyms from a small built-in map (`ancestry` → `#genealogy #familyhistory #familytree`;
  `seo` → `#searchengineoptimization`)
- a few niche words from the name's pit.world listing (`GET https://pit.world/api/listing?domain=<name>`)

The tags refresh weekly until an admin edits them on `/admin`. A community can follow at
most 30 tags.

### Relays, all at once

`src/ingest.ts` opens every relay in `PIT_SOCIAL_RELAYS` at once:

- **jetstream** (`/subscribe?wantedCollections=app.bsky.feed.post`): JSON, already
  filtered to posts, about 0.05 MB/s.
- **full relays** (`com.atproto.sync.subscribeRepos`): one CBOR header and one CBOR body
  per frame, with records inside a CAR. Decoding uses
  [`@atcute/cbor`](https://www.npmjs.com/package/@atcute/cbor) and
  [`@atcute/car`](https://www.npmjs.com/package/@atcute/car). Commits with no post create
  or delete are skipped before the CAR is opened, so a full relay costs about 10 ms of CPU
  per second under Bun. Its bandwidth is about 2.4 MB/s.

Only `app.bsky.feed.post` creates are considered. Hashtags come from
`app.bsky.richtext.facet#tag` facets, from `#word` in the text, and from the record's
`tags`. A post is kept only if some community follows one of its tags; an in-memory map
from tag to communities is rebuilt whenever tags change. A post seen on several relays is
stored once (deduplicated by at-uri), and the record keeps every relay that carried it.
When the author deletes a post on the network, we delete it here too. We store the text,
tags, langs, `createdAt`, an embed summary (link title and URL, image count, quote) and
the relays. We never download images. Handles are resolved lazily from plc.directory for
display and cached for a day; a failed lookup only means the DID is shown instead.

Each relay:

- reconnects on its own with jittered backoff (1 s up to 60 s)
- keeps a cursor (seq, or jetstream `time_us`) and replays it only when it is less than
  10 minutes old
- reconnects after 90 s of silence

When a relay's events arrive more than `PIT_SOCIAL_MAX_LAG_S` (120 s) late for 30 s, its
backlog is shed: the cursor is dropped and the relay reconnects live, and the shed is
logged. If it is still that late after a live reconnect, the relay itself is behind
upstream, so we leave it alone for 10 minutes and say so on `/status`. One bad relay never
stops the others. Network posts are pruned hourly: older than `PIT_SOCIAL_RETENTION_DAYS`
(30), and beyond `PIT_SOCIAL_CAP` (20,000) per community.

Relay health (state, events/s, lag, last event, matched, reconnects, sheds, last error) is
saved to the database every 5 s, so `/status` and `/api/v1/status` work even from a web
process running with `PIT_SOCIAL_INGEST=off`.

### Sign in with pit.world

This is a [`@profullstack/bridges`](https://github.com/profullstack/bridges) client. For
host `H = social.<name>.pit.world`:

```
authorizeUrl = https://pit.world/bridge/authorize
tokenUrl     = https://pit.world/bridge/token
clientId     = H
redirectUri  = https://H/auth/bridge/callback
clientSecret = base64url(HMAC-SHA256(key = PIT_BRIDGE_KEY, message = clientId))   # no padding
```

The routes are `GET /auth/bridge` (begin), `GET /auth/bridge/callback` and `POST /signout`.
A visitor who isn't signed in is tried once per browser session with `prompt=none`. If
pit.world answers `login_required`, a session cookie stops it from looping. Bots, API calls
and non-navigation requests are never bounced, and `PIT_SOCIAL_BRIDGE_AUTO=off` turns
silent sign-in off.

A person is one `users` row per bridge `sub` (their CoinPay DID) across **all**
communities. Membership in a community starts with their first post there. Only `sub`
links accounts, never email. A session works only on the host it was made for.

Admins: the subs in `PIT_SOCIAL_ADMINS` are admins everywhere and can make anyone an admin
of one community on `/admin`. Signing in first doesn't make you an admin. Admins edit tags
and hide reported posts. Members can report posts and delete their own.

### Security

- Pages use a strict CSP: `default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'`.
- Writes are protected by a double-submit CSRF cookie plus `Sec-Fetch-Site`. JSON writes
  with a session need a same-origin `Origin`. Bearer tokens are exempt, because a browser
  never sends them on its own.
- Everything from the network is HTML-escaped, and links from it are `nofollow`.
- API tokens are stored only as SHA-256 hashes.
- Every SQL string is a plain literal (no template literals, no concatenation), so the
  threatcrush scan in CI stays at zero findings.

## Running it

```sh
bun install
PIT_SOCIAL_INGEST=off bun src/server.ts      # http://127.0.0.1:8794, data in ~/.local/share/pit-social
curl -H 'x-pit-name: family.ancestry' http://127.0.0.1:8794/api/v1/tags
bun test && bunx tsc --noEmit
bun scripts/smoke-relays.ts 20               # join every relay for 20 s, print what each delivered
```

Every variable, with defaults, is in [`deploy/app.env.example`](deploy/app.env.example).

## Deploy on dev2

The service runs as root from `/opt/pit-social` and listens on `127.0.0.1:8794` only.
pit.world terminates TLS for `social.<name>.pit.world` and forwards to it, so there is no
nginx site for this app.

```sh
git clone https://github.com/moshcoder/pit-social /opt/pit-social
install -d -m 700 /root/.local/share/pit-social
cp /opt/pit-social/deploy/app.env.example /root/.local/share/pit-social/app.env
chmod 600 /root/.local/share/pit-social/app.env
#   set PIT_BRIDGE_KEY (the same key pit.world derives client secrets from) and PIT_SOCIAL_ADMINS
cd /opt/pit-social && ./bin/install.sh       # OpenInstall: bun install, systemd unit pit-social, health check on /health
```

`bin/install.sh` (settings in `bin/install.conf`) writes and manages its own
`pit-social.service`. It reads `/root/.local/share/pit-social/app.env`, and the database
goes to `/root/.local/share/pit-social/pit-social.db`. If you would rather install the
hand-written unit [`deploy/pit-social.service`](deploy/pit-social.service), copy it to
`/etc/systemd/system/` and skip `install.sh activate`. `install.sh` refuses to overwrite a
unit it did not write.

To have CI deploy every merge, as family.ancestry does, install
[`deploy/pit-social-deploy`](deploy/pit-social-deploy) as `/usr/local/bin/pit-social-deploy`.
Then add a root key restricted to it (`restrict,command="/usr/local/bin/pit-social-deploy"`)
and set the repo secrets `PS_DEPLOY_KEY` and `PS_KNOWN_HOSTS`. Until those secrets are set,
`.github/workflows/deploy.yml` does nothing.

Bandwidth: each full relay is about 2.4 MB/s (about 200 GB/day) inbound, and a jetstream
is about 0.05 MB/s. The default list has five full relays. To cut traffic, set
`PIT_SOCIAL_RELAYS` to the jetstreams plus one or two full relays.

## Roadmap

- **Publish member posts to the network.** Local posts are already stored as
  `app.bsky.feed.post` records (text, tag facets with UTF-8 byte offsets, `createdAt`), so
  a later version can write them from a PDS. v0.1 does **not** publish anything to the
  network.
- **Make the feed discoverable in Bluesky.** The feed generator endpoints and the
  `did:web` document are live. For the Bluesky app to list the feed, an
  `app.bsky.feed.generator` record has to be published in some repo, which needs a PDS
  account. We deliberately don't create one in v0.1.
- A TUI (`pitsocial tui`).
- Images, as links to the author's PDS blob, never stored here.

## License

MIT
