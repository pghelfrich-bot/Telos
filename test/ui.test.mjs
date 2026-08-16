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
// and route the page's fetch calls to the running worker.
function loadPage(path) {
  const dom = new JSDOM(pub("index.html"), {
    url: srv.baseUrl + path,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      // Resolve relative URLs to the worker and retry transient connection
      // resets, which happen with keep-alive against a local worker.
      window.fetch = async (input, init) => {
        const url = new URL(input, srv.baseUrl);
        for (let attempt = 0; ; attempt++) {
          try {
            return await fetch(url, init);
          } catch (err) {
            if (attempt >= 5) throw err;
            await sleep(200);
          }
        }
      };
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
