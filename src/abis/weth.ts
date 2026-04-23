/**
 * Minimal WETH9 ABI. Covers the WETH9-specific surface used by prepare_*
 * tools AND referenced by the pre-sign allowlist / calldata decoder:
 *   - `withdraw(uint256)` — unwrap WETH → native ETH (prepare_weth_unwrap).
 *   - `deposit()` — wrap native ETH → WETH. Our prepare_* path for wrap
 *     uses `prepare_native_send` against WETH9 (fallback() hits deposit),
 *     which produces empty calldata and bypasses the selector gate. But
 *     callers may still emit explicit `deposit()` calldata, and we want
 *     the pre-sign check to recognize it instead of refusing.
 *   - `balanceOf(address)` — used by the "max" resolver and the
 *     pre-build balance guard in buildWethUnwrap.
 */
export const wethAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "wad", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
] as const;
