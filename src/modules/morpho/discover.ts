import { parseAbiItem } from "viem";
import { getClient } from "../../data/rpc.js";
import { CONTRACTS } from "../../config/contracts.js";
import type { SupportedChain } from "../../types/index.js";

/**
 * Morpho Blue deployment block per chain. We only start the log scan from
 * here — scanning back to genesis is a multi-million-block waste on mainnet.
 */
const MORPHO_DEPLOYMENT_BLOCK: Partial<Record<SupportedChain, bigint>> = {
  ethereum: 18883124n,
};

/**
 * Most public RPC providers (Alchemy/Infura free tier, public nodes) cap
 * `eth_getLogs` at 10k blocks per request. Users on premium endpoints with
 * higher caps can override via MORPHO_DISCOVERY_CHUNK.
 */
const SCAN_CHUNK: bigint = (() => {
  const raw = process.env.MORPHO_DISCOVERY_CHUNK;
  if (!raw) return 10_000n;
  const parsed = BigInt(raw);
  return parsed > 0n ? parsed : 10_000n;
})();

/**
 * Position-opening events: a wallet's set of active markets is a subset of
 * the markets it has ever opened into. Closed positions drop out later when
 * readMarketPosition sees zero shares/collateral. Withdraw/Repay/Liquidate
 * never introduce a fresh market, so we don't scan them.
 *
 * In Morpho Blue, `onBehalf` is indexed on all three, which means the RPC
 * does the filter server-side via topic3 (or topic2 for Borrow — viem maps
 * named args to the correct topic slot automatically).
 */
const supplyEvent = parseAbiItem(
  "event Supply(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares)"
);
const borrowEvent = parseAbiItem(
  "event Borrow(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)"
);
const supplyCollateralEvent = parseAbiItem(
  "event SupplyCollateral(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets)"
);

function morphoAddress(chain: SupportedChain): `0x${string}` | null {
  const entry = (CONTRACTS as Record<string, Record<string, Record<string, string>>>)[chain]
    ?.morpho;
  const addr = entry?.blue;
  return (addr as `0x${string}` | undefined) ?? null;
}

/**
 * Discover every Morpho Blue marketId the wallet has ever opened a position
 * in (as `onBehalf`) on a single chain. Returns unique ids; callers should
 * treat these as candidates and re-read live state via `readMarketPosition`
 * to filter out closed positions.
 *
 * Returns `[]` for chains with no Morpho Blue deployment.
 */
export async function discoverMorphoMarketIds(
  wallet: `0x${string}`,
  chain: SupportedChain
): Promise<`0x${string}`[]> {
  const morpho = morphoAddress(chain);
  const deploymentBlock = MORPHO_DEPLOYMENT_BLOCK[chain];
  if (!morpho || deploymentBlock === undefined) return [];

  const client = getClient(chain);
  const latest = await client.getBlockNumber();

  const ids = new Set<`0x${string}`>();

  for (let from = deploymentBlock; from <= latest; from += SCAN_CHUNK) {
    const to = from + SCAN_CHUNK - 1n > latest ? latest : from + SCAN_CHUNK - 1n;
    const [supplyLogs, borrowLogs, collateralLogs] = await Promise.all([
      client.getLogs({
        address: morpho,
        event: supplyEvent,
        args: { onBehalf: wallet },
        fromBlock: from,
        toBlock: to,
      }),
      client.getLogs({
        address: morpho,
        event: borrowEvent,
        args: { onBehalf: wallet },
        fromBlock: from,
        toBlock: to,
      }),
      client.getLogs({
        address: morpho,
        event: supplyCollateralEvent,
        args: { onBehalf: wallet },
        fromBlock: from,
        toBlock: to,
      }),
    ]);

    for (const log of [...supplyLogs, ...borrowLogs, ...collateralLogs]) {
      const id = (log.args as { id?: `0x${string}` }).id;
      if (id) ids.add(id);
    }
  }

  return Array.from(ids);
}
