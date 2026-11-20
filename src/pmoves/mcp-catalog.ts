/**
 * PMOVES MCP Catalog Client — brokers the gateway-agent tool registry.
 */

export interface MCPRegistryEntry {
  args?: string[]
  description: string
  endpoint?: string
  env_required?: string[]
  name: string
  source: string
  transport: 'http' | 'sse' | 'stdio'
}

const DEFAULT_GATEWAY_URL = process.env.GATEWAY_AGENT_URL ?? 'http://gateway-agent:8111'
const DEFAULT_TTL = Number(process.env.MCP_CATALOG_TTL ?? 300) * 1000

class MCPCatalogClientImpl {
  private cache: MCPRegistryEntry[] | null = null
  private cacheTime = 0
  private fetching: null | Promise<MCPRegistryEntry[]> = null
  private gatewayUrl: string
  private ttlMs: number

  constructor() {
    this.gatewayUrl = DEFAULT_GATEWAY_URL
    this.ttlMs = DEFAULT_TTL
  }

  async get(name: string): Promise<MCPRegistryEntry | null> {
    const entries = await this.list()
    return entries.find((e) => e.name === name) ?? null
  }

  async list(): Promise<MCPRegistryEntry[]> {
    if (this.cache && Date.now() - this.cacheTime < this.ttlMs) return this.cache
    if (this.fetching) return this.fetching
    this.fetching = this.refresh()
    return this.fetching
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
      args: Array.isArray(raw.args) ? (raw.args as string[]) : undefined,
      description: String(raw.description ?? ''),
      endpoint: raw.endpoint ? String(raw.endpoint) : raw.url ? String(raw.url) : raw.command ? String(raw.command) : undefined,
      env_required: Array.isArray(raw.env_required) ? (raw.env_required as string[]) : undefined,
      name: String(raw.name ?? raw.tool_name ?? 'unknown'),
      source: 'gateway-agent',
      transport: (String(raw.transport ?? raw.type ?? 'stdio') as 'http' | 'sse' | 'stdio'),
    }
  }
}

let catalogInstance: MCPCatalogClientImpl | null = null

export function getMCPCatalogClient(): MCPCatalogClientImpl {
  if (!catalogInstance) catalogInstance = new MCPCatalogClientImpl()
  return catalogInstance
}
