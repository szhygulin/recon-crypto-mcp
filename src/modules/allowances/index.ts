/**
 * `get_token_allowances` — enumerate every spender holding a non-zero
 * allowance for a given (wallet, token, chain) tuple.
 *
 * Pipeline:
 *   1. Pull every `Approval(owner=wallet)` event emitted by `token` via
 *      the Etherscan V2 logs API. Single call covers the chain's full
 *      history (Etherscan indexes from genesis).
 *   2. Dedup by spender, keeping the LATEST event per spender. The log
 *      entries' `value` field is the snapshot at approval time; the
 *      live allowance may differ (subsequent transfers consume it,
 *      subsequent approves overwrite it). We use the log's metadata
 *      (block / tx hash / timestamp) for "last approved" provenance,
 *      not for the value itself.
 *   3. Multicall3 batched `allowance(owner, spender)` reads for each
 *      unique spender to get the LIVE current allowance.
 *   4. Drop spenders whose live allowance is 0 (revoked or fully used).
 *   5. Resolve token metadata (symbol / decimals / name) once.
 *   6. Surface friendly labels for known protocol contracts (Aave V3
 *      Pool, Uniswap V3 SwapRouter02, etc.) via the canonical
 *      `CONTRACTS` table.
 *   7. Sort descending by allowance — largest exposures first.
 *
 * No price math, no USD valuation in v1. The "how much exposure?"
 * question is genuinely about the raw allowance, not its current spot
 * value — a 1000 USDC allowance is concerning regardless of USDC price.
 */

import type { Hex } from "viem";
import { getClient } from "../../data/rpc.js";
import { erc20Abi } from "../../abis/erc20.js";
import { etherscanV2Fetch } from "../../data/apis/etherscan-v2.js";
import { CONTRACTS } from "../../config/contracts.js";
import { formatUnits } from "../../data/format.js";
import type { SupportedChain } from "../../types/index.js";
import type {
  AllowanceRow,
  GetTokenAllowancesArgs,
  GetTokenAllowancesResult,
} from "./schemas.js";

const APPROVAL_TOPIC =
  "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const MAX_UINT256 = (1n << 256n) - 1n;
/**
 * Threshold above which an allowance is considered "unlimited". Many
 * wallets cap below MAX_UINT256 (USDC's `permit` for instance subtracts 1);
 * anything within 0.01% of MAX is functionally unlimited.
 */
const UNLIMITED_THRESHOLD = MAX_UINT256 - MAX_UINT256 / 10_000n;

/**
 * Etherscan logs API row shape. Per the V2 docs, `module=logs&action=getLogs`
 * returns these fields when `status === "1"`.
 */
interface EtherscanLogRow {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  /** Decimal string of unix seconds. */
  timeStamp?: string;
  transactionHash: string;
  transactionIndex?: string;
  logIndex?: string;
}

/**
 * Pad a 0x-prefixed 20-byte EVM address to a 32-byte topic value.
 */
function addressToTopic(addr: `0x${string}`): string {
  return `0x000000000000000000000000${addr.slice(2).toLowerCase()}`;
}

/**
 * Build a one-shot lookup map for known protocol-contract addresses on
 * the given chain. Resolves spender addresses to user-facing labels.
 */
function buildKnownSpenderMap(chain: SupportedChain): Map<string, string> {
  const out = new Map<string, string>();
  const c = CONTRACTS[chain] as Record<string, Record<string, string>> | undefined;
  if (!c) return out;
  for (const [protocol, addrs] of Object.entries(c)) {
    if (protocol === "tokens") continue; // not spenders
    if (typeof addrs !== "object" || addrs === null) continue;
    for (const [name, addr] of Object.entries(addrs)) {
      if (typeof addr !== "string" || !addr.startsWith("0x")) continue;
      out.set(
        addr.toLowerCase(),
        `${prettyProtocol(protocol)} ${prettyContractName(name)}`,
      );
    }
  }
  return out;
}

