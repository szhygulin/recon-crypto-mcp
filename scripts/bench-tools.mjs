#!/usr/bin/env node
/**
 * MCP tool static-surface token-cost benchmark (issue #637).
 *
 * Spawns the built server (`dist/index.js`) over stdio, performs the
 * MCP `initialize` handshake, requests `tools/list`, and feeds the
 * response into `src/diagnostics/tool-cost.ts` to produce a ranked
 * Markdown report of per-tool token cost.
 *
 * The point: identify which tool descriptions / input schemas eat the
 * most agent context per session, so future trim PRs can target the
 * heavy hitters with numbers (the analog of the README rewrite, but
 * for tool surface).
 *
 * Scope: static surface only — what the agent loads via `tools/list`
 * once per conversation. Response-side measurement (CHECKS PERFORMED
 * blocks, NOTICE blocks, payload bodies that load on every tool call)
 * is a follow-on; it requires fixtures or live RPC and is a separate
 * harness.
 *
 * Usage:
 *   npm run build               # produce dist/
 *   npm run bench:tools         # print ranked table to stdout
 *   npm run bench:tools -- --out bench/tool-cost.md  # save markdown
 *   npm run bench:tools -- --top 20   # show top N (default 10)
 *
 * Exit codes: 0 ok, 1 bench failure (server crash, no tools, malformed
 * response). Never modifies state — read-only via `tools/list`.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

import {
  analyzeToolList,
  formatRankingTable,
} from "../dist/diagnostics/tool-cost.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DIST_ENTRY = resolve(REPO_ROOT, "dist", "index.js");

function parseArgs(argv) {
  const args = { out: null, top: 10 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") {
      args.out = argv[++i];
    } else if (a === "--top") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--top requires a positive integer, got: ${argv[i]}`);
      }
      args.top = Math.floor(n);
    } else if (a === "--help" || a === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown flag: ${a}`);
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(
    [
      "bench-tools — measure MCP tool static-surface token cost",
      "",
      "Usage:",
      "  npm run bench:tools                       Print ranked table to stdout",
      "  npm run bench:tools -- --out FILE         Save markdown report to FILE",
      "  npm run bench:tools -- --top N            Show top N tools (default 10)",
      "  npm run bench:tools -- --help             This message",
      "",
    ].join("\n"),
  );
}

/**
 * Spawn the built server and run an MCP `initialize` + `tools/list`
 * round-trip. Returns the array of tool descriptors.
 */
async function listTools() {
  if (!existsSync(DIST_ENTRY)) {
    throw new Error(
      `dist/index.js not found at ${DIST_ENTRY} — run \`npm run build\` first`,
    );
  }

  return new Promise((resolveList, rejectList) => {
    // Force demo mode off and any chain scoping off so we measure the
    // full registered surface, not a narrowed slice. Bench is the
    // canonical "what does the unrestricted agent load?" snapshot.
    const child = spawn(process.execPath, [DIST_ENTRY], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        VAULTPILOT_DEMO: "",
        VAULTPILOT_SCOPE: "",
      },
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      rejectList(
        new Error(
          `bench-tools timed out after 30s. server stderr tail:\n${stderrBuf.slice(-2000)}`,
        ),
      );
    }, 30_000);

    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectList(err);
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectList(
        new Error(
          `server exited unexpectedly (code=${code}, signal=${signal}) before tools/list response. stderr tail:\n${stderrBuf.slice(-2000)}`,
        ),
      );
    });

    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf8");
      // JSON-RPC over stdio is newline-delimited.
      let nl;
      while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          // Non-JSON lines on stdout shouldn't happen for an MCP
          // server; skip and continue.
          continue;
        }
        if (msg.id === 1 && msg.result) {
          // initialize response — fire the initialized notification,
          // then request tools/list.
          send(child, {
            jsonrpc: "2.0",
            method: "notifications/initialized",
          });
          send(child, {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
            params: {},
          });
        } else if (msg.id === 2) {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (msg.error) {
            rejectList(
              new Error(`tools/list returned error: ${JSON.stringify(msg.error)}`),
            );
          } else {
            resolveList(msg.result?.tools ?? []);
          }
          // Polite shutdown — server has no graceful close hook for
          // stdio, so SIGTERM is the right signal.
          child.kill("SIGTERM");
        }
      }
    });

    // Kick off the handshake.
    send(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "vaultpilot-bench-tools", version: "0.0.0" },
      },
    });
  });
}

function send(child, msg) {
  child.stdin.write(JSON.stringify(msg) + "\n");
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    process.stderr.write(`bench-tools: ${err.message}\n`);
    printHelp();
    process.exit(2);
  }
  if (args.help) {
    printHelp();
    return;
  }

  const tools = await listTools();
  if (tools.length === 0) {
    throw new Error("tools/list returned zero tools — server registered nothing");
  }

  const summary = analyzeToolList(tools);
  const report = formatRankingTable(summary, { top: args.top });

  process.stdout.write(report + "\n");

  if (args.out) {
    const outPath = resolve(REPO_ROOT, args.out);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, report + "\n", "utf8");
    process.stderr.write(`bench-tools: wrote report to ${outPath}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`bench-tools failed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
