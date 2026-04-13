import { getClient } from "../../data/rpc.js";
import { CONTRACTS, NATIVE_SYMBOL } from "../../config/contracts.js";
import { erc20Abi } from "../../abis/erc20.js";
import { makeTokenAmount, priceTokenAmounts, round } from "../../data/format.js";
import { getTokenPrice } from "../../data/prices.js";
import { getLendingPositions, getLpPositions } from "../positions/index.js";
import { getStakingPositions } from "../staking/index.js";
import { getCompoundPositions } from "../compound/index.js";
import { getBitcoinPortfolio } from "../bitcoin/index.js";
import type { GetPortfolioSummaryArgs } from "./schemas.js";
import type {
  BitcoinPortfolioSlice,
  LendingPositionUnion,
  MultiWalletPortfolioSummary,
  PortfolioSummary,
  SupportedChain,
  TokenAmount,
} from "../../types/index.js";
import { SUPPORTED_CHAINS } from "../../types/index.js";

function zeroNative(wallet: `0x${string}`, chain: SupportedChain): TokenAmount {
  return makeTokenAmount(
    chain,
    "0x0000000000000000000000000000000000000000" as `0x${string}`,
    0n,
    18,
    NATIVE_SYMBOL[chain]
  );
}

async function fetchNativeBalance(wallet: `0x${string}`, chain: SupportedChain): Promise<TokenAmount> {
  const client = getClient(chain);
  const [balance, ethPrice] = await Promise.all([
    client.getBalance({ address: wallet }),
    getTokenPrice(chain, "native"),
  ]);
  return makeTokenAmount(
    chain,
    "0x0000000000000000000000000000000000000000" as `0x${string}`,
    balance,
    18,
    NATIVE_SYMBOL[chain],
    ethPrice
  );
}

async function fetchTopErc20Balances(
  wallet: `0x${string}`,
  chain: SupportedChain
): Promise<TokenAmount[]> {
  const tokens = CONTRACTS[chain].tokens as Record<string, string>;
  const entries = Object.entries(tokens);
  if (entries.length === 0) return [];

  const client = getClient(chain);
  const calls = entries.flatMap(([, addr]) => [
    { address: addr as `0x${string}`, abi: erc20Abi, functionName: "balanceOf" as const, args: [wallet] as const },
    { address: addr as `0x${string}`, abi: erc20Abi, functionName: "decimals" as const },
  ]);
  const results = await client.multicall({ contracts: calls, allowFailure: true });

  const out: TokenAmount[] = [];
  for (let i = 0; i < entries.length; i++) {
    const [symbol, addr] = entries[i];
    const balanceRes = results[i * 2];
    const decimalsRes = results[i * 2 + 1];
    if (balanceRes.status !== "success" || decimalsRes.status !== "success") continue;
    const balance = balanceRes.result as bigint;
    if (balance === 0n) continue;
    const decimals = Number(decimalsRes.result);
    out.push(makeTokenAmount(chain, addr as `0x${string}`, balance, decimals, symbol));
  }

  await priceTokenAmounts(chain, out);
  return out;
}

