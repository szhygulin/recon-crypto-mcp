import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";
import { EVM_ADDRESS } from "../../shared/address-patterns.js";

const evmChainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);

/**
 * `get_safe_positions` accepts at least one of `signerAddress` (discover all
 * Safes the address is an owner of via Safe Transaction Service) or
 * `safeAddress` (direct lookup of one Safe). The "at least one" rule is
 * enforced inside the handler — MCP requires the raw ZodObject here, so we
 * can't `.refine` at the schema root.
 *
 * `chains` defaults to `["ethereum"]` rather than fanning out across all five
 * EVM chains. The Safe Transaction Service is a per-chain authenticated API:
 * fanning out by default would 5x the API-key request budget and surface a
 * pile of "no Safes here" empty results for users who only use mainnet.
 */
export const getSafePositionsInput = z.object({
  signerAddress: z.string().regex(EVM_ADDRESS).optional(),
  safeAddress: z.string().regex(EVM_ADDRESS).optional(),
  chains: z.array(evmChainEnum).min(1).optional(),
});

export type GetSafePositionsArgs = z.infer<typeof getSafePositionsInput>;
