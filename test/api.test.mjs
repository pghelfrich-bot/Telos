// API tests run against a real local worker with a clean database.
// Milestone 3 covers the two public routes; later milestones extend this file.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, api } from "./server.mjs";

let srv;

// A generous ceiling so functional tests never trip the limiter; the
// dedicated rate-limit test starts its own low-ceiling worker.
before(async () => {
  srv = await startServer({ RATE_LIMIT_SUBMISSIONS_PER_HOUR: 1000, RATE_LIMIT_LOGINS_PER_HOUR: 1000 });
  srv.exec(`
    INSERT INTO courses (id, slug, title, topics, accepting, show_authors, archived) VALUES
      (1, 'bio-open', 'Intro Biology', '["Cells","Genetics"]', 1, 0, 0),
      (2, 'bio-authors', 'Cell Biology', '["Membranes"]', 1, 1, 0),
      (3, 'bio-closed', 'Closed Course', '["General"]', 0, 0, 0);
    INSERT INTO questions (course_id, author, topic, question, answer, status, released_at) VALUES
      (1, 'Ada Byron', 'Cells', 'What is the powerhouse of the cell?', 'The mitochondrion makes most of the cell ATP.', 'released', 1000),
      (1, 'Rosalind', 'Genetics', 'This pending question must stay out of the guide.', 'A pending answer students never see in the guide.', 'pending', NULL),
      (1, 'Nobody', 'Cells', 'This rejected question must never appear at all.', 'A rejected answer body that is hidden from students.', 'rejected', NULL),
      (2, 'Grace Hopper', 'Membranes', 'What controls what enters a cell?', 'The plasma membrane is selectively permeable.', 'released', 2000);
  `);
});

after(async () => {
  if (srv) await srv.stop();
});

// A submission body that passes validation, with a distinct name per test so
// rows can be looked up by name rather than by position.
function submission(overrides = {}) {
  return {
    name: "Test Student",
    topic: "Cells",
    question: "A valid question that is clearly longer than ten characters.",
    answer: "A valid answer that is also clearly longer than ten characters.",
    ...overrides,
  };
}

// The password comes from .dev.vars, which wrangler dev loads automatically.
const ADMIN_PASSWORD = "test-password-123";

// Log in and return the session cookie string for use on protected routes.
async function login(password = ADMIN_PASSWORD) {
  const res = await api(srv.baseUrl, "/api/login", { method: "POST", json: { password } });
  const setCookie = res.headers.get("set-cookie");
  return { status: res.status, data: res.data, cookie: setCookie ? setCookie.split(";")[0] : null };
}

// Create a course through the API and return its record.
async function makeCourse(cookie, body) {
  const res = await api(srv.baseUrl, "/api/courses", { method: "POST", json: body, headers: { cookie } });
  assert.equal(res.status, 201, "course creation should succeed");
  return res.data.course;
}

// Submit a question through the public route, then look it up by author on the
// instructor route so the test references it by name, not by position.
async function makeQuestion(cookie, courseId, slug, body) {
  const sub = await api(srv.baseUrl, `/api/course/${slug}/questions`, {
    method: "POST",
    json: body,
    headers: { "cf-connecting-ip": `10.10.${(counter >> 8) & 255}.${counter++ & 255}` },
  });
  assert.equal(sub.status, 201, "submission should succeed");
  const list = await api(srv.baseUrl, `/api/courses/${courseId}/questions`, { headers: { cookie } });
  return list.data.questions.find((q) => q.author === body.name);
}
let counter = 1;

test("GET /api/course/:slug returns header and released questions only", async () => {
  const res = await api(srv.baseUrl, "/api/course/bio-open");
  assert.equal(res.status, 200);
  assert.equal(res.data.title, "Intro Biology");
  assert.deepEqual(res.data.topics, ["Cells", "Genetics"]);
  assert.equal(res.data.accepting, true);
  assert.equal(res.data.show_authors, false);

  // Only the released question appears; pending and rejected are excluded.
  assert.equal(res.data.questions.length, 1);
  assert.equal(res.data.questions[0].question, "What is the powerhouse of the cell?");
  assert.equal(res.data.questions[0].topic, "Cells");
});