export async function getPortfolioSummary(
  args: GetPortfolioSummaryArgs
): Promise<PortfolioSummary | MultiWalletPortfolioSummary> {
  if (!args.wallet && !(args.wallets && args.wallets.length > 0) && !(args.bitcoinAddresses && args.bitcoinAddresses.length > 0)) {
    throw new Error("Provide at least one of `wallet`, `wallets`, or `bitcoinAddresses`.");
  }
  const chains = ((args.chains as SupportedChain[] | undefined) ?? [...SUPPORTED_CHAINS]);
  const wallets = args.wallets?.length
    ? (args.wallets as `0x${string}`[])
    : args.wallet
    ? [args.wallet as `0x${string}`]
    : [];
  const bitcoinAddresses = args.bitcoinAddresses ?? [];

  // Bitcoin is a single namespaced fetch shared across the whole report (it isn't
  // per-EVM-wallet). Degrade to an empty slice if mempool.space is unreachable.
  const bitcoinSlice: BitcoinPortfolioSlice | undefined =
    bitcoinAddresses.length > 0
      ? await buildBitcoinSlice(bitcoinAddresses).catch(() => undefined)
      : undefined;
  const bitcoinUsd = round(bitcoinSlice?.totalUsd ?? 0, 2);

  // Bitcoin-only request: no EVM wallet provided, just BTC addresses.
  if (wallets.length === 0) {
    const fakeWallet = "0x0000000000000000000000000000000000000000" as `0x${string}`;
    const perChain: Record<SupportedChain, number> = Object.fromEntries(
      chains.map((c) => [c, 0])
    ) as Record<SupportedChain, number>;
    return {
      wallet: fakeWallet,
      chains,
      walletBalancesUsd: 0,
      lendingNetUsd: 0,
      lpUsd: 0,
      stakingUsd: 0,
      bitcoinUsd,
      totalUsd: bitcoinUsd,
      perChain,
      ...(bitcoinSlice ? { bitcoin: bitcoinSlice } : {}),
      breakdown: { native: [], erc20: [], lending: [], lp: [], staking: [] },
    };
  }

  // Branch: single wallet returns the flat summary; multi-wallet aggregates.
  if (wallets.length === 1) {
    const summary = await buildWalletSummary(wallets[0], chains);
    return attachBitcoinToSingle(summary, bitcoinSlice, bitcoinUsd);
  }

  const perWallet = await Promise.all(wallets.map((w) => buildWalletSummary(w, chains)));
  const evmTotal = perWallet.reduce((s, p) => s + p.totalUsd, 0);
  const totalUsd = round(evmTotal + bitcoinUsd, 2);
  const walletBalancesUsd = round(perWallet.reduce((s, p) => s + p.walletBalancesUsd, 0), 2);
  const lendingNetUsd = round(perWallet.reduce((s, p) => s + p.lendingNetUsd, 0), 2);
  const lpUsd = round(perWallet.reduce((s, p) => s + p.lpUsd, 0), 2);
  const stakingUsd = round(perWallet.reduce((s, p) => s + p.stakingUsd, 0), 2);
  const perChain: Record<SupportedChain, number> = Object.fromEntries(
    chains.map((c) => [c, 0])
  ) as Record<SupportedChain, number>;
  for (const p of perWallet) {
    for (const c of chains) {
      perChain[c] = round((perChain[c] ?? 0) + (p.perChain[c] ?? 0), 2);
    }
  }
  return {
    wallets,
    chains,
    totalUsd,
    walletBalancesUsd,
    lendingNetUsd,
    lpUsd,
    stakingUsd,
    bitcoinUsd,
    perChain,
    ...(bitcoinSlice ? { bitcoin: bitcoinSlice } : {}),
    perWallet,
  };
}

async function buildBitcoinSlice(addresses: string[]): Promise<BitcoinPortfolioSlice> {
  const portfolio = await getBitcoinPortfolio({ addresses });
  return {
    addresses: portfolio.addresses,
    balances: portfolio.balances.map((b) => ({
      address: b.address,
      amountSats: b.amountSats,
      formattedBtc: b.formattedBtc,
      valueUsd: b.valueUsd !== undefined ? round(b.valueUsd, 2) : undefined,
    })),
    totalSats: portfolio.totalSats,
    totalBtc: portfolio.totalBtc,
    totalUsd: round(portfolio.totalUsd ?? 0, 2),
    priceUsd: portfolio.priceUsd,
  };
}

function attachBitcoinToSingle(
  summary: PortfolioSummary,
  bitcoinSlice: BitcoinPortfolioSlice | undefined,
  bitcoinUsd: number
): PortfolioSummary {
  summary.bitcoinUsd = bitcoinUsd;
  summary.totalUsd = round(summary.totalUsd + bitcoinUsd, 2);
  if (bitcoinSlice) summary.bitcoin = bitcoinSlice;
  return summary;
}

