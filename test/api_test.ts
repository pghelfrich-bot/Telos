// API tests run the real handler in-process over a fresh in-memory KV.
// No server, no ports: each test builds the app, exercises it, and closes.

import assert from "./assert.ts";
import { collapseSingleLine } from "../server/lib.ts";
import { ADMIN_PASSWORD, type App, type Client, newApp } from "./helpers.ts";

// --- small helpers ---

async function login(c: Client, password = ADMIN_PASSWORD) {
  return c.call("POST", "/api/login", { json: { password } });
}

async function makeCourse(c: Client, body: Record<string, unknown>) {
  const res = await c.call("POST", "/api/courses", { json: body });
  assert.equal(res.status, 201, "course creation should succeed");
  return res.data.course;
}

// Submit through the public route, then find the question by author on the
// instructor route so tests reference records by name, not position.
async function makeQuestion(c: Client, courseId: number, slug: string, body: Record<string, unknown>, ip = "203.0.113.5") {
  const sub = await c.call("POST", `/api/course/${slug}/questions`, { json: body, headers: { "x-forwarded-for": ip } });
  assert.equal(sub.status, 201, "submission should succeed");
  const list = await c.call("GET", `/api/courses/${courseId}/questions`);
  const wanted = collapseSingleLine(body.name);
  return list.data.questions.find((q: any) => q.author === wanted);
}

function submission(overrides: Record<string, unknown> = {}) {
  return {
    name: "Test Student",
    topic: "Cells",
    question: "A valid question that is clearly longer than ten characters.",
    answer: "A valid answer that is also clearly longer than ten characters.",
    ...overrides,
  };
}

async function withApp(over: Record<string, string>, fn: (app: App) => Promise<void>) {
  const app = await newApp(over);
  try {
    await fn(app);
  } finally {
    app.close();
  }
}

// Seed a course with a released, a pending, and a rejected question, plus a
// second course with authors shown.
async function seedGuide(c: Client) {
  await login(c);
  const course = await makeCourse(c, { title: "Intro Biology", topics: ["Cells", "Genetics"] });
  const released = await makeQuestion(c, course.id, course.slug, {
    name: "Ada Byron", topic: "Cells",
    question: "What is the powerhouse of the cell?",
    answer: "The mitochondrion makes most of the cell ATP.",
  }, "203.0.113.10");
  await makeQuestion(c, course.id, course.slug, {
    name: "Rosalind", topic: "Genetics",
    question: "This pending question must stay out of the guide.",
    answer: "A pending answer students never see in the guide.",
  }, "203.0.113.11");
  const rejected = await makeQuestion(c, course.id, course.slug, {
    name: "Nobody", topic: "Cells",
    question: "This rejected question must never appear at all.",
    answer: "A rejected answer body that is hidden from students.",
  }, "203.0.113.12");
  await c.call("POST", "/api/questions/status", { json: { ids: [released.id], status: "released" } });
  await c.call("POST", "/api/questions/status", { json: { ids: [rejected.id], status: "rejected" } });
  return course;
}

// --- Milestone 3: public routes ---

Deno.test("GET course returns header and released questions only", () =>
  withApp({}, async ({ client }) => {
    const course = await seedGuide(client);
    const res = await client.call("GET", `/api/course/${course.slug}`);
    assert.equal(res.status, 200);
    assert.equal(res.data.title, "Intro Biology");
    assert.deepEqual(res.data.topics, ["Cells", "Genetics"]);
    assert.equal(res.data.accepting, true);
    assert.equal(res.data.show_authors, false);
    assert.equal(res.data.questions.length, 1);
    assert.equal(res.data.questions[0].question, "What is the powerhouse of the cell?");
    assert.equal(res.data.questions[0].topic, "Cells");
  }));

Deno.test("GET course never exposes ids or hidden authors", () =>
  withApp({}, async ({ client }) => {
    const course = await seedGuide(client);
    const res = await client.call("GET", `/api/course/${course.slug}`);
    const q = res.data.questions[0];
    assert.equal("id" in q, false);
    assert.equal("author" in q, false);
    assert.equal("id" in res.data, false);
  }));

