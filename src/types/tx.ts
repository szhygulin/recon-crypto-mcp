/**
 * Per-argument decode from the calldata — one entry per ABI input field.
 * `valueHuman` is populated only when we can apply decimals + symbol (known
 * ERC-20 tokens via `TOKEN_META`). For everything else, `value` is the raw
 * stringified bigint / address / bytes and callers render that directly.
 */
export interface DecodedArg {
  name: string;
  type: string;
  value: string;
  valueHuman?: string;
}

/**
 * Local decode of the exact calldata that will be signed. Built from the
 * static ABI registry in `src/abis/*` via viem's `decodeFunctionData`. Never
 * calls a network — if the destination isn't in our registry, `source` is
 * `"none"` and the user is told to rely entirely on the swiss-knife URL.
 */
export interface HumanDecode {
  /** Function name (`"supply"`), or `"nativeTransfer"` / `"unknown"`. */
  functionName: string;
  /** Full signature like `supply(address,uint256,address,uint16)`. */
  signature?: string;
  args: DecodedArg[];
  /**
   * - `"local-abi"`: full decode against an ABI in our static registry — `functionName` is the canonical on-chain name and is corroborable against 4byte.directory's selector→name mapping.
   * - `"local-abi-partial"`: the destination is in our registry but the specific selector/facet isn't (e.g. LiFi Diamond bridge facets) — we surfaced a positional decode of a known shared sub-tuple, but `functionName` is synthetic and MUST NOT be cross-checked against 4byte (a name-equality check would always fail by design).
   * - `"native"`: pure native-value transfer, no calldata.
   * - `"none"`: unknown destination, no decode possible.
   */
  source: "local-abi" | "local-abi-partial" | "native" | "none";
}

/**
 * Pre-sign verification payload — attached to EVERY prepared transaction
 * unconditionally. The user is expected to open `decoderUrl` in a browser,
 * compare what swiss-knife.xyz decodes against `humanDecode` in chat, and
 * only approve on Ledger if the two agree. The `payloadHash` is a
 * domain-tagged keccak256 that can be recomputed independently from the
 * swiss-knife URL params and is re-checked at send time against the exact
 * bytes forwarded to WalletConnect (the bytes-we-previewed == bytes-we-sign
 * proof).
 */
export interface TxVerification {
  /** keccak256 of `("VaultPilot-txverify-v1:" ‖ chainId ‖ to ‖ value ‖ data)` for EVM; `("VaultPilot-txverify-v1:tron:" ‖ rawDataHex)` for TRON. */
  payloadHash: `0x${string}`;
  /** First 8 hex chars (no `0x`) of `payloadHash` — short enough to read off a Ledger screen and eyeball-match. */
  payloadHashShort: string;
  /** swiss-knife.xyz decoder URL with calldata, address, chainId preloaded. EVM only; absent when calldata is too large to fit or on TRON. */
  decoderUrl?: string;
  /** Fallback when `decoderUrl` can't be built — short instructions telling the user to paste calldata/address/chainId manually. */
  decoderPasteInstructions?: string;
  /** Local decode of the calldata (viem + ABI registry). */
  humanDecode: HumanDecode;
  /** Canonical comparison string `<chainId>:<to>:<value>:<data>` — exactly the four fields fed into the fingerprint. */
  comparisonString: string;
  /**
   * TRC-20 calldata bytes (`0x` + 4-byte selector + ABI-encoded params) for
   * `trc20_send` / `trc20_approve` actions. Surfaced so the agent can
   * (a) decode the recipient slot itself and cross-check it against the
   * typed base58 address (mirror of EVM CHECK 1), and (b) splice into a
   * swiss-knife.xyz decoder URL the user can open in the browser. Absent
   * for native TRX sends, freeze/unfreeze, votes, and other non-ABI
   * actions — those have no calldata to decode.
   */
  tronCalldataHex?: `0x${string}`;
}
