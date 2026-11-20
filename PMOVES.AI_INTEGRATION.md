# PMOVES.AI Integration Dossier — Cipher Memory Shim

> **Version:** 2.1 — refreshed 2026-11-19 for the per-agent-auth era (PRs #11, #26, #27, #28, #29, #31, #33)
> **Supersedes:** v2.0 (2026-07-14, A1-Shim re-fork) · v1.0 (2026-04, old `@byterover/cipher` v0.3.0)

## What This Is

The `Pmoves-cipher` submodule is a PMOVES-forked `campfirein/byterover-cli` (formerly "Cipher") with a PMOVES additive overlay (`src/pmoves/`) that exposes 8 agent contracts on top of ByteRover's `MemoryManager`.

## Architecture

```
PMOVES agents (Claude Code, Crush, Hermes, Agent Zero, semantic-cache, ...)
    │
    │  REST :8105                SSE :8105/mcp/sse       A2A :8105/.well-known/agent.json
    ▼                            ▼                        ▼
┌────────────────────────────────────────────────────────────────┐
│  src/pmoves/ — PMOVES Shim                                      │
│    rest-server.ts    — Express app (port 8105)                  │
│    auth.ts           — per-agent Bearer middleware (see Auth)    │
│    health.ts         — GET /health (+ per_agent_auth state)     │
│    memory-routes.ts  — /api/memory CRUD (agentId-scoped)        │
│    mcp-sse.ts        — /mcp/sse + POST /mcp (streamable HTTP)   │
│    a2a.ts            — /.well-known/agent.json (A2A discovery)  │
│    hirag-client.ts   — HiRAG v2 /hirag/query client             │
│    embedding.ts      — TensorZero→Ollama fallback + Qdrant      │
│    nats-emitter.ts   — cipher.*.v1 + services.announce.v1       │
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
| 2 | Store memory | `POST /api/memory` | Bearer (agentId required) |
| 3 | Search memories | `GET /api/memory/search` | Bearer |
| 4 | Get memory | `GET /api/memory/:id` | Bearer |
| 5 | Delete memory | `DELETE /api/memory/:id` | Bearer (ownership-enforced) |
| 6 | MCP-over-SSE | `GET /mcp/sse` | Bearer |
| 7 | MCP streamable HTTP | `POST /mcp` | Bearer (stateless, no session) |
| 8 | Bearer auth | per-agent tokens (see Auth) | — |
| 9 | A2A discovery | `GET /.well-known/agent.json` | Bearer |

## Auth (per-agent tokens)

`auth.ts` resolves Bearer tokens against the PostgREST `per-agent token` table
(`agent_id`, `scopes`, `revoked_at`, `expires`). Three outcomes, not two
(PR #28 — a failed lookup is NOT a revocation):

- **resolved** — active row found; identity + scopes attach to the request
- **rejected** — lookup succeeded, no active row → `401 invalid or revoked`
- **unavailable** — service key missing/refused, PostgREST error, or timeout → `503`, never `401`

- `CIPHER_API_TOKEN` (env) remains as the legacy bootstrap token.
- `CIPHER_AUTH_REQUIRED=true` closes dev mode: unauthenticated requests are
  refused even when no token env is set (PR #33). Read per request, not at startup.
- `CIPHER_MCP_ENFORCE` gates MCP per-request identity: in advisory mode (default)
  a token-vs-declared agentId mismatch surfaces an advisory line, but an
  **omitted** agentId with a token is still refused (`-32003`) (PR #27).
- `/api/memory` store **requires** `agentId`; `metadata.agentId` cannot
  override the top-level value; delete is ownership-enforced; token agentId
  must match the declared agentId or the store is `403` (PR #11, Phase B PR 2).
- Token lookups are cached in-memory 60s; a per-token audit budget and
  interval floor bound emission cost (B1/B2).

## /health per-agent auth state

Still `200` when degraded (a restart cannot fix a refused service key);
the body says what is wrong: `per_agent_auth.state` ∈ `unknown` (no lookup
yet) → `healthy` | `degraded` (lookup unavailable or service key missing).

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
| `CIPHER_API_TOKEN` | (empty = dev-skip unless `CIPHER_AUTH_REQUIRED`) | Legacy bootstrap Bearer token |
| `CIPHER_AUTH_REQUIRED` | `false` | Refuse unauthenticated requests even with no token env (PR #33) |
| `CIPHER_MCP_ENFORCE` | (unset = advisory) | MCP per-request identity enforcement (PR #27) |
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

## HiRAG v2 client

`hirag-client.ts` serializes the v2 payload (`topK → k`, `rerank → use_rerank`,
defaults `k=10`, `use_rerank=true`), reads the live v2 `hits` envelope (the
legacy `results` key is still accepted), and maps unknown envelopes to empty
results instead of throwing (kb reported 0 before the fix).

## Test contracts

Every PMOVES behavior above is pinned by `test/unit/pmoves/` — one suite per
lane: `agent-isolation` (PR #11), `token-enforcement` (Phase B PR 2),
`auth-lookup-failure` (PR #28), `auth-required-switch` (PR #33),
`mcp-per-request-auth` (PR #27), `mcp-streamable-http`, `rest-server-wiring`,
`retrieval-defects` (PR #29/#31), `health-per-agent-auth`, `hirag-client`.
Changes to `src/pmoves/` behavior must keep these suites green or update this
dossier in the same PR.

## Variants (Not This Service)

- **BoTZ cipher** (`:8081`) — own `botz.cipher.*` NATS namespace, TensorZero config, Python MCP bridge
- **DoX CipherService** (`:8096`) — native Python, team workspace memory with RLS (namesake, not this)
