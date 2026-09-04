#!/bin/sh
# openclaw-setup-pmoves.sh — PMOVES Cipher Memory Integration Installer for OpenClaw
# Usage: sh scripts/openclaw-setup-pmoves.sh
#
# PMOVES fork adaptation of the upstream openclaw-setup.sh (campfirein/
# byterover-cli): configures the SELF-HOSTED PMOVES Cipher Memory (cipher-api,
# default http://127.0.0.1:8105, tailnet-only) as long-term memory for OpenClaw
# agents — instead of the ByteRover cloud service. This is why the fork exists:
# to customize claws and agents.
#
# Configures PMOVES Cipher as long-term memory for OpenClaw agents:
#   - Automatic Memory Flush (context compaction, storing to cipher-api)
#   - Cipher MCP/SSE registration in openclaw.json (no cloud plugin)
#   - Workspace protocol updates (AGENTS.md, TOOLS.md) with PMOVES endpoints
#
# Env overrides:
#   CIPHER_URL      - default http://127.0.0.1:8105 (set to the tailnet IP/IP:port
#                     of the node hosting cipher-api for remote agents)
#   CIPHER_TOKEN    - optional Authorization: Bearer <token> if cipher auth is on
#   OPENCLAW_CONFIG - default $HOME/.openclaw/openclaw.json

set -eu

# ─── Constants ────────────────────────────────────────────────────────────────

CONFIG_PATH="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"
CIPHER_URL="${CIPHER_URL:-http://127.0.0.1:8105}"
CIPHER_MEMORY_COLLECTION="${QDRANT_CIPHER_COLLECTION:-pmoves_cipher_memory}"

# ─── Colors (respects NO_COLOR and non-terminal) ─────────────────────────────

if [ -n "${NO_COLOR:-}" ] || [ ! -t 1 ]; then
  DIM=''; GREEN=''; YELLOW=''; RED=''; BLUE=''; RESET=''
else
  DIM='\033[2m'; GREEN='\033[32m'; YELLOW='\033[1;33m'; RED='\033[31m'; BLUE='\033[34m'; RESET='\033[0m'
fi

# ─── Helpers ──────────────────────────────────────────────────────────────────

info()    { printf "${BLUE}%s${RESET}\n" "$1"; }
success() { printf "${GREEN}[ok] %s${RESET}\n" "$1"; }
warn()    { printf "${YELLOW}[!] %s${RESET}\n" "$1" >&2; }
error()   { printf "${RED}[X] %b${RESET}\n" "$1" >&2; exit 1; }

confirm() {
  printf "%s (y/N): " "$1"
  if [ -t 0 ]; then read -r answer; else read -r answer < /dev/tty; fi
  case "${answer:-}" in
    [Yy]|[Yy][Ee][Ss]) return 0 ;;
    *) return 1 ;;
  esac
}

setup_cleanup() {
  CLEANUP_FILES=""
  CONFIG_BACKUP=""
  cleanup() {
    local exit_code=$?
    if [ -n "$CLEANUP_FILES" ]; then
      # shellcheck disable=SC2086
      rm -f $CLEANUP_FILES
    fi
    if [ "$exit_code" -ne 0 ] && [ -n "$CONFIG_BACKUP" ] && [ -f "$CONFIG_BACKUP" ]; then
      printf "${YELLOW}[!] Installation failed. Restoring config from backup...${RESET}\n" >&2
      cp "$CONFIG_BACKUP" "$CONFIG_PATH"
      printf "${GREEN}[ok] Config restored from %s${RESET}\n" "$CONFIG_BACKUP" >&2
    fi
  }
  trap cleanup EXIT
}

cipher_curl() {
  # All cipher-api calls go through here so auth stays in one place.
  if [ -n "${CIPHER_TOKEN:-}" ]; then
    curl -fsS -H "Authorization: Bearer ${CIPHER_TOKEN}" "$@"
  else
    curl -fsS "$@"
  fi
}

# ─── Pre-flight Checks ───────────────────────────────────────────────────────

check_cipher_api() {
  info "Probing PMOVES Cipher Memory at ${CIPHER_URL}..."
  if cipher_curl "${CIPHER_URL}/api/memory/search?q=pmoves-setup-probe&limit=1" >/dev/null 2>&1; then
    success "Cipher Memory reachable at ${CIPHER_URL}"
  else
    error "Cipher Memory not reachable at ${CIPHER_URL}. Start it first:
    make -C pmoves up-cipher-full        (on the node hosting cipher-api)
  or set CIPHER_URL to the tailnet address of that node."
  fi
}

