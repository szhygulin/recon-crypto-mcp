# VaultPilot MCP — Security Model

This document describes VaultPilot's trust boundaries, the defenses that catch
attacks across them, and — equally important — the attacks that are *not*
covered. The goal is an honest map of what you're trusting when you let an AI
agent prepare transactions against your Ledger device.

For the product overview, install instructions, and tool reference, see the
main [README](./README.md).

## Trust boundaries

The signing pipeline crosses several independent trust boundaries, each of
which can be compromised in isolation:

```
user-intent ──► agent ──► MCP server ──► WalletConnect / USB-HID ──► Ledger Live / host ──► Ledger device
```

The Ledger device is the only component whose display the user sees directly
(not filtered through the agent) and which cannot be software-compromised at
the host level. Everything else can fail. VaultPilot's defenses are layered so
that **most single-layer compromises are caught, single-layer compromises are
caught by at least one cross-check, and coordinated multi-layer attacks are
either caught or honestly called out as unprotected**.

## Defenses and what each catches

Two of the anti-compromised-MCP checks below — agent-side ABI decode and the
pair-consistency pre-sign hash recomputation — run **automatically at
`preview_send` time** and report their results in a `CHECKS PERFORMED` block
before the user replies "send". The agent is instructed to run them
unprompted; the user does not consent check-by-check. The second-LLM
verification is the one remaining opt-in, because it requires physical user
action (paste into another LLM). The swiss-knife decoder URL stays embedded
in the VERIFY-BEFORE-SIGNING block as a suggested manual fallback when the
agent's built-in ABI knowledge is low-confidence on the target selector.

| Layer | Threat it catches | Honest limits |
|---|---|---|
| **Prepare↔send `payloadFingerprint`** — domain-tagged `keccak256` over `{chainId, to, value, data}`, checked at send time | MCP-internal drift between prepare and send (bug or bytes-swap at send) | Not what Ledger displays. The server never claims this matches the device hash. |
| **Independent 4byte.directory cross-check** — auto-emitted `[CROSS-CHECK SUMMARY]` block on every `prepare_*` | Agent fabricating a "✓ cross-check passed" line; server-side ABI swap vs. the public selector registry | Function-signature only (no arg values). "error" / "not-applicable" states are surfaced verbatim rather than masked. |
| **Agent-side ABI decode** — auto-run at `preview_send` time; the agent decodes `data` from its built-in model-weight ABI knowledge and compares against the server's compact summary; `⚠ DECODE UNAVAILABLE` fallback surfaces the swiss-knife URL embedded in VERIFY-BEFORE-SIGNING for a third-party browser-context decode | MCP-side calldata tampering — if the server rewrote the bytes, the agent's independent decode disagrees with the compact summary | Depends on the agent's ABI coverage for the target selector. Low-confidence decodes hand off to swiss-knife, which is a client-side SPA — the user opens the URL in a browser the agent can't sandbox. |
| **`LEDGER BLIND-SIGN HASH` block** — EIP-1559 pre-sign RLP `keccak256` over `{chainId, nonce, maxFeePerGas, maxPriorityFeePerGas, gas, to, value, data}`, emitted by `preview_send` | Any bytes-tampering between MCP and the device: WC-relay MITM, Ledger Live malware, a USB-channel adversary on TRON. The value is what the device will display in blind-sign mode; the user matches on-device. | Bytes-integrity only — does not prove the bytes match user intent (calldata could still be malicious if MCP itself is compromised). Tapping "Edit gas" in Ledger Live invalidates the match by design; the in-block wording says "you may still approve, but the hash-match guarantee no longer applies." |
| **`PREPARE RECEIPT` block** — verbatim-relay of the raw args the agent passed to `prepare_*` | Narrow agent compromise: prompt injection from other tool output, malicious Claude skill, compromised subagent in a delegation chain — anything that rewrites args without also crafting a matching filter on the agent's output | Defense-in-depth, not a hard boundary. A fully-coordinated compromised agent can drop or mutate the block; "verbatim relay" is a social contract enforced by in-block prose. |
| **Agent-side pair-consistency pre-sign hash recomputation** — auto-run by the agent at `preview_send` time, results reported in the `CHECKS PERFORMED` block; uses `viem.serializeTransaction` + `keccak256` over the server-returned pinned tuple and compares against the server's claimed hash | Compromised MCP that reports a hash inconsistent with the bytes it forwards to WC. `viem` is a separate code trust boundary; the agent's recompute agreeing with the server's hash narrows the MCP-lying gap. | Requires local code execution. For contract calls, depends on the agent first decoding `data` against its built-in ABI knowledge to sanity-check intent — otherwise the hash check tautologically agrees with any tuple. For native sends (`data = "0x"`), the agent knows the full tuple and the check is clean. |
| **`previewToken` + `userDecision` gate on `send_transaction`** — server-minted UUID (bound to the pin, re-minted on `refresh:true`) plus `z.literal("send")`, both required on every EVM send | Accidental preview-step collapse: agent going `preview_send` → `send_transaction` in one silent step, skipping the `CHECKS PERFORMED` report that `preview_send`'s agent-task block instructs it to emit. Missing/mismatched values cause a clear-error refusal naming the missing arg. | Schema-level, not user-physical. A fully-hostile agent can still fabricate `userDecision: "send"` after calling `preview_send` for a real token — the server has no channel to distinguish "user really said send" from "agent claims user said send". Closes careless mistakes, not coordinated lying. |
| **Ledger device display** — `To`, `Value`, hash in blind-sign; decoded fields when a plugin clear-signs (Aave, Lido, 1inch, LiFi, approve) | Any tampering that survived every software layer. The device serializes the bytes it received and hashes locally; the user's eyeball on the device screen is the final check. | Blind-sign shows no calldata decode. Intent-vs-bytes matching on contract calls happens off-device, through agent model-weight decode with swiss-knife fallback. |

