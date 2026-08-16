// Shared helpers: JSON responses, text normalization, and validation.

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function badRequest(errors: string | string[], status = 400): Response {
  return json({ error: "invalid request", details: ([] as string[]).concat(errors) }, status);
}

// Read and parse a JSON request body, returning { ok, value } or { ok:false }.
export async function readJson(request: Request): Promise<{ ok: boolean; value?: Record<string, unknown> }> {
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
export function collapseSingleLine(value: unknown): string {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

// Body fields collapse horizontal whitespace within each line but keep
// paragraph breaks. Runs of three or more blank lines become one blank line.
export function collapseBody(value: unknown): string {
  const normalized = String(value == null ? "" : value).replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n").map((line) => line.replace(/[^\S\n]+/g, " ").trim());
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const MAX = 2000;

// Validate and normalize a student submission. Returns { errors, values }.
export function validateSubmission(body: Record<string, unknown>): {
  errors: string[];
  values: { name: string; topic: string; question: string; answer: string };
} {
  const values = {
    name: collapseSingleLine(body.name),
    topic: collapseSingleLine(body.topic),
    question: collapseBody(body.question),
    answer: collapseBody(body.answer),
  };
  const errors: string[] = [];
  if (values.name.length < 2) errors.push("name must be at least 2 characters");
  if (values.name.length > MAX) errors.push("name must be at most 2000 characters");
  if (values.topic.length > MAX) errors.push("topic must be at most 2000 characters");
  if (values.question.length < 10) errors.push("question must be at least 10 characters");
  if (values.question.length > MAX) errors.push("question must be at most 2000 characters");
  if (values.answer.length < 10) errors.push("answer must be at least 10 characters");
  if (values.answer.length > MAX) errors.push("answer must be at most 2000 characters");
  return { errors, values };
}

// The client IP, from the forwarded header set by Deno Deploy, falling back to
// the direct connection address. A constant fallback keeps a missing header
// from handing every caller its own unlimited bucket.
export function clientIp(request: Request, remoteAddr?: string): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  if (remoteAddr) return remoteAddr;
  return "unknown";
}

export function submissionLimit(env: Record<string, string | undefined>): number {
  const n = Number(env.RATE_LIMIT_SUBMISSIONS_PER_HOUR);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 200;
}

export function loginLimit(env: Record<string, string | undefined>): number {
  const n = Number(env.RATE_LIMIT_LOGINS_PER_HOUR);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30;
}

export const HOUR_MS = 3600 * 1000;

// The text shown in the guide: the instructor edit when present, else the
// student original.
export function effective(edited: string | null, original: string): string {
  return edited != null && edited !== "" ? edited : original;
}
