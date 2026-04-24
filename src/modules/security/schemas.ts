import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";
import { EVM_ADDRESS } from "../../shared/address-patterns.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);
const addressSchema = z.string().regex(EVM_ADDRESS);

export const checkContractSecurityInput = z.object({
  address: addressSchema,
  chain: chainEnum,
});

export const checkPermissionRisksInput = z.object({
  address: addressSchema,
  chain: chainEnum,
});

export const getProtocolRiskScoreInput = z.object({
  protocol: z.string().min(1),
});

export type CheckContractSecurityArgs = z.infer<typeof checkContractSecurityInput>;
export type CheckPermissionRisksArgs = z.infer<typeof checkPermissionRisksInput>;
export type GetProtocolRiskScoreArgs = z.infer<typeof getProtocolRiskScoreInput>;