test("GET /api/course/:slug never exposes ids or hidden authors", async () => {
  const res = await api(srv.baseUrl, "/api/course/bio-open");
  const q = res.data.questions[0];
  assert.equal("id" in q, false);
  assert.equal("author" in q, false, "author must be hidden when show_authors is off");
  assert.equal("id" in res.data, false);
});

test("GET /api/course/:slug exposes author names when show_authors is on", async () => {
  const res = await api(srv.baseUrl, "/api/course/bio-authors");
  assert.equal(res.status, 200);
  assert.equal(res.data.show_authors, true);
  assert.equal(res.data.questions.length, 1);
  assert.equal(res.data.questions[0].author, "Grace Hopper");
});

test("GET /api/course/:slug returns 404 for an unknown slug", async () => {
  const res = await api(srv.baseUrl, "/api/course/does-not-exist");
  assert.equal(res.status, 404);
  assert.equal(res.data.error, "course not found");
});

test("POST submission stores a valid question as pending, not in the guide", async () => {
  const res = await api(srv.baseUrl, "/api/course/bio-open/questions", {
    method: "POST",
    json: submission({ name: "Valid Submitter" }),
    headers: { "cf-connecting-ip": "203.0.113.10" },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.ok, true);

  const rows = srv.exec("SELECT status FROM questions WHERE author = 'Valid Submitter';");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "pending");

  // The guide still shows only the originally released question.
  const guide = await api(srv.baseUrl, "/api/course/bio-open");
  assert.equal(guide.data.questions.length, 1);
});

test("POST rejects a name shorter than 2 characters", async () => {
  const res = await api(srv.baseUrl, "/api/course/bio-open/questions", {
    method: "POST",
    json: submission({ name: "A" }),
    headers: { "cf-connecting-ip": "203.0.113.11" },
  });
  assert.equal(res.status, 422);
  assert.match(res.data.details.join(" "), /name must be at least 2/);
});

test("POST rejects a question shorter than 10 characters", async () => {
  const res = await api(srv.baseUrl, "/api/course/bio-open/questions", {
    method: "POST",
    json: submission({ question: "too short" }),
    headers: { "cf-connecting-ip": "203.0.113.12" },
  });
  assert.equal(res.status, 422);
  assert.match(res.data.details.join(" "), /question must be at least 10/);
});

test("POST rejects an answer shorter than 10 characters", async () => {
  const res = await api(srv.baseUrl, "/api/course/bio-open/questions", {
    method: "POST",
    json: submission({ answer: "nope" }),
    headers: { "cf-connecting-ip": "203.0.113.13" },
  });
  assert.equal(res.status, 422);
  assert.match(res.data.details.join(" "), /answer must be at least 10/);
});

test("POST rejects a field longer than 2000 characters", async () => {
  const res = await api(srv.baseUrl, "/api/course/bio-open/questions", {
    method: "POST",
    json: submission({ answer: "x".repeat(2001) }),
    headers: { "cf-connecting-ip": "203.0.113.14" },
  });
  assert.equal(res.status, 422);
  assert.match(res.data.details.join(" "), /answer must be at most 2000/);
});

test("POST collapses single-line whitespace and preserves paragraph breaks", async () => {
  const res = await api(srv.baseUrl, "/api/course/bio-open/questions", {
    method: "POST",
    json: submission({
      name: "  Marie    Curie  ",
      topic: "  Cells \n biology ",
      question: "Line one   has   runs.\n\n\n\nLine two after a big gap.",
      answer: "Answer with\ttabs   and spaces.\nSecond line stays separate.",
    }),
    headers: { "cf-connecting-ip": "203.0.113.15" },
  });
  assert.equal(res.status, 201);

  const rows = srv.exec("SELECT author, topic, question, answer FROM questions WHERE author = 'Marie Curie';");
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.author, "Marie Curie");
  assert.equal(row.topic, "Cells biology");
  assert.equal(row.question, "Line one has runs.\n\nLine two after a big gap.");
  assert.equal(row.answer, "Answer with tabs and spaces.\nSecond line stays separate.");
});

