/**
 * Uniswap V3 QuoterV2 — read-only quoting. We call these via eth_call (not
 * sign); the router's actual swap calldata is priced against these quotes.
 *
 * `quoteExactInputSingle` takes a params struct (tokenIn/tokenOut/fee/etc.)
 * and returns (amountOut, sqrtPriceX96After, initializedTicksCrossed,
 * gasEstimate). `quoteExactInput` takes a packed path bytes and an amountIn
 * and returns amountOut plus the same per-hop diagnostics.
 *
 * QuoterV2 is not `view` by declaration — it reverts-to-return-values
 * internally to skirt solidity limitations on deep stack returns. viem's
 * `readContract` handles that transparently.
 */
export const uniswapQuoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "quoteExactInput",
    stateMutability: "nonpayable",
    inputs: [
      { name: "path", type: "bytes" },
      { name: "amountIn", type: "uint256" },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96AfterList", type: "uint160[]" },
      { name: "initializedTicksCrossedList", type: "uint32[]" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;
