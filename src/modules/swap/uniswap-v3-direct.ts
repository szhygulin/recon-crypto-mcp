import { concat, encodeFunctionData, pad, toHex, type Hex } from "viem";
import { getClient } from "../../data/rpc.js";
import { uniswapQuoterAbi } from "../../abis/uniswap-quoter.js";
import { uniswapSwapRouterAbi } from "../../abis/uniswap-swap-router.js";
import { CONTRACTS } from "../../config/contracts.js";
import type { SupportedChain, UnsignedTx } from "../../types/index.js";

/**
 * Direct Uniswap V3 swap builder. Bypasses the LiFi aggregator for same-chain
 * swaps that can route through a Uniswap V3 pool, because SwapRouter02 is a
 * Ledger clear-sign target (`exactInputSingle` / `exactInput` / `multicall`
 * are all decoded on-device) while LiFi Diamond calls are always blind-sign.
 *
 * Logic:
 *   1. Try single-hop `exactInputSingle` across standard fee tiers (100, 500,
 *      3000, 10000). Pick the tier with the best quote.
 *   2. If no single-hop route has liquidity, try multi-hop `exactInput` via
 *      WETH. This catches thin long-tail pairs that trade via the native
 *      wrapper hub (USDC → WETH → ARB is a typical shape on Arbitrum).
 *   3. Native ETH in/out is handled inside a `multicall` so the router can
 *      wrap/unwrap via WETH9 atomically with the swap.
 *
 * Return: `{ tx, expectedOut, minOut }` on success, `null` when no direct
 * route exists (the caller then falls back to LiFi). Never throws on "no
 * liquidity" — that's a normal signal that this chain/pair isn't Uniswap-
 * native. Other errors (bad input, RPC failure) propagate as thrown errors.
 */

/** Fee tiers we try, in descending order of market share. */
const V3_FEE_TIERS = [500, 3000, 100, 10000] as const;
type FeeTier = (typeof V3_FEE_TIERS)[number];

interface SingleHopRoute {
  kind: "single";
  fee: FeeTier;
  amountOut: bigint;
}

interface MultiHopRoute {
  kind: "multi";
  /** Packed path bytes: tokenIn || fee0 || weth || fee1 || tokenOut (3-byte fees). */
  path: Hex;
  /** Fee tier of the first hop (input side), for accounting. */
  fee0: FeeTier;
  /** Fee tier of the second hop (output side). */
  fee1: FeeTier;
  amountOut: bigint;
}

type Route = SingleHopRoute | MultiHopRoute;

export interface DirectSwapArgs {
  chain: SupportedChain;
  from: `0x${string}`;
  fromToken: `0x${string}` | "native";
  toToken: `0x${string}` | "native";
  /** Raw amount in fromToken base units (wei for ETH). */
  amountIn: bigint;
  /** Slippage tolerance in basis points (50 = 0.5%). */
  slippageBps: number;
  /** Unix seconds; SwapRouter02's multicall takes a deadline. */
  deadline?: bigint;
}

export interface DirectSwapResult {
  tx: UnsignedTx;
  expectedOut: bigint;
  minOut: bigint;
  routeDescription: string;
}

function packPath(tokenA: `0x${string}`, feeAB: number, tokenB: `0x${string}`, feeBC: number, tokenC: `0x${string}`): Hex {
  // V3 path encoding: addr(20) || fee(3 bytes) || addr(20) || fee(3) || addr(20)
  return concat([
    tokenA,
    pad(toHex(feeAB), { size: 3 }),
    tokenB,
    pad(toHex(feeBC), { size: 3 }),
    tokenC,
  ]) as Hex;
}

/** Resolve the actual ERC-20 address used in swap calldata for a "native" leg. */
function resolveTokenAddress(chain: SupportedChain, token: `0x${string}` | "native"): `0x${string}` {
  if (token === "native") return CONTRACTS[chain].uniswap.weth9 as `0x${string}`;
  return token;
}

async function quoteSingleHop(
  chain: SupportedChain,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  amountIn: bigint
): Promise<SingleHopRoute | null> {
  const quoter = CONTRACTS[chain].uniswap.quoterV2 as `0x${string}`;
  const client = getClient(chain);

  let best: SingleHopRoute | null = null;
  // Tier probing is parallelized — each eth_call is independent, and waiting
  // serially adds 4x latency on L1.
  const results = await Promise.allSettled(
    V3_FEE_TIERS.map(async (fee) => {
      const { result } = await client.simulateContract({
        address: quoter,
        abi: uniswapQuoterAbi,
        functionName: "quoteExactInputSingle",
        args: [
          {
            tokenIn,
            tokenOut,
            amountIn,
            fee,
            sqrtPriceLimitX96: 0n,
          },
        ],
      });
      // simulateContract returns the tuple; amountOut is the first element.
      const [amountOut] = result as unknown as [bigint, bigint, number, bigint];
      return { fee, amountOut };
    })
  );

  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    if (r.value.amountOut === 0n) continue;
    if (!best || r.value.amountOut > best.amountOut) {
      best = { kind: "single", fee: r.value.fee, amountOut: r.value.amountOut };
    }
  }
  return best;
}

