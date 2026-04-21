import { getAaveLendingPosition, simulateHealthFactorChange } from "./aave.js";
import { getUniswapPositions } from "./uniswap.js";
import { getCompoundPositions } from "../compound/index.js";
import { getCompoundMarketInfo } from "../compound/market-info.js";
import { getMorphoPositions } from "../morpho/index.js";
import type {
  GetLendingPositionsArgs,
  GetLpPositionsArgs,
  GetHealthAlertsArgs,
  SimulatePositionChangeArgs,
} from "./schemas.js";
import type { LendingPosition, LPPosition, SupportedChain } from "../../types/index.js";
import { SUPPORTED_CHAINS } from "../../types/index.js";

function resolveChains(chains?: string[]): SupportedChain[] {
  return (chains as SupportedChain[] | undefined) ?? [...SUPPORTED_CHAINS];
}

export async function getLendingPositions(args: GetLendingPositionsArgs): Promise<{
  wallet: string;
  positions: LendingPosition[];
}> {
  const wallet = args.wallet as `0x${string}`;
  const chains = resolveChains(args.chains);
  const results = await Promise.all(chains.map((c) => getAaveLendingPosition(wallet, c)));
  return { wallet, positions: results.filter((p): p is LendingPosition => p !== null) };
}

export async function getLpPositions(args: GetLpPositionsArgs): Promise<{
  wallet: string;
  positions: LPPosition[];
}> {
  const wallet = args.wallet as `0x${string}`;
  const chains = resolveChains(args.chains);
  const perChain = await Promise.all(chains.map((c) => getUniswapPositions(wallet, c)));
  return { wallet, positions: perChain.flat() };
}

export async function getHealthAlerts(args: GetHealthAlertsArgs): Promise<{
  wallet: string;
  threshold: number;
  atRisk: Array<{
    chain: SupportedChain;
    healthFactor: number;
    collateralUsd: number;
    debtUsd: number;
    marginToLiquidation: number;
  }>;
}> {
  const threshold = args.threshold ?? 1.5;
  const { positions, wallet } = await getLendingPositions({ wallet: args.wallet, chains: undefined });
  const atRisk = positions
    .filter((p) => p.healthFactor < threshold && p.totalDebtUsd > 0)
    .map((p) => ({
      chain: p.chain,
      healthFactor: p.healthFactor,
      collateralUsd: p.totalCollateralUsd,
      debtUsd: p.totalDebtUsd,
      // Margin is the % HF would need to drop by to hit 1.0.
      marginToLiquidation: Math.max(0, Math.round(((p.healthFactor - 1) / p.healthFactor) * 10000) / 100),
    }));
  return { wallet, threshold, atRisk };
}

