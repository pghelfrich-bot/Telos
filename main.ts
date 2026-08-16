// Entry point for local dev and Deno Deploy. Opens the built-in KV store,
// reads configuration from the environment, and serves the app.

import { createHandler } from "./server/handler.ts";

const kv = await Deno.openKv();
const env = Deno.env.toObject();
const handler = createHandler({ kv, env, staticRoot: "public" });

Deno.serve(handler);
