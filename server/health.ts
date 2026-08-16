// A storage health probe. It writes a marker to KV once, then reports it on
// every request. If a durable KV database is attached, the marker is created on
// the very first request and stays identical afterwards. If no database is
// attached, each isolate gets its own ephemeral store, so the marker keeps
// being recreated and changes between requests: the signature of data that will
// not persist.

import { json } from "./lib.ts";
import { listCourses } from "./store.ts";
import type { Ctx } from "./types.ts";

export async function health(ctx: Ctx): Promise<Response> {
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
    note:
      "Reload this a few times. If marker stays the same and marker_created_this_request is false, storage is durable. If the marker keeps changing, no KV database is attached to this deployment.",
  });
}