check_openclaw_cli() {
  if command -v openclaw >/dev/null 2>&1; then
    success "OpenClaw CLI is installed"
  else
    error "OpenClaw CLI is missing. Cannot configure OpenClaw."
  fi
}

check_config() {
  if [ ! -f "$CONFIG_PATH" ]; then
    error "Config file not found at $CONFIG_PATH. Install openclaw first (https://docs.openclaw.ai/install#npm-pnpm) to generate the configuration."
  fi
  if ! CONFIG_PATH="$CONFIG_PATH" node -e 'JSON.parse(require("fs").readFileSync(process.env.CONFIG_PATH, "utf8"))' 2>/dev/null; then
    error "Config file at $CONFIG_PATH is not valid JSON."
  fi
  success "Config file is valid"
}

# ─── Storage Setup ────────────────────────────────────────────────────────────

backup_config() {
  CONFIG_BACKUP="${CONFIG_PATH}.bak.$(date +%Y%m%d%H%M%S)"
  (umask 0077; cp "$CONFIG_PATH" "$CONFIG_BACKUP")
  echo "Backed up config to $CONFIG_BACKUP"
}

# ─── Config Patching (Node.js) ───────────────────────────────────────────────

# Registers the cipher-api SSE MCP server in openclaw.json (idempotent).
# This is the PMOVES replacement for the upstream @byterover/byterover
# contextEngine plugin: the memory context arrives through the same
# SSE MCP transport every PMOVES agent already uses (.claude/mcp.json shape).
patch_cipher_mcp_config() {
  CIPHER_URL="$CIPHER_URL" CIPHER_TOKEN="${CIPHER_TOKEN:-}" CONFIG_PATH="$CONFIG_PATH" node -e '
    const fs = require("fs");
    const configPath = process.env.CONFIG_PATH;
    const url = process.env.CIPHER_URL;
    const token = process.env.CIPHER_TOKEN;
    try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        config.mcpServers = config.mcpServers || {};
        const entry = { type: "sse", url: url + "/mcp/sse" };
        if (token) entry.headers = { Authorization: "Bearer " + token };
        config.mcpServers["pmoves-cipher"] = entry;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log("mcpServers[\"pmoves-cipher\"] -> " + url + "/mcp/sse");
    } catch (e) {
        console.error("Failed to patch config:", e);
        process.exit(1);
    }
  '
}

remove_cipher_mcp_config() {
  CONFIG_PATH="$CONFIG_PATH" node -e '
    const fs = require("fs");
    const configPath = process.env.CONFIG_PATH;
    try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        if (config.mcpServers && config.mcpServers["pmoves-cipher"]) {
            delete config.mcpServers["pmoves-cipher"];
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
            console.log("pmoves-cipher MCP entry removed.");
        } else { console.log("No pmoves-cipher MCP entry found."); }
    } catch (e) { console.error("Failed:", e); process.exit(1); }
  '
}

patch_memory_flush_config() {
  CIPHER_URL="$CIPHER_URL" FLUSH_SYSTEM_PROMPT="$1" FLUSH_PROMPT="$2" CONFIG_PATH="$CONFIG_PATH" node -e '
    const fs = require("fs");
    const configPath = process.env.CONFIG_PATH;
    const systemPrompt = process.env.FLUSH_SYSTEM_PROMPT;
    const prompt = process.env.FLUSH_PROMPT;
    try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        config.agents = config.agents || {};
        config.agents.defaults = config.agents.defaults || {};
        config.agents.defaults.compaction = config.agents.defaults.compaction || {};
        config.agents.defaults.compaction.reserveTokensFloor = 50000;
        config.agents.defaults.compaction.memoryFlush = {
            enabled: true,
            softThresholdTokens: 4000,
            systemPrompt: systemPrompt,
            prompt: prompt
        };
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log("Config updated successfully.");
    } catch (e) {
        console.error("Failed to patch config:", e);
        process.exit(1);
    }
  '
}

