import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/**
 * Hosted-mode HTTP server scaffolding — PR A of the
 * `claude-work/plan-hosted-mcp-endpoint.md` rollout.
 *
 * **What this does today:**
 *   - Boots a Node `http` server when `VAULTPILOT_TRANSPORT=http`.
 *   - Exposes `GET /` and `GET /healthz` returning a small JSON status
 *     envelope so deployment liveness probes (Docker/k8s/Fly/Railway)
 *     have something to hit.
 *   - Returns `501 Not Implemented` for `POST /mcp` and every other
 *     route, with a body explaining which subsequent PR (B-F) implements
 *     each piece.
 *
 * **What this does NOT do** (deferred to subsequent PRs in the plan):
 *   - **PR B**: per-user WalletConnect isolation — `WalletConnectRegistry`
 *     replaces module-scoped state in `src/signing/walletconnect.ts`;
 *     `userId` threading via `AsyncLocalStorage`.
 *   - **PR C**: OAuth 2.1 provider + GitHub upstream + bearer-token
 *     issuance + SQLite state + per-user rate limiting. The MCP
 *     streamable-HTTP handler wires up here.
 *   - **PR D**: hosted-mode tool gating — TRON / Solana / USB-HID
 *     prepare tools return a structured "use local install" error.
 *   - **PR E**: `SECURITY.md` addendum, README hosted-mode section,
 *     Dockerfile, docker-compose, self-host docs.
 *   - **PR F**: maintainer-run reference deployment (out of repo).
 *
 * Deliberately uses `node:http` (zero new deps). Hono lands in PR C
 * when we need real OAuth routes + middleware composition.
 */

const DEFAULT_PORT = 3000;

/**
 * Resolve the package version once at module load. Same pattern as the
 * setup binary's `readPackageVersion` — read `package.json` relative to
 * this file's compiled location so it works for both global-install and
 * source runs.
 */
function readVersion(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    const req = createRequire(here);
    // Compiled location: dist/hosted/server.js → ../../package.json
    const pkg = req("../../package.json") as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const VERSION = readVersion();

/**
 * Status envelope returned on health-probe routes. Stable shape so a
 * future deployment monitor can match against it.
 */
interface StatusEnvelope {
  service: "vaultpilot-mcp";
  mode: "hosted";
  version: string;
  status: "scaffolding-only";
  prState: {
    /** Which PR landed which capability. Mirrors the plan doc. */
    transport: "PR A — done (this commit)";
    walletConnectRegistry: "PR B — pending";
    auth: "PR C — pending";
    toolGating: "PR D — pending";
    docs: "PR E — pending";
    deployment: "PR F — pending";
  };
  /** Stable health flag for liveness probes. */
  ready: boolean;
}

function buildStatus(): StatusEnvelope {
  return {
    service: "vaultpilot-mcp",
    mode: "hosted",
    version: VERSION,
    status: "scaffolding-only",
    prState: {
      transport: "PR A — done (this commit)",
      walletConnectRegistry: "PR B — pending",
      auth: "PR C — pending",
      toolGating: "PR D — pending",
      docs: "PR E — pending",
      deployment: "PR F — pending",
    },
    // Liveness probe: PR A is intentionally `ready: false` — the MCP
    // surface isn't actually serving requests yet (auth + dispatch land
    // in PR C). A future operator deploying PR A standalone should NOT
    // route real traffic at it. Flips to `true` in PR C.
    ready: false,
  };
}

function jsonResponse(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    // Conservative CORS posture for the placeholder. PR C will refine
    // when actual auth flows + browser dashboard land.
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function notImplemented(res: ServerResponse, route: string, plannedPr: string): void {
  jsonResponse(res, 501, {
    error: "not_implemented",
    route,
    message:
      `The hosted endpoint scaffolding is in place (PR A), but ${route} is implemented in ${plannedPr}. ` +
      `See claude-work/plan-hosted-mcp-endpoint.md for the rollout sequence.`,
    plannedPr,
  });
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";
  // Strip query string for routing.
  const path = url.split("?")[0];
  // Minimal access log — real structured logger lands in PR C with
  // request-id + user-id + latency. Stderr so it doesn't pollute MCP
  // stdout if anyone misroutes the streams.
  process.stderr.write(`[vaultpilot-mcp:hosted] ${method} ${path}\n`);

  if (method === "GET" && (path === "/" || path === "/healthz")) {
    jsonResponse(res, 200, buildStatus());
    return;
  }

  // OAuth discovery doc — populated for real in PR C. For now, return
  // a stub that says "this endpoint is reserved" so Claude Desktop's
  // OAuth probe gets a structured response instead of a 501 (which
  // would break its discovery flow once real OAuth lands and confuse
  // anyone testing).
  if (method === "GET" && path === "/.well-known/oauth-authorization-server") {
    jsonResponse(res, 503, {
      error: "service_unavailable",
      message: "OAuth provider not yet configured — lands in PR C.",
      retryAfterPr: "C",
    });
    return;
  }

  if (method === "POST" && path === "/mcp") {
    notImplemented(res, "POST /mcp", "PR C (auth + MCP streamable-HTTP handler)");
    return;
  }

  if (path.startsWith("/authorize") || path.startsWith("/token") || path.startsWith("/revoke")) {
    notImplemented(res, path, "PR C (OAuth 2.1 provider)");
    return;
  }

  if (path.startsWith("/dashboard")) {
    notImplemented(res, path, "PR C (operator dashboard for token management)");
    return;
  }

  // Unknown route — keep the response shape consistent with the
  // structured-error pattern above so an agent debugging "what does
  // this endpoint expose?" gets a useful response, not a bare 404.
  jsonResponse(res, 404, {
    error: "not_found",
    method,
    path,
    available: ["GET /", "GET /healthz"],
    pending: [
      "GET /.well-known/oauth-authorization-server (PR C)",
      "GET /authorize, POST /token, POST /revoke (PR C)",
      "GET /dashboard (PR C)",
      "POST /mcp (PR C)",
    ],
  });
}

/**
 * Start the hosted HTTP server. Returns the bound port (useful for
 * tests where PORT=0 lets the OS pick a free port). Caller (typically
 * `src/index.ts`'s transport dispatch) decides what to await on; we
 * return both the server handle and a `ready` promise so tests can
 * cleanly start + stop without races.
 */
export interface HostedServerHandle {
  port: number;
  close: () => Promise<void>;
}

export async function startHostedServer(opts: {
  port?: number;
  host?: string;
} = {}): Promise<HostedServerHandle> {
  const requestedPort = opts.port ?? Number(process.env.PORT ?? DEFAULT_PORT);
  const host = opts.host ?? "0.0.0.0";

  const server = createServer((req, res) => {
    try {
      handleRequest(req, res);
    } catch (err) {
      // Defensive: any throw in a handler shouldn't kill the process.
      // Real error reporting lands with the structured logger in PR C.
      process.stderr.write(
        `[vaultpilot-mcp:hosted] handler error: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      try {
        jsonResponse(res, 500, {
          error: "internal_server_error",
          message: "Unhandled error in request pipeline.",
        });
      } catch {
        /* response already partially sent — give up */
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const port =
    addr && typeof addr === "object" ? addr.port : requestedPort;
  process.stderr.write(
    `[vaultpilot-mcp:hosted] listening on http://${host}:${port}/ (mode=scaffolding-only)\n`,
  );

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}

// Test-only export — lets unit tests assert envelope shape without
// spinning up the HTTP listener.
export const _testing = {
  buildStatus,
  handleRequest,
};
