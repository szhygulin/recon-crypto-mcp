import { describe, it, expect, afterEach } from "vitest";
import {
  startHostedServer,
  _testing,
  type HostedServerHandle,
} from "../src/hosted/server.js";

/**
 * Tests for the PR A hosted-mode transport scaffolding.
 *
 * The full MCP-over-HTTP surface lands in PR C (auth + dispatch);
 * everything here covers the placeholder shape:
 *   - status envelope on `/` and `/healthz`
 *   - 501 with structured "PR X" hint for endpoints that aren't
 *     implemented yet
 *   - 404 with usage hint on unknown routes
 *   - real HTTP smoke against a started server (PORT=0 → OS-picked port)
 */

let handle: HostedServerHandle | undefined;

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = undefined;
  }
});

describe("buildStatus envelope (pure)", () => {
  it("returns the scaffolding-only shape with all six PRs accounted for", () => {
    const s = _testing.buildStatus();
    expect(s.service).toBe("vaultpilot-mcp");
    expect(s.mode).toBe("hosted");
    expect(s.status).toBe("scaffolding-only");
    // `ready: false` is intentional — PR A is not real-traffic-ready.
    expect(s.ready).toBe(false);
    // PR-state map covers the full plan.
    expect(s.prState).toHaveProperty("transport");
    expect(s.prState).toHaveProperty("walletConnectRegistry");
    expect(s.prState).toHaveProperty("auth");
    expect(s.prState).toHaveProperty("toolGating");
    expect(s.prState).toHaveProperty("docs");
    expect(s.prState).toHaveProperty("deployment");
    // Only PR A is marked done.
    expect(s.prState.transport).toMatch(/done/);
    expect(s.prState.walletConnectRegistry).toMatch(/pending/);
    expect(s.prState.auth).toMatch(/pending/);
  });

  it("version field is populated (or 'unknown' on resolution failure)", () => {
    const s = _testing.buildStatus();
    expect(typeof s.version).toBe("string");
    expect(s.version.length).toBeGreaterThan(0);
  });
});

describe("HTTP smoke — real server on a random port", () => {
  it("GET / returns the status envelope (200)", async () => {
    handle = await startHostedServer({ port: 0, host: "127.0.0.1" });
    const res = await fetch(`http://127.0.0.1:${handle.port}/`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReturnType<typeof _testing.buildStatus>;
    expect(body.service).toBe("vaultpilot-mcp");
    expect(body.status).toBe("scaffolding-only");
  });

  it("GET /healthz mirrors GET /", async () => {
    handle = await startHostedServer({ port: 0, host: "127.0.0.1" });
    const res = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReturnType<typeof _testing.buildStatus>;
    expect(body.ready).toBe(false);
  });

  it("POST /mcp returns 501 with a structured 'plannedPr: PR C' envelope", async () => {
    handle = await startHostedServer({ port: 0, host: "127.0.0.1" });
    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(501);
    const body = await res.json() as { error: string; plannedPr: string; route: string };
    expect(body.error).toBe("not_implemented");
    expect(body.plannedPr).toMatch(/PR C/);
    expect(body.route).toBe("POST /mcp");
  });

  it("OAuth discovery returns 503 (reserved, lands in PR C)", async () => {
    handle = await startHostedServer({ port: 0, host: "127.0.0.1" });
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/.well-known/oauth-authorization-server`,
    );
    expect(res.status).toBe(503);
    const body = await res.json() as { retryAfterPr: string };
    expect(body.retryAfterPr).toBe("C");
  });

  it("OAuth flow routes (/authorize, /token, /revoke) all return 501 → PR C", async () => {
    handle = await startHostedServer({ port: 0, host: "127.0.0.1" });
    for (const route of ["/authorize", "/token", "/revoke"]) {
      const res = await fetch(`http://127.0.0.1:${handle.port}${route}`);
      expect(res.status).toBe(501);
      const body = await res.json() as { plannedPr: string };
      expect(body.plannedPr).toMatch(/PR C/);
    }
  });

  it("/dashboard returns 501 → PR C", async () => {
    handle = await startHostedServer({ port: 0, host: "127.0.0.1" });
    const res = await fetch(`http://127.0.0.1:${handle.port}/dashboard`);
    expect(res.status).toBe(501);
    const body = await res.json() as { plannedPr: string };
    expect(body.plannedPr).toMatch(/PR C/);
  });

  it("unknown route returns 404 with available + pending hints (no bare 404)", async () => {
    handle = await startHostedServer({ port: 0, host: "127.0.0.1" });
    const res = await fetch(`http://127.0.0.1:${handle.port}/some/random/path`);
    expect(res.status).toBe(404);
    const body = await res.json() as {
      error: string;
      method: string;
      path: string;
      available: string[];
      pending: string[];
    };
    expect(body.error).toBe("not_found");
    expect(body.method).toBe("GET");
    expect(body.path).toBe("/some/random/path");
    expect(body.available).toContain("GET /");
    expect(body.available).toContain("GET /healthz");
    expect(body.pending.length).toBeGreaterThan(0);
  });

  it("Cache-Control: no-store on every response (avoid stale OAuth/health caching)", async () => {
    handle = await startHostedServer({ port: 0, host: "127.0.0.1" });
    const res = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("survives a malformed request body without crashing", async () => {
    handle = await startHostedServer({ port: 0, host: "127.0.0.1" });
    // Send a POST with an unparseable body — the placeholder doesn't
    // parse JSON yet (it just 501s), but the server shouldn't choke.
    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json{",
    });
    expect(res.status).toBe(501);
    // Follow-up request still works.
    const res2 = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
    expect(res2.status).toBe(200);
  });
});