## Threat → what catches it

- **Prompt injection / malicious skill / compromised subagent (narrow):** `PREPARE RECEIPT` surfaces the args that hit MCP, bypassing the agent's natural-language retelling. For native sends, the Ledger device's `To` / `Value` display backstops even if the receipt is dropped. For contract calls (swaps, supplies, approvals) the calldata remains unverifiable on-device in blind-sign — the agent's auto-run ABI decode at `preview_send` is the next line of defense, with the swiss-knife URL as a manual fallback when the agent's ABI knowledge is low-confidence.
- **Fully-corrupted agent that coordinates on BOTH arg manipulation AND output filtering:** No protection. The user's entire view flows through the agent; there is no non-agent display channel for calldata in blind-sign mode. Conceded honestly — this threat is only reachable with a non-agent display channel (a hardware wallet with full clear-signing for the target calldata), which we do not have yet for most contract calls.
- **Compromised MCP (lies about hash, swaps bytes at send-time):** `LEDGER BLIND-SIGN HASH` catches bytes-tampering between MCP and device — the device recomputes from received bytes, and the user matches the agent-relayed value against the device-displayed one. The agent's auto-run pair-consistency hash recompute (reported in `CHECKS PERFORMED`) gives an honest agent a first-line check before the device is involved.
- **Compromised Ledger Live or WalletConnect relay (middle-layer MITM):** `LEDGER BLIND-SIGN HASH` — the device is the source of truth; any substitution between MCP and the device produces a divergent on-device hash.
- **Agent accidentally skips the `CHECKS PERFORMED` report at preview time:** `previewToken` (server-minted at `preview_send`, stashed on the pin) + `userDecision: "send"` (schema literal) on `send_transaction`. Both required on the EVM path; missing/mismatched values cause a clear-error refusal naming the missing arg. A fully-hostile agent can still forge `userDecision` after a legitimate `preview_send`, so this is a careless-mistake backstop, not a coordinated-lying defense.
- **"Edit gas" in Ledger Live:** Hash mismatch is expected (the user changed a hashed field). The in-block wording explicitly allows "accept the tradeoff without the hash-match guarantee" — user owns the choice; not a bug.

