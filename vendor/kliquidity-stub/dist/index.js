"use strict";
// Stub of @kamino-finance/kliquidity-sdk for vaultpilot-mcp.
//
// Only the symbols klend-sdk + farms-sdk reach at runtime are implemented.
// Each helper mirrors the real impl byte-for-byte in behavior; the `Kamino`
// class throws if instantiated (kliquidity vault flows are not supported in
// the stripped binary).

var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });

const decimal_js_1 = __importDefault(require("decimal.js"));
const bn_js_1 = __importDefault(require("bn.js"));

// from kliquidity-sdk/dist/utils/math.js
exports.ZERO = new decimal_js_1.default(0);
exports.aprToApy = function aprToApy(apr, compoundPeriods) {
    return new decimal_js_1.default(1).add(apr.div(compoundPeriods)).pow(compoundPeriods).sub(1);
};

// from kliquidity-sdk/dist/utils/batch.js
exports.chunks = function chunks(array, size) {
    return [...new Array(Math.ceil(array.length / size)).keys()].map((_, index) => array.slice(index * size, (index + 1) * size));
};
exports.batchFetch = async function batchFetch(addresses, fetchBatch, chunkSize = 100) {
    const results = await Promise.all(exports.chunks(addresses, chunkSize).map((chunk) => fetchBatch(chunk)));
    return results.reduce((acc, curr) => acc.concat(...curr), new Array());
};

// from kliquidity-sdk/dist/utils/utils.js
exports.collToLamportsDecimal = function collToLamportsDecimal(amount, decimals) {
    const factor = new decimal_js_1.default(10).pow(decimals);
    return amount.mul(factor);
};

// from kliquidity-sdk/dist/utils/tokenUtils.js
exports.DECIMALS_SOL = 9;

// from kliquidity-sdk/dist/constants/numericalValues.js
exports.ZERO_BN = new bn_js_1.default(0);

// from kliquidity-sdk/dist/utils/CreationParameters.js (also re-exported here
// because farms-sdk + klend-sdk reach the bare path for these in some branches)
exports.FullBPS = 10_000;
exports.FullBPSDecimal = new decimal_js_1.default(exports.FullBPS);

class Kamino {
    constructor() {
        throw new Error(
            "@kamino-finance/kliquidity-sdk is stubbed in vaultpilot-mcp to keep the bundled binary small. " +
            "This code path (Kamino vault strategies) requires the real package — install it separately " +
            "or remove the kliquidity-sdk override in package.json to restore."
        );
    }
}
exports.Kamino = Kamino;
