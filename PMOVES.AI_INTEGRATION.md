# PMOVES.AI Integration Guide for Cipher Memory

## Integration Overview

Cipher Memory is a dual-layer memory system (System 1: concepts/business logic, System 2: reasoning traces) with MCP integration. It provides persistent knowledge-graph memory for Claude Code, Agent Zero, and all PMOVES.AI agents via a Neo4j backend.

## Service Details

- **Name:** Cipher Memory
- **Slug:** cipher-api
- **Tier:** agent
- **Port:** 8096 (API, remapped from internal 3000)
- **Health Check:** http://localhost:8096/health
- **NATS Enabled:** True
- **GPU Enabled:** False

## Integration Points

### MCP Bridge
- MCP server at `pmoves-cipher-mcp/` (stdio transport)
- Tools: `pmoves_cipher_store`, `pmoves_cipher_search`, `pmoves_cipher_store_reasoning`, `pmoves_cipher_reasoning_patterns`

### Agent Memory Pipeline
```
Claude Code / Agent Zero → Cipher MCP → Neo4j Knowledge Graph
                         → Reasoning Traces → Pattern Storage
                         → Agent Checkpoints (plan, checkpoint, completion)
```

### NATS Subjects
- `botz.cipher.memory.stored.v1` - Memory stored event
- `botz.cipher.memory.recalled.v1` - Memory recalled event

### API Endpoints
- `POST http://localhost:8096/api/memory` - Store memory
- `GET http://localhost:8096/api/memory/search?q=...` - Search memory
- `GET http://localhost:8096/health` - Health check

## Next Steps

### 1. Customize Environment Variables

Edit the following files with your service-specific values:

- `env.shared` - Base environment configuration
- `env.tier-agent` - AGENT tier specific configuration
- `chit/secrets_manifest_v2.yaml` - Add your service's required secrets

### 2. Update Docker Compose

Add the PMOVES.AI environment anchor to your `docker-compose.yml`:

```yaml
services:
  cipher-api:
    <<: [*env-tier-agent, *pmoves-healthcheck]
    ports:
      - "8096:3000"
```

### 3. Add Service Announcement

```python
from pmoves_announcer import announce_service

@app.on_event("startup")
async def startup():
    await announce_service(
        slug="cipher-api",
        name="Cipher Memory",
        url="http://cipher-api:3000",
        port=8096,
        tier="agent"
    )
```

### 4. Test Integration

```bash
# Test health check
curl http://localhost:8096/health

# Test memory store
curl -X POST http://localhost:8096/api/memory \
  -H "Content-Type: application/json" \
  -d '{"key": "test", "content": "integration test"}'

# Search memory
curl "http://localhost:8096/api/memory/search?q=test"

# Verify NATS announcement
nats sub "services.announce.v1"
```

## Files Created

- `PMOVES.AI_INTEGRATION.md` - This integration guide

## Support

For questions or issues, see the PMOVES.AI documentation.