export async function simulatePositionChange(args: SimulatePositionChangeArgs): Promise<{
  wallet: string;
  chain: SupportedChain;
  protocol: "aave-v3" | "compound-v3" | "morpho-blue";
  action: string;
  before: { healthFactor: number; collateralUsd: number; debtUsd: number };
  after: { healthFactor: number; collateralUsd: number; debtUsd: number; safe: boolean };
}> {
  const wallet = args.wallet as `0x${string}`;
  const chain = (args.chain ?? "ethereum") as SupportedChain;
  const protocol = args.protocol ?? "aave-v3";

  if (protocol === "aave-v3") {
    const base = await getAaveLendingPosition(wallet, chain);
    if (!base) {
      throw new Error(`Wallet ${wallet} has no Aave V3 position on ${chain}.`);
    }
    const sim = simulateHealthFactorChange(base, args.action, args.amountUsd);
    return {
      wallet,
      chain,
      protocol,
      action: args.action,
      before: {
        healthFactor: base.healthFactor,
        collateralUsd: base.totalCollateralUsd,
        debtUsd: base.totalDebtUsd,
      },
      after: {
        healthFactor: sim.newHealthFactor,
        collateralUsd: sim.newCollateralUsd,
        debtUsd: sim.newDebtUsd,
        safe: sim.safe,
      },
    };
  }

  if (protocol === "compound-v3") {
    if (!args.market) {
      throw new Error(
        `simulate_position_change for compound-v3 requires \`market\` (the Comet market address).`
      );
    }
    const market = args.market as `0x${string}`;
    const [{ positions }, info] = await Promise.all([
      getCompoundPositions({ wallet: args.wallet, chains: [chain] }),
      getCompoundMarketInfo({ chain, market }),
    ]);
    const pos = positions.find(
      (p) => p.chain === chain && p.marketAddress.toLowerCase() === market.toLowerCase()
    );
    if (!pos) {
      throw new Error(
        `Wallet ${wallet} has no Compound V3 position in market ${market} on ${chain}.`
      );
    }
    // Comet's liquidation rule: sum(collateral_i × liquidateCF_i) ≥ baseBorrowed.
    // Reproduce that as a 1-to-1 health factor.
    const cfByAsset = new Map<string, number>();
    for (const c of info.collateralAssets) {
      cfByAsset.set(
        c.asset.toLowerCase(),
        Number(c.liquidateCollateralFactor) / 1e18
      );
    }
    const liquidationCollateralUsd = pos.collateral.reduce((sum, t) => {
      const cf = cfByAsset.get(t.token.toLowerCase()) ?? 0;
      return sum + (t.valueUsd ?? 0) * cf;
    }, 0);
    const beforeDebt = pos.totalDebtUsd;
    const beforeHF =
      beforeDebt === 0 ? Number.POSITIVE_INFINITY : liquidationCollateralUsd / beforeDebt;

    // Apply delta. For add/remove_collateral, use the asset-specific CF when
    // `asset` was passed and resolves to a known collateral; otherwise weighted
    // average across existing collaterals.
    const weightedAvgCF =
      pos.totalCollateralUsd > 0
        ? liquidationCollateralUsd / pos.totalCollateralUsd
        : 0;
    const argAssetCF =
      args.asset && cfByAsset.has(args.asset.toLowerCase())
        ? cfByAsset.get(args.asset.toLowerCase())!
        : weightedAvgCF;

    let newCollateralUsd = pos.totalCollateralUsd;
    let newLiquidationCollateralUsd = liquidationCollateralUsd;
    let newDebt = beforeDebt;
    switch (args.action) {
      case "add_collateral":
        newCollateralUsd += args.amountUsd;
        newLiquidationCollateralUsd += args.amountUsd * argAssetCF;
        break;
      case "remove_collateral":
        newCollateralUsd = Math.max(0, newCollateralUsd - args.amountUsd);
        newLiquidationCollateralUsd = Math.max(
          0,
          newLiquidationCollateralUsd - args.amountUsd * argAssetCF
        );
        break;
      case "borrow":
        newDebt += args.amountUsd;
        break;
      case "repay":
        newDebt = Math.max(0, newDebt - args.amountUsd);
        break;
    }
    const afterHF =
      newDebt === 0 ? Number.POSITIVE_INFINITY : newLiquidationCollateralUsd / newDebt;

    return {
      wallet,
      chain,
      protocol,
      action: args.action,
      before: {
        healthFactor: beforeHF === Number.POSITIVE_INFINITY ? 1e18 : Math.round(beforeHF * 10000) / 10000,
        collateralUsd: pos.totalCollateralUsd,
        debtUsd: beforeDebt,
      },
      after: {
        healthFactor: afterHF === Number.POSITIVE_INFINITY ? 1e18 : Math.round(afterHF * 10000) / 10000,
        collateralUsd: Math.round(newCollateralUsd * 100) / 100,
        debtUsd: Math.round(newDebt * 100) / 100,
        safe: afterHF > 1.0,
      },
    };
  }

  // morpho-blue
  if (!args.marketId) {
    throw new Error(
      `simulate_position_change for morpho-blue requires \`marketId\` (bytes32).`
    );
  }
  const marketId = args.marketId as `0x${string}`;
  const { positions } = await getMorphoPositions({
    wallet: args.wallet,
    chain,
    marketIds: [marketId],
  });
  const pos = positions.find((p) => p.marketId.toLowerCase() === marketId.toLowerCase());
  if (!pos) {
    throw new Error(
      `Wallet ${wallet} has no Morpho Blue position in market ${marketId} on ${chain}.`
    );
  }
  // Morpho: liquidation when collateralUsd × lltv < borrowedUsd. lltv is a
  // 1e18-scaled fraction. Health = (collat × lltv) / debt.
  const lltvFraction = Number(pos.lltv) / 1e18;
  const beforeHF =
    pos.totalDebtUsd === 0
      ? Number.POSITIVE_INFINITY
      : (pos.totalCollateralUsd * lltvFraction) / pos.totalDebtUsd;

  let newCollateralUsd = pos.totalCollateralUsd;
  let newDebt = pos.totalDebtUsd;
  switch (args.action) {
    case "add_collateral":
      newCollateralUsd += args.amountUsd;
      break;
    case "remove_collateral":
      newCollateralUsd = Math.max(0, newCollateralUsd - args.amountUsd);
      break;
    case "borrow":
      newDebt += args.amountUsd;
      break;
    case "repay":
      newDebt = Math.max(0, newDebt - args.amountUsd);
      break;
  }
  const afterHF =
    newDebt === 0
      ? Number.POSITIVE_INFINITY
      : (newCollateralUsd * lltvFraction) / newDebt;

  return {
    wallet,
    chain,
    protocol,
    action: args.action,
    before: {
      healthFactor: beforeHF === Number.POSITIVE_INFINITY ? 1e18 : Math.round(beforeHF * 10000) / 10000,
      collateralUsd: pos.totalCollateralUsd,
      debtUsd: pos.totalDebtUsd,
    },
    after: {
      healthFactor: afterHF === Number.POSITIVE_INFINITY ? 1e18 : Math.round(afterHF * 10000) / 10000,
      collateralUsd: Math.round(newCollateralUsd * 100) / 100,
      debtUsd: Math.round(newDebt * 100) / 100,
      safe: afterHF > 1.0,
    },
  };
}
