import { getAddress, zeroAddress } from "viem";
import { getClient } from "./rpc.js";
import type { SupportedChain } from "../types/index.js";

export const EIP1967_IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;
export const EIP1967_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as const;

export async function readAddressFromSlot(
  chain: SupportedChain,
  address: `0x${string}`,
  slot: `0x${string}`
): Promise<`0x${string}` | undefined> {
  const client = getClient(chain);
  try {
    const raw = await client.getStorageAt({ address, slot });
    if (!raw || raw === "0x" || raw.length < 66) return undefined;
    const addr = `0x${raw.slice(26)}` as `0x${string}`;
    if (addr === zeroAddress) return undefined;
    return getAddress(addr) as `0x${string}`;
  } catch {
    return undefined;
  }
}

export async function readEip1967Implementation(
  chain: SupportedChain,
  address: `0x${string}`
): Promise<`0x${string}` | undefined> {
  return readAddressFromSlot(chain, address, EIP1967_IMPL_SLOT);
}

export async function readEip1967Admin(
  chain: SupportedChain,
  address: `0x${string}`
): Promise<`0x${string}` | undefined> {
  return readAddressFromSlot(chain, address, EIP1967_ADMIN_SLOT);
}
