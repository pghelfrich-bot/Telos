// Instructor routes. Every handler here runs only behind a valid session
// (enforced by the router). Ids are visible to the instructor; they are never
// exposed on the public routes.

import { json, badRequest, readJson, collapseSingleLine, collapseBody, parseTopics } from "./lib.js";

const MAX_TITLE = 200;
const MAX_TEXT = 2000;
const MAX_NOTES = 5000;
const STATUSES = ["pending", "released", "rejected"];

// A URL-safe slug from the title plus a random hex suffix. The suffix is what
// keeps the course page unguessable, so it must come from a CSPRNG.
function slugify(title) {
  const base = String(title)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "course";
}

function randomSuffix() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizeTopics(value) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const t = collapseSingleLine(item).slice(0, MAX_TITLE);
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

function courseView(row, pendingCount) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    topics: parseTopics(row.topics),
    accepting: !!row.accepting,
    show_authors: !!row.show_authors,
    archived: !!row.archived,
    created_at: row.created_at,
    pending_count: pendingCount,
  };
}

// GET /api/courses
export async function listCourses(env) {
  const rows = await env.DB.prepare(
    `SELECT c.*,
            (SELECT COUNT(*) FROM questions q WHERE q.course_id = c.id AND q.status = 'pending') AS pending_count
       FROM courses c
       ORDER BY c.archived ASC, c.created_at DESC`
  ).all();
  return json({ courses: rows.results.map((r) => courseView(r, r.pending_count)) });
}

// POST /api/courses
export async function createCourse(request, env) {
  const body = await readJson(request);
  if (!body.ok) return badRequest("request body must be a JSON object");

  const title = collapseSingleLine(body.value.title);
  if (title.length < 1) return badRequest("title is required", 422);
  if (title.length > MAX_TITLE) return badRequest("title must be at most 200 characters", 422);

  const topics = body.value.topics === undefined ? [] : normalizeTopics(body.value.topics);
  if (topics === null) return badRequest("topics must be an array of strings", 422);

  const accepting = body.value.accepting === undefined ? 1 : body.value.accepting ? 1 : 0;
  const showAuthors = body.value.show_authors ? 1 : 0;

  // Retry on the astronomically unlikely slug collision.
  let created = null;
  for (let attempt = 0; attempt < 5 && !created; attempt++) {
    const slug = `${slugify(title)}-${randomSuffix()}`;
    try {
      created = await env.DB.prepare(
        `INSERT INTO courses (slug, title, topics, accepting, show_authors)
           VALUES (?, ?, ?, ?, ?)
           RETURNING *`
      )
        .bind(slug, title, JSON.stringify(topics), accepting, showAuthors)
        .first();
    } catch (err) {
      if (!String(err).includes("UNIQUE")) throw err;
    }
  }
  if (!created) return json({ error: "could not allocate a unique slug" }, 500);
  return json({ course: courseView(created, 0) }, 201);
}

async function loadCourse(env, id) {
  return env.DB.prepare(`SELECT * FROM courses WHERE id = ?`).bind(id).first();
}

// PATCH /api/courses/:id
export async function updateCourse(request, env, id) {
  const course = await loadCourse(env, id);
  if (!course) return json({ error: "course not found" }, 404);

  const body = await readJson(request);
  if (!body.ok) return badRequest("request body must be a JSON object");
  const v = body.value;

  const sets = [];
  const args = [];

  if (v.title !== undefined) {
    const title = collapseSingleLine(v.title);
    if (title.length < 1 || title.length > MAX_TITLE) return badRequest("title must be 1 to 200 characters", 422);
    sets.push("title = ?");
    args.push(title);
  }
  if (v.topics !== undefined) {
    const topics = normalizeTopics(v.topics);
    if (topics === null) return badRequest("topics must be an array of strings", 422);
    sets.push("topics = ?");
    args.push(JSON.stringify(topics));
  }
  if (v.accepting !== undefined) {
    sets.push("accepting = ?");
    args.push(v.accepting ? 1 : 0);
  }
  if (v.show_authors !== undefined) {
    sets.push("show_authors = ?");
    args.push(v.show_authors ? 1 : 0);
  }
  if (v.archived !== undefined) {
    sets.push("archived = ?");
    args.push(v.archived ? 1 : 0);
  }

  if (sets.length === 0) return badRequest("no updatable fields provided", 422);

  const updated = await env.DB.prepare(`UPDATE courses SET ${sets.join(", ")} WHERE id = ? RETURNING *`)
    .bind(...args, id)
    .first();
  return json({ course: courseView(updated, 0) });
}

