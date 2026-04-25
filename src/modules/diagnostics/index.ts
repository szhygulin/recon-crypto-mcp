/**
 * Read-only diagnostic tool: report what the server knows about its config
 * without revealing any secret values. Intended for the future agent-guided
 * `/setup` skill (separate repo) but immediately useful for a user
 * diagnosing "is my server configured the way I think it is?".
 *
 * Strict no-secrets contract:
 *  - Never echoes raw API keys, RPC URLs (which may carry keys in the path),
 *    WC session symkeys, or paired-account private material.
 *  - WC session topic surfaces only as the last 8 chars (matches the
 *    existing `get_ledger_status` convention — enough to cross-check
 *    against Ledger Live's connected-apps list).
 *  - Per-key fields are reduced to `{ set: boolean; source: "env-var" |
 *    "config" | "unset" }`.
 *
 * Pure local I/O: reads `~/.vaultpilot-mcp/config.json` and inspects
 * `process.env`. No RPC calls, no network. Cheap to invoke on every
 * `/setup` step.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readUserConfig, getConfigPath } from "../../config/user-config.js";
import { SUPPORTED_CHAINS, type SupportedChain } from "../../types/index.js";

type EvmRpcSource =
  | "env-var"
  | "provider-key-env"
  | "provider-key-config"
  | "custom-url-config"
  | "public-fallback";

type SolanaRpcSource = "env-var" | "config-url" | "public-fallback";

type ApiKeySource = "env-var" | "config" | "unset";

const ENV_URL_VAR: Record<SupportedChain, string> = {
  ethereum: "ETHEREUM_RPC_URL",
  arbitrum: "ARBITRUM_RPC_URL",
  polygon: "POLYGON_RPC_URL",
  base: "BASE_RPC_URL",
  optimism: "OPTIMISM_RPC_URL",
};

/**
 * Determine the source of the EVM RPC URL for a given chain. Mirrors the
 * priority order in `src/config/chains.ts:resolveRpcUrlRaw`. Replicated
 * deliberately rather than refactored-and-shared so a refactor of the
 * resolver doesn't accidentally change diagnostic output.
 */
function classifyEvmRpcSource(chain: SupportedChain): EvmRpcSource {
  if (process.env[ENV_URL_VAR[chain]]) return "env-var";
  const envProvider = process.env.RPC_PROVIDER?.toLowerCase();
  if (
    (envProvider === "infura" || envProvider === "alchemy") &&
    process.env.RPC_API_KEY
  ) {
    return "provider-key-env";
  }
  const cfg = readUserConfig();
  if (cfg) {
    if (cfg.rpc.provider === "custom" && cfg.rpc.customUrls?.[chain]) {
      return "custom-url-config";
    }
    if (
      (cfg.rpc.provider === "infura" || cfg.rpc.provider === "alchemy") &&
      cfg.rpc.apiKey
    ) {
      return "provider-key-config";
    }
  }
  return "public-fallback";
}

function classifySolanaRpcSource(): SolanaRpcSource {
  if (process.env.SOLANA_RPC_URL) return "env-var";
  if (readUserConfig()?.solanaRpcUrl) return "config-url";
  return "public-fallback";
}

function classifyApiKey(envName: string, configValue: unknown): { set: boolean; source: ApiKeySource } {
  if (process.env[envName]) return { set: true, source: "env-var" };
  if (typeof configValue === "string" && configValue.length > 0) {
    return { set: true, source: "config" };
  }
  return { set: false, source: "unset" };
}

interface VaultPilotConfigStatus {
  /** Where this server expects to read / write its config file. */
  configPath: string;
  /** Whether the config file exists on disk right now. */
  configFileExists: boolean;
  /** vaultpilot-mcp version (read from package.json at process start). */
  serverVersion: string;
  /** Per-chain RPC URL source classification (no URLs leaked). */
  rpc: Record<SupportedChain | "solana", { source: EvmRpcSource | SolanaRpcSource }>;
  /** Per-service API key presence + source. Boolean-only — values never leak. */
  apiKeys: {
    etherscan: { set: boolean; source: ApiKeySource };
    oneInch: { set: boolean; source: ApiKeySource };
    tronGrid: { set: boolean; source: ApiKeySource };
    walletConnectProjectId: { set: boolean; source: ApiKeySource };
  };
  /** Counts of paired Ledger accounts + WC session-topic suffix (last 8 chars). */
  pairings: {
    walletConnect: { sessionTopicSuffix?: string };
    solana: { count: number };
    tron: { count: number };
  };
  /**
   * Agent-side preflight skill state — checked by path, no content read.
   * Override path via VAULTPILOT_SKILL_MARKER_PATH env var (read-only sniff —
   * we don't validate the skill content here).
   */
  preflightSkill: {
    expectedPath: string;
    installed: boolean;
  };
}

/**
 * Resolve the server version by reading `package.json` relative to this
 * file's compiled location. Falls back to `"unknown"` if the file isn't
 * found (e.g. unusual install layouts) — diagnostic output, not load-bearing.
 */
function readServerVersion(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    // Compiled location: dist/modules/diagnostics/index.js → ../../../package.json
    const pkgPath = join(here, "..", "..", "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const DEFAULT_SKILL_MARKER = join(
  homedir(),
  ".claude",
  "skills",
  "vaultpilot-preflight",
  "SKILL.md",
);

function skillMarkerPath(): string {
  return process.env.VAULTPILOT_SKILL_MARKER_PATH ?? DEFAULT_SKILL_MARKER;
}

export function getVaultPilotConfigStatus(_args: Record<string, never> = {}): VaultPilotConfigStatus {
  const cfg = readUserConfig();
  const configPath = getConfigPath();

  const rpc = {} as VaultPilotConfigStatus["rpc"];
  for (const chain of SUPPORTED_CHAINS) {
    rpc[chain] = { source: classifyEvmRpcSource(chain) };
  }
  rpc.solana = { source: classifySolanaRpcSource() };

  // WC session-topic last-8-chars suffix only (mirrors `get_ledger_status`).
  const sessionTopic = cfg?.walletConnect?.sessionTopic;
  const sessionTopicSuffix =
    typeof sessionTopic === "string" && sessionTopic.length >= 8
      ? sessionTopic.slice(-8)
      : undefined;

  const skillPath = skillMarkerPath();
  return {
    configPath,
    configFileExists: existsSync(configPath),
    serverVersion: readServerVersion(),
    rpc,
    apiKeys: {
      etherscan: classifyApiKey("ETHERSCAN_API_KEY", cfg?.etherscanApiKey),
      oneInch: classifyApiKey("ONEINCH_API_KEY", cfg?.oneInchApiKey),
      tronGrid: classifyApiKey("TRON_API_KEY", cfg?.tronApiKey),
      walletConnectProjectId: classifyApiKey(
        "WALLETCONNECT_PROJECT_ID",
        cfg?.walletConnect?.projectId,
      ),
    },
    pairings: {
      walletConnect: sessionTopicSuffix ? { sessionTopicSuffix } : {},
      solana: { count: cfg?.pairings?.solana?.length ?? 0 },
      tron: { count: cfg?.pairings?.tron?.length ?? 0 },
    },
    preflightSkill: {
      expectedPath: skillPath,
      installed: existsSync(skillPath),
    },
  };
}
