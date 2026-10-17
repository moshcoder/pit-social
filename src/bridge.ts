/**
 * "Sign in with pit.world": one @profullstack/bridges client per community host.
 *
 * For host H = social.<name>.pit.world the client id is H, the callback is
 * https://H/auth/bridge/callback, and the secret is derived, so pit.world and we
 * share one key (PIT_BRIDGE_KEY) instead of one secret per community:
 *
 *   clientSecret = base64url(HMAC-SHA256(key = PIT_BRIDGE_KEY, message = clientId)), no padding
 */
import { createHmac } from 'node:crypto'
import { createBridgeClient, type BridgeClient } from '@profullstack/bridges'
import { hostFor } from './names.js'

export const bridgeSecret = (key: string, clientId: string) => createHmac('sha256', key).update(clientId).digest('base64url')

export type BridgeConfig = { key: string; authorizeUrl: string; tokenUrl: string; fetch?: typeof fetch }

export function bridgeConfigFromEnv(env = process.env): BridgeConfig | null {
  const key = env.PIT_BRIDGE_KEY?.trim()
  if (!key) return null
  const base = (env.PIT_WORLD_URL ?? 'https://pit.world').replace(/\/+$/, '')
  return { key, authorizeUrl: env.PIT_BRIDGE_AUTHORIZE_URL ?? base + '/bridge/authorize', tokenUrl: env.PIT_BRIDGE_TOKEN_URL ?? base + '/bridge/token' }
}

export class Bridges {
  private clients = new Map<string, BridgeClient>()
  constructor(private readonly config: BridgeConfig) {}

  /** The client for a community, built on first use. */
  forName(name: string): BridgeClient {
    let client = this.clients.get(name)
    if (!client) {
      const clientId = hostFor(name)
      client = createBridgeClient({
        authorizeUrl: this.config.authorizeUrl,
        tokenUrl: this.config.tokenUrl,
        clientId,
        clientSecret: bridgeSecret(this.config.key, clientId),
        redirectUri: `https://${clientId}/auth/bridge/callback`,
        ...(this.config.fetch ? { fetch: this.config.fetch } : {}),
      })
      if (this.clients.size > 5000) this.clients.clear()
      this.clients.set(name, client)
    }
    return client
  }
}
