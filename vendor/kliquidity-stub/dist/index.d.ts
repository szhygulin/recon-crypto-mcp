import Decimal from "decimal.js";
import BN from "bn.js";

export declare const ZERO: Decimal;
export declare const ZERO_BN: BN;
export declare const DECIMALS_SOL: 9;
export declare const FullBPS: 10000;
export declare const FullBPSDecimal: Decimal;

export declare function aprToApy(apr: Decimal, compoundPeriods: number): Decimal;
export declare function chunks<T>(array: T[], size: number): T[][];
export declare function batchFetch<T, R>(
    addresses: T[],
    fetchBatch: (chunk: T[]) => Promise<R[]>,
    chunkSize?: number,
): Promise<R[]>;
export declare function collToLamportsDecimal(amount: Decimal, decimals: number): Decimal;

export declare class Kamino {
    constructor(...args: unknown[]);
}

export type KaminoPrices = unknown;
