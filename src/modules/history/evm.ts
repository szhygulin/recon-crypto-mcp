import { cache } from "../../data/cache.js";
import { CACHE_TTL } from "../../config/cache.js";
import { resolveEtherscanApiKey, readUserConfig } from "../../config/user-config.js";
import { sanitizeContractName } from "../../data/apis/etherscan.js";
import type { SupportedChain } from "../../types/index.js";
import type {
  ExternalHistoryItem,
  TokenTransferHistoryItem,
  InternalHistoryItem,
} from "./schemas.js";

const API_BASE: Record<SupportedChain, string> = {
  ethereum: "https://api.etherscan.io/api",
  arbitrum: "https://api.arbiscan.io/api",
  polygon: "https://api.polygonscan.com/api",
  base: "https://api.basescan.org/api",
};

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const SERVER_ROW_CAP = 100;
const MAX_SYMBOL_LEN = 32;
const MAX_NAME_LEN = 64;

interface EtherscanEnvelope<T> {
  status: string;
  message: string;
  result: T | string;
}

interface TxListItem {
  hash: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
  input: string;
  isError: string;
  txreceipt_status?: string;
}

interface TokenTxItem {
  hash: string;
  timeStamp: string;
  from: string;
  to: string;
  contractAddress: string;
  value: string;
  tokenSymbol: string;
  tokenName: string;
  tokenDecimal: string;
}

interface InternalTxItem {
  hash: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
  isError: string;
  traceId?: string;
}

async function etherscanFetch<T>(
  chain: SupportedChain,
  params: Record<string, string>
): Promise<T[]> {
  const apiKey = resolveEtherscanApiKey(readUserConfig());
  const qs = new URLSearchParams({
    ...params,
    page: "1",
    offset: String(SERVER_ROW_CAP),
    sort: "desc",
  });
  if (apiKey) qs.set("apikey", apiKey);

  const res = await fetch(`${API_BASE[chain]}?${qs.toString()}`);
  if (!res.ok) {
    throw new Error(`Etherscan ${chain} ${params.action} returned ${res.status}`);
  }
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error(
      `Etherscan ${chain} ${params.action} response exceeds ${MAX_RESPONSE_BYTES} bytes (got ${text.length})`
    );
  }
  const body = JSON.parse(text) as EtherscanEnvelope<T[]>;
  if (body.status !== "1") {
    if (typeof body.result === "string" && body.result.toLowerCase().includes("no transactions")) {
      return [];
    }
    if (body.message?.toLowerCase().includes("no transactions")) {
      return [];
    }
    throw new Error(
      `Etherscan ${chain} ${params.action} error: ${body.message || "unknown"}`
    );
  }
  return Array.isArray(body.result) ? body.result : [];
}

function formatUnitsDecimal(raw: string, decimals: number): string {
  if (!/^\d+$/.test(raw)) return "0";
  if (decimals === 0) return raw;
  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return frac.length > 0 ? `${whole}.${frac}` : whole;
}

function toExternal(t: TxListItem): ExternalHistoryItem {
  const input = typeof t.input === "string" ? t.input : "0x";
  const methodSelector =
    input.length >= 10 && input.startsWith("0x") ? input.slice(0, 10) : undefined;
  const failed = t.isError === "1" || t.txreceipt_status === "0";
  const valueWei = /^\d+$/.test(t.value) ? t.value : "0";
  return {
    type: "external",
    hash: t.hash,
    timestamp: Number(t.timeStamp),
    from: t.from,
    to: t.to,
    valueNative: valueWei,
    valueNativeFormatted: formatUnitsDecimal(valueWei, 18),
    status: failed ? "failed" : "success",
    ...(methodSelector ? { methodSelector } : {}),
  };
}

/**
 * Whitelist letters/digits/spaces/dots/dashes/underscores only. Symbol and
 * name fields on-chain are attacker-controlled at deploy time and are heavily
 * phishing-targeted ("CLAIM https://...", zero-width joiners that render as
 * URLs). Whitelisting removes the entire injection surface at the cost of a
 * few legitimate exotic symbols — acceptable trade for a read-only history.
 */
function sanitizeDisplayString(raw: string | undefined, maxLen: number): string {
  if (!raw) return "";
  return raw.replace(/[^A-Za-z0-9 ._\-]/g, "").trim().slice(0, maxLen);
}

