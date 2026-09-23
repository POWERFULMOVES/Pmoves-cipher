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

> **MCP identity (updated 2026-09-23):** both MCP transports read the caller's identity
> **per request** from the auth middleware (`req.agentId` / `req.scopes`) and the legacy SSE
> flow binds it to the session, so `POST /mcp/messages` runs as whoever opened the stream.
> `CIPHER_MCP_ENFORCE` decides what a mismatch does:
>
> | `CIPHER_MCP_ENFORCE` | declared `agentId` ≠ token agent, `*` with a token, missing `agentId` with a token, missing scope, or `/messages` poster ≠ session owner |
> |---|---|
> | unset / `false` (**default, advisory**) | call proceeds; stderr gets `pmoves-mcp-auth: ADVISORY (...) token-agent='…' declared-agent='…' reason="…"` |
> | `true` / `1` / `yes` / `on` / `enforce` | refused: tool calls get McpError `-32003` (`data.httpStatus: 403`, message `Forbidden: …`); a mismatched `/messages` POST gets HTTP 403 |
>
> Scopes checked per tool: `store`→`memory:write`; `search`/`hybrid_search`/`graph_expand`→`memory:read`;
> `store_reasoning`→`reasoning:write`; `reasoning_patterns`→`reasoning:read`; `session_save`→`session:write`;
> `session_recall`→`session:read`; `admin` satisfies all; `mcp_list`/`mcp_get` need none.
> **Always refused with a token, in either mode (F3):** an omitted `agentId` and `agentId: "*"` — as on REST.
> Advisory tolerates only a declared-name mismatch (and, until enforce, a missing scope).
> Any other flag value (`enabled`, `strict`, `2`, a quoted `"true"`) stays advisory and logs
> `pmoves-mcp-auth: WARN unrecognised …`; the active mode is logged at startup as `pmoves-mcp-auth: mode=…`.
> **Behaviour change in the DEFAULT mode (#27):** before #27 the MCP path checked nothing, so an
> omitted `agentId` or `*` with a token was served. Both are now refused even with the flag unset.
> No in-repo MCP caller relies on `*`; a client that omits `agentId` must now send its signing-card id.
>
> **Audit trail** (stderr, one JSON object per line, caller values escaped incl. C1/bidi/U+2028-9):
> `pmoves-mcp-auth: ADVISORY (…accepted) {…}` for a tolerated violation, `pmoves-mcp-auth: REFUSED {…}`
> for every refusal, `pmoves-mcp-auth: ADVISORY-SUMMARY {"cause":"interval|cap|budget",…}` for counts.
> Deduped per (outcome, kind, route, tool, missing scope, token-agent, declared-agent) per
> `CIPHER_MCP_ADVISORY_INTERVAL_MS` (default 60000, clamped to >= 1000 with a WARN); suppressed counts
> flush when due on an unref'd timer and before the 1000-key cap clears. At most
> `CIPHER_MCP_ADVISORY_BUDGET` (default 200) first-occurrence lines per interval **per (outcome, token
> agent)** — a flooding token drowns only itself, and REFUSED never shares a pool with ADVISORY; each
> pool's overflow is summarised with a (tokenAgent, kind, tool) breakdown.
> No token (dev-skip) → no check in either mode. The REST path (`/api/memory`) already refuses
> mismatches unconditionally and has **no** scope check.

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
CIPHER_MCP_ENFORCE=false    # MCP identity: false = advisory (log mismatches), true = refuse
NATS_URL=nats://<user>:<password>@nats:4222
PMOVES_STORAGE_DIR=/data/cipher  # BlobStorage root
```

## Status

Phase 2 of 9 (A1-Shim Workorder). Skeleton — `/health` + `/api/memory` CRUD + Bearer auth + NATS emission implemented. MCP-over-SSE + embedding sidecar pending.
