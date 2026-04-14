import { parseUnits, formatUnits, encodeFunctionData } from "viem";
import { fetchQuote, fetchStatus } from "./lifi.js";
import { fetchOneInchQuote } from "./oneinch.js";
import { buildUniswapV3DirectSwap } from "./uniswap-v3-direct.js";
import type { GetSwapQuoteArgs, PrepareSwapArgs } from "./schemas.js";
import { getClient } from "../../data/rpc.js";
import { erc20Abi } from "../../abis/erc20.js";
import { readUserConfig, resolveOneInchApiKey } from "../../config/user-config.js";
import { CONTRACTS } from "../../config/contracts.js";
import type { SupportedChain, TrustDetails, TrustMode, UnsignedTx } from "../../types/index.js";
import { CHAIN_IDS } from "../../types/index.js";
import { payloadFingerprint } from "../../signing/pre-sign-check.js";
import { toHex, hexToBytes } from "viem";

/**
 * Sum LiFi fee/gas cost entries into a USD number.
 *
 * LiFi's `amountUSD` is unreliable on some bridge routes (notably Polygon PoS): the
 * field has been observed containing raw token units rather than a USD decimal, which
 * inflates the reported fee by ~6 orders of magnitude for stablecoins (a real 0.25 USDC
 * fee shows as ~$250,000). To sidestep this, always prefer deriving USD from the raw
 * `amount` + `token.priceUSD` + `token.decimals`. Fall back to `amountUSD` only when
 * the token price is missing, and sanity-clamp if both are available but disagree by
 * more than 10×.
 */
interface LifiCostLike {
  amount?: string;
  amountUSD?: string;
  token?: { decimals?: number; priceUSD?: string };
}

function sumLifiCostsUsd(items: readonly LifiCostLike[] | undefined): number | undefined {
  if (!items || items.length === 0) return undefined;
  let total = 0;
  for (const item of items) {
    const stated = item.amountUSD !== undefined ? Number(item.amountUSD) : NaN;
    const rawAmt = item.amount !== undefined ? Number(item.amount) : NaN;
    const priceUsd =
      item.token?.priceUSD !== undefined ? Number(item.token.priceUSD) : NaN;
    const decimals = item.token?.decimals ?? 18;

    const derived =
      Number.isFinite(rawAmt) && Number.isFinite(priceUsd)
        ? (rawAmt / 10 ** decimals) * priceUsd
        : NaN;

    if (Number.isFinite(derived)) {
      // Both available: trust derived if they disagree wildly (stated is the known-bad
      // source). 10× threshold catches the "raw-units-as-USD" class of bug.
      if (Number.isFinite(stated) && derived > 0 && stated / derived > 10) {
        total += derived;
      } else if (Number.isFinite(stated) && stated >= 0) {
        total += stated;
      } else {
        total += derived;
      }
    } else if (Number.isFinite(stated) && stated >= 0) {
      total += stated;
    }
  }
  return total;
}

/** Resolve ERC-20 decimals (native = 18). */
async function resolveDecimals(
  chain: SupportedChain,
  token: `0x${string}` | "native",
  fallback?: number
): Promise<number> {
  if (token === "native") return 18;
  if (fallback !== undefined) return fallback;
  try {
    const client = getClient(chain);
    const d = (await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "decimals",
    })) as number;
    return Number(d);
  } catch {
    return 18;
  }
}

/**
 * On-chain decimals read with no fallback path. Returns undefined for native (no
 * contract to read) and undefined on RPC failure so callers can distinguish "known
 * to match" from "couldn't verify". Used by prepareSwap to cross-check LiFi's
 * reported token metadata before returning signable calldata.
 */
async function readOnchainDecimals(
  chain: SupportedChain,
  token: `0x${string}` | "native"
): Promise<number | undefined> {
  if (token === "native") return undefined;
  try {
    const client = getClient(chain);
    const d = (await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "decimals",
    })) as number;
    return Number(d);
  } catch {
    return undefined;
  }
}

/**
 * Reject slippage configurations that are almost certainly user/agent error.
 * The schema already caps at 500 bps (5%); this adds a soft-cap at 100 bps
 * (1%) that requires an explicit ack. MEV sandwich bots target open-slippage
 * txs, so every unnecessary basis point is paid straight to a searcher.
 */
