/**
 * Streamable HTTP transport, for running this somewhere always on.
 *
 * Stdio is what an MCP client launches locally. This is for the other case: one
 * machine that holds the browser session, reached by clients elsewhere. Bearer
 * auth is mandatory when the listener is not on loopback, because this server
 * acts as a signed-in Midjourney account and can spend money.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { BuiltServer } from "../server.js";

export type HttpOptions = { port: number; host: string; token?: string };

export function httpOptionsFromEnv(argv: string[] = []): HttpOptions {
  const portFlag = argv.find((token) => token.startsWith("--port="));
  const port = Number(portFlag?.slice("--port=".length) ?? process.env.MIDJOURNEY_HTTP_PORT ?? 8787);
  return {
    port: Number.isFinite(port) ? port : 8787,
    host: process.env.MIDJOURNEY_HTTP_HOST ?? "127.0.0.1",
    token: process.env.MIDJOURNEY_HTTP_TOKEN,
  };
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export async function startHttpServer(
  built: BuiltServer,
  options: HttpOptions,
): Promise<{ close: () => Promise<void> }> {
  if (!options.token && !isLoopback(options.host)) {
    throw new Error(
      `Refusing to listen on ${options.host} without MIDJOURNEY_HTTP_TOKEN. This server acts as a signed-in Midjourney account and can spend money, so an unauthenticated public listener is not offered.`,
    );
  }

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await built.server.connect(transport);

  const http = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (options.token) {
      const header = request.headers.authorization ?? "";
      if (header !== `Bearer ${options.token}`) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }
    void transport.handleRequest(request, response);
  });

  await new Promise<void>((resolve) => http.listen(options.port, options.host, resolve));
  process.stderr.write(`[midjourney-mcp] listening on http://${options.host}:${options.port}\n`);

  return {
    close: () =>
      new Promise<void>((resolve) => {
        http.close(() => resolve());
      }),
  };
}
