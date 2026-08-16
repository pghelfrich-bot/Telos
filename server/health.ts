// Health endpoints.
//
// The public one is a pure liveness check: it touches no storage and reveals
// nothing about the contents of the deployment, so it is safe to hit anonymously.
//
// The storage probe is for the instructor and sits behind a session. It writes a
// marker once, then reports it on every request. With a durable KV database
// attached, the marker is created on the first request and stays identical
// afterwards. With no database attached, each isolate gets its own ephemeral
// store, so the marker keeps changing: the signature of data that will not
// persist.

import { json } from "./lib.ts";
import { sessionSecret } from "./auth.ts";
import { listCourses } from "./store.ts";
import type { Ctx } from "./types.ts";

// GET /api/health (public)
export function liveness(): Response {
  return json({ ok: true });
}

// GET /api/storage-check (instructor only)
export async function storageCheck(ctx: Ctx): Promise<Response> {
  const key = ["health", "marker"];
  const cur = await ctx.kv.get<string>(key);
  let marker = cur.value;
  let createdThisRequest = false;
  if (!marker) {
    marker = crypto.randomUUID();
    await ctx.kv.set(key, marker);
    createdThisRequest = true;
  }
  const courseCount = (await listCourses(ctx.kv)).length;
  return json({
    ok: true,
    storage: "connected",
    marker,
    marker_created_this_request: createdThisRequest,
    course_count: courseCount,
    session_secret_configured: sessionSecret(ctx.env) !== null,
    note:
      "Reload this a few times. If marker stays the same and marker_created_this_request is false, storage is durable. If the marker keeps changing, no KV database is attached to this deployment.",
  });
}
