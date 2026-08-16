// Entry point for local dev and Deno Deploy. Opens the built-in KV store,
// reads configuration from the environment, and serves the app.

import { createHandler } from "./server/handler.ts";

// Open KV lazily on the first API request rather than at module load, so a
// deploy still warms up and serves pages even before a KV store is attached.
const handler = createHandler({
  openKv: () => Deno.openKv(),
  env: Deno.env.toObject(),
  staticRoot: "public",
});

Deno.serve(handler);

