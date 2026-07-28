/**
 * PMOVES MCP Catalog Client — brokers the gateway-agent tool registry.
 */

export interface MCPRegistryEntry {
  name: string
  description: string
  transport: 'stdio' | 'sse' | 'http'
  endpoint?: string
  args?: string[]
  env_required?: string[]
  source: string
}

const DEFAULT_GATEWAY_URL = process.env.GATEWAY_AGENT_URL ?? 'http://gateway-agent:8111'
const DEFAULT_TTL = Number(process.env.MCP_CATALOG_TTL ?? 300) * 1000

class MCPCatalogClientImpl {
  private gatewayUrl: string
  private ttlMs: number
  private cache: MCPRegistryEntry[] | null = null
  private cacheTime = 0
  private fetching: Promise<MCPRegistryEntry[]> | null = null

  constructor() {
    this.gatewayUrl = DEFAULT_GATEWAY_URL
    this.ttlMs = DEFAULT_TTL
  }

  async list(): Promise<MCPRegistryEntry[]> {
    if (this.cache && Date.now() - this.cacheTime < this.ttlMs) return this.cache
    if (this.fetching) return this.fetching
    this.fetching = this.refresh()
    return this.fetching
  }

  async get(name: string): Promise<MCPRegistryEntry | null> {
    const entries = await this.list()
    return entries.find((e) => e.name === name) ?? null
  }

  async refresh(): Promise<MCPRegistryEntry[]> {
    this.fetching = this.doRefresh()
    try { return await this.fetching } finally { this.fetching = null }
  }

  private async doRefresh(): Promise<MCPRegistryEntry[]> {
    const entries = await this.fetchFromGateway()
    this.cache = entries
    this.cacheTime = Date.now()
    return entries
  }

  private async fetchFromGateway(): Promise<MCPRegistryEntry[]> {
    try {
      const resp = await fetch(this.gatewayUrl + '/tools', {signal: AbortSignal.timeout(5000)})
      if (!resp.ok) return []
      const data = await resp.json() as {tools?: Array<Record<string, unknown>>}
      const tools = data.tools ?? data
      if (!Array.isArray(tools)) return []
      return tools.map((t) => this.normalizeEntry(t))
    } catch { return [] }
  }

  private normalizeEntry(raw: Record<string, unknown>): MCPRegistryEntry {
    return {
      name: String(raw.name ?? raw.tool_name ?? 'unknown'),
      description: String(raw.description ?? ''),
      transport: (String(raw.transport ?? raw.type ?? 'stdio') as 'stdio' | 'sse' | 'http'),
      endpoint: raw.endpoint ? String(raw.endpoint) : raw.url ? String(raw.url) : raw.command ? String(raw.command) : undefined,
      args: Array.isArray(raw.args) ? (raw.args as string[]) : undefined,
      env_required: Array.isArray(raw.env_required) ? (raw.env_required as string[]) : undefined,
      source: 'gateway-agent',
    }
  }
}

let catalogInstance: MCPCatalogClientImpl | null = null

export function getMCPCatalogClient(): MCPCatalogClientImpl {
  if (!catalogInstance) catalogInstance = new MCPCatalogClientImpl()
  return catalogInstance
}