Deno.test("GET course exposes authors when show_authors is on", () =>
  withApp({}, async ({ client }) => {
    await login(client);
    const course = await makeCourse(client, { title: "Cell Biology", topics: ["Membranes"], show_authors: true });
    const q = await makeQuestion(client, course.id, course.slug, {
      name: "Grace Hopper", topic: "Membranes",
      question: "What controls what enters a cell?",
      answer: "The plasma membrane is selectively permeable.",
    });
    await client.call("POST", "/api/questions/status", { json: { ids: [q.id], status: "released" } });
    const res = await client.call("GET", `/api/course/${course.slug}`);
    assert.equal(res.data.show_authors, true);
    assert.equal(res.data.questions[0].author, "Grace Hopper");
  }));

Deno.test("GET course returns 404 for an unknown slug", () =>
  withApp({}, async ({ client }) => {
    const res = await client.call("GET", "/api/course/does-not-exist");
    assert.equal(res.status, 404);
    assert.equal(res.data.error, "course not found");
  }));

Deno.test("POST stores a valid question as pending, not in the guide", () =>
  withApp({}, async ({ client }) => {
    await login(client);
    const course = await makeCourse(client, { title: "Submit Course", topics: ["Cells"] });
    const q = await makeQuestion(client, course.id, course.slug, submission({ name: "Valid Submitter" }));
    assert.equal(q.status, "pending");
    const guide = await client.call("GET", `/api/course/${course.slug}`);
    assert.equal(guide.data.questions.length, 0);
  }));

Deno.test("POST rejects invalid submissions", () =>
  withApp({}, async ({ client }) => {
    await login(client);
    const course = await makeCourse(client, { title: "Valid Course", topics: ["Cells"] });
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ name: "A" }, /name must be at least 2/],
      [{ question: "too short" }, /question must be at least 10/],
      [{ answer: "nope" }, /answer must be at least 10/],
      [{ answer: "x".repeat(2001) }, /answer must be at most 2000/],
    ];
    for (const [over, re] of cases) {
      const res = await client.call("POST", `/api/course/${course.slug}/questions`, { json: submission(over) });
      assert.equal(res.status, 422);
      assertMatch(res.data.details.join(" "), re);
    }
  }));

function assertMatch(s: string, re: RegExp) {
  assert.ok(re.test(s), `expected ${JSON.stringify(s)} to match ${re}`);
}

Deno.test("POST collapses single-line whitespace and preserves paragraph breaks", () =>
  withApp({}, async ({ client }) => {
    await login(client);
    const course = await makeCourse(client, { title: "Whitespace Course", topics: ["Cells"] });
    const q = await makeQuestion(client, course.id, course.slug, {
      name: "  Marie    Curie  ",
      topic: "  Cells \n biology ",
      question: "Line one   has   runs.\n\n\n\nLine two after a big gap.",
      answer: "Answer with\ttabs   and spaces.\nSecond line stays separate.",
    });
    assert.equal(q.author, "Marie Curie");
    assert.equal(q.topic, "Cells biology");
    assert.equal(q.question, "Line one has runs.\n\nLine two after a big gap.");
    assert.equal(q.answer, "Answer with tabs and spaces.\nSecond line stays separate.");
  }));

Deno.test("POST returns 400 for a malformed JSON body", () =>
  withApp({}, async ({ client }) => {
    await login(client);
    const course = await makeCourse(client, { title: "Bad JSON Course", topics: [] });
    const res = await client.call("POST", `/api/course/${course.slug}/questions`, {
      headers: { "content-type": "application/json" },
      raw: "{ not valid json",
    });
    assert.equal(res.status, 400);
  }));

Deno.test("POST returns 404 for an unknown course and 403 when closed", () =>
  withApp({}, async ({ client }) => {
    const ghost = await client.call("POST", "/api/course/ghost/questions", { json: submission() });
    assert.equal(ghost.status, 404);

    await login(client);
    const course = await makeCourse(client, { title: "Closed Course", topics: [], accepting: false });
    const closed = await client.call("POST", `/api/course/${course.slug}/questions`, { json: submission() });
    assert.equal(closed.status, 403);
  }));

