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

/**
 * Unsigned TRON transaction. Shape is unavoidably different from EVM:
 * TronGrid builds the tx server-side (raw_data + raw_data_hex) and the
 * device signs the serialized raw_data_hex. We keep the TRON tx shape
 * separate from UnsignedTx so send_transaction's EVM-only security pipeline
 * (eth_call re-simulation, chain-id check, spender allowlist) can't be
 * silently shortcut by a TRON handle masquerading as an EVM one.
 *
 * Phase 3 (this release) routes TRON handles through `send_transaction`:
 * the USB HID signer (@ledgerhq/hw-app-trx) verifies the device address
 * matches `from`, signs `rawDataHex`, and broadcasts via TronGrid.
 */
export interface UnsignedTronTx {
  chain: "tron";
  /** Discriminator for the preview + future signer branching. */
  action:
    | "native_send"
    | "trc20_send"
    | "trc20_approve"
    | "claim_rewards"
    | "freeze"
    | "unfreeze"
    | "withdraw_expire_unfreeze"
    | "vote"
    | "lifi_swap"
    | "sunswap_swap";
  /** Base58 owner address (prefix T). */
  from: string;
  /** TronGrid-returned transaction ID (sha256 of raw_data_hex, hex string). */
  txID: string;
  /**
   * TronGrid's raw_data object — opaque to us; serialized in raw_data_hex.
   * Required for the standard `/wallet/broadcasttransaction` path. ABSENT
   * for `lifi_swap` flows where we receive only `raw_data_hex` from LiFi
   * and broadcast via `/wallet/broadcasthex` instead (broadcast.ts branches
   * on this).
   */
  rawData?: unknown;
  /** Hex-encoded raw_data used by the signer. */
  rawDataHex: string;
  /** Human-readable description for the preview. */
  description: string;
  decoded: {
    functionName: string;
    args: Record<string, string>;
    /**
     * ABI-encoded parameter payload (no `0x`, no selector) for TRC-20 calls.
     * Set by the trc20_send / trc20_approve builders so the verification
     * layer can compose the full calldata (`0x<selector><parameterHex>`)
     * without re-deriving it from the human-readable args.
     */
    parameterHex?: string;
  };
  /**
   * Fee limit in SUN, present on contract calls (TRC-20 transfers require it;
   * TronGrid rejects triggersmartcontract without one). Absent on native TRX
   * sends and WithdrawBalance — those pay bandwidth only.
   */
  feeLimitSun?: string;
  /**
   * Energy units the pre-flight triggerconstantcontract call consumed. Only
   * present on contract calls where we pre-flight (TRC-20 transfers). The
   * on-chain burn will be within a few percent of this number.
   */
  estimatedEnergyUsed?: string;
  /**
   * Estimated fee in SUN that will actually burn on-chain — energy units
   * times the mainnet energy price (420 sun/energy as of 2024-10). The
   * preview shows this alongside `feeLimitSun` so the user can see
   * "expected ~15 TRX" next to "cap 100 TRX" and not think the cap is the
   * charge.
   */
  estimatedEnergyCostSun?: string;
  /** Opaque handle — see tron-tx-store.ts. Phase 3 signer consumes this. */
  handle?: string;
  /**
   * Pre-sign verification payload, stamped by `issueTronHandle` on every
   * prepared TRON tx. Optional during rollout; flipped to required after
   * all call sites are updated.
   */
  verification?: TxVerification;
  /**
   * Invariant #14 — durable-binding source-of-truth verification (issue
   * #460). Populated by `prepare_tron_vote` (one binding per Super
   * Representative voted for). Absent on other TRON op kinds.
   */
  durableBindings?: import("../security/durable-binding.js").DurableBinding[];
}
