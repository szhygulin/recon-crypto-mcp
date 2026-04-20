import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);

export const getMarketIncidentStatusInput = z.object({
  protocol: z
    .enum(["compound-v3", "aave-v3"])
    .describe(
      "Lending protocol to scan. compound-v3 flags per-Comet pause + utilization. aave-v3 flags per-reserve isPaused/isFrozen/!isActive + utilization. Morpho Blue has no core-protocol pause and is not supported."
    ),
  chain: chainEnum
    .default("ethereum")
    .describe("EVM chain to scan. Defaults to ethereum."),
});

export type GetMarketIncidentStatusArgs = z.infer<typeof getMarketIncidentStatusInput>;