Deno.test("submission rate limit triggers at the ceiling and is per IP", () =>
  withApp({ RATE_LIMIT_SUBMISSIONS_PER_HOUR: "3" }, async ({ client }) => {
    await login(client);
    const course = await makeCourse(client, { title: "Rate Course", topics: [] });
    const body = submission();
    for (let i = 1; i <= 3; i++) {
      const ok = await client.call("POST", `/api/course/${course.slug}/questions`, {
        json: body, headers: { "x-forwarded-for": "198.51.100.1" },
      });
      assert.equal(ok.status, 201, `submission ${i} should be accepted`);
    }
    const blocked = await client.call("POST", `/api/course/${course.slug}/questions`, {
      json: body, headers: { "x-forwarded-for": "198.51.100.1" },
    });
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers.get("retry-after"));

    const other = await client.call("POST", `/api/course/${course.slug}/questions`, {
      json: body, headers: { "x-forwarded-for": "198.51.100.2" },
    });
    assert.equal(other.status, 201, "a different IP has its own bucket");
  }));

// --- Milestone 4: instructor routes and auth ---

Deno.test("every protected route rejects an unauthenticated request", () =>
  withApp({}, async ({ client }) => {
    const calls: [string, string][] = [
      ["GET", "/api/courses"],
      ["POST", "/api/courses"],
      ["PATCH", "/api/courses/1"],
      ["DELETE", "/api/courses/1"],
      ["GET", "/api/courses/1/questions"],
      ["PATCH", "/api/questions/1"],
      ["POST", "/api/questions/status"],
    ];
    for (const [method, path] of calls) {
      const res = await client.call(method, path, method === "GET" || method === "DELETE" ? {} : { json: {} });
      assert.equal(res.status, 401, `${method} ${path} should require auth`);
    }
  }));

Deno.test("login rejects a wrong password and accepts the correct one", () =>
  withApp({}, async ({ client }) => {
    const wrong = await login(client, "nope");
    assert.equal(wrong.status, 401);
    const right = await login(client);
    assert.equal(right.status, 200);
    const me = await client.call("GET", "/api/me");
    assert.equal(me.data.authenticated, true);
  }));

Deno.test("a tampered or garbage cookie is unauthenticated", () =>
  withApp({}, async ({ client }) => {
    await login(client);
    const good = client.cookie();
    const last = good.slice(-1) === "a" ? "b" : "a";
    const tampered = good.slice(0, -1) + last;
    const t = await client.call("GET", "/api/courses", { headers: { cookie: tampered } });
    assert.equal(t.status, 401);
    const g = await client.call("GET", "/api/courses", { headers: { cookie: "sg_session=garbage" } });
    assert.equal(g.status, 401);
  }));

Deno.test("course slugs are slugified title plus a random hex suffix", () =>
  withApp({}, async ({ client }) => {
    await login(client);
    const a = await makeCourse(client, { title: "Genetics 101" });
    const b = await makeCourse(client, { title: "Genetics 101" });
    assertMatch(a.slug, /^genetics-101-[0-9a-f]{8}$/);
    assertMatch(b.slug, /^genetics-101-[0-9a-f]{8}$/);
    assert.notEqual(a.slug, b.slug);
  }));

Deno.test("an edit identical to the original is discarded", () =>
  withApp({}, async ({ client }) => {
    await login(client);
    const course = await makeCourse(client, { title: "Edit Rule", topics: ["General"] });
    const q = await makeQuestion(client, course.id, course.slug, {
      name: "Ada Original", topic: "General",
      question: "The original student question text goes here.",
      answer: "The original student answer text goes here.",
    });
    const same = await client.call("PATCH", `/api/questions/${q.id}`, {
      json: { edited_question: "The original student question text goes here." },
    });
    assert.equal(same.data.question.edited_question, null);
    const real = await client.call("PATCH", `/api/questions/${q.id}`, {
      json: { edited_question: "A genuinely reworded instructor version of the question." },
    });
    assert.equal(real.data.question.edited_question, "A genuinely reworded instructor version of the question.");
    assert.equal(real.data.question.question, "The original student question text goes here.");
  }));

