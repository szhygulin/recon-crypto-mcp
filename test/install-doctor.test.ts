/**
 * Issue #359 — pre-restart install validation. Tests for the doctor
 * helpers in `src/check.ts`. The exit-code + stderr-render path is
 * exercised in `src/index.ts`'s argv branch; here we cover the
 * structural shape of the report so future regressions on a specific
 * check (e.g. flipping a `warn` to `fail` or vice versa) get caught.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfigDirForTesting } from "../src/config/user-config.js";
import {
  parseDoctorFlags,
  runDoctor,
  formatDoctorReport,
  type DoctorReport,
} from "../src/check.js";

let tmp: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vaultpilot-doctor-"));
  setConfigDirForTesting(tmp);
  // Snapshot every env var the doctor reads, then clear them so each
  // test starts from a known-empty baseline. HOME is overridden too —
  // the doctor's legacy-config path resolves via `homedir()` so a real
  // legacy config in the developer's home would otherwise leak into
  // the report under test.
  savedEnv = { ...process.env };
  process.env.HOME = tmp;
  for (const k of [
    "ETHEREUM_RPC_URL",
    "ARBITRUM_RPC_URL",
    "POLYGON_RPC_URL",
    "BASE_RPC_URL",
    "OPTIMISM_RPC_URL",
    "SOLANA_RPC_URL",
    "RPC_PROVIDER",
    "RPC_API_KEY",
    "TRON_API_KEY",
    "WALLETCONNECT_PROJECT_ID",
    "ETHERSCAN_API_KEY",
  ]) {
    delete process.env[k];
  }
});

afterEach(() => {
  setConfigDirForTesting(null);
  rmSync(tmp, { recursive: true, force: true });
  process.env = savedEnv;
});

function getCheck(report: DoctorReport, name: string) {
  const c = report.checks.find((x) => x.name === name);
  if (!c) throw new Error(`expected check "${name}" in report`);
  return c;
}

describe("parseDoctorFlags", () => {
  it("recognizes --check / --doctor / --health", () => {
    expect(parseDoctorFlags(["node", "x.js", "--check"]).enabled).toBe(true);
    expect(parseDoctorFlags(["node", "x.js", "--doctor"]).enabled).toBe(true);
    expect(parseDoctorFlags(["node", "x.js", "--health"]).enabled).toBe(true);
  });

  it("returns enabled:false when no doctor flag is present", () => {
    expect(parseDoctorFlags(["node", "x.js"]).enabled).toBe(false);
    expect(parseDoctorFlags(["node", "x.js", "--unrelated"]).enabled).toBe(false);
  });

  it("recognizes --json as a sibling flag", () => {
    expect(parseDoctorFlags(["node", "x.js", "--check", "--json"])).toEqual({
      enabled: true,
      json: true,
    });
    expect(parseDoctorFlags(["node", "x.js", "--check"])).toEqual({
      enabled: true,
      json: false,
    });
  });
});

describe("runDoctor — config presence", () => {
  it("emits a warn (not fail) when no config is present — read-only fallbacks still work", () => {
    const report = runDoctor();
    expect(getCheck(report, "config-file").status).toBe("warn");
    expect(getCheck(report, "config-file").message).toMatch(/run.*setup/i);
    // Critically: the absent config is NOT a blocker.
    expect(report.ok).toBe(true);
  });

  it("emits ok when config is present and valid", () => {
    writeFileSync(
      join(tmp, "config.json"),
      JSON.stringify({ rpc: { provider: "infura", apiKey: "test" } }),
    );
    const report = runDoctor();
    expect(getCheck(report, "config-file").status).toBe("ok");
  });

  it("emits fail when config is present but malformed JSON", () => {
    writeFileSync(join(tmp, "config.json"), "{ not valid json }");
    const report = runDoctor();
    const c = getCheck(report, "config-file");
    expect(c.status).toBe("fail");
    expect(c.message).toMatch(/failed to parse/i);
    // Malformed config IS a blocker — exit non-zero so the user sees it.
    expect(report.ok).toBe(false);
  });
});

describe("runDoctor — EVM RPC source", () => {
  it("reports `env` source when ETHEREUM_RPC_URL is set", () => {
    process.env.ETHEREUM_RPC_URL = "https://eth.example/rpc";
    const report = runDoctor();
    const c = getCheck(report, "evm-rpc");
    expect(c.status).toBe("ok");
    expect(c.message).toMatch(/per-chain env vars/i);
    expect(c.message).toContain("ETHEREUM_RPC_URL");
  });

  it("reports `env` source when RPC_PROVIDER + RPC_API_KEY are set", () => {
    process.env.RPC_PROVIDER = "alchemy";
    process.env.RPC_API_KEY = "key";
    const report = runDoctor();
    const c = getCheck(report, "evm-rpc");
    expect(c.status).toBe("ok");
    expect(c.message).toContain("alchemy");
  });

  it("reports `config` source when config.rpc.provider is set", () => {
    writeFileSync(
      join(tmp, "config.json"),
      JSON.stringify({ rpc: { provider: "infura", apiKey: "k" } }),
    );
    const report = runDoctor();
    const c = getCheck(report, "evm-rpc");
    expect(c.status).toBe("ok");
    expect(c.message).toMatch(/from config/);
  });

  it("falls back with a warn when nothing is configured (PublicNode path)", () => {
    const report = runDoctor();
    const c = getCheck(report, "evm-rpc");
    expect(c.status).toBe("warn");
    expect(c.message).toMatch(/PublicNode|fallback/i);
    // Fallback is still not a blocker — first-contact reads work.
    expect(report.ok).toBe(true);
  });
});

describe("runDoctor — Solana RPC source", () => {
  it("reports `env` when SOLANA_RPC_URL is set", () => {
    process.env.SOLANA_RPC_URL = "https://mainnet.helius-rpc.com/?api-key=k";
    const report = runDoctor();
    expect(getCheck(report, "solana-rpc").status).toBe("ok");
  });

  it("reports `config` when config.solanaRpcUrl is set", () => {
    writeFileSync(
      join(tmp, "config.json"),
      JSON.stringify({ rpc: { provider: "infura" }, solanaRpcUrl: "https://h.example" }),
    );
    expect(getCheck(runDoctor(), "solana-rpc").status).toBe("ok");
  });

  it("falls back to public mainnet with a warn when neither is set", () => {
    const c = getCheck(runDoctor(), "solana-rpc");
    expect(c.status).toBe("warn");
    expect(c.message).toMatch(/mainnet-beta|public mainnet/i);
  });
});

describe("runDoctor — API keys are warn-only when missing", () => {
  it("Etherscan / TRON / WalletConnect missing → warn (not fail), report still ok", () => {
    const report = runDoctor();
    expect(getCheck(report, "tron-api-key").status).toBe("warn");
    expect(getCheck(report, "walletconnect-project-id").status).toBe("warn");
    expect(getCheck(report, "etherscan-api-key").status).toBe("warn");
    expect(report.ok).toBe(true);
  });

  it("Etherscan / TRON / WalletConnect present → ok", () => {
    process.env.ETHERSCAN_API_KEY = "etherscan-k";
    process.env.TRON_API_KEY = "tron-k";
    process.env.WALLETCONNECT_PROJECT_ID = "wc-id";
    const report = runDoctor();
    expect(getCheck(report, "tron-api-key").status).toBe("ok");
    expect(getCheck(report, "walletconnect-project-id").status).toBe("ok");
    expect(getCheck(report, "etherscan-api-key").status).toBe("ok");
  });
});

describe("formatDoctorReport — stderr render", () => {
  it("uses ✓ ⚠ ✗ symbols and ends with a clear OK / BLOCKER summary", () => {
    const report = runDoctor();
    const text = formatDoctorReport(report);
    expect(text).toMatch(/^vaultpilot-mcp doctor/);
    // At least one symbol present (whatever the actual checks produced).
    expect(text).toMatch(/[✓⚠✗]/);
    expect(text).toMatch(/Result: OK|BLOCKER/);
  });

  it("reports the warning count when only warnings (no blockers)", () => {
    // Default empty-env, no-config state — multiple warnings, no blockers.
    const report = runDoctor();
    expect(report.ok).toBe(true);
    expect(formatDoctorReport(report)).toMatch(/with \d+ warnings?/);
  });

  it("reports BLOCKER when any check failed (e.g. malformed config)", () => {
    writeFileSync(join(tmp, "config.json"), "not json");
    const report = runDoctor();
    expect(report.ok).toBe(false);
    expect(formatDoctorReport(report)).toMatch(/BLOCKER/);
  });
});
