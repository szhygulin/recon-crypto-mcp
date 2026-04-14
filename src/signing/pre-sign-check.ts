import {
  concat,
  decodeFunctionData,
  hexToBytes,
  keccak256,
  numberToBytes,
  toBytes,
  toFunctionSelector,
  toHex,
  type Abi,
} from "viem";
import { erc20Abi } from "../abis/erc20.js";
import { aavePoolAbi } from "../abis/aave-pool.js";
import { stETHAbi, lidoWithdrawalQueueAbi } from "../abis/lido.js";
import { eigenStrategyManagerAbi } from "../abis/eigenlayer-strategy-manager.js";
import { cometAbi } from "../abis/compound-comet.js";
import { morphoBlueAbi } from "../abis/morpho-blue.js";
import { uniswapPositionManagerAbi } from "../abis/uniswap-position-manager.js";
import { uniswapSwapRouterAbi } from "../abis/uniswap-swap-router.js";
import { CONTRACTS } from "../config/contracts.js";
import {
  CHAIN_IDS,
  type SupportedChain,
  type TrustDetails,
  type TrustMode,
  type UnsignedTx,
} from "../types/index.js";

/**
 * Returns the pinned Aave V3 Pool address for `chain`. We deliberately DO NOT
 * resolve this via PoolAddressesProvider.getPool() at sign time: the pre-sign
 * check is our defense against a hostile RPC, so it must not delegate a trust-
 * root lookup to that same RPC. Pool addresses are frozen per chain since
 * Aave V3 launched and have not rotated; see contracts.ts for the source.
 */
function pinnedAavePool(chain: SupportedChain): `0x${string}` {
  return CONTRACTS[chain].aave.pool as `0x${string}`;
}

/**
 * Independent pre-sign safety check. Runs in send_transaction AFTER the handle
 * is redeemed and chain id is verified, immediately before the tx is handed to
 * Ledger Live. The goal is a second line of defense against a compromised /
 * prompt-injected agent: even if a prepare_* tool produced a misleading
 * description, this check reasons about the raw calldata alone and refuses
 * anything that doesn't match a known-safe shape.
 *
 * Threat model: the canonical prompt-injection attack against a wallet agent is
 * convincing the model to sign an `approve(attacker, MAX)` or a direct
 * `transfer(attacker, amount)` on some token. This check closes the approve
 * vector outright (spender allowlist) and narrows the call-surface to
 * contracts we've explicitly recognized.
 */

/** LiFi Diamond — deterministic address across all our chains. Stable since 2022. */
const LIFI_DIAMOND = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae";

/** 4-byte selectors we treat as explicit allowlist entries. */
const SELECTOR = {
  approve: toFunctionSelector("approve(address,uint256)").toLowerCase(),
  transfer: toFunctionSelector("transfer(address,uint256)").toLowerCase(),
} as const;

/** Kinds of destination we recognize; used for error messages only. */
type DestinationKind =
  | "aave-v3-pool"
  | "compound-v3-comet"
  | "morpho-blue"
  | "lido-stETH"
  | "lido-withdrawalQueue"
  | "eigenlayer-strategyManager"
  | "uniswap-v3-npm"
  | "uniswap-v3-router"
  | "known-erc20"
  | "lifi-diamond";

interface RecognizedDestination {
  kind: DestinationKind;
  /** ABI to check the selector against. null = skip selector check (LiFi: too many selectors). */
  allowedAbi: Abi | null;
}

function computeSelectorsFromAbi(abi: Abi): Set<string> {
  const out = new Set<string>();
  for (const item of abi) {
    if (item.type !== "function") continue;
    try {
      out.add(toFunctionSelector(item).toLowerCase());
    } catch {
      // Skip items that don't encode cleanly (shouldn't happen in our curated ABIs).
    }
  }
  return out;
}

const AAVE_SELECTORS = computeSelectorsFromAbi(aavePoolAbi);
const COMET_SELECTORS = computeSelectorsFromAbi(cometAbi);
const MORPHO_SELECTORS = computeSelectorsFromAbi(morphoBlueAbi);
const LIDO_STETH_SELECTORS = computeSelectorsFromAbi(stETHAbi);
const LIDO_QUEUE_SELECTORS = computeSelectorsFromAbi(lidoWithdrawalQueueAbi);
const EIGEN_SELECTORS = computeSelectorsFromAbi(eigenStrategyManagerAbi);
const UNISWAP_NPM_SELECTORS = computeSelectorsFromAbi(uniswapPositionManagerAbi);
const UNISWAP_ROUTER_SELECTORS = computeSelectorsFromAbi(uniswapSwapRouterAbi);
const ERC20_SELECTORS = computeSelectorsFromAbi(erc20Abi);

