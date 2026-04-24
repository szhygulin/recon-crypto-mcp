import { getAddress } from "viem";
import type { TokenAmount, SupportedChain } from "../types/index.js";
import { getTokenPrices } from "./prices.js";

/** Round a number to N decimal places without trailing zeros. */
export function round(n: number, places = 6): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/**
 * Decimal-string rendering of a fixed-point integer amount. Chain-neutral —
 * works identically for EVM wei, Solana lamports, TRON sun, SPL token raw
 * amounts. Negative-aware so it's safe for balance deltas (e.g. history
 * modules' signed-delta rows) as well as pure balance reads.
 *
 * Trailing zeros in the fractional part are trimmed (`1.500` → `1.5`);
 * a zero fractional drops the dot entirely (`1.000` → `1`). Matches the
 * shape callers expect when feeding the result into `Number(...)` or
 * rendering to the user.
 *
 * Before consolidation six near-identical copies lived in Solana, TRON,
 * history, and compound modules — any tightening meant a find-and-replace
 * sweep. Single source now.
 */
export function formatUnits(amount: bigint, decimals: number): string {
  if (decimals === 0) return amount.toString();
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const s = abs.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  const out = frac.length > 0 ? `${whole}.${frac}` : whole;
  return negative ? `-${out}` : out;
}

/**
 * Variant that accepts the amount as a decimal-digit string (as returned
 * by explorer-style APIs — Etherscan, Tronscan, wallet-indexer JSON). If
 * `raw` isn't a run of ASCII digits, returns `"0"` rather than throwing —
 * preserves the existing safety net against upstream APIs returning `null`,
 * `"0x..."`, or an empty string, which the history modules relied on.
 */
export function formatUnitsFromDecimalString(raw: string, decimals: number): string {
  if (!/^\d+$/.test(raw)) return "0";
  return formatUnits(BigInt(raw), decimals);
}

export function makeTokenAmount(
  chain: SupportedChain,
  address: `0x${string}`,
  amountWei: bigint,
  decimals: number,
  symbol: string,
  priceUsd?: number
): TokenAmount {
  const formatted = formatUnits(amountWei, decimals);
  const numeric = Number(formatted);
  const valueUsd = priceUsd !== undefined ? round(numeric * priceUsd, 2) : undefined;
  const t: TokenAmount = {
    token: getAddress(address) as `0x${string}`,
    symbol,
    decimals,
    amount: amountWei.toString(),
    formatted,
    priceUsd,
    valueUsd,
  };
  if (priceUsd === undefined && amountWei > 0n) t.priceMissing = true;
  return t;
}

/** Price up a list of token amounts in one batched call. Mutates in place. */
export async function priceTokenAmounts(
  chain: SupportedChain,
  amounts: TokenAmount[]
): Promise<void> {
  if (amounts.length === 0) return;
  const queries = amounts.map((a) => ({ chain, address: a.token }));
  const prices = await getTokenPrices(queries);
  for (const a of amounts) {
    const key = `${chain}:${a.token.toLowerCase()}`;
    const p = prices.get(key);
    if (p !== undefined) {
      a.priceUsd = p;
      a.valueUsd = round(Number(a.formatted) * p, 2);
      delete a.priceMissing;
    } else if (BigInt(a.amount) > 0n) {
      a.priceMissing = true;
    }
  }
}
