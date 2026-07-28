/**
 * PMOVES Neo4j Graph Client — cipher memories as graph nodes with inferred edges.
 *
 * On pmoves_cipher_store: write a (:Memory {id, agentId, category, tags, ts}) node.
 * Background edge inference: (:Memory)-[:SAME_CATEGORY]->(:Memory) for same agent+category.
 * On pmoves_cipher_graph_expand: N-hop traversal scoped by agentId.
 *
 * Fail-open: if Neo4j is unreachable, all operations become no-ops.
 *
 * Config (env):
 *   NEO4J_URL       — default bolt://neo4j:7687
 *   NEO4J_USER      — default neo4j
 *   NEO4J_PASSWORD  — required (from env.shared)
 */

import neo4j, {type Driver, type Session} from 'neo4j-driver'

export interface GraphNode {
  id: string
  agentId: string
  category: string
  tags: string[]
  contentPreview: string
  ts: string
}

export interface GraphNeighbor {
  node: GraphNode
  relationship: string
  depth: number
}

export interface GraphNeighborhood {
  center: GraphNode | null
  neighbors: GraphNeighbor[]
}

class Neo4jGraphClient {
  private driver: Driver | null = null
  private ready = false
  private initError: string | null = null

  constructor() {
    const url = process.env.NEO4J_URL ?? 'bolt://neo4j:7687'
    const user = process.env.NEO4J_USER ?? 'neo4j'
    const password = process.env.NEO4J_PASSWORD ?? ''
    if (!password) {
      this.initError = 'NEO4J_PASSWORD not set'
      process.stderr.write(`pmoves-graph: NEO4J_PASSWORD not set — graph features disabled\n`)
      return
    }
    try {
      this.driver = neo4j.driver(url, neo4j.auth.basic(user, password))
      process.stdout.write(`pmoves-graph: Neo4j driver created for ${url}\n`)
    } catch (e) {
      this.initError = String(e)
      process.stderr.write(`pmoves-graph: driver init failed — ${e}\n`)
    }
  }

  isAvailable(): boolean {
    return this.driver !== null
  }

  private async getSession(): Promise<Session | null> {
    if (!this.driver) return null
    if (!this.ready) {      try {
        const session = this.driver.session()
        await session.run('RETURN 1')
        await session.close()
        this.ready = true
        await this.ensureConstraints()
      } catch (e) {
        this.initError = String(e)
        process.stderr.write(`pmoves-graph: Neo4j connection failed — ${e}\n`)
        return null
      }
    }
    return this.driver.session()
  }

  private async ensureConstraints(): Promise<void> {
    if (!this.driver) return
    const session = this.driver.session()
    try {
      await session.run('CREATE CONSTRAINT memory_id_unique IF NOT EXISTS FOR (m:Memory) REQUIRE m.id IS UNIQUE')
      await session.run('CREATE INDEX memory_agent_category IF NOT EXISTS FOR (m:Memory) ON (m.agentId, m.category)')
    } finally {
      await session.close()
    }
  }

  async writeMemory(node: GraphNode): Promise<void> {
    const session = await this.getSession()
    if (!session) return
    try {
      await session.run(
        `MERGE (m:Memory {id: $id})
         SET m.agentId = $agentId, m.category = $category, m.tags = $tags,
             m.contentPreview = $contentPreview, m.ts = $ts`,
        {
          id: node.id,
          agentId: node.agentId,
          category: node.category,
          tags: node.tags,
          contentPreview: node.contentPreview,
          ts: node.ts,
        },
      )
    } catch (e) {
      process.stderr.write(`pmoves-graph: writeMemory failed — ${e}\n`)
    } finally {
      await session.close()
    }
  }

  async inferEdges(memoryId: string): Promise<number> {
    const session = await this.getSession()
    if (!session) return 0
    try {
      const result = await session.run(
        `MATCH (m:Memory {id: $id}), (other:Memory)
         WHERE m.agentId = other.agentId
           AND m.category = other.category
           AND m.id <> other.id
           AND NOT (m)-[:SAME_CATEGORY]-(other)
         WITH m, other LIMIT 50
         CREATE (m)-[:SAME_CATEGORY {inferred: true, ts: datetime()}]->(other)
         RETURN count(*) as edgeCount`,
        {id: memoryId},
      )
      return result.records[0]?.get('edgeCount').toNumber() ?? 0
    } catch (e) {
      process.stderr.write(`pmoves-graph: inferEdges failed — ${e}\n`)
      return 0
    } finally {
      await session.close()
    }
  }

  async expand(memoryId: string, maxDepth: number, agentId: string): Promise<GraphNeighborhood> {
    const session = await this.getSession()
    if (!session) return {center: null, neighbors: []}
    try {
      // Get center node
      const centerResult = await session.run(
        `MATCH (m:Memory {id: $id, agentId: $agentId}) RETURN m`,
        {id: memoryId, agentId},
      )
      if (centerResult.records.length === 0) return {center: null, neighbors: []}

      const centerRec = centerResult.records[0].get('m').properties
      const center: GraphNode = {
        id: centerRec.id,
        agentId: centerRec.agentId,
        category: centerRec.category,
        tags: centerRec.tags ?? [],
        contentPreview: centerRec.contentPreview ?? '',
        ts: centerRec.ts ?? '',
      }

      // Get neighbors via N-hop traversal
      const neighborResult = await session.run(
        `MATCH path = (m:Memory {id: $id})-[*1..${Math.min(maxDepth, 3)}]-(other:Memory)
         WHERE m.agentId = $agentId AND other.agentId = $agentId
         WITH other, relationships(path) as rels, length(path) as depth
         ORDER BY depth
         LIMIT 20
         RETURN other, rels, depth`,
        {id: memoryId, agentId},
      )

      const neighbors: GraphNeighbor[] = neighborResult.records.map((rec) => {
        const props = rec.get('other').properties
        const rels = rec.get('rels') ?? []
        const depth = rec.get('depth').toNumber()
        return {
          node: {
            id: props.id,
            agentId: props.agentId,
            category: props.category,
            tags: props.tags ?? [],
            contentPreview: props.contentPreview ?? '',
            ts: props.ts ?? '',
          },
          relationship: rels.map((r: {type: string}) => r.type).join(','),
          depth,
        }
      })

      return {center, neighbors}
    } catch (e) {
      process.stderr.write(`pmoves-graph: expand failed — ${e}\n`)
      return {center: null, neighbors: []}
    } finally {
      await session.close()
    }
  }

  async deleteMemory(memoryId: string): Promise<void> {
    const session = await this.getSession()
    if (!session) return
    try {
      await session.run('MATCH (m:Memory {id: $id}) DETACH DELETE m', {id: memoryId})
    } catch (e) {
      process.stderr.write(`pmoves-graph: deleteMemory failed — ${e}\n`)
    } finally {
      await session.close()
    }
  }
}

let graphInstance: Neo4jGraphClient | null = null

export function getGraphClient(): Neo4jGraphClient | null {
  if (!graphInstance) {
    graphInstance = new Neo4jGraphClient()
  }
  return graphInstance?.isAvailable() ? graphInstance : null
}