async function classifyDestination(
  chain: SupportedChain,
  to: `0x${string}`
): Promise<RecognizedDestination | null> {
  const lo = to.toLowerCase();

  // Aave V3 Pool — pinned from a hardcoded address, NOT a live RPC read.
  const aavePool = pinnedAavePool(chain).toLowerCase();
  if (lo === aavePool) return { kind: "aave-v3-pool", allowedAbi: aavePoolAbi };

  // Compound V3 Comet markets.
  const compound = CONTRACTS[chain].compound as Record<string, string> | undefined;
  if (compound) {
    for (const addr of Object.values(compound)) {
      if (lo === addr.toLowerCase()) {
        return { kind: "compound-v3-comet", allowedAbi: cometAbi };
      }
    }
  }

  // Ethereum-only protocols.
  if (chain === "ethereum") {
    if (lo === CONTRACTS.ethereum.morpho.blue.toLowerCase()) {
      return { kind: "morpho-blue", allowedAbi: morphoBlueAbi };
    }
    if (lo === CONTRACTS.ethereum.lido.stETH.toLowerCase()) {
      return { kind: "lido-stETH", allowedAbi: stETHAbi };
    }
    if (lo === CONTRACTS.ethereum.lido.withdrawalQueue.toLowerCase()) {
      return { kind: "lido-withdrawalQueue", allowedAbi: lidoWithdrawalQueueAbi };
    }
    if (lo === CONTRACTS.ethereum.eigenlayer.strategyManager.toLowerCase()) {
      return { kind: "eigenlayer-strategyManager", allowedAbi: eigenStrategyManagerAbi };
    }
  }

  // Uniswap V3 NonfungiblePositionManager (not currently written to by our prepare_*
  // tools, but listed because it's in CONTRACTS and we may add LP mint/collect flows).
  if (lo === CONTRACTS[chain].uniswap.positionManager.toLowerCase()) {
    return { kind: "uniswap-v3-npm", allowedAbi: uniswapPositionManagerAbi };
  }

  // Uniswap V3 SwapRouter02 — our direct-swap builder targets this. Its
  // exactInputSingle / exactInput / multicall entrypoints are Ledger
  // clear-sign covered, so txs routed here get on-device decoded rather than
  // shown as raw calldata.
  if (lo === CONTRACTS[chain].uniswap.swapRouter02.toLowerCase()) {
    return { kind: "uniswap-v3-router", allowedAbi: uniswapSwapRouterAbi };
  }

  // LiFi Diamond — accept but skip per-selector check (LiFi's ABI is huge and dynamic).
  if (lo === LIFI_DIAMOND) return { kind: "lifi-diamond", allowedAbi: null };

  // Known ERC-20s (USDC, USDT, DAI, WETH, ...). Tokens ONLY — this path never
  // covers a protocol contract that exposes transfer-like selectors, because
  // the protocol branches above match first.
  const tokens = CONTRACTS[chain].tokens as Record<string, string> | undefined;
  if (tokens) {
    for (const addr of Object.values(tokens)) {
      if (lo === addr.toLowerCase()) return { kind: "known-erc20", allowedAbi: erc20Abi };
    }
  }

  return null;
}

/** Spenders allowed for approve(spender, _). */
function buildSpenderAllowlist(chain: SupportedChain): Set<string> {
  const out = new Set<string>();
  out.add(pinnedAavePool(chain).toLowerCase());
  const compound = CONTRACTS[chain].compound as Record<string, string> | undefined;
  if (compound) for (const a of Object.values(compound)) out.add(a.toLowerCase());
  if (chain === "ethereum") {
    out.add(CONTRACTS.ethereum.morpho.blue.toLowerCase());
    out.add(CONTRACTS.ethereum.lido.withdrawalQueue.toLowerCase());
    out.add(CONTRACTS.ethereum.eigenlayer.strategyManager.toLowerCase());
  }
  out.add(CONTRACTS[chain].uniswap.positionManager.toLowerCase());
  // SwapRouter02 is an approval target for ERC-20 direct-swap inputs. Without
  // this, the router's transferFrom during `exactInput(Single)` would fail.
  out.add(CONTRACTS[chain].uniswap.swapRouter02.toLowerCase());
  out.add(LIFI_DIAMOND);
  return out;
}

