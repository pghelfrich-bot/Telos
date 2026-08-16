// Session auth: a password login that issues an HMAC-signed cookie via Web
// Crypto. The cookie is HttpOnly and SameSite=Lax, and Secure only over https
// so local http dev still works.

import { badRequest, HOUR_MS, json, loginLimit, readJson } from "./lib.ts";
import { enforceRateLimit } from "./store.ts";
import type { Ctx } from "./types.ts";

const COOKIE_NAME = "sg_session";
const SESSION_TTL_MS = 7 * 24 * HOUR_MS;
const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return toHex(sig);
}

// Constant-time comparison of two equal-length hex strings.
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Compare two secrets in constant time by hashing both to a fixed width first,
// so neither length nor content timing leaks.
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return timingSafeEqualHex(toHex(da), toHex(db));
}

async function issueSession(secret: string): Promise<string> {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = `v1.${exp}`;
  const sig = await hmacHex(secret, payload);
  return `${payload}.${sig}`;
}

async function verifySession(secret: string, token: string | null): Promise<boolean> {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [v, expStr, sig] = parts;
  const expected = await hmacHex(secret, `${v}.${expStr}`);
  if (!timingSafeEqualHex(sig, expected)) return false;
  const exp = Number(expStr);
  return Number.isFinite(exp) && exp > Date.now();
}

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function setCookieHeader(token: string, request: Request, maxAgeSeconds: number): string {
  const isHttps = new URL(request.url).protocol === "https:";
  const attrs = [`${COOKIE_NAME}=${token}`, "HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${maxAgeSeconds}`];
  if (isHttps) attrs.push("Secure");
  return attrs.join("; ");
}

// True when the request carries a valid session cookie.
export async function hasSession(request: Request, ctx: Ctx): Promise<boolean> {
  return verifySession(ctx.env.SESSION_SECRET || "", getCookie(request, COOKIE_NAME));
}

// POST /api/login
export async function login(request: Request, ctx: Ctx): Promise<Response> {
  const rl = await enforceRateLimit(ctx.kv, `login:${ctx.ip}`, loginLimit(ctx.env), HOUR_MS);
  if (!rl.allowed) {
    return json({ error: "too many attempts, try again later" }, 429, { "retry-after": String(rl.retryAfter) });
  }

  const body = await readJson(request);
  if (!body.ok) return badRequest("request body must be a JSON object");

  const password = String(body.value!.password == null ? "" : body.value!.password);
  const expected = ctx.env.ADMIN_PASSWORD || "";
  const ok = expected.length > 0 && (await constantTimeEqual(password, expected));
  if (!ok) return json({ error: "invalid password" }, 401);

  const token = await issueSession(ctx.env.SESSION_SECRET || "");
  return json({ ok: true }, 200, { "set-cookie": setCookieHeader(token, request, SESSION_TTL_MS / 1000) });
}

// POST /api/logout
export function logout(request: Request): Response {
  return json({ ok: true }, 200, { "set-cookie": setCookieHeader("", request, 0) });
}

// GET /api/me
export async function me(request: Request, ctx: Ctx): Promise<Response> {
  return json({ authenticated: await hasSession(request, ctx) });
}
