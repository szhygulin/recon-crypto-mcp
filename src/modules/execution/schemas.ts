import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);
const walletSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const dataSchema = z.string().regex(/^0x[a-fA-F0-9]*$/);

export const pairLedgerLiveInput = z.object({});

export const getLedgerStatusInput = z.object({});

const baseAaveAction = z.object({
  wallet: walletSchema,
  chain: chainEnum.default("ethereum"),
  asset: addressSchema,
  amount: z
    .string()
    .describe(
      'Human-readable decimal amount of `asset`, NOT raw wei/base units. ' +
        'Example: "1.5" for 1.5 USDC, "0.01" for 0.01 ETH. Pass "max" for full-balance withdraw/repay.'
    ),
});

export const prepareAaveSupplyInput = baseAaveAction;
export const prepareAaveWithdrawInput = baseAaveAction;
export const prepareAaveBorrowInput = baseAaveAction.extend({
  interestRateMode: z.enum(["stable", "variable"]).default("variable"),
});
export const prepareAaveRepayInput = baseAaveAction.extend({
  interestRateMode: z.enum(["stable", "variable"]).default("variable"),
});

export const prepareLidoStakeInput = z.object({
  wallet: walletSchema,
  amountEth: z
    .string()
    .describe('Human-readable ETH amount, NOT raw wei. Example: "0.5" for 0.5 ETH.'),
});
export const prepareLidoUnstakeInput = z.object({
  wallet: walletSchema,
  amountStETH: z
    .string()
    .describe(
      'Human-readable stETH amount, NOT raw wei. Example: "0.5" for 0.5 stETH (18 decimals).'
    ),
});

export const prepareEigenLayerDepositInput = z.object({
  wallet: walletSchema,
  strategy: addressSchema,
  token: addressSchema,
  amount: z
    .string()
    .describe(
      'Human-readable decimal amount of `token`, NOT raw wei/base units. Example: "0.5" for 0.5 stETH.'
    ),
});

export const prepareNativeSendInput = z.object({
  wallet: walletSchema,
  chain: chainEnum.default("ethereum"),
  to: addressSchema,
  amount: z
    .string()
    .describe(
      'Human-readable native-asset amount, NOT raw wei. Example: "0.5" for 0.5 ETH (or 0.5 MATIC on polygon).'
    ),
});

export const prepareTokenSendInput = z.object({
  wallet: walletSchema,
  chain: chainEnum.default("ethereum"),
  token: addressSchema,
  to: addressSchema,
  amount: z
    .string()
    .describe(
      'Human-readable decimal amount, NOT raw wei/base units. Example: "10" for 10 USDC. ' +
        'Decimals resolved from the token contract. Pass "max" to send the full balance.'
    ),
});

export const sendTransactionInput = z.object({
  chain: chainEnum,
  to: addressSchema,
  data: dataSchema,
  value: z
    .string()
    .default("0")
    .describe(
      'Native-asset value attached to the call, in raw wei as a decimal string (e.g. "1000000000000000000" = 1 ETH). ' +
        "This is the raw calldata `value` field — not human-readable. Usually comes from a prepare_* tool verbatim."
    ),
  from: walletSchema.optional(),
  /** Gate: the model must explicitly confirm on the user's behalf that the preview was acknowledged. */
  confirmed: z.literal(true),
});

export const getTransactionStatusInput = z.object({
  chain: chainEnum,
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
});

export type PrepareAaveSupplyArgs = z.infer<typeof prepareAaveSupplyInput>;
export type PrepareAaveWithdrawArgs = z.infer<typeof prepareAaveWithdrawInput>;
export type PrepareAaveBorrowArgs = z.infer<typeof prepareAaveBorrowInput>;
export type PrepareAaveRepayArgs = z.infer<typeof prepareAaveRepayInput>;
export type PrepareLidoStakeArgs = z.infer<typeof prepareLidoStakeInput>;
export type PrepareLidoUnstakeArgs = z.infer<typeof prepareLidoUnstakeInput>;
export type PrepareEigenLayerDepositArgs = z.infer<typeof prepareEigenLayerDepositInput>;
export type PrepareNativeSendArgs = z.infer<typeof prepareNativeSendInput>;
export type PrepareTokenSendArgs = z.infer<typeof prepareTokenSendInput>;
export type SendTransactionArgs = z.infer<typeof sendTransactionInput>;
export type GetTransactionStatusArgs = z.infer<typeof getTransactionStatusInput>;