function toTokenTransfer(t: TokenTxItem): TokenTransferHistoryItem | null {
  // Drop rows whose raw symbol/name hints at obvious phishing. Err on the side
  // of dropping — a missing row is better than a sanitized-but-still-suspicious
  // one where the injection was carried in an already-dropped Unicode char.
  const rawSymbolLower = (t.tokenSymbol ?? "").toLowerCase();
  const rawNameLower = (t.tokenName ?? "").toLowerCase();
  if (/https?|www\.|claim|visit|airdrop|\.com|\.io|\.app|\.xyz|\.net/.test(rawSymbolLower)) return null;
  if (/https?|www\.|claim|visit|airdrop|\.com|\.io|\.app|\.xyz|\.net/.test(rawNameLower)) return null;

  const rawSymbol = sanitizeDisplayString(t.tokenSymbol, MAX_SYMBOL_LEN);
  sanitizeDisplayString(t.tokenName, MAX_NAME_LEN);
  const tokenSymbol = rawSymbol || "UNKNOWN";
  const tokenDecimals = Number(t.tokenDecimal);
  if (!Number.isFinite(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 36) return null;
  const amount = /^\d+$/.test(t.value) ? t.value : "0";
  return {
    type: "token_transfer",
    hash: t.hash,
    timestamp: Number(t.timeStamp),
    from: t.from,
    to: t.to,
    tokenAddress: t.contractAddress,
    tokenSymbol,
    tokenDecimals,
    amount,
    amountFormatted: formatUnitsDecimal(amount, tokenDecimals),
    status: "success",
  };
}

function toInternal(t: InternalTxItem): InternalHistoryItem {
  const failed = t.isError === "1";
  const valueWei = /^\d+$/.test(t.value) ? t.value : "0";
  return {
    type: "internal",
    hash: t.hash,
    timestamp: Number(t.timeStamp),
    from: t.from,
    to: t.to,
    valueNative: valueWei,
    valueNativeFormatted: formatUnitsDecimal(valueWei, 18),
    status: failed ? "failed" : "success",
    ...(t.traceId ? { traceId: t.traceId } : {}),
  };
}

export interface EvmFetchResult {
  external: ExternalHistoryItem[];
  tokenTransfers: TokenTransferHistoryItem[];
  internal: InternalHistoryItem[];
  truncated: boolean;
  errors: Array<{ source: string; message: string }>;
}

export async function fetchEvmHistory(args: {
  wallet: `0x${string}`;
  chain: SupportedChain;
  includeExternal: boolean;
  includeTokenTransfers: boolean;
  includeInternal: boolean;
}): Promise<EvmFetchResult> {
  const { wallet, chain } = args;
  const cacheKey = `history:evm:${chain}:${wallet.toLowerCase()}`;
  const cached = cache.get<EvmFetchResult>(cacheKey);
  if (cached) {
    return filterForFlags(cached, args);
  }

  const errors: Array<{ source: string; message: string }> = [];
  const baseParams = { module: "account", address: wallet };

  const [externalRows, tokenRows, internalRows] = await Promise.all([
    etherscanFetch<TxListItem>(chain, { ...baseParams, action: "txlist" }).catch((e: Error) => {
      errors.push({ source: `etherscan.txlist.${chain}`, message: e.message });
      return [] as TxListItem[];
    }),
    etherscanFetch<TokenTxItem>(chain, { ...baseParams, action: "tokentx" }).catch((e: Error) => {
      errors.push({ source: `etherscan.tokentx.${chain}`, message: e.message });
      return [] as TokenTxItem[];
    }),
    etherscanFetch<InternalTxItem>(chain, { ...baseParams, action: "txlistinternal" }).catch((e: Error) => {
      errors.push({ source: `etherscan.txlistinternal.${chain}`, message: e.message });
      return [] as InternalTxItem[];
    }),
  ]);

  const external = externalRows.map(toExternal);
  const tokenTransfers = tokenRows
    .map(toTokenTransfer)
    .filter((r): r is TokenTransferHistoryItem => r !== null);
  const internal = internalRows.map(toInternal);

  const truncated =
    externalRows.length >= SERVER_ROW_CAP ||
    tokenRows.length >= SERVER_ROW_CAP ||
    internalRows.length >= SERVER_ROW_CAP;

  const result: EvmFetchResult = { external, tokenTransfers, internal, truncated, errors };
  if (errors.length < 3) cache.set(cacheKey, result, CACHE_TTL.HISTORY);
  return filterForFlags(result, args);
}

function filterForFlags(
  r: EvmFetchResult,
  flags: { includeExternal: boolean; includeTokenTransfers: boolean; includeInternal: boolean }
): EvmFetchResult {
  return {
    external: flags.includeExternal ? r.external : [],
    tokenTransfers: flags.includeTokenTransfers ? r.tokenTransfers : [],
    internal: flags.includeInternal ? r.internal : [],
    truncated: r.truncated,
    errors: r.errors,
  };
}

export { sanitizeContractName };