## Asymmetry worth naming

For the compromised-MCP case, the honest agent is a real second trust boundary — it knows the user-intent args and can recompute the expected hash. For the compromised-agent case, MCP has no ground truth for user intent; forcing verbatim args relay (`PREPARE RECEIPT`) raises the tampering bar for narrow injections but does not close the gap against a coordinated attacker. Both halves of the asymmetry are enforced in code and covered by `test/integration-security.test.ts`.

## Verifying the server-side `payloadFingerprint` yourself

EVM preimage: `"VaultPilot-txverify-v1:" ‖ chainId (32-byte BE) ‖ to (20 bytes) ‖ value (32-byte BE) ‖ data`.

```sh
# Paste calldata, address, and chainId from the swiss-knife URL; value is shown in chat.
TAG=$(cast from-utf8 "VaultPilot-txverify-v1:")
CHAIN=$(cast to-uint256 1)         # chainId
TO=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
VALUE=$(cast to-uint256 0)         # wei, as shown in chat
DATA=0xa9059cbb...                 # from swiss-knife ?calldata=
cast keccak $(cast concat-hex "$TAG" "$CHAIN" "$TO" "$VALUE" "$DATA")
```

TRON preimage: `"VaultPilot-txverify-v1:tron:" ‖ rawDataHex`.

This fingerprint is a server-side prepare↔send integrity tag — it is **not** the hash Ledger's blind-sign screen displays (those are different preimages; Ledger hashes the full EIP-1559 RLP including nonce and fees). The blind-sign-matchable hash is emitted by `preview_send` in a separate `LEDGER BLIND-SIGN HASH` block.

## Second-agent verification (optional, for the coordinated-agent case)

The table above honestly concedes that a fully-coordinated agent compromise — where the same agent that invokes `prepare_*` with malicious args also filters what the user sees in chat — has no software-only defense, because the user's entire view flows through the agent.

`get_verification_artifact(handle)` narrows that gap. It returns a sparse artifact — `{chain, chainId, from, to, value, data, payloadHash, preSignHash?}` for EVM, analogous TRON shape — deliberately stripped of the server's own humanDecode, swiss-knife URL, and 4byte cross-check. Alongside the structured fields, the artifact carries a `pasteableBlock` string: a single self-contained paste target with explicit `===== COPY FROM THIS LINE =====` / `===== END — STOP COPYING HERE =====` markers, the instructions, and the embedded JSON payload between them. The user copies everything between the markers into a **second, independent LLM session** (ideally a different provider) and lets that agent decode the bytes from scratch with no shared context. If the two agents disagree on what the transaction does, the first agent was lying — abort. The `from` field lets the second agent auto-check in-calldata recipients (unwrapWETH9 target, bridge destination, transfer `to`) against the signer — mismatches get flagged; matches are silently accepted as expected self-targeted operations (swaps, unwraps, withdrawals).

The Ledger device is the fabrication anchor: a compromised first agent can't invent bytes whose `preSignHash` matches the hash the Ledger screen displays at sign time. The canned prompt reminds the user to compare the artifact's `preSignHash` against the device before tapping approve — any mismatch proves the artifact was forged mid-flight, and the tx is rejected on-device anyway.

Limits worth naming:

- Does not catch a supply-chain compromise of the MCP process itself (the bytes the server builds are still the bytes it ships).
- Does not catch a coordinated attack that simultaneously compromises both LLM providers (significantly harder than compromising one).
- Does not replace the normal `VERIFY-BEFORE-SIGNING` block — it is an additional tool for skeptical users on high-value or unfamiliar-contract flows.

## Reporting a vulnerability

If you believe you've found a security issue, please open a GitHub security advisory at <https://github.com/szhygulin/vaultpilot-mcp/security/advisories/new> rather than a public issue. Include a reproduction, the affected version, and your assessment of the impact. I'll aim to acknowledge within a few days.
