import type { HistoryItem, SuspectedPoisoning } from "./schemas.js";

const EVM_ADDRESS_RE = /^0x[a-f0-9]{40}$/i;
const DUST_NATIVE_WEI = 10_000_000_000n;
const DUST_USD_THRESHOLD = 0.01;

function suffixKey(addr: string): string | null {
  if (!EVM_ADDRESS_RE.test(addr)) return null;
  const lower = addr.toLowerCase();
  const hex = lower.slice(2);
  return hex.slice(0, 4) + hex.slice(-4);
}

function counterpartyOf(item: HistoryItem, walletLower: string): string {
  const fromLower = item.from.toLowerCase();
  return fromLower === walletLower ? item.to : item.from;
}

function isDust(item: HistoryItem): boolean {
  if (item.type === "external" || item.type === "internal") {
    if (item.valueUsd !== undefined && item.valueUsd <= DUST_USD_THRESHOLD) return true;
    try {
      return BigInt(item.valueNative) <= DUST_NATIVE_WEI;
    } catch {
      return false;
    }
  }
  if (item.type === "token_transfer") {
    if (item.valueUsd !== undefined && item.valueUsd <= DUST_USD_THRESHOLD) return true;
    return item.amount === "0";
  }
  return false;
}

export function annotateSuspectedPoisoning(
  items: HistoryItem[],
  wallet: string
): void {
  // Skip non-EVM addresses; vanity-suffix logic is hex-only.
  if (!EVM_ADDRESS_RE.test(wallet)) return;

  const walletLower = wallet.toLowerCase();
  const walletSuffix = suffixKey(wallet);

  // Map suffix -> set of distinct counterparty addresses (lowercased) seen.
  // Used to detect vanity-suffix collisions across different counterparties.
  const suffixToCounterparties = new Map<string, Set<string>>();
  for (const item of items) {
    const cp = counterpartyOf(item, walletLower);
    const key = suffixKey(cp);
    if (!key) continue;
    const cpLower = cp.toLowerCase();
    if (cpLower === walletLower) continue;
    let bucket = suffixToCounterparties.get(key);
    if (!bucket) {
      bucket = new Set<string>();
      suffixToCounterparties.set(key, bucket);
    }
    bucket.add(cpLower);
  }

  for (const item of items) {
    const reasons: SuspectedPoisoning["reasons"] = [];
    let mimics: string | undefined;

    if (item.type === "token_transfer" && item.amount === "0") {
      reasons.push("zero_amount_transfer");
    }

    const cp = counterpartyOf(item, walletLower);
    const cpLower = cp.toLowerCase();
    const cpKey = suffixKey(cp);

    if (cpKey && cpLower !== walletLower && isDust(item)) {
      const bucket = suffixToCounterparties.get(cpKey);
      if (bucket && bucket.size > 1) {
        let legit: string | undefined;
        for (const addr of bucket) {
          if (addr !== cpLower) {
            legit = addr;
            break;
          }
        }
        if (legit) {
          reasons.push("vanity_suffix_lookalike");
          mimics = legit;
        }
      }

      if (walletSuffix && cpKey === walletSuffix) {
        reasons.push("self_suffix_lookalike");
        if (!mimics) mimics = walletLower;
      }
    }

    if (reasons.length > 0) {
      item.suspectedPoisoning = mimics
        ? { reasons, mimics }
        : { reasons };
    }
  }
}
