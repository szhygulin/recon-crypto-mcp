/**
 * Uniswap V3 SwapRouter02 — minimal surface used for direct-DEX swap routing.
 *
 * We include:
 *  - exactInputSingle / exactOutputSingle (single-hop)
 *  - multicall (needed to bundle swap + unwrapWETH9 for native-out flows)
 *  - unwrapWETH9 (convert WETH held by the router back into ETH to the recipient)
 *  - refundETH (returns leftover msg.value when exact-out with native in overshoots)
 *
 * Multi-hop (`exactInput` / `exactOutput` with encoded paths) is intentionally
 * omitted — v1 is single-pool-per-swap with auto-picked fee tier. Multi-hop
 * routing belongs behind its own follow-up: encoding + tick-liquidity search
 * across tiers multiplies surface area and the common "swap X for Y on Uniswap"
 * ask is satisfied by the best-tier single-hop path.
 */
export const swapRouter02Abi = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "exactOutputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountOut", type: "uint256" },
          { name: "amountInMaximum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountIn", type: "uint256" }],
  },
  {
    type: "function",
    name: "multicall",
    stateMutability: "payable",
    inputs: [{ name: "data", type: "bytes[]" }],
    outputs: [{ name: "results", type: "bytes[]" }],
  },
  {
    type: "function",
    name: "unwrapWETH9",
    stateMutability: "payable",
    inputs: [
      { name: "amountMinimum", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "refundETH",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
] as const;
