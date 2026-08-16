// UI tests load the real public/ files into jsdom and point them at a running
// worker. Fixtures are seeded through named records, not by position.
// Milestone 6 covers the student view; milestone 7 extends this file.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { startServer, api } from "./server.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function pub(name) {
  return readFileSync(join(root, "public", name), "utf8");
}
const SCRIPTS = ["dom.js", "student.js", "admin.js", "app.js"];

let srv;
before(async () => {
  srv = await startServer({ RATE_LIMIT_SUBMISSIONS_PER_HOUR: 1000, RATE_LIMIT_LOGINS_PER_HOUR: 1000 });
});
after(async () => {
  if (srv) await srv.stop();
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, timeout = 6000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(25);
  }
  throw new Error("waitFor timed out: " + (last && last.message ? last.message : String(last)));
}

// Load index.html into jsdom at the given path, inject the real public scripts,
// and route the page's fetch calls to the running worker. A per-page cookie jar
// carries the session, since node's fetch has none, and transient connection
// resets are retried.
function loadPage(path) {
  const jar = new Map();
  const pageFetch = async (input, init) => {
    const url = new URL(input, srv.baseUrl);
    const opts = init ? { ...init } : {};
    const headers = new Headers(opts.headers || {});
    if (jar.size) headers.set("cookie", [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; "));
    opts.headers = headers;

    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(url, opts);
        break;
      } catch (err) {
        if (attempt >= 5) throw err;
        await sleep(200);
      }
    }

    const setCookies =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : res.headers.get("set-cookie")
        ? [res.headers.get("set-cookie")]
        : [];
    for (const sc of setCookies) {
      const pair = sc.split(";")[0];
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (/max-age=0/i.test(sc)) jar.delete(name);
      else jar.set(name, value);
    }
    return res;
  };

  const dom = new JSDOM(pub("index.html"), {
    url: srv.baseUrl + path,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = pageFetch;
    },
  });
  const { document } = dom.window;
  for (const name of SCRIPTS) {
    const tag = document.createElement("script");
    tag.textContent = pub(name);
    document.body.appendChild(tag);
  }
  return dom;
}

// Seed a course with named, released questions across two topics.
function seedGuideCourse(slug) {
  srv.exec(
    `INSERT INTO courses (slug, title, topics, accepting, show_authors) VALUES ('${slug}', 'UI Biology', '["Cells","Genetics"]', 1, 0);`
  );
  const cid = srv.exec(`SELECT id FROM courses WHERE slug = '${slug}';`)[0].id;
  srv.exec(
    `INSERT INTO questions (course_id, author, topic, question, answer, status, released_at) VALUES
      (${cid}, 'Cell Author', 'Cells', 'What is the mitochondrion known for?', 'It is the powerhouse of the cell.', 'released', 100),
      (${cid}, 'Gene Author', 'Genetics', 'What molecule carries genetic information?', 'DNA carries genetic information.', 'released', 200),
      (${cid}, 'Cell Author Two', 'Cells', 'What surrounds and protects the cell?', 'The cell membrane surrounds it.', 'released', 150);`
  );
  return { slug, cid };
}

function cardByQuestion(doc, text) {
  return Array.prototype.find.call(doc.querySelectorAll(".card"), function (c) {
    const q = c.querySelector(".question");
    return q && q.textContent === text;
  });
}

test("the worker serves the SPA shell for a student route", async () => {
  const res = await fetch(srv.baseUrl + "/c/anything");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('id="app"'), "the app root should be served");
});

test("the student guide renders released questions grouped into cards", async () => {
  seedGuideCourse("ui-render");
  const dom = loadPage("/c/ui-render");
  const doc = dom.window.document;
  await waitFor(() => (doc.querySelectorAll(".card").length === 3 ? true : null));

  assert.ok(cardByQuestion(doc, "What is the mitochondrion known for?"), "the mitochondrion question renders");
  // Questions are set through textContent, so the serif class is applied to a
  // real text node with the exact submitted text.
  const q = doc.querySelector(".question");
  assert.equal(q.className, "question");
});

test("an answer stays hidden until its reveal is clicked", async () => {
  seedGuideCourse("ui-reveal");
  const dom = loadPage("/c/ui-reveal");
  const doc = dom.window.document;
  await waitFor(() => (doc.querySelector(".card") ? true : null));

  const card = cardByQuestion(doc, "What is the mitochondrion known for?");
  const answer = card.querySelector(".answer");
  const reveal = card.querySelector(".reveal");
  assert.equal(answer.hidden, true, "answer starts hidden");

  reveal.click();
  assert.equal(answer.hidden, false, "answer shows after reveal");
  reveal.click();
  assert.equal(answer.hidden, true, "answer hides again on a second click");
});

test("the topic filter narrows the visible cards", async () => {
  seedGuideCourse("ui-filter");
  const dom = loadPage("/c/ui-filter");
  const doc = dom.window.document;
  await waitFor(() => (doc.querySelectorAll(".card").length === 3 ? true : null));

  // The Cells chip shows its count of two.
  const cellsChip = Array.prototype.find.call(doc.querySelectorAll(".chip"), function (c) {
    return c.getAttribute("data-topic") === "Cells";
  });
  assert.ok(cellsChip.textContent.includes("(2)"), "the Cells chip shows a count of 2");

  // Filtering to Genetics leaves the one Genetics card and hides the two Cells.
  const geneChip = Array.prototype.find.call(doc.querySelectorAll(".chip"), function (c) {
    return c.getAttribute("data-topic") === "Genetics";
  });
  geneChip.click();

  const visible = Array.prototype.filter.call(doc.querySelectorAll(".card"), function (c) {
    return !c.hidden;
  });
  assert.equal(visible.length, 1);
  assert.equal(visible[0].getAttribute("data-topic"), "Genetics");
});

