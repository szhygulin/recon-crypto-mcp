import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";
import { approvalCapSchema } from "../shared/approval.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);
const walletSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const marketIdSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);

export const getMorphoPositionsInput = z.object({
  wallet: walletSchema,
  chain: chainEnum.default("ethereum"),
  /**
   * Morpho Blue market IDs (bytes32 each) to check. If omitted, the server
   * discovers the wallet's markets by scanning Morpho Blue event logs
   * (Supply / Borrow / SupplyCollateral with `onBehalf == wallet`). Pass this
   * explicitly as a fast path when the set of markets is already known —
   * discovery on cold lookups walks from Morpho's deploy block to head in
   * ~10k-block chunks and can take several seconds.
   */
  marketIds: z.array(marketIdSchema).optional(),
});

const baseMarketAction = z.object({
  wallet: walletSchema,
  chain: chainEnum.default("ethereum"),
  marketId: marketIdSchema,
  amount: z
    .string()
    .describe(
      'Human-readable decimal amount, NOT raw wei/base units. ' +
        'Example: "10" for 10 USDC. Pass "max" for full-balance withdraw/repay.'
    ),
});

export const prepareMorphoSupplyInput = baseMarketAction.extend({
  approvalCap: approvalCapSchema,
});
export const prepareMorphoWithdrawInput = baseMarketAction;
export const prepareMorphoBorrowInput = baseMarketAction;
export const prepareMorphoRepayInput = baseMarketAction.extend({
  approvalCap: approvalCapSchema,
});
export const prepareMorphoSupplyCollateralInput = baseMarketAction.extend({
  approvalCap: approvalCapSchema,
});
export const prepareMorphoWithdrawCollateralInput = baseMarketAction;

export type GetMorphoPositionsArgs = z.infer<typeof getMorphoPositionsInput>;
export type PrepareMorphoSupplyArgs = z.infer<typeof prepareMorphoSupplyInput>;
export type PrepareMorphoWithdrawArgs = z.infer<typeof prepareMorphoWithdrawInput>;
export type PrepareMorphoBorrowArgs = z.infer<typeof prepareMorphoBorrowInput>;
export type PrepareMorphoRepayArgs = z.infer<typeof prepareMorphoRepayInput>;
export type PrepareMorphoSupplyCollateralArgs = z.infer<typeof prepareMorphoSupplyCollateralInput>;
export type PrepareMorphoWithdrawCollateralArgs = z.infer<
  typeof prepareMorphoWithdrawCollateralInput
>;