test("POST returns 400 for a malformed JSON body", async () => {
  const res = await api(srv.baseUrl, "/api/course/bio-open/questions", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.16" },
    raw: "{ this is not valid json",
  });
  assert.equal(res.status, 400);
  assert.equal(res.data.error, "invalid request");
});

test("POST returns 404 for a submission to an unknown course", async () => {
  const res = await api(srv.baseUrl, "/api/course/ghost/questions", {
    method: "POST",
    json: submission(),
    headers: { "cf-connecting-ip": "203.0.113.17" },
  });
  assert.equal(res.status, 404);
});

test("POST returns 403 when the course is not accepting submissions", async () => {
  const res = await api(srv.baseUrl, "/api/course/bio-closed/questions", {
    method: "POST",
    json: submission(),
    headers: { "cf-connecting-ip": "203.0.113.18" },
  });
  assert.equal(res.status, 403);
});

test("submission rate limit triggers at the configured ceiling and is per IP", async () => {
  // A separate worker with a low, env-overridden ceiling.
  const limited = await startServer({ RATE_LIMIT_SUBMISSIONS_PER_HOUR: 3 });
  try {
    limited.exec(
      "INSERT INTO courses (id, slug, title, topics, accepting) VALUES (1, 'rl', 'Rate Course', '[]', 1);"
    );
    const body = {
      name: "Rate Tester",
      topic: "",
      question: "A valid question that clears the ten character minimum.",
      answer: "A valid answer that also clears the ten character minimum.",
    };
    const ipA = { "cf-connecting-ip": "198.51.100.1" };
    for (let i = 1; i <= 3; i++) {
      const ok = await api(limited.baseUrl, "/api/course/rl/questions", { method: "POST", json: body, headers: ipA });
      assert.equal(ok.status, 201, `submission ${i} should be accepted`);
    }
    const blocked = await api(limited.baseUrl, "/api/course/rl/questions", { method: "POST", json: body, headers: ipA });
    assert.equal(blocked.status, 429, "the 4th submission from one IP should be blocked");
    assert.ok(blocked.headers.get("retry-after"), "a Retry-After header should be present");

    // A different IP has its own bucket and is still accepted.
    const other = await api(limited.baseUrl, "/api/course/rl/questions", {
      method: "POST",
      json: body,
      headers: { "cf-connecting-ip": "198.51.100.2" },
    });
    assert.equal(other.status, 201, "a different IP should not be limited");
  } finally {
    await limited.stop();
  }
});

// --- Milestone 4: instructor routes and session auth ---

test("every protected route rejects an unauthenticated request with 401", async () => {
  const calls = [
    ["GET", "/api/courses"],
    ["POST", "/api/courses"],
    ["PATCH", "/api/courses/1"],
    ["DELETE", "/api/courses/1"],
    ["GET", "/api/courses/1/questions"],
    ["PATCH", "/api/questions/1"],
    ["POST", "/api/questions/status"],
  ];
  for (const [method, path] of calls) {
    const res = await api(srv.baseUrl, path, { method, json: method === "GET" || method === "DELETE" ? undefined : {} });
    assert.equal(res.status, 401, `${method} ${path} should require authentication`);
  }
});

test("login rejects a wrong password and accepts the correct one", async () => {
  const wrong = await login("not-the-password");
  assert.equal(wrong.status, 401);
  assert.equal(wrong.cookie, null);

  const right = await login();
  assert.equal(right.status, 200);
  assert.ok(right.cookie, "a session cookie should be issued");

  const meRes = await api(srv.baseUrl, "/api/me", { headers: { cookie: right.cookie } });
  assert.equal(meRes.data.authenticated, true);
});

