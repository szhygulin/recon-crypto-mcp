/**
 * LiFi Diamond (https://github.com/lifinance/contracts) swap-facet ABI —
 * covers the generic-swap entry points that LiFi's routing engine emits
 * for intra-chain swaps. Source of truth:
 *
 *   - src/Facets/GenericSwapFacet.sol          (legacy `swapTokensGeneric`)
 *   - src/Facets/GenericSwapFacetV3.sol        (V3 single-* and multiple-* variants)
 *   - src/Libraries/LibSwap.sol                (SwapData struct)
 *
 * All on `lifinance/contracts` master, verified 2026-04-15.
 *
 * Selector reference (computed locally):
 *   0x4630a0d8  swapTokensGeneric                      (legacy, SwapData[])
 *   0x4666fc80  swapTokensSingleV3ERC20ToERC20         (single, SwapData)
 *   0x733214a3  swapTokensSingleV3ERC20ToNative        (single, SwapData)
 *   0xaf7060fd  swapTokensSingleV3NativeToERC20        (single, SwapData)
 *   0x5fd9ae2e  swapTokensMultipleV3ERC20ToERC20       (multi, SwapData[])
 *   0x2c57e884  swapTokensMultipleV3ERC20ToNative      (multi, SwapData[])
 *   0x736eac0b  swapTokensMultipleV3NativeToERC20      (multi, SwapData[])
 *
 * Bridge facets (across/amarok/stargate/etc.) are intentionally out of
 * scope here — vaultpilot-mcp uses LiFi's aggregator for intra-chain
 * swaps; cross-chain bridges have their own calldata shapes per facet
 * and would double this file's size without value. Unknown selectors
 * fall back to the swiss-knife decoder URL (source: "none").
 */

const swapDataTuple = {
  type: "tuple",
  name: "_swapData",
  components: [
    { name: "callTo", type: "address" },
    { name: "approveTo", type: "address" },
    { name: "sendingAssetId", type: "address" },
    { name: "receivingAssetId", type: "address" },
    { name: "fromAmount", type: "uint256" },
    { name: "callData", type: "bytes" },
    { name: "requiresDeposit", type: "bool" },
  ],
} as const;

const swapDataArray = {
  type: "tuple[]",
  name: "_swapData",
  components: swapDataTuple.components,
} as const;

const commonInputs = [
  { name: "_transactionId", type: "bytes32" },
  { name: "_integrator", type: "string" },
  { name: "_referrer", type: "string" },
  { name: "_receiver", type: "address" },
] as const;

function swapSingle(name: string, minAmountName: "_minAmountOut" | "_minAmount") {
  return {
    type: "function" as const,
    name,
    stateMutability: "payable" as const,
    inputs: [
      ...commonInputs,
      { name: minAmountName, type: "uint256" },
      swapDataTuple,
    ],
    outputs: [],
  };
}

function swapMulti(name: string, minAmountName: "_minAmountOut" | "_minAmount") {
  return {
    type: "function" as const,
    name,
    stateMutability: "payable" as const,
    inputs: [
      ...commonInputs,
      { name: minAmountName, type: "uint256" },
      swapDataArray,
    ],
    outputs: [],
  };
}

export const lifiDiamondAbi = [
  swapMulti("swapTokensGeneric", "_minAmount"),
  swapSingle("swapTokensSingleV3ERC20ToERC20", "_minAmountOut"),
  swapSingle("swapTokensSingleV3ERC20ToNative", "_minAmountOut"),
  swapSingle("swapTokensSingleV3NativeToERC20", "_minAmountOut"),
  swapMulti("swapTokensMultipleV3ERC20ToERC20", "_minAmountOut"),
  swapMulti("swapTokensMultipleV3ERC20ToNative", "_minAmountOut"),
  swapMulti("swapTokensMultipleV3NativeToERC20", "_minAmountOut"),
] as const;
