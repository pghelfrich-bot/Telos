// Test harness: boots a real local Worker with a clean D1 database, applies
// migrations, and exposes helpers to talk to it over HTTP. Tests run against
// this worker, not mocks.

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Call the installed wrangler binary directly to avoid npx resolution on every
// spawn, which matters because each database seed shells out fresh.
const WRANGLER = join(root, "node_modules", ".bin", "wrangler");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// Start a worker with an isolated, freshly-migrated database. Pass vars to
// override wrangler vars (for example a low rate-limit ceiling).
export async function startServer(vars = {}) {
  const persistDir = mkdtempSync(join(tmpdir(), "studyguide-"));
  const port = await freePort();

  const migrate = spawnSync(
    WRANGLER,
    ["d1", "migrations", "apply", "study-guide", "--local", "--persist-to", persistDir],
    { cwd: root, encoding: "utf8" }
  );
  if (migrate.status !== 0) {
    rmSync(persistDir, { recursive: true, force: true });
    throw new Error("migration failed:\n" + migrate.stdout + migrate.stderr);
  }

  const args = [
    "dev",
    "--local",
    "--persist-to",
    persistDir,
    "--port",
    String(port),
    "--ip",
    "127.0.0.1",
  ];
  for (const [k, v] of Object.entries(vars)) {
    args.push("--var", `${k}:${v}`);
  }

  // detached so the worker and its workerd child share a process group we can
  // signal as a unit; otherwise workerd survives and keeps the runner alive.
  const child = spawn(WRANGLER, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let logs = "";
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl + "/", { method: "GET" });
      if (res.ok) break;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (Date.now() >= deadline) {
    child.kill("SIGKILL");
    rmSync(persistDir, { recursive: true, force: true });
    throw new Error("worker did not become ready:\n" + logs);
  }

  // Run SQL against the same database the worker uses. Returns the parsed
  // results array from the first statement, or [] when there are no rows.
  function exec(sql) {
    const res = spawnSync(
      WRANGLER,
      ["d1", "execute", "study-guide", "--local", "--persist-to", persistDir, "--json", "--command", sql],
      { cwd: root, encoding: "utf8" }
    );
    if (res.status !== 0) {
      throw new Error("exec failed:\n" + res.stdout + res.stderr);
    }
    try {
      const parsed = JSON.parse(res.stdout);
      return parsed[0] && parsed[0].results ? parsed[0].results : [];
    } catch {
      return [];
    }
  }

  async function stop() {
    // Kill the whole process group so workerd dies with the wrangler wrapper.
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    child.stdout.destroy();
    child.stderr.destroy();
    await new Promise((r) => setTimeout(r, 200));
    rmSync(persistDir, { recursive: true, force: true });
  }

  return { baseUrl, exec, stop, logs: () => logs };
}

// Convenience wrapper around fetch that parses JSON and returns status + body.
export async function api(baseUrl, path, options = {}) {
  const headers = { ...(options.headers || {}) };
  let body = options.body;
  if (options.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  }
  if (options.raw !== undefined) {
    body = options.raw;
  }
  const res = await fetch(baseUrl + path, { method: options.method || "GET", headers, body });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { status: res.status, data, text, headers: res.headers };
}

// Escape a string for embedding in a single-quoted SQL literal.
export function sqlStr(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}
