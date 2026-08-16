// Request handler: static assets with a single-page-application fallback, and
// the /api routes. Built by createHandler so tests can supply an in-memory KV
// and a fake environment.

import { clientIp, json } from "./lib.ts";
import { getCourse, submitQuestion } from "./public.ts";
import { hasSession, login, logout, me } from "./auth.ts";
import {
  bulkStatusRoute,
  createCourseRoute,
  deleteCourseRoute,
  listCoursesRoute,
  listQuestionsRoute,
  updateCourseRoute,
  updateQuestionRoute,
} from "./admin.ts";
import { exportCourse } from "./exports.ts";
import type { Ctx } from "./types.ts";

export interface HandlerOptions {
  // Either a ready KV instance (tests) or a function that opens one lazily
  // (production, so a missing KV does not crash warm-up on module load).
  kv?: Deno.Kv;
  openKv?: () => Promise<Deno.Kv>;
  env: Record<string, string | undefined>;
  staticRoot?: string;
}

export type Handler = (request: Request, info?: Deno.ServeHandlerInfo) => Promise<Response>;

export function createHandler(opts: HandlerOptions): Handler {
  const staticRoot = opts.staticRoot ?? "public";

  let kvPromise: Promise<Deno.Kv> | null = null;
  function getKv(): Promise<Deno.Kv> {
    if (opts.kv) return Promise.resolve(opts.kv);
    if (!opts.openKv) throw new Error("createHandler needs kv or openKv");
    if (!kvPromise) {
      // Cache the promise, but drop it on failure so a later request retries.
      kvPromise = opts.openKv().catch((err) => {
        kvPromise = null;
        throw err;
      });
    }
    return kvPromise;
  }

  return async function handler(request: Request, info?: Deno.ServeHandlerInfo): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      let kv: Deno.Kv;
      try {
        kv = await getKv();
      } catch (err) {
        console.error("storage unavailable", err);
        return json({ error: "storage is not configured" }, 503);
      }
      const addr = info?.remoteAddr as Deno.NetAddr | undefined;
      const ctx: Ctx = { kv, env: opts.env, ip: clientIp(request, addr?.hostname) };
      try {
        return await route(request, ctx, url);
      } catch (err) {
        console.error("unhandled error", err);
        return json({ error: "internal error" }, 500);
      }
    }

    // Static files, falling back to index.html for client-side routes like
    // /c/:slug so the single page app can handle them.
    return serveStatic(url, staticRoot);
  };
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  ico: "image/x-icon",
  webp: "image/webp",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
};

function contentType(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

async function indexHtml(staticRoot: string): Promise<Response> {
  const html = await Deno.readFile(`${staticRoot}/index.html`);
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

async function serveStatic(url: URL, staticRoot: string): Promise<Response> {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  // Reject path traversal; anything unresolved falls back to the SPA shell.
  if (pathname.includes("..") || !pathname.startsWith("/")) {
    return indexHtml(staticRoot);
  }
  try {
    const data = await Deno.readFile(`${staticRoot}${pathname}`);
    return new Response(data, { headers: { "content-type": contentType(pathname) } });
  } catch {
    // Unknown path: hand it to the single page app.
    return indexHtml(staticRoot);
  }
}

function methodNotAllowed(allow: string): Response {
  return json({ error: "method not allowed" }, 405, { allow });
}

async function route(request: Request, ctx: Ctx, url: URL): Promise<Response> {
  const method = request.method;
  const seg = url.pathname
    .replace(/^\/api\/?/, "")
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);

  // --- Public routes ---
  if (seg[0] === "course" && seg.length === 2) {
    if (method === "GET") return getCourse(ctx, seg[1]);
    return methodNotAllowed("GET");
  }
  if (seg[0] === "course" && seg.length === 3 && seg[2] === "questions") {
    if (method === "POST") return submitQuestion(request, ctx, seg[1]);
    return methodNotAllowed("POST");
  }

  // --- Auth routes ---
  if (seg[0] === "login" && seg.length === 1) {
    if (method === "POST") return login(request, ctx);
    return methodNotAllowed("POST");
  }
  if (seg[0] === "logout" && seg.length === 1) {
    if (method === "POST") return logout(request);
    return methodNotAllowed("POST");
  }
  if (seg[0] === "me" && seg.length === 1) {
    if (method === "GET") return me(request, ctx);
    return methodNotAllowed("GET");
  }

  // --- Protected instructor routes ---
  const protectedHandler = matchProtected(seg);
  if (protectedHandler) {
    if (!(await hasSession(request, ctx))) {
      return json({ error: "authentication required" }, 401);
    }
    return protectedHandler(request, ctx, url, method);
  }

  return json({ error: "not found" }, 404);
}

type ProtectedHandler = (request: Request, ctx: Ctx, url: URL, method: string) => Promise<Response> | Response;

function matchProtected(seg: string[]): ProtectedHandler | null {
  // /api/courses
  if (seg[0] === "courses" && seg.length === 1) {
    return (request, ctx, _url, method) => {
      if (method === "GET") return listCoursesRoute(ctx);
      if (method === "POST") return createCourseRoute(request, ctx);
      return methodNotAllowed("GET, POST");
    };
  }

  // /api/courses/:id and /api/courses/:id/(questions|export)
  if (seg[0] === "courses" && seg.length >= 2) {
    const id = Number(seg[1]);
    if (!Number.isInteger(id) || id <= 0) return null;

    if (seg.length === 2) {
      return (request, ctx, _url, method) => {
        if (method === "PATCH") return updateCourseRoute(request, ctx, id);
        if (method === "DELETE") return deleteCourseRoute(ctx, id);
        return methodNotAllowed("PATCH, DELETE");
      };
    }
    if (seg.length === 3 && seg[2] === "questions") {
      return (_request, ctx, url, method) => {
        if (method === "GET") return listQuestionsRoute(ctx, id, url);
        return methodNotAllowed("GET");
      };
    }
    if (seg.length === 3 && seg[2] === "export") {
      return (_request, ctx, url, method) => {
        if (method === "GET") return exportCourse(ctx, id, url);
        return methodNotAllowed("GET");
      };
    }
    return null;
  }

  // /api/questions/status must be checked before /api/questions/:id
  if (seg[0] === "questions" && seg.length === 2 && seg[1] === "status") {
    return (request, ctx, _url, method) => {
      if (method === "POST") return bulkStatusRoute(request, ctx);
      return methodNotAllowed("POST");
    };
  }

  // /api/questions/:id
  if (seg[0] === "questions" && seg.length === 2) {
    const id = Number(seg[1]);
    if (!Number.isInteger(id) || id <= 0) return null;
    return (request, ctx, _url, method) => {
      if (method === "PATCH") return updateQuestionRoute(request, ctx, id);
      return methodNotAllowed("PATCH");
    };
  }

  return null;
}
