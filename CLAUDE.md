## Crypto/DeFi Transaction Preflight Checks
- Before preparing ANY on-chain transaction, verify: (1) sufficient native gas/bandwidth (especially TRX bandwidth for TRON), (2) pause status on lending markets (isWithdrawPaused, isSupplyPaused), (3) minimum borrow/supply thresholds, (4) approval status for ERC20 operations.
- Never use uint256.max for collateral withdrawal amounts; always fetch and use the exact balance.
- When preparing multi-step flows (approve + action), wait for approval confirmation before sending the dependent tx.

## Git/PR Workflow
- Always use PR-based workflow: never push directly to main, and never push feature work to the wrong branch. Open a PR and let CI run.
- Before force-pushing or rebasing, confirm with user.

## Tool Usage Discipline
- Do not repeat the same informational tool call (e.g., lending_positions, compound_positions) within a single turn. Cache results mentally and reuse.
- If a tool returns ambiguous or empty data, verify once with a different method; do not enter polling loops without user consent.

## Security Incident Response Tone
- When diagnosing malware/compromise, start with evidence-based scoping before recommending destructive actions (wipe, nuke, rotate-all). Never delete evidence files before reading them.