test("a submission from the form reaches the database", async () => {
  seedGuideCourse("ui-submit");
  const dom = loadPage("/c/ui-submit");
  const doc = dom.window.document;
  await waitFor(() => (doc.querySelector(".submit-form") ? true : null));

  const form = doc.querySelector(".submit-form");
  form.querySelector('[name="name"]').value = "Jsdom Student";
  form.querySelector('[name="topic"]').value = "Cells";
  form.querySelector('[name="question"]').value = "A genuine question typed into the form for the test.";
  form.querySelector('[name="answer"]').value = "A genuine answer typed into the form for the test.";
  form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));

  const success = await waitFor(() => {
    const s = doc.querySelector(".form-success");
    return s && !s.hidden ? s : null;
  });
  assert.ok(success.textContent.length > 0, "a success message is shown");

  const rows = srv.exec("SELECT status, question FROM questions WHERE author = 'Jsdom Student';");
  assert.equal(rows.length, 1, "the submission was stored");
  assert.equal(rows[0].status, "pending");
});

test("a validation failure surfaces as a visible error", async () => {
  seedGuideCourse("ui-invalid");
  const dom = loadPage("/c/ui-invalid");
  const doc = dom.window.document;
  await waitFor(() => (doc.querySelector(".submit-form") ? true : null));

  const form = doc.querySelector(".submit-form");
  form.querySelector('[name="name"]').value = "Bad Submitter";
  form.querySelector('[name="topic"]').value = "Cells";
  form.querySelector('[name="question"]').value = "A long enough question for the test here.";
  form.querySelector('[name="answer"]').value = "no"; // too short
  form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));

  const error = await waitFor(() => {
    const e = doc.querySelector(".form-error");
    return e && !e.hidden ? e : null;
  });
  assert.match(error.textContent, /answer must be at least 10/);

  const rows = srv.exec("SELECT COUNT(*) AS n FROM questions WHERE author = 'Bad Submitter';");
  assert.equal(rows[0].n, 0, "an invalid submission is not stored");
});

// --- Milestone 7: instructor console ---

const ADMIN_PASSWORD = "test-password-123";

// Seed a course with a named pending question for the console to review.
function seedConsoleCourse(slug) {
  srv.exec(`INSERT INTO courses (slug, title, topics, accepting) VALUES ('${slug}', 'Console Course', '["General"]', 1);`);
  const cid = srv.exec(`SELECT id FROM courses WHERE slug = '${slug}';`)[0].id;
  srv.exec(
    `INSERT INTO questions (course_id, author, topic, question, answer, status) VALUES
      (${cid}, 'Queue Student', 'General', 'A pending question awaiting review in the console.', 'A pending answer awaiting review in the console.', 'pending');`
  );
  return { slug, cid };
}

function qcardByAuthor(doc, author) {
  return Array.prototype.find.call(doc.querySelectorAll(".qcard"), function (c) {
    const a = c.querySelector(".q-author");
    return a && a.textContent === author;
  });
}

test("the instructor signs in, edits and releases a question, then signs out", async () => {
  seedConsoleCourse("console-flow");
  const dom = loadPage("/");
  const doc = dom.window.document;

  // The console starts at a login form.
  await waitFor(() => (doc.querySelector(".login-form") ? true : null));

  // A wrong password surfaces an error and does not sign in.
  doc.querySelector('[name="password"]').value = "wrong-password";
  doc.querySelector(".login-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  const loginError = await waitFor(() => {
    const e = doc.querySelector(".login-error");
    return e && !e.hidden ? e : null;
  });
  assert.match(loginError.textContent, /Incorrect password/);

  // The correct password reveals the course list.
  doc.querySelector('[name="password"]').value = ADMIN_PASSWORD;
  doc.querySelector(".login-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => (doc.querySelector(".course-row") ? true : null));

  // Open the seeded course.
  const row = Array.prototype.find.call(doc.querySelectorAll(".course-row"), function (r) {
    return r.querySelector(".course-title").textContent === "Console Course";
  });
  assert.ok(row, "the seeded course appears in the list");
  row.querySelector(".open-course").click();

  // The queue shows the pending question.
  await waitFor(() => (qcardByAuthor(doc, "Queue Student") ? true : null));
  const card = qcardByAuthor(doc, "Queue Student");
  card.querySelector('[name="edited_question"]').value = "Instructor reworded question for the console test.";
  card.querySelector(".save-release").click();

  // The release round-trips through the API and the card re-renders as released.
  await waitFor(() => {
    const c = qcardByAuthor(doc, "Queue Student");
    return c && c.getAttribute("data-status") === "released" ? c : null;
  });

  // Verify the edit landed via the database.
  const rows = srv.exec("SELECT edited_question, status FROM questions WHERE author = 'Queue Student';");
  assert.equal(rows[0].status, "released");
  assert.equal(rows[0].edited_question, "Instructor reworded question for the console test.");

  // Sign out returns to the login form.
  doc.querySelector(".logout").click();
  await waitFor(() => (doc.querySelector(".login-form") ? true : null));
});
