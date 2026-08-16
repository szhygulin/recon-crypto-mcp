import { describe, it, expect } from "vitest";
import { pinLedgerLivePeer } from "../src/signing/walletconnect-peer-pin.ts";
import type { SessionTypes } from "@walletconnect/types";

/**
 * Unit tests for the WalletConnect peer pin (issue #325 P5; re-scoped
 * by issue #831). Pure function — no transport, no SignClient. Just
 * exercises the verdict logic over various peer-metadata shapes.
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
  it("matches canonical Ledger Live metadata (name: Ledger Live)", () => {
    const session = buildSession({
      name: "Ledger Live",
      url: "https://www.ledger.com",
      icons: ["https://cdn.ledger.com/logo.png"],
    });
    const result = pinLedgerLivePeer(session);
    expect(result.verdict).toBe("match");
  });

  it("matches a *.ledger.com subdomain url", () => {
    const session = buildSession({
      name: "Ledger Live",
      url: "https://my.ledger.com/some/path",
      icons: [],
    });
    expect(pinLedgerLivePeer(session).verdict).toBe("match");
  });

  it("matches regardless of icons — the icon-host check was dropped (#831): a GitHub avatar URL isn't a Ledger-controlled identifier, so it's no longer part of the pin", () => {
    const session = buildSession({
      name: "Ledger Live",
      url: "https://www.ledger.com",
      icons: ["https://attacker.example.com/logo.png"],
    });
    expect(pinLedgerLivePeer(session).verdict).toBe("match");
  });

  // Issue #831 fixture, verbatim from the issue's observed metadata
  // off a real `pair_ledger_live` today. RED on unfixed code: current
  // Ledger Live advertises name "Ledger Wallet" (not the old exact
  // "Ledger Live") and an avatars.githubusercontent.com icon (not
  // *.ledger.com), so the pre-#831 pin fails 2 of 3 checks and warns
  // on every genuine pairing.
  it("matches real Ledger Live metadata observed in issue #831 (name 'Ledger Wallet', GitHub-hosted icon)", () => {
    const session = buildSession({
      name: "Ledger Wallet",
      description: "Ledger Live Wallet with WalletConnect",
      url: "https://wc.apps.ledger.com",
      icons: ["https://avatars.githubusercontent.com/u/37784886"],
    });
    const result = pinLedgerLivePeer(session);
    expect(result.verdict).toBe("match");
  });
});

describe("pinLedgerLivePeer — mismatch", () => {
  // Contract: url is the load-bearing anchor. A non-Ledger url warns
  // and names the url field, even when name is the canonical
  // "Ledger Live" — this is the accidental-wrong-wallet case the pin
  // exists to catch, and it must still warn after #831 exactly as it
  // did before (control: the pre-#831 pin already warned here, since
  // its url check required a *.ledger.com hostname too).
  it("rejects a non-Ledger url even with a recognized name, naming the url field", () => {
    const session = buildSession({
      name: "Ledger Live",
      url: "https://evil.example",
      icons: [],
    });
    const result = pinLedgerLivePeer(session);
    expect(result.verdict).toBe("mismatch");
    expect(result.message).toMatch(/url "https:\/\/evil\.example"/);
    expect(result.message).not.toMatch(/name "Ledger Live"/);
  });

  // Contract: name is a warning contributor, not a sole trigger — an
  // unrecognized name with a good url still warns (metadata drift is
  // worth surfacing) but only the name field is named as mismatched.
  it("rejects an unrecognized name (MetaMask) with a good ledger.com url, naming only the name field", () => {
    const session = buildSession({
      name: "MetaMask",
      url: "https://wc.apps.ledger.com",
      icons: [],
    });
    const result = pinLedgerLivePeer(session);
    expect(result.verdict).toBe("mismatch");
    expect(result.message).toMatch(/name "MetaMask"/);
    expect(result.message).not.toMatch(/url "https:\/\/wc\.apps\.ledger\.com"/);
  });

  it("rejects a different wallet (Sparrow) on both fields", () => {
    const session = buildSession({
      name: "Sparrow",
      url: "https://sparrowwallet.com",
      icons: ["https://sparrowwallet.com/logo.png"],
    });
    const result = pinLedgerLivePeer(session);
    expect(result.verdict).toBe("mismatch");
    expect(result.message).toMatch(/name "Sparrow"/);
    expect(result.message).toMatch(/url "https:\/\/sparrowwallet\.com"/);
  });

  it("is case-sensitive on name (Ledger publishes 'Ledger Live'/'Ledger Wallet' verbatim)", () => {
    const session = buildSession({
      name: "ledger live",
      url: "https://www.ledger.com",
      icons: [],
    });
    expect(pinLedgerLivePeer(session).verdict).toBe("mismatch");
  });

  it("rejects an empty url even with a recognized name — no empty-url leniency post-#831", () => {
    const session = buildSession({
      name: "Ledger Live",
      url: "",
      icons: ["https://cdn.ledger.com/logo.png"],
    });
    const result = pinLedgerLivePeer(session);
    expect(result.verdict).toBe("mismatch");
    expect(result.message).toMatch(/url ""/);
  });
});

describe("pinLedgerLivePeer — missing-metadata", () => {
  it("returns missing-metadata when name+url are both empty", () => {
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
