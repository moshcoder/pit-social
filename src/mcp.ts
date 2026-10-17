/**
 * `pitsocial mcp`: the social side of every Moshpit name as an MCP server on stdio.
 *
 *   claude mcp add pitsocial -- pitsocial mcp
 *   PIT_SOCIAL_TOKEN=ps_... lets the assistant post as you (make one at /settings).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { SocialClient, formatItem, formatStatus } from './client.js'
import { VERSION } from './html.js'

const text = (value: string) => ({ content: [{ type: 'text', text: value }] })
const NAME = z.string().min(3).max(200).describe('a Moshpit name, like family.ancestry or seo.rank')

export function createMcpServer(client = new SocialClient()): McpServer {
  // Typed loosely: the SDK's generic tool() signature recurses past TypeScript's limits with zod shapes.
  const server: any = new McpServer({ name: 'pit-social', version: VERSION })
  server.tool(
    'read_feed',
    "Read a community's feed at social.<name>.pit.world: members' posts mixed with AT Protocol network posts under the community's hashtags.",
    { name: NAME, tag: z.string().max(64).optional(), tab: z.enum(['all', 'network', 'members']).optional(), limit: z.number().int().min(1).max(100).optional() },
    async ({ name, tag, tab, limit }: any) => {
      const feed = await client.feed(name, { tag, tab, limit: limit ?? 20 })
      return text(feed.items.length ? feed.items.map(formatItem).join('\n\n') : `Nothing yet. Tags: ${feed.tags.map((t) => '#' + t).join(' ')}`)
    },
  )
  server.tool('list_tags', 'The hashtags a community follows on the AT Protocol network.', { name: NAME }, async ({ name }: any) => text((await client.tags(name)).tags.map((t) => '#' + t).join(' ')))
  server.tool('relay_status', 'Health of every relay and jetstream the server reads: state, events per second, lag, matched posts.', { name: NAME }, async ({ name }: any) => text(formatStatus(await client.status(name))))
  server.tool(
    'post',
    'Post to a community as the token owner (needs PIT_SOCIAL_TOKEN). Up to 3000 characters; #hashtags work. Give reply_to (a post id) to reply.',
    { name: NAME, text: z.string().min(1).max(3000), reply_to: z.string().max(40).optional() },
    async ({ name, text: body, reply_to }: any) => text(`Posted: ${(await client.post(name, body, reply_to)).url}`),
  )
  return server
}

export async function runMcp() {
  await createMcpServer().connect(new StdioServerTransport())
}
