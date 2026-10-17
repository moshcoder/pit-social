/**
 * `pitsocial`: every social.<name>.pit.world from the terminal.
 */
import { ApiError, SocialClient, formatItem, formatStatus } from './client.js'
import { VERSION } from './html.js'

const HELP = `pitsocial ${VERSION}: the social side of every Moshpit name (social.<name>.pit.world)

  pitsocial feed <name> [--tag t] [--tab all|network|members] [--limit n]
  pitsocial tags <name>
  pitsocial status <name>             relay health and counts
  pitsocial post <name> <text...> [--reply-to ID] [--token ps_...]
  pitsocial serve [--port 8794]       run the server (every name, one process)
  pitsocial mcp                       MCP server on stdio (claude mcp add pitsocial -- pitsocial mcp)

  Flags: --json prints JSON.
  Env: PIT_SOCIAL_TOKEN (make one at https://social.<name>.pit.world/settings),
       PIT_SOCIAL_URL (one server for every name, e.g. http://127.0.0.1:8794).
`

type Args = { _: string[]; flags: Record<string, string | true> }

export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--') {
      out._.push(...argv.slice(i + 1))
      break
    }
    const m = a.match(/^--?([A-Za-z][\w-]*)(?:=(.*))?$/)
    if (m) {
      const key = { h: 'help', v: 'version', t: 'tag', n: 'limit' }[m[1]!] ?? m[1]!
      if (m[2] !== undefined) out.flags[key] = m[2]
      else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('-') && !['json', 'help', 'version'].includes(key)) out.flags[key] = argv[++i]!
      else out.flags[key] = true
    } else out._.push(a)
  }
  return out
}

const str = (v: string | true | undefined) => (typeof v === 'string' ? v : undefined)

export async function runCli(argv: string[], out: (s: string) => void = (s) => console.log(s), clientFor = (token?: string, url?: string) => new SocialClient({ token, url })): Promise<number> {
  const { _: args, flags } = parseArgs(argv)
  const [cmd, name, ...rest] = args
  if (flags.version) return out(VERSION), 0
  if (!cmd || flags.help || cmd === 'help') return out(HELP), 0
  const client = clientFor(str(flags.token), str(flags.url))
  const json = !!flags.json
  try {
    switch (cmd) {
      case 'serve': {
        if (str(flags.port)) process.env.PORT = str(flags.port)
        const { serve } = await import('./server.js')
        serve()
        await new Promise(() => {})
        return 0
      }
      case 'mcp': {
        const { runMcp } = await import('./mcp.js')
        await runMcp()
        return 0
      }
      case 'feed': {
        if (!name) throw new ApiError(400, 'usage: pitsocial feed <name> [--tag t]')
        const tab = str(flags.tab) as 'all' | 'network' | 'members' | undefined
        const feed = await client.feed(name, { tag: str(flags.tag), tab, limit: Number(str(flags.limit) ?? 20) })
        if (json) out(JSON.stringify(feed, null, 2))
        else out(feed.items.length ? feed.items.map(formatItem).join('\n\n') : `Nothing yet in ${feed.community}. Tags: ${feed.tags.map((t) => '#' + t).join(' ')}`)
        return 0
      }
      case 'tags': {
        if (!name) throw new ApiError(400, 'usage: pitsocial tags <name>')
        const t = await client.tags(name)
        out(json ? JSON.stringify(t, null, 2) : t.tags.map((x) => '#' + x).join('\n'))
        return 0
      }
      case 'status': {
        if (!name) throw new ApiError(400, 'usage: pitsocial status <name>')
        const s = await client.status(name)
        out(json ? JSON.stringify(s, null, 2) : formatStatus(s))
        return 0
      }
      case 'post': {
        const text = rest.join(' ').trim()
        if (!name || !text) throw new ApiError(400, 'usage: pitsocial post <name> <text...> [--token ps_...]')
        const p = await client.post(name, text, str(flags['reply-to']))
        out(json ? JSON.stringify(p, null, 2) : `Posted: ${p.url}`)
        return 0
      }
      default:
        out(HELP)
        return 2
    }
  } catch (error) {
    console.error(`pitsocial: ${(error as Error).message}`)
    return error instanceof ApiError && error.status === 401 ? 3 : 1
  }
}
