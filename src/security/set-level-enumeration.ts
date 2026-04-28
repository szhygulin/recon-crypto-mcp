/**
 * Renderer for the `[SET-LEVEL ENUMERATION]` text block emitted on
 * every `get_token_allowances` response. Required by skill v8's
 * Invariant #14 (set-level intent verification). A missing block is
 * an Invariant #4 compromise signal — the agent treats absence as
 * evidence the MCP silently filtered the row set.
 *
 * Pure function over the existing `GetTokenAllowancesResult` shape;
 * no I/O. Exported so the wrapper handler in `src/index.ts` and the
 * unit test can both consume it without coupling.
 */

import type { GetTokenAllowancesResult } from "../modules/allowances/schemas.js";

export function renderSetLevelEnumeration(
  payload: GetTokenAllowancesResult,
): string {
  const lines: string[] = [];
  lines.push("[SET-LEVEL ENUMERATION]");
  lines.push("");
  lines.push(`- **Wallet:** \`${payload.wallet}\``);
  lines.push(
    `- **Token:** ${payload.token.symbol} (\`${payload.token.address}\`) on ${payload.chain}`,
  );
  lines.push(
    `- **Active non-zero allowances:** ${payload.allowances.length} (${payload.unlimitedCount} unlimited)`,
  );
  if (payload.truncated) {
    lines.push(
      "- ⚠ **Indexer truncation flag set** — Etherscan row cap hit; the list below may be incomplete.",
    );
  }
  lines.push("");
  if (payload.allowances.length === 0) {
    lines.push("_No active allowances on this (wallet, token, chain) tuple._");
  } else {
    lines.push("| # | Spender | Label | Current allowance | Unlimited | Last approved |");
    lines.push("|---|---------|-------|-------------------|-----------|---------------|");
    payload.allowances.forEach((row, i) => {
      const label = row.spenderLabel ?? "(unlabeled)";
      const unlimited = row.isUnlimited ? "**YES**" : "no";
      const lastApproved = row.lastApprovedAt ?? `block ${row.lastApprovedBlock}`;
      lines.push(
        `| ${i} | \`${row.spender}\` | ${label} | ${row.currentAllowanceFormatted} | ${unlimited} | ${lastApproved} |`,
      );
    });
  }
  lines.push("");
  lines.push(
    "Per Invariant #14 (set-level intent verification): surface this enumeration verbatim to the user. The user — not the agent — picks which row to revoke. Do NOT filter or recommend.",
  );
  return lines.join("\n");
}
