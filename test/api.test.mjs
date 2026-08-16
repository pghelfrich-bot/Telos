// API tests run against a real local worker with a clean database.
// Milestone 3 covers the two public routes; later milestones extend this file.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, api } from "./server.mjs";

let srv;

// A generous ceiling so functional tests never trip the limiter; the
// dedicated rate-limit test starts its own low-ceiling worker.
before(async () => {
  srv = await startServer({ RATE_LIMIT_SUBMISSIONS_PER_HOUR: 1000 });
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
