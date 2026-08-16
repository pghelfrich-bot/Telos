// Study guide Worker entry point.
// Only /api/* requests reach here (see run_worker_first in wrangler.jsonc);
// all other paths are served from ./public/ by the static asset handler.

import { json } from "./lib.js";
import { getCourse, submitQuestion } from "./public.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }
    try {
      return await route(request, env, url);
    } catch (err) {
      console.error("unhandled error", err && err.stack ? err.stack : err);
      return json({ error: "internal error" }, 500);
    }
  },
};

async function route(request, env, url) {
  const method = request.method;
  // Path segments after /api, e.g. ["course", "biology-ab12"].
  const seg = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);

  // GET /api/course/:slug
  if (seg[0] === "course" && seg.length === 2) {
    if (method === "GET") return getCourse(env, seg[1]);
    return methodNotAllowed("GET");
  }

  // POST /api/course/:slug/questions
  if (seg[0] === "course" && seg.length === 3 && seg[2] === "questions") {
    if (method === "POST") return submitQuestion(request, env, seg[1]);
    return methodNotAllowed("POST");
  }

  return json({ error: "not found" }, 404);
}

function methodNotAllowed(allow) {
  return json({ error: "method not allowed" }, 405, { allow });
}
