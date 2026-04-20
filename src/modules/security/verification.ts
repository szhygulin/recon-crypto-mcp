import { getAddress } from "viem";
import { getContractInfo } from "../../data/apis/etherscan.js";
import { readEip1967Admin, readEip1967Implementation } from "../../data/proxy.js";
import type { SecurityReport, SupportedChain } from "../../types/index.js";

const DANGEROUS_FUNCTION_NAMES = new Set([
  "mint",
  "pause",
  "unpause",
  "upgradeTo",
  "upgradeToAndCall",
  "setAdmin",
  "transferOwnership",
  "setImplementation",
  "changeAdmin",
  "setPause",
]);

/** Scan an ABI for dangerous function signatures. */
export function scanAbiForDangerousFunctions(abi: unknown[] | undefined): string[] {
  if (!abi) return [];
  const found: string[] = [];
  for (const item of abi) {
    if (typeof item !== "object" || !item) continue;
    const it = item as { type?: string; name?: string };
    if (it.type === "function" && it.name && DANGEROUS_FUNCTION_NAMES.has(it.name)) {
      found.push(it.name);
    }
  }
  return found;
}

export async function checkContractSecurity(
  address: `0x${string}`,
  chain: SupportedChain
): Promise<SecurityReport> {
  const [info, eipImpl, eipAdmin] = await Promise.all([
    getContractInfo(address, chain),
    readEip1967Implementation(chain, address),
    readEip1967Admin(chain, address),
  ]);

  const isProxy = info.isProxy || eipImpl !== undefined;
  const implementation = info.implementation ?? eipImpl;

  // If proxy, also check the implementation's ABI for dangerous functions.
  let dangerousFns = scanAbiForDangerousFunctions(info.abi);
  if (isProxy && implementation) {
    try {
      const implInfo = await getContractInfo(implementation, chain);
      dangerousFns = [
        ...new Set([...dangerousFns, ...scanAbiForDangerousFunctions(implInfo.abi)]),
      ];
    } catch {
      // ignore
    }
  }

  return {
    address: getAddress(address) as `0x${string}`,
    chain,
    isVerified: info.isVerified,
    isProxy,
    implementation,
    admin: eipAdmin,
    dangerousFunctions: dangerousFns,
    privilegedRoles: [], // populated by permissions module when requested
  };
}
