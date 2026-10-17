import { describe, expect, test } from 'bun:test'
import { runCli, parseArgs } from '../src/cli.ts'
import { SocialClient } from '../src/client.ts'
import { createMcpServer } from '../src/mcp.ts'
import { harness } from './harness.ts'

describe('cli', () => {
  test('args', () => {
    expect(parseArgs(['feed', 'seo.rank', '--tag', 'seo', '--json'])).toEqual({ _: ['feed', 'seo.rank'], flags: { tag: 'seo', json: true } })
  })

  test('feed, tags, status and post through one local server', async () => {
    const h = harness()
    await h.req('/')
    await h.signIn('did:key:z6MkAlice', { name: 'Alice' })
    const token = (await (await h.formPost('/settings/tokens', { label: 'cli' })).text()).match(/ps_[A-Za-z0-9_-]+/)![0]
    // PIT_SOCIAL_URL style: one server, the name travels as X-Pit-Name from loopback.
    const local = (async (input: any, init: any) => h.app.request(String(input), init, { peer: '127.0.0.1' })) as typeof fetch
    const clientFor = (t?: string) => new SocialClient({ url: 'http://127.0.0.1:8794', token: t, fetch: local })
    const lines: string[] = []
    const out = (s: string) => void lines.push(s)
    expect(await runCli(['post', 'family.ancestry', 'hello', 'from', 'the', 'terminal', '#genealogy', '--token', token], out, clientFor)).toBe(0)
    expect(lines.at(-1)).toMatch(/^Posted: https:\/\/social\.family\.ancestry\.pit\.world\/p\//)
    expect(await runCli(['feed', 'family.ancestry'], out, clientFor)).toBe(0)
    expect(lines.at(-1)).toContain('hello from the terminal #genealogy')
    expect(await runCli(['tags', 'family.ancestry'], out, clientFor)).toBe(0)
    expect(lines.at(-1)).toContain('#genealogy')
    expect(await runCli(['status', 'family.ancestry', '--json'], out, clientFor)).toBe(0)
    expect(JSON.parse(lines.at(-1)!).community).toBe('family.ancestry')
    expect(await runCli(['post', 'family.ancestry', 'no token'], out, () => clientFor(undefined))).toBe(3)
    expect(await runCli(['feed', 'notaname'], out, clientFor)).toBe(1)
  })

  test('mcp server builds with its four tools', () => {
    const server: any = createMcpServer(new SocialClient({ url: 'http://127.0.0.1:1' }))
    expect(Object.keys(server._registeredTools).sort()).toEqual(['list_tags', 'post', 'read_feed', 'relay_status'])
  })
})