remove_memory_flush_config() {
  CONFIG_PATH="$CONFIG_PATH" node -e '
    const fs = require("fs");
    const configPath = process.env.CONFIG_PATH;
    try {
        const compaction = config.agents?.defaults?.compaction;
        if (!compaction) { console.log("No memory flush config found."); process.exit(0); }
        let changed = false;
        if (compaction.memoryFlush) { delete compaction.memoryFlush; changed = true; }
        if (compaction.reserveTokensFloor) { delete compaction.reserveTokensFloor; changed = true; }
        if (Object.keys(compaction).length === 0) delete config.agents.defaults.compaction;
        if (changed) {
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
            console.log("Memory flush config removed.");
        } else { console.log("No memory flush config found."); }
    } catch (e) { console.error("Failed to remove memory flush config:", e); process.exit(1); }
  '
}

list_workspaces() {
  CONFIG_PATH="$CONFIG_PATH" node -e '
    const fs = require("fs");
    try {
        const config = JSON.parse(fs.readFileSync(process.env.CONFIG_PATH, "utf8"));
        const ws = new Set();
        if (config.agents?.defaults?.workspace) ws.add(config.agents.defaults.workspace);
        if (Array.isArray(config.agents?.list)) {
            config.agents.list.forEach(a => { if (a.workspace) ws.add(a.workspace); });
        }
        console.log(Array.from(ws).join("\n"));
    } catch (e) { process.exit(0); }
  '
}

# ─── Feature: Memory Flush ───────────────────────────────────────────────────

configure_memory_flush() {
  printf "${YELLOW}Feature: Automatic Memory Flush${RESET}\n"
  echo "Automatically curates durable insights to PMOVES Cipher (${CIPHER_URL}) when the context window fills up."

  if confirm "Enable Automatic Memory Flush?"; then
    echo "Patching $CONFIG_PATH..."
    local system_prompt="Session nearing compaction. Store durable memories to PMOVES Cipher now."
    local prompt="Review the session for architectural decisions, bug fixes, new patterns, and references worth keeping. Store each durable item to PMOVES Cipher Memory via the pmoves-cipher MCP tools (or POST ${CIPHER_URL}/api/memory with agentId, category, content, tags). Also write personal notes to memory/YYYY-MM-DD.md. Reply NO_REPLY if nothing to store."

    patch_memory_flush_config "$system_prompt" "$prompt"
    success "openclaw.json updated."
  else
    echo "Disabling Memory Flush..."
    remove_memory_flush_config
  fi
  echo ""
}

# ─── Feature: Cipher MCP Registration ────────────────────────────────────────

configure_cipher_mcp() {
  printf "${YELLOW}Feature: PMOVES Cipher Memory - self-hosted, tailnet-only${RESET}\n"
  echo "Registers the cipher-api SSE MCP server (${CIPHER_URL}/mcp/sse) in openclaw.json."
  echo "No cloud plugin is installed - the memory backend is the PMOVES fleet's own cipher-api."

  if confirm "Register pmoves-cipher MCP in openclaw.json?"; then
    echo "Patching $CONFIG_PATH..."
    patch_cipher_mcp_config
    success "openclaw.json updated."
  else
    echo "Removing pmoves-cipher MCP entry..."
    remove_cipher_mcp_config
  fi
  echo ""
}

# ─── Workspace Protocol Updates ───────────────────────────────────────────────

