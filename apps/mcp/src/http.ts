// HTTP transport for hosting the server remotely, so clients
// that can't launch a local process, like claude.ai and the Claude mobile apps,
// can connect. The server holds the user's ESPN cookies, so every MCP request
// needs the access token: either in the path (/mcp/<token>, for clients that
// only take a URL) or as `Authorization: Bearer <token>`.

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer as createNodeServer, type IncomingMessage, type Server } from "node:http";
import { Readable } from "node:stream";
import type { FantasyService } from "@espn-fantasy-mcp/core";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createServer, type ServerOptions } from "./server.js";

export const MIN_TOKEN_LENGTH = 32;

export interface HttpOptions extends ServerOptions {
  /** Shared secret for every MCP request. At least MIN_TOKEN_LENGTH characters. */
  token: string;
}

const digest = (s: string) => createHash("sha256").update(s).digest();
/** Constant-time comparison; hashing first makes the lengths equal. */
const sameSecret = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

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
export function createHttpServer(service: () => FantasyService, options: HttpOptions): Server {
  if (options.token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`The access token must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  const handler = createMcpHandler(() => createServer(service, options));

  return createNodeServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    const token = presentedToken(url.pathname, req.headers.authorization);
    if (token === null || !sameSecret(token, options.token)) {
      res.writeHead(404).end();
      return;
    }
    try {
      const response = await handler.fetch(toRequest(req, url));
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