/**
 * Throws a descriptive error if `tx` looks unsafe to sign. Call synchronously
 * before every WalletConnect submission. "Unsafe" is conservative: unknown
 * destination + non-empty data, approves to non-allowlisted spenders, or
 * selectors that don't belong to the contract we think we're calling.
 */
export async function assertTransactionSafe(tx: UnsignedTx): Promise<void> {
  // 1) Pure native send — data must be empty. Allow the transfer; the user
  //    picks the recipient, and the Ledger screen shows it.
  if (tx.data === "0x" || tx.data === "0x0" || tx.data === "0x00") {
    return;
  }

  if (tx.data.length < 10) {
    throw new Error(
      `Pre-sign check: calldata (${tx.data}) is too short to carry a function selector. ` +
        `Refusing to sign.`
    );
  }

  const selector = tx.data.slice(0, 10).toLowerCase() as `0x${string}`;
  const dest = await classifyDestination(tx.chain, tx.to);

  // 2) approve(): the single highest-leverage attack vector. Spender MUST be on
  //    the protocol allowlist. Destination is whichever ERC-20 we're approving.
  if (selector === SELECTOR.approve) {
    if (!dest) {
      throw new Error(
        `Pre-sign check: refusing approve() on ${tx.to} (${tx.chain}) — token is not in our ` +
          `recognized set. If this is a legitimate token, add it to CONTRACTS[${tx.chain}].tokens.`
      );
    }
    // `to` must be a token (ERC-20 or a protocol token surface like stETH),
    // not, say, the Aave Pool. approve() on the pool itself is nonsensical.
    if (
      dest.kind !== "known-erc20" &&
      dest.kind !== "lido-stETH" // stETH IS an ERC-20; approvals to spenders happen on it
    ) {
      throw new Error(
        `Pre-sign check: refusing approve() on ${dest.kind} (${tx.to}) — approvals should ` +
          `target ERC-20 tokens, not protocol contracts.`
      );
    }
    let spender: string;
    try {
      const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
      spender = (decoded.args?.[0] as string).toLowerCase();
    } catch {
      throw new Error(
        `Pre-sign check: could not decode approve() calldata on ${tx.to}. Refusing to sign.`
      );
    }
    const allowlist = buildSpenderAllowlist(tx.chain);
    if (!allowlist.has(spender)) {
      throw new Error(
        `Pre-sign check: refusing approve(spender=${spender}, ...) on ${tx.chain} — spender is ` +
          `not in the protocol allowlist (Aave Pool, Compound Comet, Morpho Blue, Lido Queue, ` +
          `EigenLayer, Uniswap NPM, LiFi Diamond). This is the canonical phishing/prompt-injection ` +
          `pattern. If you need to approve a different spender, do it from the Ledger Live app directly.`
      );
    }
    return;
  }

  // 3) transfer(): user-directed token move. Destination must still be a token
  //    we recognize (otherwise the agent is calling transfer() on an arbitrary
  //    contract with matching 4-byte — unlikely but worth rejecting).
  if (selector === SELECTOR.transfer) {
    if (!dest || (dest.kind !== "known-erc20" && dest.kind !== "lido-stETH")) {
      throw new Error(
        `Pre-sign check: refusing transfer() on ${tx.to} (${tx.chain}) — token is not in our ` +
          `recognized set. Add it to CONTRACTS[${tx.chain}].tokens if this is a legitimate asset.`
      );
    }
    return;
  }

  // 4) Every other selector: must be a known protocol destination.
  if (!dest) {
    throw new Error(
      `Pre-sign check: refusing to sign against unknown contract ${tx.to} on ${tx.chain} ` +
        `(selector ${selector}). Accepted destinations: Aave V3 Pool, Compound V3 Comet markets, ` +
        `Morpho Blue, Lido (stETH/Queue), EigenLayer StrategyManager, Uniswap V3 NPM, LiFi Diamond, ` +
        `and known ERC-20s. An unknown destination with non-empty calldata is exactly the shape of ` +
        `a prompt-injection attack.`
    );
  }

  // 5) For destinations where we have a tight ABI, verify the selector is one
  //    of its functions. LiFi Diamond is the explicit exception (allowedAbi=null).
  if (dest.allowedAbi === null) return;

  // Pick the right precomputed selector set.
  const allowedSelectors = (() => {
    switch (dest.kind) {
      case "aave-v3-pool":
        return AAVE_SELECTORS;
      case "compound-v3-comet":
        return COMET_SELECTORS;
      case "morpho-blue":
        return MORPHO_SELECTORS;
      case "lido-stETH":
        // stETH is both the Lido submit surface AND an ERC-20 (transfer/approve).
        return new Set<string>([...LIDO_STETH_SELECTORS, ...ERC20_SELECTORS]);
      case "lido-withdrawalQueue":
        return LIDO_QUEUE_SELECTORS;
      case "eigenlayer-strategyManager":
        return EIGEN_SELECTORS;
      case "uniswap-v3-npm":
        return UNISWAP_NPM_SELECTORS;
      case "uniswap-v3-router":
        return UNISWAP_ROUTER_SELECTORS;
      case "known-erc20":
        return ERC20_SELECTORS;
      case "lifi-diamond":
        return null; // handled above
    }
  })();

  if (allowedSelectors && !allowedSelectors.has(selector)) {
    throw new Error(
      `Pre-sign check: selector ${selector} is not a known function on ${dest.kind} (${tx.to}). ` +
        `Refusing to sign.`
    );
  }
}