// DELETE /api/courses/:id
export async function deleteCourse(env, id) {
  const course = await loadCourse(env, id);
  if (!course) return json({ error: "course not found" }, 404);
  // Delete questions first so removal does not depend on foreign-key cascade
  // being enabled in the local engine.
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM questions WHERE course_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM courses WHERE id = ?`).bind(id),
  ]);
  return json({ ok: true });
}

function questionView(r) {
  return {
    id: r.id,
    course_id: r.course_id,
    author: r.author,
    topic: r.topic,
    question: r.question,
    answer: r.answer,
    edited_question: r.edited_question,
    edited_answer: r.edited_answer,
    status: r.status,
    notes: r.notes,
    created_at: r.created_at,
    released_at: r.released_at,
  };
}

// GET /api/courses/:id/questions?status=
export async function listQuestions(request, env, id, url) {
  const course = await loadCourse(env, id);
  if (!course) return json({ error: "course not found" }, 404);

  const status = url.searchParams.get("status");
  let stmt;
  if (status) {
    if (!STATUSES.includes(status)) return badRequest("unknown status filter", 422);
    stmt = env.DB.prepare(
      `SELECT * FROM questions WHERE course_id = ? AND status = ? ORDER BY created_at DESC`
    ).bind(id, status);
  } else {
    stmt = env.DB.prepare(`SELECT * FROM questions WHERE course_id = ? ORDER BY created_at DESC`).bind(id);
  }
  const rows = await stmt.all();
  return json({ questions: rows.results.map(questionView) });
}

// PATCH /api/questions/:id
// Updates topic, instructor edits, and private notes. An edit whose text
// matches the student original is discarded so the edited_* columns cannot be
// filled with a duplicate of the original.
export async function updateQuestion(request, env, id) {
  const q = await env.DB.prepare(`SELECT * FROM questions WHERE id = ?`).bind(id).first();
  if (!q) return json({ error: "question not found" }, 404);

  const body = await readJson(request);
  if (!body.ok) return badRequest("request body must be a JSON object");
  const v = body.value;

  const sets = [];
  const args = [];

  if (v.topic !== undefined) {
    sets.push("topic = ?");
    args.push(collapseSingleLine(v.topic).slice(0, MAX_TITLE));
  }
  if (v.edited_question !== undefined) {
    const edited = collapseBody(v.edited_question);
    // Discard an edit that is empty or identical to the original.
    const value = edited === "" || edited === q.question ? null : edited.slice(0, MAX_TEXT);
    sets.push("edited_question = ?");
    args.push(value);
  }
  if (v.edited_answer !== undefined) {
    const edited = collapseBody(v.edited_answer);
    const value = edited === "" || edited === q.answer ? null : edited.slice(0, MAX_TEXT);
    sets.push("edited_answer = ?");
    args.push(value);
  }
  if (v.notes !== undefined) {
    sets.push("notes = ?");
    args.push(String(v.notes == null ? "" : v.notes).slice(0, MAX_NOTES));
  }

  if (sets.length === 0) return badRequest("no updatable fields provided", 422);

  const updated = await env.DB.prepare(`UPDATE questions SET ${sets.join(", ")} WHERE id = ? RETURNING *`)
    .bind(...args, id)
    .first();
  return json({ question: questionView(updated) });
}

// POST /api/questions/status
// Bulk status change. Releasing sets released_at only when it is not already
// set, so re-releasing an already-released question keeps its original
// timestamp and the guide does not reorder on a typo fix.
export async function bulkStatus(request, env) {
  const body = await readJson(request);
  if (!body.ok) return badRequest("request body must be a JSON object");

  const { ids, status } = body.value;
  if (!Array.isArray(ids) || ids.length === 0) return badRequest("ids must be a non-empty array", 422);
  const cleanIds = ids.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0);
  if (cleanIds.length === 0) return badRequest("ids must be positive integers", 422);
  if (!STATUSES.includes(status)) return badRequest("status must be pending, released, or rejected", 422);

  const now = Date.now();
  const placeholders = cleanIds.map(() => "?").join(",");
  let sql;
  let args;
  if (status === "released") {
    sql = `UPDATE questions
             SET status = 'released',
                 released_at = COALESCE(released_at, ?)
             WHERE id IN (${placeholders})`;
    args = [now, ...cleanIds];
  } else {
    // Leave released_at intact so a later re-release keeps the first timestamp.
    sql = `UPDATE questions SET status = ? WHERE id IN (${placeholders})`;
    args = [status, ...cleanIds];
  }
  const res = await env.DB.prepare(sql).bind(...args).run();
  return json({ ok: true, updated: res.meta.changes });
}