async function buildWalletSummary(
  wallet: `0x${string}`,
  chains: SupportedChain[]
): Promise<PortfolioSummary> {
  // Each subquery is independent — one failing shouldn't kill the summary. We swap
  // Promise.all for per-task catchers that return empty payloads on error, so a flaky
  // Aave read (say, "returned no data") still lets us report native + ERC-20 + LP totals.
  // Morpho Blue is deliberately NOT included here: it requires caller-supplied marketIds
  // (Blue has no on-chain enumeration of a user's markets). Surface Morpho via the
  // dedicated get_morpho_positions tool instead.
  const emptyPositions = { wallet, positions: [] as never[] };
  const [nativeAmounts, erc20Amounts, aave, compound, lp, staking] = await Promise.all([
    Promise.all(
      chains.map((c) =>
        fetchNativeBalance(wallet, c).catch(() => zeroNative(wallet, c))
      )
    ),
    Promise.all(chains.map((c) => fetchTopErc20Balances(wallet, c).catch(() => []))),
    getLendingPositions({ wallet, chains }).catch(() => emptyPositions as never),
    getCompoundPositions({ wallet, chains }).catch(() => emptyPositions as never),
    getLpPositions({ wallet, chains }).catch(() => emptyPositions as never),
    getStakingPositions({ wallet, chains }).catch(() => emptyPositions as never),
  ]);

  // Filter zero native balances out.
  const native = nativeAmounts.filter((a) => a.amount !== "0");
  const erc20 = erc20Amounts.flat();

  // Merge Aave + Compound into a single lending bucket — they both carry `chain` and
  // `netValueUsd`, which is all the summary math needs.
  const lendingPositions: LendingPositionUnion[] = [
    ...aave.positions,
    ...compound.positions,
  ];

  const walletBalancesUsd = round(
    [...native, ...erc20].reduce((sum, t) => sum + (t.valueUsd ?? 0), 0),
    2
  );
  const lendingNetUsd = round(
    lendingPositions.reduce((sum, p) => sum + p.netValueUsd, 0),
    2
  );
  const lpUsd = round(lp.positions.reduce((sum, p) => sum + p.totalValueUsd, 0), 2);
  const stakingUsd = round(
    staking.positions.reduce((sum, p) => sum + (p.stakedAmount.valueUsd ?? 0), 0),
    2
  );
  const totalUsd = round(walletBalancesUsd + lendingNetUsd + lpUsd + stakingUsd, 2);

  // Per-chain breakdown (sums everything tagged to each chain).
  const perChain: Record<SupportedChain, number> = Object.fromEntries(
    chains.map((c) => [c, 0])
  ) as Record<SupportedChain, number>;

  chains.forEach((c, i) => {
    const chainNative = nativeAmounts[i]?.valueUsd ?? 0;
    const chainErc20 = erc20Amounts[i].reduce((s, t) => s + (t.valueUsd ?? 0), 0);
    const chainLending = lendingPositions.filter((p) => p.chain === c).reduce((s, p) => s + p.netValueUsd, 0);
    const chainLp = lp.positions.filter((p) => p.chain === c).reduce((s, p) => s + p.totalValueUsd, 0);
    const chainStaking = staking.positions.filter((p) => p.chain === c).reduce((s, p) => s + (p.stakedAmount.valueUsd ?? 0), 0);
    perChain[c] = round(chainNative + chainErc20 + chainLending + chainLp + chainStaking, 2);
  });

  return {
    wallet,
    chains,
    walletBalancesUsd,
    lendingNetUsd,
    lpUsd,
    stakingUsd,
    bitcoinUsd: 0,
    totalUsd,
    perChain,
    breakdown: {
      native,
      erc20,
      lending: lendingPositions,
      lp: lp.positions,
      staking: staking.positions,
    },
  };
}