// ---------------------------------------------------------------------------
// Clear-signing classifier
// ---------------------------------------------------------------------------
//
// The `assertTransactionSafe` pipeline above decides whether a prepared tx is
// SAFE enough to hand to the signer. The classifier below is a second, finer
// decision on top of that: will the Ledger hardware itself decode this call
// to plain language on its own screen (clear-sign), or will it only show raw
// calldata hex (blind-sign)?
//
// Same input (tx), complementary question. Clear-sign coverage depends on
// which Ledger app is loaded and which plugins Ledger has shipped for the
// destination contract — it is NOT the same set as "looks ABI-valid."
// LEDGER_CLEAR_SIGN_SELECTORS is a strict subset of each destination's
// ABI-derived selector set, hand-curated against what Ledger plugins cover
// today. Extend it as Ledger adds coverage; keep it conservative otherwise.

type DestinationKindOrNull = DestinationKind | null;

function sel(sig: string): string {
  return toFunctionSelector(sig).toLowerCase();
}

/**
 * Per-destination selector subsets the Ledger hardware is known to decode on
 * its own screen (via the Ethereum app + the relevant protocol plugin).
 *
 * Source of truth: Ledger's published plugin roster. Anything that's NOT in
 * these sets falls through to blind-sign (with a swiss-knife decoder URL as
 * a compensating verification path).
 */
const LEDGER_CLEAR_SIGN_SELECTORS: Record<DestinationKind, Set<string>> = {
  "aave-v3-pool": new Set([
    sel("supply(address,uint256,address,uint16)"),
    sel("withdraw(address,uint256,address)"),
    sel("borrow(address,uint256,uint256,uint16,address)"),
    sel("repay(address,uint256,uint256,address)"),
    sel("repayWithATokens(address,uint256,uint256)"),
    sel("setUserUseReserveAsCollateral(address,bool)"),
  ]),
  "compound-v3-comet": new Set([
    sel("supply(address,uint256)"),
    sel("withdraw(address,uint256)"),
    sel("supplyTo(address,address,uint256)"),
    sel("withdrawTo(address,address,uint256)"),
  ]),
  "morpho-blue": new Set([
    // Morpho Blue's signatures take a MarketParams tuple as the first arg.
    sel(
      "supply((address,address,address,address,uint256),uint256,uint256,address,bytes)"
    ),
    sel(
      "withdraw((address,address,address,address,uint256),uint256,uint256,address,address)"
    ),
    sel(
      "borrow((address,address,address,address,uint256),uint256,uint256,address,address)"
    ),
    sel(
      "repay((address,address,address,address,uint256),uint256,uint256,address,bytes)"
    ),
    sel(
      "supplyCollateral((address,address,address,address,uint256),uint256,address,bytes)"
    ),
    sel(
      "withdrawCollateral((address,address,address,address,uint256),uint256,address,address)"
    ),
  ]),
  "lido-stETH": new Set([sel("submit(address)")]),
  "lido-withdrawalQueue": new Set([
    sel("requestWithdrawals(uint256[],address)"),
    sel("claimWithdrawal(uint256)"),
  ]),
  "eigenlayer-strategyManager": new Set([
    sel("depositIntoStrategy(address,address,uint256)"),
  ]),
  // No LP mint/collect flows yet — when we add them, seed selectors here.
  "uniswap-v3-npm": new Set<string>(),
  "uniswap-v3-router": new Set([
    sel(
      "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))"
    ),
    sel("exactInput((bytes,address,uint256,uint256))"),
    sel("multicall(bytes[])"),
  ]),
  // Generic ERC-20 plugin clear-signs transfer/approve on every token;
  // amounts and recipients land on-device in plain form.
  "known-erc20": new Set([
    sel("transfer(address,uint256)"),
    sel("approve(address,uint256)"),
  ]),
  // LiFi Diamond is never clear-sign — the selector space is too large and
  // Ledger has no LiFi plugin. Left empty on purpose so every call falls
  // through to blind-sign (or blind-sign-unavoidable for cross-chain).
  "lifi-diamond": new Set<string>(),
};