Deno.test("re-releasing keeps the original released_at", () =>
  withApp({}, async ({ client }) => {
    await login(client);
    const course = await makeCourse(client, { title: "Release Rule", topics: ["General"] });
    const q = await makeQuestion(client, course.id, course.slug, {
      name: "Grace Release", topic: "General",
      question: "A question that will be released and then re-released.",
      answer: "An answer that will be released and then re-released.",
    });
    await client.call("POST", "/api/questions/status", { json: { ids: [q.id], status: "released" } });
    const first = (await client.call("GET", `/api/courses/${course.id}/questions`))
      .data.questions.find((x: any) => x.id === q.id).released_at;
    assert.ok(first);
    await client.call("POST", "/api/questions/status", { json: { ids: [q.id], status: "released" } });
    const second = (await client.call("GET", `/api/courses/${course.id}/questions`))
      .data.questions.find((x: any) => x.id === q.id).released_at;
    assert.equal(second, first);
  }));

Deno.test("a partial PATCH leaves the other fields alone", () =>
  withApp({}, async ({ client }) => {
    await login(client);
    const course = await makeCourse(client, { title: "Partial Course", topics: ["Alpha", "Beta"] });
    const q = await makeQuestion(client, course.id, course.slug, {
      name: "Partial Person", topic: "Alpha",
      question: "The original question for the partial patch test here.",
      answer: "The original answer for the partial patch test here.",
    });
    await client.call("PATCH", `/api/questions/${q.id}`, {
      json: { edited_question: "An edited version to preserve across a later patch.", topic: "Beta" },
    });
    const res = await client.call("PATCH", `/api/questions/${q.id}`, { json: { notes: "A private note." } });
    assert.equal(res.data.question.notes, "A private note.");
    assert.equal(res.data.question.edited_question, "An edited version to preserve across a later patch.");
    assert.equal(res.data.question.topic, "Beta");

    const patched = await client.call("PATCH", `/api/courses/${course.id}`, { json: { accepting: false } });
    assert.equal(patched.data.course.accepting, false);
    assert.equal(patched.data.course.title, "Partial Course");
    assert.deepEqual(patched.data.course.topics, ["Alpha", "Beta"]);
  }));

Deno.test("archiving hides a course from students", () =>
  withApp({}, async ({ client }) => {
    await login(client);
    const course = await makeCourse(client, { title: "Soon Archived", topics: ["General"] });
    assert.equal((await client.call("GET", `/api/course/${course.slug}`)).status, 200);
    await client.call("PATCH", `/api/courses/${course.id}`, { json: { archived: true } });
    assert.equal((await client.call("GET", `/api/course/${course.slug}`)).status, 404);
    const submit = await client.call("POST", `/api/course/${course.slug}/questions`, { json: submission() });
    assert.equal(submit.status, 404);
  }));

Deno.test("DELETE removes a course and its questions", () =>
  withApp({}, async ({ client }) => {
    await login(client);
    const course = await makeCourse(client, { title: "Delete Me", topics: ["General"] });
    const q = await makeQuestion(client, course.id, course.slug, {
      name: "Doomed Author", topic: "General",
      question: "A question that should be deleted with its course.",
      answer: "An answer that should be deleted with its course.",
    });
    const del = await client.call("DELETE", `/api/courses/${course.id}`);
    assert.equal(del.status, 200);
    const gone = await client.call("GET", `/api/course/${course.slug}`);
    assert.equal(gone.status, 404);
    const list = await client.call("GET", `/api/courses/${course.id}/questions`);
    assert.equal(list.status, 404);
    void q;
  }));

Deno.test("logout clears the session", () =>
  withApp({}, async ({ client }) => {
    await login(client);
    assert.equal((await client.call("GET", "/api/courses")).status, 200);
    const out = await client.call("POST", "/api/logout");
    assertMatch(out.headers.get("set-cookie") || "", /Max-Age=0/);
    assert.equal((await client.call("GET", "/api/me")).data.authenticated, false);
    assert.equal((await client.call("GET", "/api/courses")).status, 401);
  }));

// --- Milestone 5: exports ---

