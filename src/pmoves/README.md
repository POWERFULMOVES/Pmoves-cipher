# PMOVES Cipher Shim

Additive overlay exposing PMOVES agent contracts on top of ByteRover's memory layer.

## Why this exists

PMOVES agents depend on 8 contracts (REST routes + MCP SSE + Bearer auth + NATS events) that upstream ByteRover doesn't provide. This shim re-exposes them by translating to ByteRover's `MemoryManager` + `BlobStorage`.

See `pmoves/docs/TAC/TAC_CIPHER.md` §A1-Shim Workorder (PMOVES.AI superproject) for the full decision context.

## Architecture

```
PMOVES agents (Claude Code, Crush, Hermes, Agent Zero, semantic-cache)
        │
        │  REST :8105                SSE :8105/mcp/sse
        ▼                            ▼
┌──────────────────────────────────────────────┐
│  src/pmoves/                                  │
│    rest-server.ts    — Express app            │
│    auth.ts           — Bearer middleware      │
│    memory-routes.ts  — /api/memory CRUD       │
│    health.ts         — GET /health            │
│    nats-emitter.ts   — cipher.*.v1 + services.announce.v1
│    mcp-sse.ts        — MCP-over-SSE bridge    │
└──────────────────────────────────────────────┘
        │
        │  direct import (in-process)
        ▼
┌──────────────────────────────────────────────┐
│  ByteRover (upstream)                         │
│    MemoryManager     — create/get/list/delete │
│    FileBlobStorage   — filesystem persistence │
└──────────────────────────────────────────────┘
```

## Contracts preserved (8)

| # | Contract | PMOVES caller | Shim route |
|---|----------|--------------|------------|
| 1 | `GET /health` | gateway-agent, spark_health, hirag-mcp, showtime | `health.ts` |
| 2 | `POST /api/memory` → `{id: ...}` raw JSON | semantic-cache, analyze_beats | `memory-routes.ts` |
| 3 | `GET /api/memory/search?q=&limit=&category=` → `{results: [...]}` | semantic-cache, analyze_beats | `memory-routes.ts` |
| 4 | `GET /api/memory/:id` | bridge (disabled) | `memory-routes.ts` |
| 5 | `DELETE /api/memory/:id` | bridge (disabled) | `memory-routes.ts` |
| 6 | `GET /mcp/sse` (MCP-over-SSE, **legacy**) | legacy SSE clients | `mcp-sse.ts` |
| 7 | Bearer auth via `CIPHER_API_TOKEN` | all callers | `auth.ts` |
| 8 | `POST /mcp` (MCP-over-HTTP, **stateless streamable-http — preferred**) | Agent Zero, deepseek-harness, Claude Code | `mcp-sse.ts` |

> **Transport (updated 2026-09-04):** prefer the **streamable-http `POST /mcp`** endpoint.
> It is stateless (`sessionIdGenerator: undefined`) — no in-memory session map, so it
> cannot emit the "Unknown session" HTTP 400 the legacy SSE flow returns when a client's
> stream and its message POST don't share one in-process transport (the failure Agent Zero
> hit; it was moved onto `/mcp` in PMOVES.AI #2923). `GET /mcp/sse` + `POST /mcp/messages`
> remain for back-compat. Both require `Authorization: Bearer ${CIPHER_API_TOKEN}`.

## NATS events emitted

| Subject | When | Live subscribers |
|---------|------|------------------|
| `cipher.memory.stored.v1` | after `POST /api/memory` | declared in agent_registry + nats_subject_registry |
| `cipher.memory.searched.v1` | after `GET /api/memory/search` | declared |
| `cipher.reasoning.stored.v1` | after reasoning store | declared |
| `services.announce.v1` | on shim startup | **LIVE**: `ServiceAnnouncementListener` (PMOVES `nats_service_listener.py:130`) |

## Run

```bash
# Standalone (PMOVES fleet)
node dist/src/pmoves/rest-server.js --port 8105 --host 0.0.0.0

# Env vars
CIPHER_API_TOKEN=<bearer>   # auth (graceful skip if unset = dev mode)
NATS_URL=nats://nats:pmoves@nats:4222
PMOVES_STORAGE_DIR=/data/cipher  # BlobStorage root
```

## Status

Phase 2 of 9 (A1-Shim Workorder). Skeleton — `/health` + `/api/memory` CRUD + Bearer auth + NATS emission implemented. MCP-over-SSE + embedding sidecar pending.
