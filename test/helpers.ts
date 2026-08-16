// Test helpers: build the real handler over a fresh in-memory KV and talk to it
// with an in-process client that carries the session cookie. No server, no
// ports, no mocks.

import { createHandler, type Handler } from "../server/handler.ts";

export interface Client {
  call(
    method: string,
    path: string,
    opts?: { json?: unknown; raw?: string; headers?: Record<string, string> },
  ): Promise<{ status: number; data: any; text: string; headers: Headers }>;
  cookie(): string;
}

function makeClient(handler: Handler): Client {
  let cookie = "";
  return {
    cookie: () => cookie,
    async call(method, path, opts = {}) {
      const headers = new Headers(opts.headers || {});
      let body: string | undefined;
      if (opts.json !== undefined) {
        headers.set("content-type", "application/json");
        body = JSON.stringify(opts.json);
      }
      if (opts.raw !== undefined) body = opts.raw;
      // Carry the stored session cookie unless the caller set one explicitly
      // (tests pass tampered cookies on purpose).
      if (cookie && !headers.has("cookie")) headers.set("cookie", cookie);

      const res = await handler(new Request("http://localhost" + path, { method, headers, body }));
      const sc = res.headers.get("set-cookie");
      if (sc) {
        if (/max-age=0/i.test(sc)) cookie = "";
        else cookie = sc.split(";")[0];
      }
      const text = await res.text();
      let data: any = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      return { status: res.status, data, text, headers: res.headers };
    },
  };
}

export interface App {
  kv: Deno.Kv;
  handler: Handler;
  client: Client;
  close(): void;
}

export async function newApp(envOverrides: Record<string, string> = {}): Promise<App> {
  const kv = await Deno.openKv(":memory:");
  const env: Record<string, string | undefined> = {
    ADMIN_PASSWORD: "test-password-123",
    SESSION_SECRET: "local-dev-session-secret",
    ...envOverrides,
  };
  const handler = createHandler({ kv, env, staticRoot: "public" });
  return { kv, handler, client: makeClient(handler), close: () => kv.close() };
}

export const ADMIN_PASSWORD = "test-password-123";
