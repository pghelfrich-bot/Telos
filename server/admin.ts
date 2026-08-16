// Instructor routes. Every handler here runs only behind a valid session
// (enforced by the router).

import { badRequest, collapseBody, collapseSingleLine, json, readJson } from "./lib.ts";
import {
  createCourse,
  deleteCourse as deleteCourseRow,
  getCourse,
  getQuestion,
  listCourses,
  listQuestions,
  saveCourse,
  saveQuestion,
  type Course,
  type Question,
  type Status,
} from "./store.ts";
import type { Ctx } from "./types.ts";

const MAX_TITLE = 200;
const MAX_TEXT = 2000;
const MAX_NOTES = 5000;
const STATUSES: Status[] = ["pending", "released", "rejected"];

// A URL-safe slug from the title plus a random hex suffix. The suffix is what
// keeps the course page unguessable, so it must come from a CSPRNG.
function slugify(title: string): string {
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

function randomSuffix(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function slugFor(title: string): string {
  return `${slugify(title)}-${randomSuffix()}`;
}

function normalizeTopics(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const t = collapseSingleLine(item).slice(0, MAX_TITLE);
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

async function courseView(ctx: Ctx, c: Course) {
  const pending = (await listQuestions(ctx.kv, c.id)).filter((q) => q.status === "pending").length;
  return {
    id: c.id,
    slug: c.slug,
    title: c.title,
    topics: c.topics,
    accepting: c.accepting,
    show_authors: c.show_authors,
    archived: c.archived,
    created_at: c.created_at,
    pending_count: pending,
  };
}

function questionView(r: Question) {
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

// GET /api/courses
export async function listCoursesRoute(ctx: Ctx): Promise<Response> {
  const courses = await listCourses(ctx.kv);
  const views = [];
  for (const c of courses) views.push(await courseView(ctx, c));
  return json({ courses: views });
}

// POST /api/courses
export async function createCourseRoute(request: Request, ctx: Ctx): Promise<Response> {
  const body = await readJson(request);
  if (!body.ok) return badRequest("request body must be a JSON object");
  const v = body.value!;

  const title = collapseSingleLine(v.title);
  if (title.length < 1) return badRequest("title is required", 422);
  if (title.length > MAX_TITLE) return badRequest("title must be at most 200 characters", 422);

  const topics = v.topics === undefined ? [] : normalizeTopics(v.topics);
  if (topics === null) return badRequest("topics must be an array of strings", 422);

  const accepting = v.accepting === undefined ? true : !!v.accepting;
  const showAuthors = !!v.show_authors;

  const created = await createCourse(ctx.kv, { title, topics, accepting, show_authors: showAuthors }, slugFor);
  if (!created) return json({ error: "could not allocate a unique slug" }, 500);
  return json({ course: await courseView(ctx, created) }, 201);
}

// PATCH /api/courses/:id
export async function updateCourseRoute(request: Request, ctx: Ctx, id: number): Promise<Response> {
  const course = await getCourse(ctx.kv, id);
  if (!course) return json({ error: "course not found" }, 404);

  const body = await readJson(request);
  if (!body.ok) return badRequest("request body must be a JSON object");
  const v = body.value!;

  let changed = false;
  if (v.title !== undefined) {
    const title = collapseSingleLine(v.title);
    if (title.length < 1 || title.length > MAX_TITLE) return badRequest("title must be 1 to 200 characters", 422);
    course.title = title;
    changed = true;
  }
  if (v.topics !== undefined) {
    const topics = normalizeTopics(v.topics);
    if (topics === null) return badRequest("topics must be an array of strings", 422);
    course.topics = topics;
    changed = true;
  }
  if (v.accepting !== undefined) {
    course.accepting = !!v.accepting;
    changed = true;
  }
  if (v.show_authors !== undefined) {
    course.show_authors = !!v.show_authors;
    changed = true;
  }
  if (v.archived !== undefined) {
    course.archived = !!v.archived;
    changed = true;
  }
  if (!changed) return badRequest("no updatable fields provided", 422);

  await saveCourse(ctx.kv, course);
  return json({ course: await courseView(ctx, course) });
}

// DELETE /api/courses/:id
export async function deleteCourseRoute(ctx: Ctx, id: number): Promise<Response> {
  const course = await getCourse(ctx.kv, id);
  if (!course) return json({ error: "course not found" }, 404);
  await deleteCourseRow(ctx.kv, course);
  return json({ ok: true });
}

// GET /api/courses/:id/questions?status=
export async function listQuestionsRoute(ctx: Ctx, id: number, url: URL): Promise<Response> {
  const course = await getCourse(ctx.kv, id);
  if (!course) return json({ error: "course not found" }, 404);

  const status = url.searchParams.get("status");
  if (status && !STATUSES.includes(status as Status)) {
    return badRequest("unknown status filter", 422);
  }

  let questions = await listQuestions(ctx.kv, id);
  if (status) questions = questions.filter((q) => q.status === status);
  questions.sort((a, b) => b.created_at - a.created_at);
  return json({ questions: questions.map(questionView) });
}

// PATCH /api/questions/:id
// Updates topic, instructor edits, and private notes. An edit whose text
// matches the student original is discarded so the edited_* columns cannot be
// filled with a duplicate of the original.
export async function updateQuestionRoute(request: Request, ctx: Ctx, id: number): Promise<Response> {
  const q = await getQuestion(ctx.kv, id);
  if (!q) return json({ error: "question not found" }, 404);

  const body = await readJson(request);
  if (!body.ok) return badRequest("request body must be a JSON object");
  const v = body.value!;

  if (v.topic !== undefined) {
    q.topic = collapseSingleLine(v.topic).slice(0, MAX_TITLE);
  }
  if (v.edited_question !== undefined) {
    const edited = collapseBody(v.edited_question);
    q.edited_question = edited === "" || edited === q.question ? null : edited.slice(0, MAX_TEXT);
  }
  if (v.edited_answer !== undefined) {
    const edited = collapseBody(v.edited_answer);
    q.edited_answer = edited === "" || edited === q.answer ? null : edited.slice(0, MAX_TEXT);
  }
  if (v.notes !== undefined) {
    q.notes = String(v.notes == null ? "" : v.notes).slice(0, MAX_NOTES);
  }

  await saveQuestion(ctx.kv, q);
  return json({ question: questionView(q) });
}

// POST /api/questions/status
// Bulk status change. Releasing sets released_at only when it is not already
// set, so re-releasing an already-released question keeps its original
// timestamp and the guide does not reorder on a typo fix.
export async function bulkStatusRoute(request: Request, ctx: Ctx): Promise<Response> {
  const body = await readJson(request);
  if (!body.ok) return badRequest("request body must be a JSON object");
  const { ids, status } = body.value! as { ids?: unknown; status?: unknown };

  if (!Array.isArray(ids) || ids.length === 0) return badRequest("ids must be a non-empty array", 422);
  const cleanIds = ids.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0);
  if (cleanIds.length === 0) return badRequest("ids must be positive integers", 422);
  if (typeof status !== "string" || !STATUSES.includes(status as Status)) {
    return badRequest("status must be pending, released, or rejected", 422);
  }

  const now = Date.now();
  let updated = 0;
  for (const id of cleanIds) {
    const q = await getQuestion(ctx.kv, id);
    if (!q) continue;
    q.status = status as Status;
    if (status === "released" && q.released_at == null) q.released_at = now;
    await saveQuestion(ctx.kv, q);
    updated++;
  }
  return json({ ok: true, updated });
}