export function assertSlippageOk(slippageBps: number | undefined, ack: boolean | undefined): void {
  if (slippageBps === undefined) return;
  if (slippageBps > 100 && !ack) {
    throw new Error(
      `Requested slippage is ${slippageBps} bps (${(slippageBps / 100).toFixed(2)}%). ` +
        `The default cap is 100 bps (1%) because anything higher is almost always a ` +
        `sandwich-bait misconfiguration. If a thin-liquidity route genuinely needs this, ` +
        `retry with \`acknowledgeHighSlippage: true\` and confirm with the user first.`
    );
  }
}

export async function getSwapQuote(args: GetSwapQuoteArgs) {
  assertSlippageOk(args.slippageBps, args.acknowledgeHighSlippage);
  const chain = args.fromChain as SupportedChain;
  const toChain = args.toChain as SupportedChain;
  const fromDecimals = await resolveDecimals(chain, args.fromToken as `0x${string}` | "native", args.fromTokenDecimals);
  const fromAmountWei = parseUnits(args.amount, fromDecimals).toString();

  // Intra-chain only: 1inch has no cross-chain aggregator. Skip silently when no
  // API key is configured so users without a 1inch portal account still get LiFi.
  const intraChain = args.fromChain === args.toChain;
  const oneInchApiKey = intraChain ? resolveOneInchApiKey(readUserConfig()) : undefined;

  const [quote, oneInchRaw] = await Promise.all([
    fetchQuote({
      fromChain: chain,
      toChain,
      fromToken: args.fromToken as `0x${string}` | "native",
      toToken: args.toToken as `0x${string}` | "native",
      fromAmount: fromAmountWei,
      fromAddress: args.wallet as `0x${string}`,
      slippage: args.slippageBps !== undefined ? args.slippageBps / 10_000 : undefined,
    }),
    oneInchApiKey
      ? fetchOneInchQuote({
          chain,
          fromToken: args.fromToken as `0x${string}` | "native",
          toToken: args.toToken as `0x${string}` | "native",
          fromAmount: fromAmountWei,
          apiKey: oneInchApiKey,
        }).catch((err: unknown) => ({ __error: (err as Error).message }) as const)
      : Promise.resolve(undefined),
  ]);

  const fromTokenDecimals = quote.action.fromToken.decimals;
  const toTokenDecimals = quote.action.toToken.decimals;
  const fromPriceUsd = Number(quote.action.fromToken.priceUSD ?? NaN);
  const toPriceUsd = Number(quote.action.toToken.priceUSD ?? NaN);

  const fromAmountFormatted = formatUnits(BigInt(quote.action.fromAmount), fromTokenDecimals);
  const rawToAmount = formatUnits(BigInt(quote.estimate.toAmount), toTokenDecimals);
  const rawToAmountMin = formatUnits(BigInt(quote.estimate.toAmountMin), toTokenDecimals);

  const fromAmountUsd = Number.isFinite(fromPriceUsd)
    ? Number(fromAmountFormatted) * fromPriceUsd
    : undefined;
  const statedToAmountUsd = Number.isFinite(toPriceUsd)
    ? Number(rawToAmount) * toPriceUsd
    : undefined;

  // Sanity-check the output amount. LiFi has been observed returning toAmount scaled
  // wrong for some aggregator integrations (100 USDC → supposedly 1288 WBTC). When
  // priced out, the implied output USD vastly exceeds the input USD — no rational
  // route pays >10× the input. When that happens, we re-derive the displayed amount
  // from prices and attach a warning so the caller doesn't sign a malformed tx.
  let toAmountExpected = rawToAmount;
  let toAmountMin = rawToAmountMin;
  let toAmountUsd = statedToAmountUsd;
  let warning: string | undefined;

  if (
    fromAmountUsd !== undefined &&
    statedToAmountUsd !== undefined &&
    fromAmountUsd > 0 &&
    statedToAmountUsd / fromAmountUsd > 10
  ) {
    // Derive what the output *should* be from prices.
    const impliedToAmount = fromAmountUsd / toPriceUsd;
    // Preserve the route's stated slippage ratio when re-deriving the min.
    const rawRatio =
      Number(rawToAmount) > 0 ? Number(rawToAmountMin) / Number(rawToAmount) : 1;
    toAmountExpected = impliedToAmount.toString();
    toAmountMin = (impliedToAmount * rawRatio).toString();
    toAmountUsd = fromAmountUsd;
    warning =
      `LiFi returned toAmount=${rawToAmount} ${quote.action.toToken.symbol} (~$${statedToAmountUsd.toFixed(2)}) ` +
      `which is >10× the input value ($${fromAmountUsd.toFixed(2)}). Displayed output re-derived from ` +
      `token prices. Do NOT sign a prepared tx using this quote — fetch a fresh one.`;
  }

  // Intra-chain comparison against 1inch. Quote in the same token, so a direct
  // numeric comparison of output amounts is meaningful. USD is derived from the
  // LiFi-provided toToken price (1inch doesn't return priceUSD) so both sides
  // use the same reference price and only the route differs.
  let alternatives: Array<
    | { source: "1inch"; toAmountExpected: string; toAmountUsd?: number; gasEstimate?: number }
    | { source: "1inch"; error: string }
  > | undefined;
  let bestSource: "lifi" | "1inch" | "tie" | undefined;
  let savingsVsLifi: { source: "1inch"; outputDeltaPct: number; outputDeltaUsd?: number } | undefined;

  if (intraChain && oneInchRaw) {
    if ("__error" in oneInchRaw) {
      alternatives = [{ source: "1inch", error: oneInchRaw.__error }];
    } else {
      const oiDecimals = oneInchRaw.dstToken?.decimals ?? toTokenDecimals;
      const oiFormatted = formatUnits(BigInt(oneInchRaw.dstAmount), oiDecimals);
      const oiOut = Number(oiFormatted);
      const oiUsd = Number.isFinite(toPriceUsd) ? oiOut * toPriceUsd : undefined;
      alternatives = [
        {
          source: "1inch",
          toAmountExpected: oiFormatted,
          toAmountUsd: oiUsd,
          gasEstimate: oneInchRaw.gas,
        },
      ];

      // Compare against the *raw* LiFi toAmount (not the re-derived one). If LiFi's
      // quote was flagged by the >10× sanity check, the raw number is the one the
      // aggregator actually advertised — that's what we're comparing route quality on.
      const lifiOut = Number(rawToAmount);
      if (lifiOut > 0 && oiOut > 0) {
        const delta = (oiOut - lifiOut) / lifiOut;
        if (Math.abs(delta) < 0.0005) bestSource = "tie";
        else bestSource = delta > 0 ? "1inch" : "lifi";
        savingsVsLifi = {
          source: "1inch",
          outputDeltaPct: delta * 100,
          outputDeltaUsd: Number.isFinite(toPriceUsd) ? (oiOut - lifiOut) * toPriceUsd : undefined,
        };
      }
    }
  }

  return {
    fromChain: args.fromChain,
    toChain: args.toChain,
    fromToken: quote.action.fromToken,
    toToken: quote.action.toToken,
    fromAmount: fromAmountFormatted,
    toAmountMin,
    toAmountExpected,
    fromAmountUsd,
    toAmountUsd,
    tool: quote.tool,
    executionDurationSeconds: quote.estimate.executionDuration,
    feeCostsUsd: sumLifiCostsUsd(quote.estimate.feeCosts),
    gasCostsUsd: sumLifiCostsUsd(quote.estimate.gasCosts),
    crossChain: args.fromChain !== args.toChain,
    ...(alternatives ? { alternatives } : {}),
    ...(bestSource ? { bestSource } : {}),
    ...(savingsVsLifi ? { savingsVsLifi } : {}),
    ...(warning ? { warning } : {}),
  };
}

