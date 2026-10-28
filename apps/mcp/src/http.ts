// HTTP transport for hosting the server remotely, so clients
// that can't launch a local process, like claude.ai and the Claude mobile apps,
// can connect. The server holds ESPN cookies, so every MCP request needs an
// access token: either in the path (/mcp/<token>, for clients that only take a
// URL) or as `Authorization: Bearer <token>`. The token also picks whose
// leagues the request reads (see tenants.ts).

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer as createNodeServer, type IncomingMessage, type Server } from "node:http";
import { Readable } from "node:stream";
import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { createServer, type ServerOptions } from "./server.js";
import type { Tenant, TenantSource } from "./tenants.js";

const digest = (s: string) => createHash("sha256").update(s).digest();
/** Constant-time comparison; hashing first makes the lengths equal. */
const sameSecret = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

/** The tenant owning `token`, comparing against every token in constant time. */
export function tenantForToken(tenants: Tenant[], token: string): Tenant | null {
  let match: Tenant | null = null;
  for (const t of tenants)
    for (const candidate of t.tokens) if (sameSecret(token, candidate)) match = t;
  return match;
}

/** The token from /mcp/<token>, else from a bearer header; null if neither is there. */
export function presentedToken(path: string, authorization: string | undefined): string | null {
  const fromPath = /^\/mcp\/([^/]+)\/?$/.exec(path)?.[1];
  if (fromPath) return decodeURIComponent(fromPath);
  if (path === "/mcp" || path === "/mcp/") {
    const bearer = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1]?.trim();
    if (bearer) return bearer;
  }
  return null;
}

function toRequest(req: IncomingMessage, url: URL): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  // The token never travels past this point: drop it from the URL and headers.
  headers.delete("authorization");
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(new URL("/mcp", url), {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
    duplex: "half",
  } as RequestInit);
}

/**
 * A node:http server with GET /health (no auth, no data) and the MCP endpoint.
 * Anything else, including a wrong token, gets a bare 404 so the endpoint
 * doesn't advertise itself.
 */
export function createHttpServer(source: TenantSource, options: ServerOptions = {}): Server {
  // One handler per tenant, created on first use.
  const handlers = new Map<string, McpHttpHandler>();
  const handlerFor = (tenant: Tenant) => {
    let handler = handlers.get(tenant.name);
    if (!handler) {
      handler = createMcpHandler(() => createServer(tenant.service, options));
      handlers.set(tenant.name, handler);
    }
    return handler;
  };
  let lastErrors = "";

  return createNodeServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    const token = presentedToken(url.pathname, req.headers.authorization);
    const { tenants, errors } = source();
    // Log configuration problems when they change, never per request.
    if (errors.join("\n") !== lastErrors) {
      lastErrors = errors.join("\n");
      for (const e of errors) console.error(`tenants: ${e}`);
    }
    const tenant = token === null ? null : tenantForToken(tenants, token);
    if (!tenant) {
      res.writeHead(404).end();
      return;
    }
    try {
      const response = await handlerFor(tenant).fetch(toRequest(req, url));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      console.error("MCP request failed:", (err as Error).message);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
}