async function quoteMultiHop(
  chain: SupportedChain,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  amountIn: bigint
): Promise<MultiHopRoute | null> {
  const weth = CONTRACTS[chain].uniswap.weth9 as `0x${string}`;
  if (tokenIn.toLowerCase() === weth.toLowerCase() || tokenOut.toLowerCase() === weth.toLowerCase()) {
    // No sense routing X → WETH → Y when one leg already is WETH.
    return null;
  }
  const quoter = CONTRACTS[chain].uniswap.quoterV2 as `0x${string}`;
  const client = getClient(chain);

  // Cross-product over fee tiers for the two hops.
  const combos: Array<{ fee0: FeeTier; fee1: FeeTier; path: Hex }> = [];
  for (const fee0 of V3_FEE_TIERS) {
    for (const fee1 of V3_FEE_TIERS) {
      combos.push({ fee0, fee1, path: packPath(tokenIn, fee0, weth, fee1, tokenOut) });
    }
  }

  const results = await Promise.allSettled(
    combos.map(async ({ fee0, fee1, path }) => {
      const { result } = await client.simulateContract({
        address: quoter,
        abi: uniswapQuoterAbi,
        functionName: "quoteExactInput",
        args: [path, amountIn],
      });
      const [amountOut] = result as unknown as [bigint, bigint[], number[], bigint];
      return { fee0, fee1, path, amountOut };
    })
  );

  let best: MultiHopRoute | null = null;
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    if (r.value.amountOut === 0n) continue;
    if (!best || r.value.amountOut > best.amountOut) {
      best = {
        kind: "multi",
        fee0: r.value.fee0,
        fee1: r.value.fee1,
        path: r.value.path,
        amountOut: r.value.amountOut,
      };
    }
  }
  return best;
}

/** Build the calldata + value for a resolved route. */
function buildRouterCalldata(
  args: DirectSwapArgs,
  route: Route,
  minOut: bigint,
  tokenInAddr: `0x${string}`,
  tokenOutAddr: `0x${string}`
): { to: `0x${string}`; data: Hex; value: string } {
  const router = CONTRACTS[args.chain].uniswap.swapRouter02 as `0x${string}`;
  const isNativeIn = args.fromToken === "native";
  const isNativeOut = args.toToken === "native";

  const value = isNativeIn ? args.amountIn.toString() : "0";

  // When native is on the output side we need to receive WETH to the router
  // (address(2) sentinel) and then unwrap to the user inside a multicall.
  // When native is on the input side the router auto-wraps using msg.value.
  // When both sides are ERC-20, a single exactInput(Single) call suffices —
  // but we still wrap in multicall so the selector the Ledger sees is
  // consistent across cases.
  const RECIPIENT_ROUTER = "0x0000000000000000000000000000000000000002" as `0x${string}`;
  const recipient: `0x${string}` = isNativeOut ? RECIPIENT_ROUTER : args.from;

  // Inner swap call.
  let innerData: Hex;
  if (route.kind === "single") {
    innerData = encodeFunctionData({
      abi: uniswapSwapRouterAbi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: tokenInAddr,
          tokenOut: tokenOutAddr,
          fee: route.fee,
          recipient,
          amountIn: args.amountIn,
          amountOutMinimum: minOut,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
  } else {
    innerData = encodeFunctionData({
      abi: uniswapSwapRouterAbi,
      functionName: "exactInput",
      args: [
        {
          path: route.path,
          recipient,
          amountIn: args.amountIn,
          amountOutMinimum: minOut,
        },
      ],
    });
  }

  const calls: Hex[] = [innerData];
  if (isNativeOut) {
    const unwrapData = encodeFunctionData({
      abi: uniswapSwapRouterAbi,
      functionName: "unwrapWETH9",
      args: [minOut, args.from],
    });
    calls.push(unwrapData);
  }

  const data = encodeFunctionData({
    abi: uniswapSwapRouterAbi,
    functionName: "multicall",
    args: [calls as readonly Hex[]],
  });

  return { to: router, data, value };
}

export async function buildUniswapV3DirectSwap(
  args: DirectSwapArgs
): Promise<DirectSwapResult | null> {
  const router = CONTRACTS[args.chain].uniswap.swapRouter02;
  if (!router) return null;

  const tokenInAddr = resolveTokenAddress(args.chain, args.fromToken);
  const tokenOutAddr = resolveTokenAddress(args.chain, args.toToken);
  if (tokenInAddr.toLowerCase() === tokenOutAddr.toLowerCase()) {
    // Wrap/unwrap is not a swap — user memory: wrapping is a native send.
    return null;
  }

  // Probe single-hop first; only fall back to multi-hop if single is absent.
  // This keeps the quote request budget tight: 4 eth_calls for single, +16 if
  // we fall through to multi.
  const single = await quoteSingleHop(args.chain, tokenInAddr, tokenOutAddr, args.amountIn);
  let route: Route | null = single;
  if (!route) {
    route = await quoteMultiHop(args.chain, tokenInAddr, tokenOutAddr, args.amountIn);
  }
  if (!route) return null;

  const slippageNum = BigInt(10_000 - args.slippageBps);
  const minOut = (route.amountOut * slippageNum) / 10_000n;

  const { to, data, value } = buildRouterCalldata(
    args,
    route,
    minOut,
    tokenInAddr,
    tokenOutAddr
  );

  const routeDescription =
    route.kind === "single"
      ? `Uniswap V3 direct (${route.fee / 10_000}% fee)`
      : `Uniswap V3 via WETH (${route.fee0 / 10_000}% → ${route.fee1 / 10_000}%)`;

  const tx: UnsignedTx = {
    chain: args.chain,
    to,
    data,
    value,
    from: args.from,
    description: `Swap via ${routeDescription} on ${args.chain}`,
    decoded: {
      functionName: "multicall",
      args: {
        route: routeDescription,
        expectedOut: route.amountOut.toString(),
        minOut: minOut.toString(),
      },
    },
  };

  return { tx, expectedOut: route.amountOut, minOut, routeDescription };
}