async function seedExport(client: Client) {
  await login(client);
  const course = await makeCourse(client, { title: "Export Course", topics: ["Beta", "Alpha"] });
  async function q(name: string, topic: string, question: string, answer: string, status: string) {
    const rec = await makeQuestion(client, course.id, course.slug, { name, topic, question, answer });
    if (status !== "pending") {
      await client.call("POST", "/api/questions/status", { json: { ids: [rec.id], status } });
    }
    return rec;
  }
  await q("Alpha Author", "Alpha", "Alpha released question, with a comma.", "Alpha answer body text here.", "released");
  await q("Beta Author", "Beta", 'Beta released with a "quote" inside.', "Beta answer body text here.", "released");
  await q("Gamma Author", "Gamma", "Gamma extra topic released question here.", "Gamma answer body text here.", "released");
  const rej = await q("Rejected Author", "Alpha", "Rejected secret question text ZZZ here.", "Rejected answer body text.", "rejected");
  await client.call("PATCH", `/api/questions/${rej.id}`, { json: { notes: "a private note, with comma" } });
  await q("Pending Author", "Alpha", "Pending hidden question text QQQ here.", "Pending answer body text here.", "pending");
  return course;
}

Deno.test("export requires authentication", () =>
  withApp({}, async ({ client }) => {
    const course = await seedExport(client);
    await client.call("POST", "/api/logout");
    const res = await client.call("GET", `/api/courses/${course.id}/export?format=md`);
    assert.equal(res.status, 401);
  }));

Deno.test("Markdown export orders topics as configured and excludes rejected", () =>
  withApp({}, async ({ client }) => {
    const course = await seedExport(client);
    const res = await client.call("GET", `/api/courses/${course.id}/export?format=md`);
    assert.equal(res.status, 200);
    assertMatch(res.headers.get("content-type") || "", /text\/markdown/);
    const md = res.text;
    assert.ok(md.includes("Alpha released question, with a comma."));
    assert.ok(md.includes('Beta released with a "quote" inside.'));
    assert.ok(md.includes("Gamma extra topic released question here."));
    assert.ok(!md.includes("Rejected secret question text ZZZ"));
    assert.ok(!md.includes("Pending hidden question text QQQ"));
    const iBeta = md.indexOf("## Beta"), iAlpha = md.indexOf("## Alpha"), iGamma = md.indexOf("## Gamma");
    assert.ok(iBeta >= 0 && iAlpha >= 0 && iGamma >= 0);
    assert.ok(iBeta < iAlpha, "configured order Beta before Alpha");
    assert.ok(iAlpha < iGamma, "extras appended after configured");
  }));

Deno.test("CSV export includes every question with notes and quotes commas and quotes", () =>
  withApp({}, async ({ client }) => {
    const course = await seedExport(client);
    const res = await client.call("GET", `/api/courses/${course.id}/export?format=csv`);
    assert.equal(res.status, 200);
    assertMatch(res.headers.get("content-type") || "", /text\/csv/);
    const csv = res.text;
    assert.ok(csv.includes("Rejected secret question text ZZZ here."));
    assert.ok(csv.includes('"a private note, with comma"'));
    assert.ok(csv.includes('"Alpha released question, with a comma."'));
    assert.ok(csv.includes('"Beta released with a ""quote"" inside."'));
  }));

Deno.test("export rejects an unknown format", () =>
  withApp({}, async ({ client }) => {
    const course = await seedExport(client);
    const res = await client.call("GET", `/api/courses/${course.id}/export?format=pdf`);
    assert.equal(res.status, 422);
  }));

// --- static serving / SPA fallback ---

Deno.test("the server serves the SPA shell for a student route", () =>
  withApp({}, async ({ handler }) => {
    const res = await handler(new Request("http://localhost/c/anything"));
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('id="app"'));
  }));

// --- storage health probe ---

Deno.test("the health probe reports durable storage with a stable marker", () =>
  withApp({}, async ({ client }) => {
    const first = await client.call("GET", "/api/health");
    assert.equal(first.status, 200);
    assert.equal(first.data.marker_created_this_request, true);
    const second = await client.call("GET", "/api/health");
    assert.equal(second.data.marker, first.data.marker, "marker is stable on durable storage");
    assert.equal(second.data.marker_created_this_request, false);
  }));
