import { describe, it, expect } from "vitest";
import { pinLedgerLivePeer } from "../src/signing/walletconnect-peer-pin.ts";
import type { SessionTypes } from "@walletconnect/types";

/**
 * Unit tests for the WalletConnect peer pin (issue #325 P5). Pure
 * function — no transport, no SignClient. Just exercises the
 * verdict logic over various peer-metadata shapes.
 */

function buildSession(metadata: Partial<{
  name: string;
  url: string;
  description: string;
  icons: string[];
}>): SessionTypes.Struct {
  return {
    peer: {
      publicKey: "00".repeat(32),
      metadata: {
        name: metadata.name ?? "",
        url: metadata.url ?? "",
        description: metadata.description ?? "",
        icons: metadata.icons ?? [],
      },
    },
  } as unknown as SessionTypes.Struct;
}

describe("pinLedgerLivePeer — match", () => {
  it("matches canonical Ledger Live metadata", () => {
    const session = buildSession({
      name: "Ledger Live",
      url: "https://www.ledger.com",
      icons: ["https://cdn.ledger.com/logo.png"],
    });
    const result = pinLedgerLivePeer(session);
    expect(result.verdict).toBe("match");
  });

  it("matches when url is empty (mobile clients omit it)", () => {
    const session = buildSession({
      name: "Ledger Live",
      url: "",
      icons: ["https://cdn.ledger.com/logo.png"],
    });
    expect(pinLedgerLivePeer(session).verdict).toBe("match");
  });

  it("matches when icons array is empty (defensive — only refuse if BOTH url+icons fail Ledger check)", () => {
    const session = buildSession({
      name: "Ledger Live",
      url: "https://www.ledger.com",
      icons: [],
    });
    expect(pinLedgerLivePeer(session).verdict).toBe("match");
  });

  it("matches a *.ledger.com subdomain url", () => {
    const session = buildSession({
      name: "Ledger Live",
      url: "https://my.ledger.com/some/path",
      icons: [],
    });
    expect(pinLedgerLivePeer(session).verdict).toBe("match");
  });
});

describe("pinLedgerLivePeer — mismatch", () => {
  it("rejects an exact-name impostor (different name)", () => {
    const session = buildSession({
      name: "Ledger Wallet", // not the canonical name
      url: "https://www.ledger.com",
      icons: ["https://cdn.ledger.com/logo.png"],
    });
    const result = pinLedgerLivePeer(session);
    expect(result.verdict).toBe("mismatch");
    expect(result.message).toMatch(/name "Ledger Wallet"/);
  });

  it("rejects a non-Ledger URL", () => {
    const session = buildSession({
      name: "Ledger Live",
      url: "https://attacker.example.com",
      icons: ["https://cdn.ledger.com/logo.png"],
    });
    const result = pinLedgerLivePeer(session);
    expect(result.verdict).toBe("mismatch");
    expect(result.message).toMatch(/url "https:\/\/attacker.example.com"/);
  });

  it("rejects when icons are present but none point at *.ledger.com", () => {
    const session = buildSession({
      name: "Ledger Live",
      url: "https://www.ledger.com",
      icons: ["https://attacker.example.com/logo.png"],
    });
    const result = pinLedgerLivePeer(session);
    expect(result.verdict).toBe("mismatch");
    expect(result.message).toMatch(/icon hosts/);
  });

  it("rejects a different wallet (Sparrow)", () => {
    const session = buildSession({
      name: "Sparrow",
      url: "https://sparrowwallet.com",
      icons: ["https://sparrowwallet.com/logo.png"],
    });
    const result = pinLedgerLivePeer(session);
    expect(result.verdict).toBe("mismatch");
  });

  it("is case-sensitive on name (Ledger publishes 'Ledger Live' verbatim)", () => {
    const session = buildSession({
      name: "ledger live",
      url: "https://www.ledger.com",
      icons: [],
    });
    expect(pinLedgerLivePeer(session).verdict).toBe("mismatch");
  });
});

describe("pinLedgerLivePeer — missing-metadata", () => {
  it("returns missing-metadata when name+url+icons are all empty", () => {
    const session = buildSession({});
    const result = pinLedgerLivePeer(session);
    expect(result.verdict).toBe("missing-metadata");
    expect(result.message).toMatch(/no metadata/);
  });

  it("returns missing-metadata when peer.metadata itself is undefined", () => {
    const session = {
      peer: { publicKey: "00".repeat(32) },
    } as unknown as SessionTypes.Struct;
    expect(pinLedgerLivePeer(session).verdict).toBe("missing-metadata");
  });
});