update_agents_md() {
  local agents_md="$1"
  if [ ! -f "$agents_md" ]; then
    warn "AGENTS.md not found in $(dirname "$agents_md"). Skipping."
    return
  fi
  if grep -q "Knowledge Protocol (PMOVES Cipher)" "$agents_md"; then
    MDFILE="$agents_md" node -e '
      const fs = require("fs");
      const f = process.env.MDFILE;
      let t = fs.readFileSync(f, "utf8");
      t = t.replace(/\n*## Knowledge Protocol \(PMOVES Cipher\)[\s\S]*?(?=\n## |\s*$)/, "");
      fs.writeFileSync(f, t.replace(/\s+$/, "\n"));
    '
  fi

  cat >> "$agents_md" <<AGENTS_EOF

## Knowledge Protocol (PMOVES Cipher)
This agent uses PMOVES Cipher Memory (self-hosted at \`${CIPHER_URL}\`, tailnet-only)
as its long-term structured memory. Biometric/medical data never enters this store.
1.  **Start:** Before answering questions, search existing knowledge:
    \`curl "${CIPHER_URL}/api/memory/search?q=<topic>"\` (or the pmoves-cipher MCP tools).
2.  **Finish:** After completing a task, store durable knowledge:
    \`curl -X POST "${CIPHER_URL}/api/memory" -H "Content-Type: application/json" -d '{"agentId":"<agent>","category":"<category>","content":"<summary>","tags":["..."]}'\`
3.  **Don't Guess:** If you don't know anything, query it first.
4.  **Cite:** When using stored knowledge, mention the source collection
    (\`${CIPHER_MEMORY_COLLECTION}\`) per the trail doctrine (reconcile to docs/examples).
AGENTS_EOF
  success "Updated $agents_md"
}

update_tools_md() {
  local tools_md="$1"
  if [ ! -f "$tools_md" ]; then
    warn "TOOLS.md not found in $(dirname "$tools_md"). Skipping."
    return
  fi
  if grep -q "PMOVES Cipher (Memory)" "$tools_md"; then
    MDFILE="$tools_md" node -e '
      const fs = require("fs");
      const f = process.env.MDFILE;
      let t = fs.readFileSync(f, "utf8");
      t = t.replace(/\n*## PMOVES Cipher \(Memory\)[\s\S]*?(?=\n## |\s*$)/, "");
      fs.writeFileSync(f, t.replace(/\s+$/, "\n"));
    '
  fi

  cat >> "$tools_md" <<TOOLS_EOF

## PMOVES Cipher (Memory)
- **Query:**  \`curl "${CIPHER_URL}/api/memory/search?q=<topic>"\` (check existing knowledge)
- **Store:**  \`curl -X POST "${CIPHER_URL}/api/memory" -d '{"agentId":"<agent>","category":"<cat>","content":"<text>","tags":[...]}'\`
- **Transport:** tailnet-only; biometric/medical data is excluded from this store (L14 privacy tier).
TOOLS_EOF
  success "Updated $tools_md"
}

restart_openclaw_gateway() {
  echo "Restarting OpenClaw gateway to apply changes..."
  openclaw gateway stop 2>/dev/null || true
  if openclaw gateway install; then
    if openclaw gateway start; then
      success "OpenClaw gateway restarted."
    else
      warn "Failed to restart OpenClaw gateway. Run 'openclaw gateway install' manually."
    fi
  else
    warn "Failed to restart OpenClaw gateway. Run 'openclaw gateway install' manually."
  fi
}

update_workspace_protocols() {
  info "Phase 3: Updating Protocols"
  local workspaces
  workspaces=$(list_workspaces)
  if [ -z "$workspaces" ]; then
    warn "No agent workspaces found in config. Skipping workspace protocol updates."
  else
    echo "$workspaces" | while IFS= read -r ws; do
      [ -z "$ws" ] && continue
      case "$ws" in
        "~")   ws="$HOME" ;;
        "~"/*) ws="$HOME${ws#"~"}" ;;
      esac
      if [ ! -d "$ws" ]; then
        warn "Workspace directory not found: $ws. Skipping."
        continue
      fi
      printf "Updating workspace: ${GREEN}%s${RESET}\n" "$ws"
      update_agents_md "$ws/AGENTS.md"
      update_tools_md "$ws/TOOLS.md"
    done
  fi
  restart_openclaw_gateway
}

# ─── Output ───────────────────────────────────────────────────────────────────

print_success() {
  echo ""
  success "=== Installation Complete ==="
  echo "Your OpenClaw agent is now integrated with PMOVES Cipher Memory (self-hosted)."
  echo "Memory backend: ${CIPHER_URL} (collection: ${CIPHER_MEMORY_COLLECTION})"
  echo "Transport: tailnet-only. Biometric data excluded (L14 privacy tier)."
  echo ""
}

# ─── Main ─────────────────────────────────────────────────────────────────────

main() {
  setup_cleanup

  info "=== PMOVES Cipher Memory Integration Installer ==="
  echo "This script configures the self-hosted PMOVES Cipher Memory as your"
  echo "OpenClaw agent's long-term memory (no cloud service)."
  echo ""

  info "Phase 1: Pre-flight Checks"
  check_openclaw_cli
  check_cipher_api
  check_config
  echo ""

  info "Phase 1.1: Storage & Backup"
  backup_config
  echo ""

  info "Phase 2: Configuration"
  configure_cipher_mcp
  echo "--- Curate Story Options ---"
  configure_memory_flush
  echo ""

  info "Phase 3: Workspace Updates"
  update_workspace_protocols
  echo ""

  print_success
}

main "$@"