test("a tampered or garbage cookie is treated as unauthenticated", async () => {
  const { cookie } = await login();
  // Flip the last character of the signature.
  const last = cookie.slice(-1) === "a" ? "b" : "a";
  const tampered = cookie.slice(0, -1) + last;

  const t = await api(srv.baseUrl, "/api/courses", { headers: { cookie: tampered } });
  assert.equal(t.status, 401, "a tampered signature must not authenticate");

  const g = await api(srv.baseUrl, "/api/courses", { headers: { cookie: "sg_session=complete-garbage" } });
  assert.equal(g.status, 401, "a garbage cookie must not authenticate");

  const meRes = await api(srv.baseUrl, "/api/me", { headers: { cookie: tampered } });
  assert.equal(meRes.data.authenticated, false);
});

test("course slugs are the title slugified plus a random hex suffix", async () => {
  const { cookie } = await login();
  const a = await makeCourse(cookie, { title: "Genetics 101" });
  const b = await makeCourse(cookie, { title: "Genetics 101" });
  assert.match(a.slug, /^genetics-101-[0-9a-f]{8}$/);
  assert.match(b.slug, /^genetics-101-[0-9a-f]{8}$/);
  assert.notEqual(a.slug, b.slug, "the random suffix must differ between courses");
});

test("an edit identical to the original is discarded server-side", async () => {
  const { cookie } = await login();
  const course = await makeCourse(cookie, { title: "Edit Rule", topics: ["General"] });
  const q = await makeQuestion(cookie, course.id, course.slug, {
    name: "Ada Original",
    topic: "General",
    question: "The original student question text goes here.",
    answer: "The original student answer text goes here.",
  });

  // An edit that matches the original is stored as null.
  const same = await api(srv.baseUrl, `/api/questions/${q.id}`, {
    method: "PATCH",
    json: { edited_question: "The original student question text goes here." },
    headers: { cookie },
  });
  assert.equal(same.status, 200);
  assert.equal(same.data.question.edited_question, null, "an identical edit must not be stored");

  // A genuine edit is kept.
  const real = await api(srv.baseUrl, `/api/questions/${q.id}`, {
    method: "PATCH",
    json: { edited_question: "A genuinely reworded instructor version of the question." },
    headers: { cookie },
  });
  assert.equal(real.data.question.edited_question, "A genuinely reworded instructor version of the question.");

  // The student original is never overwritten.
  const rows = srv.exec(`SELECT question FROM questions WHERE id = ${q.id};`);
  assert.equal(rows[0].question, "The original student question text goes here.");
});

test("re-releasing an already released question keeps its original released_at", async () => {
  const { cookie } = await login();
  const course = await makeCourse(cookie, { title: "Release Rule", topics: ["General"] });
  const q = await makeQuestion(cookie, course.id, course.slug, {
    name: "Grace Release",
    topic: "General",
    question: "A question that will be released and then re-released.",
    answer: "An answer that will be released and then re-released.",
  });

  const first = await api(srv.baseUrl, "/api/questions/status", {
    method: "POST",
    json: { ids: [q.id], status: "released" },
    headers: { cookie },
  });
  assert.equal(first.status, 200);
  const afterFirst = srv.exec(`SELECT released_at FROM questions WHERE id = ${q.id};`)[0].released_at;
  assert.ok(afterFirst, "released_at should be set on first release");

  // Re-release; released_at must not move.
  await api(srv.baseUrl, "/api/questions/status", {
    method: "POST",
    json: { ids: [q.id], status: "released" },
    headers: { cookie },
  });
  const afterSecond = srv.exec(`SELECT released_at FROM questions WHERE id = ${q.id};`)[0].released_at;
  assert.equal(afterSecond, afterFirst, "re-releasing must keep the original released_at");
});

