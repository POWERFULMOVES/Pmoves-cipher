import { describe, it } from "mocha";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Regression tests for scripts/openclaw-setup-pmovies.sh — the PMOVES Cipher
// installer for OpenClaw. These cover the paths the 2026-09-10 review flagged:
// the disable-path ReferenceError (config must be parsed before use), the
// authenticated preflight probe (agentId is mandatory on memory routes under
// per-agent token mode), and the generated Store command (without the JSON
// content type express.json() drops the body and the API answers 400).
// Function-level: the script is sourced with
// OPENCLAW_SETUP_PMOLVES_SKIP_MAIN=1 and the reviewed functions run against
// temporary configs, with curl stubbed on PATH.

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(here, "..", "..", "scripts", "openclaw-setup-pmovies.sh");

function shAvailable(): boolean {
  const probe = spawnSync("sh", ["-c", "true"]);
  return !probe.error;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runInSh(snippet: string, env: Record<string, string> = {}): RunResult {
  const r = spawnSync("sh", ["-c", snippet], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_SETUP_PMOLVES_SKIP_MAIN: "1",
      NO_COLOR: "1",
      SETUP_SCRIPT: SCRIPT,
      ...env,
    },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("openclaw-setup-pmovies.sh", function () {
  before(function () {
    if (!shAvailable()) {
      this.skip();
    }
  });

  it("passes sh -n syntax check", function () {
    const r = spawnSync("sh", ["-n", SCRIPT], { encoding: "utf8" });
    assert.strictEqual(r.status, 0, r.stderr);
  });

  it("disable path parses the config instead of throwing ReferenceError", function () {
    // Reviewed defect: remove_memory_flush_config read config.agents without
    // ever parsing the file, so declining the memory-flush prompt (including
    // the default Enter) aborted the whole installer under set -e.
    const dir = mkdtempSync(join(tmpdir(), "openclaw-disable-"));
    try {
      const cfg = join(dir, "openclaw.json");
      writeFileSync(
        cfg,
        JSON.stringify({
          agents: {
            defaults: {
              compaction: {
                reserveTokensFloor: 50000,
                memoryFlush: { enabled: true, softThresholdTokens: 4000 },
              },
            },
          },
        }),
      );
      const r = runInSh(`. "$SETUP_SCRIPT"; remove_memory_flush_config`, {
        // the installer derives CONFIG_PATH from OPENCLAW_CONFIG at source time
        OPENCLAW_CONFIG: cfg,
      });
      assert.strictEqual(
        r.status,
        0,
        `installer function failed:\n${r.stderr}`,
      );
      const after = JSON.parse(readFileSync(cfg, "utf8"));
      assert.strictEqual(after.agents.defaults.memoryFlush, undefined);
      // the now-empty compaction block is cleaned up too
      assert.strictEqual(after.agents.defaults.compaction, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("authenticated preflight probe carries the agent identity", function () {
    // Reviewed defect: with CIPHER_TOKEN set, memory routes answer 400 for a
    // search without agentId, and curl -f turned that into installer failure.
    const dir = mkdtempSync(join(tmpdir(), "openclaw-probe-"));
    try {
      const stub = join(dir, "curl");
      const log = join(dir, "curl-args.log");
      writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" >> "$CURL_LOG"\nexit 0\n`);
      chmodSync(stub, 0o755);
      const r = runInSh(`. "$SETUP_SCRIPT"; check_cipher_api`, {
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        CURL_LOG: log,
        CIPHER_URL: "http://127.0.0.1:8105",
        CIPHER_TOKEN: "cipher_testtoken",
        CIPHER_AGENT_ID: "opal",
      });
      assert.strictEqual(
        r.status,
        0,
        `probe failed with token set:\n${r.stderr}`,
      );
      const captured = readFileSync(log, "utf8");
      assert.match(captured, /agentId=opal/, `probe URL lacks agentId:\n${captured}`);
      assert.match(captured, /Authorization: Bearer cipher_testtoken/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("generated Store command sends JSON content type", function () {
    // Reviewed defect: curl -d defaults to form-urlencoded and express.json()
    // only parses JSON, so the workspace TOOLS.md Store command 400'd.
    const dir = mkdtempSync(join(tmpdir(), "openclaw-tools-"));
    try {
      const toolsMd = join(dir, "TOOLS.md");
      const r = runInSh(`. "$SETUP_SCRIPT"; update_tools_md "$TOOLS_PATH"`, {
        TOOLS_PATH: toolsMd,
        CIPHER_URL: "http://127.0.0.1:8105",
      });
      assert.strictEqual(r.status, 0, r.stderr);
      const body = readFileSync(toolsMd, "utf8");
      const storeLine = body.split("\n").find((line) => line.includes("**Store:**"));
      assert.ok(storeLine, "Store command missing from generated TOOLS.md");
      assert.match(storeLine, /-H "Content-Type: application\/json"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
