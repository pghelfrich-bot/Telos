// Study guide Worker entry point.
// Only /api/* requests reach here (see run_worker_first in wrangler.jsonc);
// all other paths are served from ./public/ by the static asset handler.

import { json } from "./lib.js";
import { getCourse, submitQuestion } from "./public.js";
import { login, logout, me, hasSession } from "./auth.js";
import {
  listCourses,
  createCourse,
  updateCourse,
  deleteCourse,
  listQuestions,
  updateQuestion,
  bulkStatus,
} from "./admin.js";
import { exportCourse } from "./exports.js";

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
  const seg = url.pathname
    .replace(/^\/api\/?/, "")
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);

  // --- Public routes ---

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

  // --- Auth routes ---

  if (seg[0] === "login" && seg.length === 1) {
    if (method === "POST") return login(request, env);
    return methodNotAllowed("POST");
  }
  if (seg[0] === "logout" && seg.length === 1) {
    if (method === "POST") return logout(request);
    return methodNotAllowed("POST");
  }
  if (seg[0] === "me" && seg.length === 1) {
    if (method === "GET") return me(request, env);
    return methodNotAllowed("GET");
  }

  // --- Protected instructor routes ---

  const protectedMatch = matchProtected(seg);
  if (protectedMatch) {
    if (!(await hasSession(request, env))) {
      return json({ error: "authentication required" }, 401);
    }
    return protectedMatch(request, env, url, method);
  }

  return json({ error: "not found" }, 404);
}

// Returns a handler for a protected route, or null when the path is not one.
function matchProtected(seg) {
  // /api/courses
  if (seg[0] === "courses" && seg.length === 1) {
    return (request, env, url, method) => {
      if (method === "GET") return listCourses(env);
      if (method === "POST") return createCourse(request, env);
      return methodNotAllowed("GET, POST");
    };
  }

  // /api/courses/:id  and  /api/courses/:id/(questions|export)
  if (seg[0] === "courses" && seg.length >= 2) {
    const id = Number(seg[1]);
    if (!Number.isInteger(id) || id <= 0) return null;

    if (seg.length === 2) {
      return (request, env, url, method) => {
        if (method === "PATCH") return updateCourse(request, env, id);
        if (method === "DELETE") return deleteCourse(env, id);
        return methodNotAllowed("PATCH, DELETE");
      };
    }
    if (seg.length === 3 && seg[2] === "questions") {
      return (request, env, url, method) => {
        if (method === "GET") return listQuestions(request, env, id, url);
        return methodNotAllowed("GET");
      };
    }
    if (seg.length === 3 && seg[2] === "export") {
      return (request, env, url, method) => {
        if (method === "GET") return exportCourse(env, id, url);
        return methodNotAllowed("GET");
      };
    }
    return null;
  }

  // /api/questions/status  (bulk) must be checked before /api/questions/:id
  if (seg[0] === "questions" && seg.length === 2 && seg[1] === "status") {
    return (request, env, url, method) => {
      if (method === "POST") return bulkStatus(request, env);
      return methodNotAllowed("POST");
    };
  }

  // /api/questions/:id
  if (seg[0] === "questions" && seg.length === 2) {
    const id = Number(seg[1]);
    if (!Number.isInteger(id) || id <= 0) return null;
    return (request, env, url, method) => {
      if (method === "PATCH") return updateQuestion(request, env, id);
      return methodNotAllowed("PATCH");
    };
  }

  return null;
}

function methodNotAllowed(allow) {
  return json({ error: "method not allowed" }, 405, { allow });
}