/**
 * Pure-function variant of `classifyDestination` that doesn't need to care
 * about whether the destination exists in CONTRACTS. Walks the same checks
 * synchronously. Returns null if nothing matches.
 */
function classifyDestinationSync(
  chain: SupportedChain,
  to: `0x${string}`
): { kind: DestinationKind } | null {
  const lo = to.toLowerCase();

  if (lo === pinnedAavePool(chain).toLowerCase()) return { kind: "aave-v3-pool" };

  const compound = CONTRACTS[chain].compound as Record<string, string> | undefined;
  if (compound) {
    for (const addr of Object.values(compound)) {
      if (lo === addr.toLowerCase()) return { kind: "compound-v3-comet" };
    }
  }

  if (chain === "ethereum") {
    if (lo === CONTRACTS.ethereum.morpho.blue.toLowerCase()) return { kind: "morpho-blue" };
    if (lo === CONTRACTS.ethereum.lido.stETH.toLowerCase()) return { kind: "lido-stETH" };
    if (lo === CONTRACTS.ethereum.lido.withdrawalQueue.toLowerCase())
      return { kind: "lido-withdrawalQueue" };
    if (lo === CONTRACTS.ethereum.eigenlayer.strategyManager.toLowerCase())
      return { kind: "eigenlayer-strategyManager" };
  }

  if (lo === CONTRACTS[chain].uniswap.positionManager.toLowerCase())
    return { kind: "uniswap-v3-npm" };
  if (lo === CONTRACTS[chain].uniswap.swapRouter02.toLowerCase())
    return { kind: "uniswap-v3-router" };

  if (lo === LIFI_DIAMOND) return { kind: "lifi-diamond" };

  const tokens = CONTRACTS[chain].tokens as Record<string, string> | undefined;
  if (tokens) {
    for (const addr of Object.values(tokens)) {
      if (lo === addr.toLowerCase()) return { kind: "known-erc20" };
    }
  }

  return null;
}

function abiSelectorsForKind(kind: DestinationKindOrNull): Set<string> | null {
  switch (kind) {
    case "aave-v3-pool":
      return AAVE_SELECTORS;
    case "compound-v3-comet":
      return COMET_SELECTORS;
    case "morpho-blue":
      return MORPHO_SELECTORS;
    case "lido-stETH":
      return new Set<string>([...LIDO_STETH_SELECTORS, ...ERC20_SELECTORS]);
    case "lido-withdrawalQueue":
      return LIDO_QUEUE_SELECTORS;
    case "eigenlayer-strategyManager":
      return EIGEN_SELECTORS;
    case "uniswap-v3-npm":
      return UNISWAP_NPM_SELECTORS;
    case "uniswap-v3-router":
      return UNISWAP_ROUTER_SELECTORS;
    case "known-erc20":
      return ERC20_SELECTORS;
    case "lifi-diamond":
      // LiFi's ABI is wide and dynamic. swiss-knife decodes most of it via
      // its published Diamond facets, so we don't gate on a selector set.
      return null;
    case null:
      return null;
  }
}