function prettyProtocol(slug: string): string {
  if (slug === "aave") return "Aave V3";
  if (slug === "uniswap") return "Uniswap V3";
  if (slug === "lido") return "Lido";
  if (slug === "eigenlayer") return "EigenLayer";
  if (slug === "compound") return "Compound V3";
  if (slug === "morpho") return "Morpho Blue";
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

function prettyContractName(name: string): string {
  // Camel-to-spaced. "swapRouter02" → "SwapRouter02".
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Fetch ERC-20 metadata in one multicall: symbol, decimals, name. Tolerant
 * — name is allowed to fail (some non-standard tokens omit it); symbol +
 * decimals are mandatory.
 */
async function fetchTokenMetadata(
  chain: SupportedChain,
  token: `0x${string}`,
): Promise<{ symbol: string; decimals: number; name?: string }> {
  const client = getClient(chain);
  const results = await client.multicall({
    contracts: [
      { address: token, abi: erc20Abi, functionName: "symbol" },
      { address: token, abi: erc20Abi, functionName: "decimals" },
      { address: token, abi: erc20Abi, functionName: "name" },
    ],
    allowFailure: true,
  });
  const symbolRes = results[0];
  const decimalsRes = results[1];
  const nameRes = results[2];
  if (symbolRes.status !== "success" || decimalsRes.status !== "success") {
    throw new Error(
      `Token ${token} on ${chain} did not return symbol+decimals. Is this an ERC-20 contract?`,
    );
  }
  return {
    symbol: symbolRes.result as string,
    decimals: Number(decimalsRes.result),
    ...(nameRes.status === "success"
      ? { name: nameRes.result as string }
      : {}),
  };
}

/**
 * Multicall3 batched `allowance(owner, spender)` for every spender in
 * `spenders`. Returns one bigint per row, in input order. Failed reads
 * fall through to 0n — same posture as the rest of the codebase.
 */
async function fetchCurrentAllowances(
  chain: SupportedChain,
  token: `0x${string}`,
  owner: `0x${string}`,
  spenders: `0x${string}`[],
): Promise<bigint[]> {
  if (spenders.length === 0) return [];
  const client = getClient(chain);
  const results = await client.multicall({
    contracts: spenders.map((spender) => ({
      address: token,
      abi: erc20Abi,
      functionName: "allowance" as const,
      args: [owner, spender] as const,
    })),
    allowFailure: true,
  });
  return results.map((r) => (r.status === "success" ? (r.result as bigint) : 0n));
}

/**
 * Etherscan caps `getLogs` at 1000 records per page. We pull page 1
 * with offset=1000; if exactly 1000 came back, surface a `truncated`
 * flag so the caller knows the oldest approvals may be missing.
 * Pagination beyond page 1 is deferred — wallets with >1000 distinct
 * approvals on a single token are extremely rare and the live allowance
 * read still tells the truth about the spenders we DID see.
 */
const LOGS_PAGE_SIZE = 1000;

async function fetchApprovalLogs(
  chain: SupportedChain,
  token: `0x${string}`,
  owner: `0x${string}`,
): Promise<{ logs: EtherscanLogRow[]; truncated: boolean }> {
  const params: Record<string, string> = {
    module: "logs",
    action: "getLogs",
    address: token,
    topic0: APPROVAL_TOPIC,
    topic1: addressToTopic(owner),
    topic0_1_opr: "and",
    fromBlock: "0",
    toBlock: "latest",
    page: "1",
    offset: String(LOGS_PAGE_SIZE),
  };
  const logs = await etherscanV2Fetch<EtherscanLogRow>(chain, params);
  return {
    logs,
    truncated: logs.length >= LOGS_PAGE_SIZE,
  };
}

export async function getTokenAllowances(
  args: GetTokenAllowancesArgs,
): Promise<GetTokenAllowancesResult> {
  const chain = args.chain as SupportedChain;
  const wallet = args.wallet.toLowerCase() as `0x${string}`;
  const token = args.token.toLowerCase() as `0x${string}`;

  // 1. Pull Approval events from Etherscan.
  const { logs, truncated } = await fetchApprovalLogs(chain, token, wallet);

  // 2. Dedup by spender, keeping the latest event per spender. Etherscan
  //    returns logs in chronological order (oldest first). Iterating
  //    forward and overwriting in a Map yields "latest wins".
  interface SeenLog {
    spender: `0x${string}`;
    blockNumber: string;
    txHash: `0x${string}`;
    timeStamp?: string;
  }
  const lastBySpender = new Map<string, SeenLog>();
  for (const log of logs) {
    if (!log.topics || log.topics.length < 3) continue;
    if (log.topics[0]?.toLowerCase() !== APPROVAL_TOPIC) continue;
    const spenderTopic = log.topics[2];
    if (!spenderTopic || spenderTopic.length < 42) continue;
    const spender = `0x${spenderTopic.slice(-40)}` as `0x${string}`;
    lastBySpender.set(spender, {
      spender,
      blockNumber: log.blockNumber,
      txHash: log.transactionHash as `0x${string}`,
      ...(log.timeStamp ? { timeStamp: log.timeStamp } : {}),
    });
  }

  // 3. Multicall live allowances + 5. fetch token metadata in parallel.
  const uniqueSpenders = Array.from(lastBySpender.values()).map((s) => s.spender);
  const [meta, currentAllowances] = await Promise.all([
    fetchTokenMetadata(chain, token),
    fetchCurrentAllowances(chain, token, wallet, uniqueSpenders),
  ]);

  // 6. Build rows, dropping zero-allowance spenders.
  const knownSpenderMap = buildKnownSpenderMap(chain);
  const rows: AllowanceRow[] = [];
  let unlimitedCount = 0;
  for (let i = 0; i < uniqueSpenders.length; i++) {
    const allowance = currentAllowances[i];
    if (allowance === 0n) continue;
    const spender = uniqueSpenders[i];
    const meta2 = lastBySpender.get(spender)!;
    const isUnlimited = allowance >= UNLIMITED_THRESHOLD;
    if (isUnlimited) unlimitedCount++;
    const label = knownSpenderMap.get(spender.toLowerCase());
    const lastApprovedAt = meta2.timeStamp
      ? new Date(Number(meta2.timeStamp) * 1000).toISOString()
      : undefined;
    rows.push({
      spender,
      ...(label ? { spenderLabel: label } : {}),
      currentAllowance: allowance.toString(),
      currentAllowanceFormatted: isUnlimited
        ? "unlimited"
        : formatUnits(allowance, meta.decimals),
      isUnlimited,
      lastApprovedBlock: meta2.blockNumber,
      lastApprovedTxHash: meta2.txHash,
      ...(lastApprovedAt ? { lastApprovedAt } : {}),
    });
  }

  // 7. Sort descending by allowance.
  rows.sort((a, b) => {
    const aBig = BigInt(a.currentAllowance);
    const bBig = BigInt(b.currentAllowance);
    if (bBig > aBig) return 1;
    if (bBig < aBig) return -1;
    return 0;
  });

  const notes: string[] = [];
  if (truncated) {
    notes.push(
      `Etherscan logs API returned the cap (${LOGS_PAGE_SIZE} entries) — older Approval events may be missing. ` +
        `The LIVE allowance reads still reflect the truth for the spenders we DID see; only spenders whose ` +
        `single approval landed before the truncation horizon could be missed entirely.`,
    );
  }
  if (unlimitedCount > 0) {
    notes.push(
      `${unlimitedCount} unlimited allowance${unlimitedCount === 1 ? "" : "s"} — the spender(s) can move ` +
        `your entire ${meta.symbol} balance at any time, including any future top-ups. Revoke obsolete ` +
        `unlimited approvals via \`prepare_*\` an approve(spender, 0) call, or via Etherscan's "Token Approvals" UI.`,
    );
  }
  if (rows.length === 0) {
    notes.push(
      `No active approvals found for ${wallet} on ${meta.symbol} (${chain}). Either the wallet has never ` +
        `approved this token, or every prior approval has since been revoked or fully consumed.`,
    );
  }

  return {
    wallet,
    chain,
    token: { address: token, ...meta },
    allowances: rows,
    totalScanned: lastBySpender.size,
    unlimitedCount,
    truncated,
    notes,
  };
}
