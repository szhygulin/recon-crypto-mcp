import { describe, it, expect } from "vitest";
import {
  approxTokens,
  utf8Bytes,
  serializeInputSchema,
  analyzeTool,
  analyzeToolList,
  formatRankingTable,
  type ToolDescriptor,
} from "../src/diagnostics/tool-cost.ts";

/**
 * Pure-helper tests for the tool-cost analyzer (issue #637). The
 * spawn/JSON-RPC plumbing in `scripts/bench-tools.mjs` is exercised
 * separately via `npm run bench:tools` against the built server;
 * unit tests cover only the deterministic analysis layer.
 */

describe("approxTokens", () => {
  it("returns 0 for empty string", () => {
    expect(approxTokens("")).toBe(0);
  });

  it("rounds chars/4 up", () => {
    expect(approxTokens("abcd")).toBe(1);
    expect(approxTokens("abcde")).toBe(2);
    expect(approxTokens("a".repeat(100))).toBe(25);
    expect(approxTokens("a".repeat(101))).toBe(26);
  });
});

describe("utf8Bytes", () => {
  it("counts UTF-8 bytes, not code units", () => {
    expect(utf8Bytes("abc")).toBe(3);
    // Multibyte characters — emoji is 4 bytes, accent is 2 bytes.
    expect(utf8Bytes("é")).toBe(2);
    // Bytes diverge from `.length` (code units): rocket emoji is 2
    // surrogate pairs (`.length === 2`) but 4 UTF-8 bytes.
    expect(utf8Bytes("🚀")).toBe(4);
    expect("🚀".length).toBe(2);
  });
});

describe("serializeInputSchema", () => {
  it("returns empty string for null/undefined", () => {
    expect(serializeInputSchema(undefined)).toBe("");
    expect(serializeInputSchema(null)).toBe("");
  });

  it("emits compact JSON (no pretty-printing)", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    const out = serializeInputSchema(schema);
    expect(out).toBe('{"type":"object","properties":{"a":{"type":"string"}}}');
    expect(out).not.toContain("\n");
  });
});

describe("analyzeTool", () => {
  it("breaks down bytes by section", () => {
    const tool: ToolDescriptor = {
      name: "get_things",
      description: "Fetch things.",
      inputSchema: { type: "object" },
    };
    const row = analyzeTool(tool);
    expect(row.name).toBe("get_things");
    expect(row.nameBytes).toBe(10);
    expect(row.descriptionBytes).toBe("Fetch things.".length);
    expect(row.inputSchemaBytes).toBe('{"type":"object"}'.length);
    expect(row.totalBytes).toBe(
      row.nameBytes + row.descriptionBytes + row.inputSchemaBytes,
    );
    expect(row.approxTokens).toBeGreaterThan(0);
  });

  it("handles missing description and schema", () => {
    const row = analyzeTool({ name: "x" });
    expect(row.nameBytes).toBe(1);
    expect(row.descriptionBytes).toBe(0);
    expect(row.inputSchemaBytes).toBe(0);
    expect(row.totalBytes).toBe(1);
  });
});

describe("analyzeToolList", () => {
  const tools: ToolDescriptor[] = [
    { name: "small", description: "tiny", inputSchema: {} },
    {
      name: "big",
      description: "a much longer description that takes more bytes",
      inputSchema: { type: "object", properties: { a: { type: "string" } } },
    },
    { name: "mid", description: "medium length", inputSchema: { type: "object" } },
  ];

  it("sorts rows by totalBytes descending", () => {
    const summary = analyzeToolList(tools);
    expect(summary.rows[0].name).toBe("big");
    expect(summary.rows[summary.rows.length - 1].name).toBe("small");
    // Strict descending order.
    for (let i = 1; i < summary.rows.length; i++) {
      expect(summary.rows[i - 1].totalBytes).toBeGreaterThanOrEqual(
        summary.rows[i].totalBytes,
      );
    }
  });

  it("computes consistent totals", () => {
    const summary = analyzeToolList(tools);
    const expectedBytes = summary.rows.reduce((acc, r) => acc + r.totalBytes, 0);
    const expectedTokens = summary.rows.reduce((acc, r) => acc + r.approxTokens, 0);
    expect(summary.totalBytes).toBe(expectedBytes);
    expect(summary.totalApproxTokens).toBe(expectedTokens);
    expect(summary.toolCount).toBe(3);
  });

  it("handles empty list", () => {
    const summary = analyzeToolList([]);
    expect(summary.rows).toEqual([]);
    expect(summary.totalBytes).toBe(0);
    expect(summary.totalApproxTokens).toBe(0);
    expect(summary.toolCount).toBe(0);
  });
});

describe("formatRankingTable", () => {
  const summary = analyzeToolList([
    { name: "a_tool", description: "A".repeat(100), inputSchema: {} },
    { name: "b_tool", description: "B".repeat(50), inputSchema: {} },
    { name: "c_tool", description: "C".repeat(10), inputSchema: {} },
  ]);

  it("includes every tool when fewer than top", () => {
    const table = formatRankingTable(summary, { top: 10 });
    expect(table).toContain("a_tool");
    expect(table).toContain("b_tool");
    expect(table).toContain("c_tool");
  });

  it("respects --top truncation", () => {
    const table = formatRankingTable(summary, { top: 2 });
    expect(table).toContain("a_tool");
    expect(table).toContain("b_tool");
    expect(table).not.toContain("c_tool");
    expect(table).toContain("Top 2 by total bytes");
  });

  it("renders the section breakdown", () => {
    const table = formatRankingTable(summary);
    expect(table).toContain("## Section breakdown across all tools");
    expect(table).toContain("Tool names");
    expect(table).toContain("Descriptions");
    expect(table).toContain("Input schemas");
  });

  it("declares the proxy nature of token counts", () => {
    const table = formatRankingTable(summary);
    expect(table.toLowerCase()).toContain("approximation");
  });

  it("formats summary footer with total stats", () => {
    const table = formatRankingTable(summary);
    expect(table).toContain("Per-conversation static cost");
    expect(table).toMatch(/\d[\d,]*\s+bytes/);
  });
});