function prettyKind(kind: DestinationKind): string {
  switch (kind) {
    case "aave-v3-pool":
      return "Aave V3 Pool";
    case "compound-v3-comet":
      return "Compound V3 Comet";
    case "morpho-blue":
      return "Morpho Blue";
    case "lido-stETH":
      return "Lido stETH";
    case "lido-withdrawalQueue":
      return "Lido Withdrawal Queue";
    case "eigenlayer-strategyManager":
      return "EigenLayer StrategyManager";
    case "uniswap-v3-npm":
      return "Uniswap V3 Position Manager";
    case "uniswap-v3-router":
      return "Uniswap V3 SwapRouter02";
    case "known-erc20":
      return "ERC-20 token";
    case "lifi-diamond":
      return "LiFi Diamond";
  }
}

/**
 * Domain-tagged keccak256 over (chainId, to, value, data). Acts as a
 * user-visible commitment to the exact bytes the Ledger will sign. Including
 * chainId prevents the same calldata on two chains producing the same
 * fingerprint — which would otherwise let a replay on a different chain slip
 * past a visual cross-check.
 *
 * Domain-tagged so the hash can never collide with some other keccak256 the
 * user might see elsewhere (EIP-712 digest, tx hash, etc.).
 */
export function payloadFingerprint(
  tx: Pick<UnsignedTx, "chain" | "to" | "value" | "data">
): `0x${string}` {
  const chainId = CHAIN_IDS[tx.chain];
  return keccak256(
    concat([
      toBytes("VaultPilot-clearsign-v1:"),
      numberToBytes(chainId, { size: 32 }),
      hexToBytes(tx.to),
      numberToBytes(BigInt(tx.value), { size: 32 }),
      hexToBytes(tx.data),
    ])
  );
}

/** TRON variant — domain-separated from the EVM tag, hashes the raw_data_hex the device signs. */
export function tronPayloadFingerprint(rawDataHex: string): `0x${string}` {
  const hex = rawDataHex.startsWith("0x") ? (rawDataHex as `0x${string}`) : (`0x${rawDataHex}` as `0x${string}`);
  return keccak256(
    concat([toBytes("VaultPilot-clearsign-v1:tron:"), hexToBytes(hex)])
  );
}

/**
 * Chrome's practical URL limit is ~8 KB (2 KB on some older stacks). Stay
 * well under that so the decoder URL reliably opens. Calldata is 2 hex chars
 * per byte, so 8000 chars ≈ 4 KB of raw data.
 */
const SWISS_KNIFE_URL_CHAR_BUDGET = 8000;

function swissKnifeDecoderUrl(
  chainId: number,
  to: `0x${string}`,
  data: `0x${string}`
): { decoderUrl?: string; decoderPasteInstructions?: string } {
  if (data === "0x" || data.length < 10) {
    // No calldata to decode — shouldn't be called on a native send, but handle it.
    return {};
  }
  const base = "https://calldata.swiss-knife.xyz/decoder";
  const qs = `?calldata=${data}&address=${to}&chainId=${chainId}`;
  if (qs.length + base.length > SWISS_KNIFE_URL_CHAR_BUDGET) {
    return {
      decoderPasteInstructions:
        `Calldata is too large to preload via URL. Open ${base} and paste the ` +
        `following calldata into the decoder input: ${data}`,
    };
  }
  return { decoderUrl: `${base}${qs}` };
}

/**
 * Classify a prepared EVM transaction into one of the three `TrustMode`
 * tiers. Pure — does not consult RPC, does not throw, does not mutate.
 *
 * Logic:
 *   1. Native send (`data === "0x"`): always clear-sign, every Ledger app
 *      decodes a value transfer natively.
 *   2. Recognized destination + selector in `LEDGER_CLEAR_SIGN_SELECTORS`:
 *      clear-sign. Reason identifies the plugin.
 *   3. Recognized destination + selector NOT in the clear-sign subset but IN
 *      the ABI-derived set: blind-sign with a swiss-knife decoder URL.
 *   4. LiFi Diamond: always blind-sign, with a decoder URL (swiss-knife has
 *      the Diamond facets). If the ABI-derived destination was null (LiFi's
 *      allowedAbi=null) we fall through via the same blind-sign branch.
 *   5. Unrecognized destination: blind-sign-unavoidable — we can't promise
 *      swiss-knife will decode it, and the user should strongly consider
 *      rejecting.
 */
