import { z } from "zod";
import { getTokenPrice } from "../../data/prices.js";
import { SUPPORTED_CHAINS, type SupportedChain } from "../../types/index.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);
const tokenSchema = z.union([
  z.literal("native"),
  z.string().regex(/^0x[a-fA-F0-9]{40}$/),
]);

export const getTokenPriceInput = z.object({
  chain: chainEnum,
  token: tokenSchema,
});

export type GetTokenPriceArgs = z.infer<typeof getTokenPriceInput>;

export async function getTokenPriceTool(args: GetTokenPriceArgs) {
  const chain = args.chain as SupportedChain;
  const token = args.token as "native" | `0x${string}`;
  const priceUsd = await getTokenPrice(chain, token);
  if (priceUsd === undefined) {
    throw new Error(
      `No DefiLlama price found for ${token} on ${chain}. The token may be unlisted, illiquid, or the address may be wrong.`
    );
  }
  return { chain, token, priceUsd, source: "defillama" as const };
}