/**
 * Maximum direct-V3 vs LiFi output-shortfall we tolerate before falling back
 * to LiFi, in basis points. L1 gets a looser bound because its deeper pools
 * and higher gas mean a 1% quote gap can easily be made up in execution, and
 * the clear-signing win is worth that tradeoff. L2s tighten to 50 bps because
 * (a) gas is cheap enough to refresh a quote, (b) LiFi's L2 aggregator paths
 * often beat direct by bundling over multiple DEXes.
 */
const DIRECT_V3_SHORTFALL_BPS: Record<SupportedChain, number> = {
  ethereum: 100, // 1.0%
  arbitrum: 50, // 0.5%
  polygon: 50,
  base: 50,
};

/**
 * Stamp a UnsignedTx and every .next node with explicit trust metadata. Used
 * when prepareSwap knows the trust mode a priori (e.g. LiFi cross-chain
 * bridges are always blind-sign-unavoidable regardless of what the
 * classifier would say from calldata alone). `issueHandles` respects
 * pre-stamped trust metadata.
 */
function stampTrust(tx: UnsignedTx, mode: TrustMode, reason: string): UnsignedTx {
  const payloadHash = payloadFingerprint(tx);
  const payloadHashShort = toHex(hexToBytes(payloadHash).subarray(0, 4));
  const details: TrustDetails = {
    reason,
    payloadHash,
    payloadHashShort,
  };
  return {
    ...tx,
    trustMode: mode,
    trustDetails: details,
    ...(tx.next ? { next: stampTrust(tx.next, mode, reason) } : {}),
  };
}