export function classifyEvmTrust(tx: UnsignedTx): { mode: TrustMode; details: TrustDetails } {
  const payloadHash = payloadFingerprint(tx);
  const payloadHashShort = toHex(hexToBytes(payloadHash).subarray(0, 4));
  const chainId = CHAIN_IDS[tx.chain];

  // 1) Pure native value transfer — no calldata, every Ledger app handles this.
  if (tx.data === "0x" || tx.data === "0x0" || tx.data === "0x00") {
    return {
      mode: "clear-signable",
      details: {
        reason: `Native ${tx.chain} value transfer`,
        ledgerPlugin: "Ethereum",
        payloadHash,
        payloadHashShort,
      },
    };
  }

  const selector = tx.data.slice(0, 10).toLowerCase();
  const dest = classifyDestinationSync(tx.chain, tx.to);

  // 2) Unrecognized destination. We cannot assume swiss-knife will decode
  //    anything — the contract may not even be verified on Etherscan.
  if (!dest) {
    const decoder = swissKnifeDecoderUrl(chainId, tx.to, tx.data);
    return {
      mode: "blind-sign-unavoidable",
      details: {
        reason:
          `Unrecognized destination contract ${tx.to} on ${tx.chain}. Ledger cannot decode ` +
          `this, and swiss-knife may not decode it either if the contract is unverified. ` +
          `Strongly consider rejecting.`,
        ...decoder,
        payloadHash,
        payloadHashShort,
      },
    };
  }

  const clearSignSet = LEDGER_CLEAR_SIGN_SELECTORS[dest.kind];
  if (clearSignSet.has(selector)) {
    return {
      mode: "clear-signable",
      details: {
        reason: `${prettyKind(dest.kind)} — Ledger plugin will decode this on-device`,
        ledgerPlugin: prettyKind(dest.kind),
        payloadHash,
        payloadHashShort,
      },
    };
  }

  // 3) Recognized but not clear-sign. Fall back to blind-sign with decoder URL.
  //    Cross-chain LiFi is always blind-sign-unavoidable regardless of selector
  //    decodability, because the user has no way to verify the other-chain
  //    leg will execute as claimed.
  if (dest.kind === "lifi-diamond") {
    const isCrossChain = BigInt(tx.value) > 0n || /* default */ true;
    // Cross-chain detection is imprecise from tx shape alone — LiFi same-chain
    // swaps also hit the Diamond. Conservative default: treat LiFi as
    // blind-sign (decodable) UNLESS the routing layer explicitly marked it
    // cross-chain by stamping trustDetails upstream. Here, without that
    // signal, we report blind-sign with decoder URL and let the swap router
    // override to blind-sign-unavoidable when it knows.
    void isCrossChain;
    const decoder = swissKnifeDecoderUrl(chainId, tx.to, tx.data);
    return {
      mode: "blind-sign",
      details: {
        reason:
          `LiFi aggregator (Diamond) — Ledger shows raw calldata; swiss-knife decodes the ` +
          `Diamond facet call. Verify the function + args before approving.`,
        ...decoder,
        payloadHash,
        payloadHashShort,
      },
    };
  }

  // Recognized protocol but not a Ledger-decoded selector — verifiable
  // through swiss-knife because we have the ABI.
  const abiSet = abiSelectorsForKind(dest.kind);
  const selectorOnAbi = abiSet === null || abiSet.has(selector);
  const decoder = swissKnifeDecoderUrl(chainId, tx.to, tx.data);

  if (!selectorOnAbi) {
    // Shouldn't happen — assertTransactionSafe rejects this shape before we
    // get here — but if it somehow did, classify defensively.
    return {
      mode: "blind-sign-unavoidable",
      details: {
        reason:
          `Selector ${selector} is not on the recognized ABI for ${prettyKind(dest.kind)}. ` +
          `Recommend rejecting.`,
        ...decoder,
        payloadHash,
        payloadHashShort,
      },
    };
  }

  return {
    mode: "blind-sign",
    details: {
      reason:
        `${prettyKind(dest.kind)} — selector not in Ledger's clear-sign set for this contract. ` +
        `Verify the decoded call at the linked swiss-knife URL before approving.`,
      ...decoder,
      payloadHash,
      payloadHashShort,
    },
  };
}
