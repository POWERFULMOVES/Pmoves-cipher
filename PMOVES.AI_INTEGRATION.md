# PMOVES.AI Integration Dossier — Cipher Memory Shim

> **Version:** 2.0 — refreshed 2026-07-14 for A1-Shim (ByteRover v3.16.1 re-fork)
> **Supersedes:** v1.0 (2026-04, old `@byterover/cipher` v0.3.0)

## What This Is

The `Pmoves-cipher` submodule is a PMOVES-forked `campfirein/byterover-cli` (formerly "Cipher") with a PMOVES additive overlay (`src/pmoves/`) that exposes 8 agent contracts on top of ByteRover's `MemoryManager`.

## Architecture

```
PMOVES agents (Claude Code, Crush, Hermes, Agent Zero, semantic-cache, ...)
    │
    │  REST :8105                SSE :8105/mcp/sse       A2A :8105/.well-known/agent.json
    ▼                            ▼                        ▼
┌────────────────────────────────────────────────────────────────┐
│  src/pmoves/ — PMOVES Shim (856 LOC, 9 files)                  │
│    rest-server.ts    — Express app (port 8105)                  │
│    auth.ts           — Bearer middleware (CIPHER_API_TOKEN)     │
│    health.ts         — GET /health                              │
│    memory-routes.ts  — /api/memory CRUD (4 routes)              │
│    mcp-sse.ts        — /mcp/sse + /mcp/messages (4 MCP tools)   │
│    a2a.ts            — /.well-known/agent.json (A2A discovery)  │
│    embedding.ts      — TensorZero→Ollama fallback + Qdrant      │
│    nats-emitter.ts   — cipher.*.v1 + services.announce.v1       │
│    README.md                                                   │
└────────────────────────────────────────────────────────────────┘
    │                            │                              │
    │  direct import             │  HTTP                        │  HTTP
    ▼                            ▼                              ▼
┌──────────────────┐  ┌──────────────────┐    ┌──────────────────────────┐
│  ByteRover v3.16 │  │  TensorZero :3000│    │  Qdrant :6333            │
│  MemoryManager   │  │  (primary embed) │    │  pmoves_cipher_memory    │
│  + FileBlobStorage│ │  qwen3_emb_4b    │    │  2560d / Cosine          │
│  (filesystem)    │  │  2560d           │    │                          │
└──────────────────┘  └──────────────────┘    └──────────────────────────┘
                           │ fallback
                           ▼
                     ┌──────────────────┐
                     │  Ollama :11434   │
                     │  qwen3-embedding │
                     │  :4b (2560d)     │
                     └──────────────────┘
```

## Contracts (8 + 1 A2A)

| # | Contract | Route | Auth |
|---|----------|-------|------|
| 1 | Health | `GET /health` | Public |
| 2 | Store memory | `POST /api/memory` | Bearer |
| 3 | Search memories | `GET /api/memory/search` | Bearer |
| 4 | Get memory | `GET /api/memory/:id` | Bearer |
| 5 | Delete memory | `DELETE /api/memory/:id` | Bearer |
| 6 | MCP-over-SSE | `GET /mcp/sse` | Bearer |
| 7 | MCP messages | `POST /mcp/messages` | Bearer |
| 8 | Bearer auth | `CIPHER_API_TOKEN` env | — |
| 9 | A2A discovery | `GET /.well-known/agent.json` | Bearer |

## MCP Tools (4)

| Tool | Description |
|------|-------------|
| `pmoves_cipher_store` | Store knowledge with category + tags |
| `pmoves_cipher_search` | Semantic vector search (Qdrant) with lexical fallback |
| `pmoves_cipher_store_reasoning` | Store chain-of-thought reasoning traces |
| `pmoves_cipher_reasoning_patterns` | Search past reasoning patterns |

## NATS Subjects (4)

| Subject | When | Live subscriber |
|---------|------|------------------|
| `cipher.memory.stored.v1` | After POST /api/memory | Declared in registries |
| `cipher.memory.searched.v1` | After search | Declared in registries |
| `cipher.reasoning.stored.v1` | After reasoning store | Declared in registries |
| `services.announce.v1` | On startup | `ServiceAnnouncementListener` (LIVE) |

## Embedding Pipeline

1. **Primary:** TensorZero `http://tensorzero-gateway:3000/openai/v1/embeddings` — model `tensorzero::embedding_model_name::qwen3_embedding_4b_local` (2560d)
2. **Fallback:** Ollama `http://pmoves-ollama:11434/api/embed` — model `qwen3-embedding:4b` (2560d)
3. **Vector store:** Qdrant `pmoves_cipher_memory` collection (2560d, Cosine) — auto-provisioned on first use
4. **Fail-open:** If both TensorZero and Ollama are down, memory stores via ByteRover (no vector), search falls back to lexical list

## Categories

`code_pattern` · `decision` · `context` · `submodule` · `architecture` · `reasoning` · `agent_plan` · `agent_checkpoint` · `agent_completion`

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `CIPHER_API_TOKEN` | (empty = dev-skip) | Bearer auth token |
| `NATS_URL` | (required in fleet) | NATS for event emission |
| `PMOVES_STORAGE_DIR` | `/data/cipher` | ByteRover FileBlobStorage root |
| `PMOVES_PORT` | `8105` | Listen port |
| `PMOVES_HOST` | `0.0.0.0` | Listen host |
| `TENSORZERO_URL` | `http://tensorzero-gateway:3000` | Primary embedder |
| `OLLAMA_URL` | `http://pmoves-ollama:11434` | Fallback embedder |
| `OLLAMA_EMBED_MODEL` | `qwen3-embedding:4b` | Ollama embedding model |
| `QDRANT_URL` | `http://qdrant:6333` | Vector store |
| `QDRANT_API_KEY` | (empty) | Qdrant auth |
| `QDRANT_COLLECTION` | `pmoves_cipher_memory` | Collection name |
| `EMBEDDING_MODEL` | `tensorzero::...qwen3_embedding_4b_local` | TensorZero model key |
| `EMBEDDING_DIM` | `2560` | Vector dimensions |

## Docker

```bash
docker build -f Dockerfile.pmoves -t pmoves-cipher-api .
docker run -p 8105:8105 \
  -e NATS_URL=nats://nats:4222 \
  -e CIPHER_API_TOKEN=secret \
  -e TENSORZERO_URL=http://tensorzero-gateway:3000 \
  -e QDRANT_URL=http://qdrant:6333 \
  pmoves-cipher-api
```

Compose: `pmoves/docker-compose.yml` → `cipher-api` service (profile: `agents`).

## What's NOT Included (vs Old Cipher v0.3.0)

- ~~Neo4j~~ — ByteRover uses filesystem only
- ~~Express REST `/api/sessions`, `/api/message`~~ — not in PMOVES contract
- ~~Old `cipher_*` MCP tools~~ — replaced by PMOVES shim tools
- ~~OAuth2/RBAC~~ — aspirational, never implemented (see `docs/historical/SECURITY_ENHANCEMENTS.md`)
- ~~node-gyp/pnpm build fixes~~ — obsolete on new arch

## Variants (Not This Service)

- **BoTZ cipher** (`:8081`) — own `botz.cipher.*` NATS namespace, TensorZero config, Python MCP bridge
- **DoX CipherService** (`:8096`) — native Python, team workspace memory with RLS (namesake, not this)
