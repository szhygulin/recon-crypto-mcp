"use strict";
// Stub of @kamino-finance/kliquidity-sdk/dist/utils/CreationParameters.
// klend-sdk's vault.js + leverage/operations.js require this subpath
// directly. Mirrors the real exports for FullBPS / FullBPSDecimal.

var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });

const decimal_js_1 = __importDefault(require("decimal.js"));

exports.FullBPS = 10_000;
exports.FullBPSDecimal = new decimal_js_1.default(exports.FullBPS);
