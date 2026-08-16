// Public routes: the student-facing guide and the submission form.

import {
  badRequest,
  effective,
  HOUR_MS,
  json,
  readJson,
  submissionLimit,
  validateSubmission,
} from "./lib.ts";
import { createQuestion, enforceRateLimit, getCourseBySlug, listQuestions } from "./store.ts";
import { readLimit, throttle } from "./throttle.ts";
import type { Ctx } from "./types.ts";

// GET /api/course/:slug
// Returns the course header and its released questions only. Never exposes
// internal ids, and only exposes author names when show_authors is on.
export async function getCourse(ctx: Ctx, slug: string): Promise<Response> {
  // Reading the guide scans every question in the course, so blunt a client
  // hammering this endpoint before doing the work.
  const rl = throttle(`read:${ctx.ip}`, readLimit(ctx.env), HOUR_MS);
  if (!rl.allowed) {
    return json({ error: "too many requests, try again shortly" }, 429, {
      "retry-after": String(rl.retryAfter),
    });
  }

  const course = await getCourseBySlug(ctx.kv, slug);
  if (!course || course.archived) {
    return json({ error: "course not found" }, 404);
  }

  const questions = (await listQuestions(ctx.kv, course.id))
    .filter((q) => q.status === "released")
    .sort((a, b) => (b.released_at || 0) - (a.released_at || 0) || b.created_at - a.created_at)
    .map((r) => {
      const q: Record<string, unknown> = {
        topic: r.topic,
        question: effective(r.edited_question, r.question),
        answer: effective(r.edited_answer, r.answer),
      };
      if (course.show_authors) q.author = r.author;
      return q;
    });

  return json({
    title: course.title,
    topics: course.topics,
    accepting: course.accepting,
    show_authors: course.show_authors,
    questions,
  });
}

// POST /api/course/:slug/questions
// Accepts a student submission after validation and rate limiting.
export async function submitQuestion(request: Request, ctx: Ctx, slug: string): Promise<Response> {
  const course = await getCourseBySlug(ctx.kv, slug);
  if (!course || course.archived) {
    return json({ error: "course not found" }, 404);
  }
  if (!course.accepting) {
    return json({ error: "this course is not accepting submissions" }, 403);
  }

  const limit = submissionLimit(ctx.env);
  const rl = await enforceRateLimit(ctx.kv, `submit:${ctx.ip}`, limit, HOUR_MS);
  if (!rl.allowed) {
    return json({ error: "too many submissions, try again later" }, 429, {
      "retry-after": String(rl.retryAfter),
    });
  }

  const body = await readJson(request);
  if (!body.ok) {
    return badRequest("request body must be a JSON object");
  }

  const { errors, values } = validateSubmission(body.value!);
  if (errors.length) {
    return badRequest(errors, 422);
  }

  await createQuestion(ctx.kv, {
    course_id: course.id,
    author: values.name,
    topic: values.topic,
    question: values.question,
    answer: values.answer,
  });

  return json({ ok: true }, 201);
}