export async function prepareSwap(args: PrepareSwapArgs): Promise<UnsignedTx> {
  assertSlippageOk(args.slippageBps, args.acknowledgeHighSlippage);
  const chain = args.fromChain as SupportedChain;
  const toChain = args.toChain as SupportedChain;
  const fromDecimals = await resolveDecimals(chain, args.fromToken as `0x${string}` | "native", args.fromTokenDecimals);
  const fromAmountWei = parseUnits(args.amount, fromDecimals).toString();
  const fromToken = args.fromToken as `0x${string}` | "native";
  const toToken = args.toToken as `0x${string}` | "native";
  const isCrossChain = chain !== toChain;
  const slippageBps = args.slippageBps ?? 50;

  // Same-chain only: attempt the direct Uniswap V3 path in parallel with
  // the LiFi fetch. Direct is clear-signable on Ledger; LiFi is blind-sign.
  // The parallel fetch means we don't pay a round-trip to pick the winner.
  const directPromise = !isCrossChain
    ? buildUniswapV3DirectSwap({
        chain,
        from: args.wallet as `0x${string}`,
        fromToken,
        toToken,
        amountIn: BigInt(fromAmountWei),
        slippageBps,
      }).catch(() => null)
    : Promise.resolve(null);

  const [direct, quote] = await Promise.all([
    directPromise,
    fetchQuote({
      fromChain: chain,
      toChain,
      fromToken,
      toToken,
      fromAmount: fromAmountWei,
      fromAddress: args.wallet as `0x${string}`,
      slippage: args.slippageBps !== undefined ? args.slippageBps / 10_000 : undefined,
    }),
  ]);

  const txRequest = quote.transactionRequest;
  if (!txRequest || !txRequest.to || !txRequest.data) {
    throw new Error("LiFi did not return a transactionRequest for this quote.");
  }

  // Cross-check LiFi's reported token decimals against on-chain reads. A mismatch
  // would mean either LiFi has stale metadata or the route targets a token different
  // from what we asked for — in either case, the formatted expectedOut/minOut shown
  // to the user would be wrong, so refuse. Native assets are skipped (no contract).
  const [fromDecimalsOnchain, toDecimalsOnchain] = await Promise.all([
    readOnchainDecimals(chain, fromToken),
    readOnchainDecimals(args.toChain as SupportedChain, toToken),
  ]);
  if (
    fromDecimalsOnchain !== undefined &&
    fromDecimalsOnchain !== quote.action.fromToken.decimals
  ) {
    throw new Error(
      `Decimals mismatch for fromToken ${quote.action.fromToken.symbol} (${quote.action.fromToken.address}): ` +
        `LiFi reports ${quote.action.fromToken.decimals}, on-chain says ${fromDecimalsOnchain}. ` +
        `Refusing to return calldata.`
    );
  }
  if (
    toDecimalsOnchain !== undefined &&
    toDecimalsOnchain !== quote.action.toToken.decimals
  ) {
    throw new Error(
      `Decimals mismatch for toToken ${quote.action.toToken.symbol} (${quote.action.toToken.address}): ` +
        `LiFi reports ${quote.action.toToken.decimals}, on-chain says ${toDecimalsOnchain}. ` +
        `Refusing to return calldata.`
    );
  }

  // Sanity-check the quote before returning signable calldata. LiFi has been observed
  // returning toAmount scaled wrong on certain aggregator integrations (e.g. 10 USDC →
  // ~4500 ETH). The calldata embeds the bogus minOut and won't execute, but we refuse
  // up front so the user doesn't waste a signature on a broken quote. Mirrors the
  // warning path in getSwapQuote.
  const fromPriceUsd = Number(quote.action.fromToken.priceUSD ?? NaN);
  const toPriceUsd = Number(quote.action.toToken.priceUSD ?? NaN);
  const fromAmountFormatted = Number(
    formatUnits(BigInt(quote.action.fromAmount), quote.action.fromToken.decimals)
  );
  const toAmountFormatted = Number(
    formatUnits(BigInt(quote.estimate.toAmount), quote.action.toToken.decimals)
  );
  if (
    Number.isFinite(fromPriceUsd) &&
    Number.isFinite(toPriceUsd) &&
    fromPriceUsd > 0 &&
    toPriceUsd > 0
  ) {
    const fromUsd = fromAmountFormatted * fromPriceUsd;
    const toUsd = toAmountFormatted * toPriceUsd;
    if (fromUsd > 0 && toUsd / fromUsd > 10) {
      throw new Error(
        `LiFi returned a malformed quote: toAmount=${toAmountFormatted} ${quote.action.toToken.symbol} ` +
          `(~$${toUsd.toFixed(2)}) for input ~$${fromUsd.toFixed(2)} (route: ${quote.tool}). ` +
          `Output is >10× the input value, so the calldata is not safe to sign. ` +
          `Re-run get_swap_quote to fetch a fresh route.`
      );
    }
  }

  const fromSym = quote.action.fromToken.symbol;
  const toSym = quote.action.toToken.symbol;
  const crossChain = args.fromChain !== args.toChain;
  const description = crossChain
    ? `Bridge ${args.amount} ${fromSym} from ${args.fromChain} to ${toSym} on ${args.toChain} via ${quote.tool}`
    : `Swap ${args.amount} ${fromSym} → ${toSym} on ${args.fromChain} via ${quote.tool}`;

  const swapTx: UnsignedTx = {
    chain,
    to: txRequest.to as `0x${string}`,
    data: txRequest.data as `0x${string}`,
    value: txRequest.value ? BigInt(txRequest.value).toString() : "0",
    from: args.wallet as `0x${string}`,
    description,
    decoded: {
      functionName: "lifi",
      args: {
        tool: quote.tool,
        from: `${args.amount} ${fromSym}`,
        expectedOut: `${formatUnits(BigInt(quote.estimate.toAmount), quote.action.toToken.decimals)} ${toSym}`,
        minOut: `${formatUnits(BigInt(quote.estimate.toAmountMin), quote.action.toToken.decimals)} ${toSym}`,
      },
    },
    gasEstimate: txRequest.gasLimit ? BigInt(txRequest.gasLimit).toString() : undefined,
  };

  // ------------------------------------------------------------------------
  // Routing decision: direct Uniswap V3 vs LiFi
  // ------------------------------------------------------------------------
  //
  // Cross-chain is always LiFi (no direct-V3 equivalent for bridging) and
  // gets the `blind-sign-unavoidable` label — the destination-chain execution
  // cannot be verified locally at sign time.
  //
  // Same-chain: if direct came back with a quote and its minOut is within
  // DIRECT_V3_SHORTFALL_BPS of LiFi's, prefer direct (clear-signable beats
  // a small routing-quality gap). Otherwise stick with LiFi (blind-sign,
  // but with a swiss-knife decoder URL).
  const lifiMinOut = BigInt(quote.estimate.toAmountMin);
  let useDirect = false;
  let routingDecision: "direct-v3" | "lifi" | "lifi-bridge" = isCrossChain
    ? "lifi-bridge"
    : "lifi";
  let rejectedAlternative: { route: "direct-v3"; minOut: string; gapBps: number } | undefined;

  if (!isCrossChain && direct) {
    const threshold = DIRECT_V3_SHORTFALL_BPS[chain];
    if (direct.minOut >= (lifiMinOut * BigInt(10_000 - threshold)) / 10_000n) {
      useDirect = true;
      routingDecision = "direct-v3";
    } else {
      // Direct was worse by more than the threshold — stick with LiFi, and
      // surface the gap so the agent can explain the choice.
      const gapBps =
        lifiMinOut > 0n
          ? Number(((lifiMinOut - direct.minOut) * 10_000n) / lifiMinOut)
          : 0;
      rejectedAlternative = {
        route: "direct-v3",
        minOut: direct.minOut.toString(),
        gapBps,
      };
    }
  }

  // Build the chosen tx (pre-approval). Direct gets stamped clear-signable
  // via the classifier in `issueHandles` (SwapRouter02's `multicall` is in
  // the clear-sign set). LiFi bridges are explicitly marked
  // blind-sign-unavoidable here so the classifier's default blind-sign
  // label is overridden.
  let chosenTx: UnsignedTx;
  let approvalSpender: `0x${string}`;
  let approvalDescSource: string;

  if (useDirect && direct) {
    chosenTx = {
      ...direct.tx,
      description:
        `Swap ${args.amount} ${fromSym} → ${toSym} on ${args.fromChain} via ${direct.routeDescription} ` +
        `(direct-V3, hardware-verified on Ledger)`,
      decoded: {
        functionName: "multicall",
        args: {
          route: direct.routeDescription,
          expectedOut: `${formatUnits(direct.expectedOut, quote.action.toToken.decimals)} ${toSym}`,
          minOut: `${formatUnits(direct.minOut, quote.action.toToken.decimals)} ${toSym}`,
          routingDecision,
          ...(rejectedAlternative
            ? { rejectedAlternative: JSON.stringify(rejectedAlternative) }
            : {}),
        },
      },
    };
    approvalSpender = (CONTRACTS_LOOKUP(chain, "swapRouter02") as `0x${string}`);
    approvalDescSource = `Uniswap V3 SwapRouter (direct)`;
  } else {
    chosenTx = {
      ...swapTx,
      decoded: {
        ...swapTx.decoded!,
        args: {
          ...(swapTx.decoded!.args as Record<string, string>),
          routingDecision,
          ...(rejectedAlternative
            ? { rejectedAlternative: JSON.stringify(rejectedAlternative) }
            : {}),
        },
      },
    };
    if (isCrossChain) {
      chosenTx = stampTrust(
        chosenTx,
        "blind-sign-unavoidable",
        `LiFi cross-chain bridge ${quote.tool}: destination-chain execution cannot be ` +
          `verified locally at sign time. Bridging is irreversible — strongly recommend ` +
          `independent verification via the decoder URL before approving.`
      );
    }
    approvalSpender = (quote.estimate.approvalAddress ?? (txRequest.to as `0x${string}`)) as `0x${string}`;
    approvalDescSource = isCrossChain
      ? `${quote.tool} via LiFi bridge`
      : `${quote.tool} via LiFi`;
  }

  // ERC-20 inputs require an allowance on the chosen spender (LiFi Diamond
  // or Uniswap SwapRouter depending on routing). Without this, the swap
  // reverts on transferFrom. Native inputs skip this step.
  if (fromToken !== "native") {
    const client = getClient(chain);
    const allowance = (await client.readContract({
      address: fromToken,
      abi: erc20Abi,
      functionName: "allowance",
      args: [args.wallet as `0x${string}`, approvalSpender],
    })) as bigint;

    const amountWeiBig = BigInt(fromAmountWei);
    if (allowance < amountWeiBig) {
      const approveTx: UnsignedTx = {
        chain,
        to: fromToken,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [approvalSpender, amountWeiBig],
        }),
        value: "0",
        from: args.wallet as `0x${string}`,
        description: `Approve ${args.amount} ${fromSym} for ${approvalDescSource} (exact amount)`,
        decoded: {
          functionName: "approve",
          args: { spender: approvalSpender, amount: `${args.amount} ${fromSym}` },
        },
        next: chosenTx,
      };
      if (allowance > 0n) {
        // USDT-style reset: tokens like USDT revert on approve(nonzero→nonzero).
        // Chain approve(0) → approve(amount) → swap so we don't silently fail on
        // the first tx of the triple.
        const resetTx: UnsignedTx = {
          chain,
          to: fromToken,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [approvalSpender, 0n],
          }),
          value: "0",
          from: args.wallet as `0x${string}`,
          description: `Reset ${fromSym} allowance to 0 (required by USDT-style tokens before re-approval)`,
          decoded: {
            functionName: "approve",
            args: { spender: approvalSpender, amount: "0" },
          },
          next: approveTx,
        };
        return resetTx;
      }
      return approveTx;
    }
  }

  return chosenTx;
}

/** Narrow lookup into CONTRACTS tolerant of the string-index view. */
function CONTRACTS_LOOKUP(chain: SupportedChain, key: "swapRouter02"): string {
  // Defined via a helper so the import of CONTRACTS stays next to its usage.
  return CONTRACTS[chain].uniswap[key];
}

export async function getSwapStatus(args: { txHash: string; fromChain: SupportedChain; toChain: SupportedChain }) {
  return fetchStatus(args.txHash, args.fromChain, args.toChain);
}
