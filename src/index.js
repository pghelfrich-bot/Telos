// Study guide Worker entry point.
// Only /api/* requests reach here (see run_worker_first in wrangler.jsonc);
// all other paths are served from ./public/ by the static asset handler.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    // Fallback: hand anything else to the asset handler if it ever arrives here.
    return env.ASSETS.fetch(request);
  },
};