test("a partial PATCH leaves the other fields alone", async () => {
  const { cookie } = await login();
  const course = await makeCourse(cookie, { title: "Partial Course", topics: ["Alpha", "Beta"], accepting: true });
  const q = await makeQuestion(cookie, course.id, course.slug, {
    name: "Partial Person",
    topic: "Alpha",
    question: "The original question for the partial patch test here.",
    answer: "The original answer for the partial patch test here.",
  });

  // Set an edit and a topic first.
  await api(srv.baseUrl, `/api/questions/${q.id}`, {
    method: "PATCH",
    json: { edited_question: "An edited version to preserve across a later patch.", topic: "Beta" },
    headers: { cookie },
  });

  // Now patch only notes; the edit and topic must survive.
  const res = await api(srv.baseUrl, `/api/questions/${q.id}`, {
    method: "PATCH",
    json: { notes: "A private instructor note." },
    headers: { cookie },
  });
  assert.equal(res.data.question.notes, "A private instructor note.");
  assert.equal(res.data.question.edited_question, "An edited version to preserve across a later patch.");
  assert.equal(res.data.question.topic, "Beta");

  // A partial course PATCH is the same story.
  const patched = await api(srv.baseUrl, `/api/courses/${course.id}`, {
    method: "PATCH",
    json: { accepting: false },
    headers: { cookie },
  });
  assert.equal(patched.data.course.accepting, false);
  assert.equal(patched.data.course.title, "Partial Course", "title should be untouched");
  assert.deepEqual(patched.data.course.topics, ["Alpha", "Beta"], "topics should be untouched");
});

test("archiving a course hides it from students", async () => {
  const { cookie } = await login();
  const course = await makeCourse(cookie, { title: "Soon Archived", topics: ["General"] });

  // Visible before archiving.
  const before = await api(srv.baseUrl, `/api/course/${course.slug}`);
  assert.equal(before.status, 200);

  await api(srv.baseUrl, `/api/courses/${course.id}`, {
    method: "PATCH",
    json: { archived: true },
    headers: { cookie },
  });

  const after = await api(srv.baseUrl, `/api/course/${course.slug}`);
  assert.equal(after.status, 404, "an archived course must be hidden from students");

  const submit = await api(srv.baseUrl, `/api/course/${course.slug}/questions`, {
    method: "POST",
    json: submission(),
    headers: { "cf-connecting-ip": "10.20.30.40" },
  });
  assert.equal(submit.status, 404, "an archived course must not accept submissions");
});

test("DELETE removes a course and its questions", async () => {
  const { cookie } = await login();
  const course = await makeCourse(cookie, { title: "Delete Me", topics: ["General"] });
  const q = await makeQuestion(cookie, course.id, course.slug, {
    name: "Doomed Author",
    topic: "General",
    question: "A question that should be deleted with its course here.",
    answer: "An answer that should be deleted with its course here.",
  });

  const del = await api(srv.baseUrl, `/api/courses/${course.id}`, { method: "DELETE", headers: { cookie } });
  assert.equal(del.status, 200);

  const gone = srv.exec(`SELECT COUNT(*) AS n FROM questions WHERE id = ${q.id};`);
  assert.equal(gone[0].n, 0, "the course's questions should be gone");
  const courseGone = srv.exec(`SELECT COUNT(*) AS n FROM courses WHERE id = ${course.id};`);
  assert.equal(courseGone[0].n, 0);
});

test("logout clears the session", async () => {
  const { cookie } = await login();
  const ok = await api(srv.baseUrl, "/api/courses", { headers: { cookie } });
  assert.equal(ok.status, 200);

  const out = await api(srv.baseUrl, "/api/logout", { method: "POST", headers: { cookie } });
  assert.equal(out.status, 200);
  const cleared = out.headers.get("set-cookie");
  assert.match(cleared, /Max-Age=0/, "logout should expire the cookie");
});
