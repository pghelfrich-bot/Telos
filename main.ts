// Entry point for local dev and Deno Deploy. Opens the built-in KV store,
// reads configuration from the environment, and serves the app.

import { createHandler } from "./server/handler.ts";
import { adminPassword, sessionSecret } from "./server/auth.ts";

const env = Deno.env.toObject();

// Say plainly at startup when sign in cannot work, so a misconfigured deploy is
// obvious in the logs instead of failing quietly later.
if (!adminPassword(env)) {
  console.error("ADMIN_PASSWORD is not set. Instructor sign in is disabled until it is.");
}
if (!sessionSecret(env)) {
  console.error(
    "SESSION_SECRET is missing or too short (need at least 16 characters). Instructor sign in is disabled until it is set.",
  );
}

// Open KV lazily on the first API request rather than at module load, so a
// deploy still warms up and serves pages even before a KV store is attached.
const handler = createHandler({
  openKv: () => Deno.openKv(),
  env,
  staticRoot: "public",
});

Deno.serve(handler);

