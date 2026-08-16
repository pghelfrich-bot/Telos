// Shared helpers: JSON responses, text normalization, validation, rate limiting.

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function badRequest(errors, status = 400) {
  return json({ error: "invalid request", details: [].concat(errors) }, status);
}

// Read and parse a JSON request body, returning { ok, value } or { ok:false }.
export async function readJson(request) {
  try {
    const value = await request.json();
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false };
    }
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

// Single-line fields collapse every run of whitespace to one space.
export function collapseSingleLine(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

// Body fields collapse horizontal whitespace within each line but keep
// paragraph breaks. Runs of three or more blank lines become one blank line.
export function collapseBody(value) {
  const normalized = String(value == null ? "" : value).replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n").map((line) => line.replace(/[^\S\n]+/g, " ").trim());
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const MAX = 2000;

// Validate and normalize a student submission. Returns { errors, values }.
export function validateSubmission(body) {
  const values = {
    name: collapseSingleLine(body.name),
    topic: collapseSingleLine(body.topic),
    question: collapseBody(body.question),
    answer: collapseBody(body.answer),
  };
  const errors = [];
  if (values.name.length < 2) errors.push("name must be at least 2 characters");
  if (values.name.length > MAX) errors.push("name must be at most 2000 characters");
  if (values.topic.length > MAX) errors.push("topic must be at most 2000 characters");
  if (values.question.length < 10) errors.push("question must be at least 10 characters");
  if (values.question.length > MAX) errors.push("question must be at most 2000 characters");
  if (values.answer.length < 10) errors.push("answer must be at least 10 characters");
  if (values.answer.length > MAX) errors.push("answer must be at most 2000 characters");
  return { errors, values };
}

// The client IP, from Cloudflare's header in production or the forwarded
// header in local dev. Falls back to a constant so a missing header does not
// hand every caller a distinct unlimited bucket.
export function clientIp(request) {
  const cf = request.headers.get("cf-connecting-ip");
  if (cf) return cf;
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return "unknown";
}

// Fixed-window rate limit backed by the rate_limits table. Atomically resets
// or increments and returns the new count in one statement so concurrent
// requests cannot both read a stale count.
export async function enforceRateLimit(env, key, limit, windowMs) {
  const now = Date.now();
  const resetAt = now + windowMs;
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, reset_at)
       VALUES (?1, 1, ?2)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN rate_limits.reset_at <= ?3 THEN 1 ELSE rate_limits.count + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= ?3 THEN ?2 ELSE rate_limits.reset_at END
       RETURNING count, reset_at`
  )
    .bind(key, resetAt, now)
    .first();
  return {
    allowed: row.count <= limit,
    retryAfter: Math.max(1, Math.ceil((row.reset_at - now) / 1000)),
  };
}

export function submissionLimit(env) {
  const n = Number(env.RATE_LIMIT_SUBMISSIONS_PER_HOUR);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 200;
}

export function loginLimit(env) {
  const n = Number(env.RATE_LIMIT_LOGINS_PER_HOUR);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30;
}

export const HOUR_MS = 3600 * 1000;

// Parse the topics JSON array stored as text, tolerating bad data.
export function parseTopics(text) {
  try {
    const parsed = JSON.parse(text || "[]");
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}

// The text shown in the guide: the instructor edit when present, else the
// student original.
export function effective(edited, original) {
  return edited != null && edited !== "" ? edited : original;
}
