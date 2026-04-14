/**
 * Uniswap V3 SwapRouter02 — the subset of functions our direct-swap builder
 * emits plus the subset we want the pre-sign check to recognize.
 *
 * `exactInputSingle` / `exactInput` are the two routing entrypoints (single-hop
 * vs multi-hop). `multicall(bytes[])` is the wrapping/unwrapping envelope used
 * when a swap touches native ETH (the router wraps via WETH9 internally as the
 * first step of the multicall). `unwrapWETH9` / `sweepToken` are the trailing
 * steps the router uses inside multicall when the output side is native.
 *
 * This ABI is intentionally narrow: it names exactly the selectors we expect
 * to route, so a malicious destination that happens to land on the SwapRouter
 * address with some other selector (e.g. the legacy `exactOutputSingle`,
 * which our builder never emits) is rejected by the pre-sign check's
 * "selector must exist on ABI" rule.
 */
export const uniswapSwapRouterAbi = [
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
    name: "exactInput",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "path", type: "bytes" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
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
    name: "sweepToken",
    stateMutability: "payable",
    inputs: [
      { name: "token", type: "address" },
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
