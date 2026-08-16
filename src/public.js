// Public routes: the student-facing guide and the submission form.

import {
  json,
  badRequest,
  readJson,
  validateSubmission,
  clientIp,
  enforceRateLimit,
  submissionLimit,
  HOUR_MS,
  parseTopics,
  effective,
} from "./lib.js";

// GET /api/course/:slug
// Returns the course header and its released questions only. Never exposes
// internal ids, and only exposes author names when show_authors is on.
export async function getCourse(env, slug) {
  const course = await env.DB.prepare(
    `SELECT id, title, topics, accepting, show_authors, archived
       FROM courses WHERE slug = ?`
  )
    .bind(slug)
    .first();

  if (!course || course.archived) {
    return json({ error: "course not found" }, 404);
  }

  const rows = await env.DB.prepare(
    `SELECT topic, author, question, answer, edited_question, edited_answer
       FROM questions
       WHERE course_id = ? AND status = 'released'
       ORDER BY released_at DESC, created_at DESC`
  )
    .bind(course.id)
    .all();

  const showAuthors = !!course.show_authors;
  const questions = rows.results.map((r) => {
    const q = {
      topic: r.topic,
      question: effective(r.edited_question, r.question),
      answer: effective(r.edited_answer, r.answer),
    };
    if (showAuthors) q.author = r.author;
    return q;
  });

  return json({
    title: course.title,
    topics: parseTopics(course.topics),
    accepting: !!course.accepting,
    show_authors: showAuthors,
    questions,
  });
}

// POST /api/course/:slug/questions
// Accepts a student submission after validation and rate limiting.
export async function submitQuestion(request, env, slug) {
  const course = await env.DB.prepare(
    `SELECT id, accepting, archived FROM courses WHERE slug = ?`
  )
    .bind(slug)
    .first();

  if (!course || course.archived) {
    return json({ error: "course not found" }, 404);
  }
  if (!course.accepting) {
    return json({ error: "this course is not accepting submissions" }, 403);
  }

  const limit = submissionLimit(env);
  const rl = await enforceRateLimit(env, `submit:${clientIp(request)}`, limit, HOUR_MS);
  if (!rl.allowed) {
    return json({ error: "too many submissions, try again later" }, 429, {
      "retry-after": String(rl.retryAfter),
    });
  }

  const body = await readJson(request);
  if (!body.ok) {
    return badRequest("request body must be a JSON object");
  }

  const { errors, values } = validateSubmission(body.value);
  if (errors.length) {
    return badRequest(errors, 422);
  }

  await env.DB.prepare(
    `INSERT INTO questions (course_id, author, topic, question, answer)
       VALUES (?, ?, ?, ?, ?)`
  )
    .bind(course.id, values.name, values.topic, values.question, values.answer)
    .run();

  return json({ ok: true }, 201);
}
