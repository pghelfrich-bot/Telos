// Session auth: a password login that issues an HMAC-signed cookie via Web
// Crypto. The cookie is HttpOnly and SameSite=Lax, and Secure only over https
// so local http dev still works.

import { badRequest, HOUR_MS, json, loginLimit, readJson } from "./lib.ts";
import { enforceRateLimit } from "./store.ts";
import type { Ctx } from "./types.ts";

const COOKIE_NAME = "sg_session";
const SESSION_TTL_MS = 7 * 24 * HOUR_MS;
const encoder = new TextEncoder();

// A signing key shorter than this is treated as unconfigured. Without this the
// app would fall back to signing sessions with an empty string, and anyone who
// knows the scheme could forge an instructor cookie. Fail closed instead.
const MIN_SECRET_LENGTH = 16;

export function sessionSecret(env: Record<string, string | undefined>): string | null {
  const secret = env.SESSION_SECRET || "";
  return secret.length >= MIN_SECRET_LENGTH ? secret : null;
}

export function adminPassword(env: Record<string, string | undefined>): string | null {
  const password = env.ADMIN_PASSWORD || "";
  return password.length > 0 ? password : null;
}

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

// True when the request carries a valid session cookie. With no usable signing
// key, no cookie is ever accepted.
export async function hasSession(request: Request, ctx: Ctx): Promise<boolean> {
  const secret = sessionSecret(ctx.env);
  if (!secret) return false;
  return verifySession(secret, getCookie(request, COOKIE_NAME));
}

// POST /api/login
export async function login(request: Request, ctx: Ctx): Promise<Response> {
  const rl = await enforceRateLimit(ctx.kv, `login:${ctx.ip}`, loginLimit(ctx.env), HOUR_MS);
  if (!rl.allowed) {
    return json({ error: "too many attempts, try again later" }, 429, { "retry-after": String(rl.retryAfter) });
  }

  const secret = sessionSecret(ctx.env);
  const expected = adminPassword(ctx.env);
  if (!secret || !expected) {
    console.error(
      "login refused: ADMIN_PASSWORD must be set and SESSION_SECRET must be at least " +
        MIN_SECRET_LENGTH +
        " characters",
    );
    return json({ error: "this deployment is not configured for sign in" }, 503);
  }

  const body = await readJson(request);
  if (!body.ok) return badRequest("request body must be a JSON object");

  const password = String(body.value!.password == null ? "" : body.value!.password);
  const ok = await constantTimeEqual(password, expected);
  if (!ok) return json({ error: "invalid password" }, 401);

  const token = await issueSession(secret);
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
