// UI tests load the real public/ files into jsdom and drive them against the
// real handler running in-process over a fresh in-memory KV.

// deno-lint-ignore-file no-explicit-any
import { JSDOM } from "npm:jsdom@25";
import assert from "./assert.ts";
import { ADMIN_PASSWORD, type App, type Client, newApp } from "./helpers.ts";
import type { Handler } from "../server/handler.ts";

const SCRIPTS = ["dom.js", "student.js", "admin.js", "app.js"];
const read = (name: string) => Deno.readTextFileSync(new URL(`../public/${name}`, import.meta.url));

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor<T>(fn: () => T, timeout = 4000): Promise<T> {
  const end = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(15);
  }
  throw new Error("waitFor timed out: " + (last instanceof Error ? last.message : String(last)));
}

// Build a jsdom page whose fetch calls the handler directly, with a per-page
// cookie jar so the session survives across requests.
function loadPage(handler: Handler, path: string) {
  const jar = new Map<string, string>();
  const dom = new JSDOM(read("index.html"), {
    url: "http://localhost" + path,
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  // deno-lint-ignore no-explicit-any
  (dom.window as any).fetch = async (input: any, init: any = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, "http://localhost");
    const headers = new Headers(init.headers || {});
    if (jar.size) headers.set("cookie", [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await handler(new Request(url, { method: init.method || "GET", headers, body: init.body }));
    const sc = res.headers.get("set-cookie");
    if (sc) {
      const pair = sc.split(";")[0];
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      if (/max-age=0/i.test(sc)) jar.delete(name);
      else jar.set(name, pair.slice(eq + 1).trim());
    }
    return res;
  };
  const { document } = dom.window;
  for (const name of SCRIPTS) {
    const tag = document.createElement("script");
    tag.textContent = read(name);
    document.body.appendChild(tag);
  }
  return dom;
}

// Seed a course with three named released questions across two topics.
async function seedGuide(client: Client) {
  await client.call("POST", "/api/login", { json: { password: ADMIN_PASSWORD } });
  const course = (await client.call("POST", "/api/courses", {
    json: { title: "UI Biology", topics: ["Cells", "Genetics"] },
  })).data.course;
  const specs = [
    ["Cell Author", "Cells", "What is the mitochondrion known for?", "It is the powerhouse of the cell."],
    ["Gene Author", "Genetics", "What molecule carries genetic information?", "DNA carries genetic information."],
    ["Cell Author Two", "Cells", "What surrounds and protects the cell?", "The cell membrane surrounds it."],
  ];
  for (const [name, topic, question, answer] of specs) {
    await client.call("POST", `/api/course/${course.slug}/questions`, { json: { name, topic, question, answer } });
  }
  const list = (await client.call("GET", `/api/courses/${course.id}/questions`)).data.questions;
  await client.call("POST", "/api/questions/status", {
    json: { ids: list.map((q: any) => q.id), status: "released" },
  });
  return course;
}

function cardByQuestion(doc: any, text: string) {
  return Array.prototype.find.call(doc.querySelectorAll(".card"), (c: any) => {
    const q = c.querySelector(".question");
    return q && q.textContent === text;
  }) as any | undefined;
}

function qcardByAuthor(doc: any, author: string) {
  return Array.prototype.find.call(doc.querySelectorAll(".qcard"), (c: any) => {
    const a = c.querySelector(".q-author");
    return a && a.textContent === author;
  }) as any | undefined;
}

async function withApp(fn: (app: App) => Promise<void>) {
  const app = await newApp();
  try {
    await fn(app);
  } finally {
    app.close();
  }
}

Deno.test("the student guide renders released questions as cards", () =>
  withApp(async ({ handler, client }) => {
    const course = await seedGuide(client);
    const doc = loadPage(handler, `/c/${course.slug}`).window.document;
    await waitFor(() => doc.querySelectorAll(".card").length === 3 || null);
    assert.ok(cardByQuestion(doc, "What is the mitochondrion known for?"));
  }));

Deno.test("an answer stays hidden until its reveal is clicked", () =>
  withApp(async ({ handler, client }) => {
    const course = await seedGuide(client);
    const doc = loadPage(handler, `/c/${course.slug}`).window.document;
    await waitFor(() => doc.querySelector(".card") || null);
    const card = cardByQuestion(doc, "What is the mitochondrion known for?")!;
    const answer = card.querySelector(".answer") as any;
    const reveal = card.querySelector(".reveal") as any;
    assert.equal(answer.hidden, true);
    reveal.click();
    assert.equal(answer.hidden, false);
    reveal.click();
    assert.equal(answer.hidden, true);
  }));

Deno.test("the topic filter narrows the visible cards", () =>
  withApp(async ({ handler, client }) => {
    const course = await seedGuide(client);
    const doc = loadPage(handler, `/c/${course.slug}`).window.document;
    await waitFor(() => doc.querySelectorAll(".card").length === 3 || null);
    const cells = Array.prototype.find.call(
      doc.querySelectorAll(".chip"),
      (c: any) => c.getAttribute("data-topic") === "Cells",
    ) as any;
    assert.ok(cells.textContent!.includes("(2)"), "Cells chip shows a count of 2");
    const genetics = Array.prototype.find.call(
      doc.querySelectorAll(".chip"),
      (c: any) => c.getAttribute("data-topic") === "Genetics",
    ) as any;
    genetics.click();
    const visible = Array.prototype.filter.call(doc.querySelectorAll(".card"), (c: any) => !c.hidden);
    assert.equal(visible.length, 1);
    assert.equal((visible[0] as any).getAttribute("data-topic"), "Genetics");
  }));

Deno.test("a submission from the form reaches the store", () =>
  withApp(async ({ handler, client }) => {
    const course = await seedGuide(client);
    const dom = loadPage(handler, `/c/${course.slug}`);
    const doc = dom.window.document;
    await waitFor(() => doc.querySelector(".submit-form") || null);
    const form = doc.querySelector(".submit-form") as any;
    (form.querySelector('[name="name"]') as any).value = "Jsdom Student";
    (form.querySelector('[name="topic"]') as any).value = "Cells";
    (form.querySelector('[name="question"]') as any).value =
      "A genuine question typed into the form for the test.";
    (form.querySelector('[name="answer"]') as any).value =
      "A genuine answer typed into the form for the test.";
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));

    const success = await waitFor(() => {
      const s = doc.querySelector(".form-success") as any | null;
      return s && !s.hidden ? s : null;
    });
    assert.ok(success.textContent!.length > 0);

    const list = (await client.call("GET", `/api/courses/${course.id}/questions`)).data.questions;
    const stored = list.find((q: any) => q.author === "Jsdom Student");
    assert.ok(stored, "the submission was stored");
    assert.equal(stored.status, "pending");
  }));

Deno.test("a validation failure surfaces as a visible error", () =>
  withApp(async ({ handler, client }) => {
    const course = await seedGuide(client);
    const dom = loadPage(handler, `/c/${course.slug}`);
    const doc = dom.window.document;
    await waitFor(() => doc.querySelector(".submit-form") || null);
    const form = doc.querySelector(".submit-form") as any;
    (form.querySelector('[name="name"]') as any).value = "Bad Submitter";
    (form.querySelector('[name="topic"]') as any).value = "Cells";
    (form.querySelector('[name="question"]') as any).value = "A long enough question here.";
    (form.querySelector('[name="answer"]') as any).value = "no";
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));

    const error = await waitFor(() => {
      const e = doc.querySelector(".form-error") as any | null;
      return e && !e.hidden ? e : null;
    });
    assert.match(error.textContent || "", /answer must be at least 10/);
  }));

Deno.test("the instructor signs in, edits and releases a question, then signs out", () =>
  withApp(async ({ handler, client }) => {
    // Seed a course with a pending question to review.
    await client.call("POST", "/api/login", { json: { password: ADMIN_PASSWORD } });
    const course = (await client.call("POST", "/api/courses", {
      json: { title: "Console Course", topics: ["General"] },
    })).data.course;
    await client.call("POST", `/api/course/${course.slug}/questions`, {
      json: {
        name: "Queue Student", topic: "General",
        question: "A pending question awaiting review in the console.",
        answer: "A pending answer awaiting review in the console.",
      },
    });

    const dom = loadPage(handler, "/");
    const doc = dom.window.document;
    await waitFor(() => doc.querySelector(".login-form") || null);

    // Wrong password.
    (doc.querySelector('[name="password"]') as any).value = "wrong-password";
    (doc.querySelector(".login-form") as any)
      .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    const loginError = await waitFor(() => {
      const e = doc.querySelector(".login-error") as any | null;
      return e && !e.hidden ? e : null;
    });
    assert.match(loginError.textContent || "", /Incorrect password/);

    // Correct password reveals the course list.
    (doc.querySelector('[name="password"]') as any).value = ADMIN_PASSWORD;
    (doc.querySelector(".login-form") as any)
      .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => doc.querySelector(".course-row") || null);

    const row = Array.prototype.find.call(
      doc.querySelectorAll(".course-row"),
      (r: any) => r.querySelector(".course-title")?.textContent === "Console Course",
    ) as any;
    (row.querySelector(".open-course") as any).click();

    await waitFor(() => qcardByAuthor(doc, "Queue Student") || null);
    const card = qcardByAuthor(doc, "Queue Student")!;
    (card.querySelector('[name="edited_question"]') as any).value =
      "Instructor reworded question for the console test.";
    (card.querySelector(".save-release") as any).click();

    await waitFor(() => {
      const c = qcardByAuthor(doc, "Queue Student");
      return c && c.getAttribute("data-status") === "released" ? c : null;
    });

    const list = (await client.call("GET", `/api/courses/${course.id}/questions`)).data.questions;
    const q = list.find((x: any) => x.author === "Queue Student");
    assert.equal(q.status, "released");
    assert.equal(q.edited_question, "Instructor reworded question for the console test.");

    // Sign out returns to the login form.
    (doc.querySelector(".logout") as any).click();
    await waitFor(() => doc.querySelector(".login-form") || null);
  }));

// --- Telos: practice tab, guide search, topics editor ---

Deno.test("the practice tab runs a deck filtered by topic and reports a summary", () =>
  withApp(async ({ handler, client }) => {
    const course = await seedGuide(client);
    const dom = loadPage(handler, `/c/${course.slug}`);
    const doc = dom.window.document;
    await waitFor(() => doc.querySelectorAll(".card").length === 3 || null);

    // Open the Practice tab.
    const practiceTab = Array.prototype.find.call(
      doc.querySelectorAll(".tab"),
      (t: any) => t.textContent === "Practice",
    ) as any;
    practiceTab.click();

    // Restrict the deck to the Genetics topic (one card).
    const cellsBox = Array.prototype.find.call(
      doc.querySelectorAll(".practice-topic input"),
      (b: any) => b.getAttribute("data-topic") === "Cells",
    ) as any;
    cellsBox.checked = false;
    (doc.querySelector(".practice-start") as any).click();

    await waitFor(() => doc.querySelector(".practice-card") || null);
    const card = doc.querySelector(".practice-card") as any;
    assert.equal(
      card.querySelector(".question").textContent,
      "What molecule carries genetic information?",
      "only the Genetics card is in the deck",
    );
    assert.equal((doc.querySelector(".practice-progress") as any).textContent, "Card 1 of 1");

    // The answer stays hidden until revealed, then the card can be marked.
    assert.equal((card.querySelector(".practice-answer") as any).hidden, true);
    (card.querySelector(".practice-reveal") as any).click();
    assert.equal((card.querySelector(".practice-answer") as any).hidden, false);
    (card.querySelector(".practice-got") as any).click();

    await waitFor(() => doc.querySelector(".practice-summary") || null);
    const summary = (doc.querySelector(".practice-summary") as any).textContent;
    assert.ok(summary.includes("1 card"), "the summary counts the single card");
    assert.ok(summary.includes("Nothing marked for review"), "nothing was missed");
  }));

Deno.test("a card marked review again comes back and feeds the missed deck", () =>
  withApp(async ({ handler, client }) => {
    const course = await seedGuide(client);
    const dom = loadPage(handler, `/c/${course.slug}`);
    const doc = dom.window.document;
    await waitFor(() => doc.querySelectorAll(".card").length === 3 || null);

    const practiceTab = Array.prototype.find.call(
      doc.querySelectorAll(".tab"),
      (t: any) => t.textContent === "Practice",
    ) as any;
    practiceTab.click();
    const cellsBox = Array.prototype.find.call(
      doc.querySelectorAll(".practice-topic input"),
      (b: any) => b.getAttribute("data-topic") === "Cells",
    ) as any;
    cellsBox.checked = false;
    (doc.querySelector(".practice-start") as any).click();

    await waitFor(() => doc.querySelector(".practice-card") || null);
    (doc.querySelector(".practice-reveal") as any).click();
    (doc.querySelector(".practice-miss") as any).click();

    await waitFor(() => doc.querySelector(".practice-summary") || null);
    assert.ok(
      (doc.querySelector(".practice-summary") as any).textContent.includes("marked for review"),
      "the summary reports the missed card",
    );
    assert.ok(doc.querySelector(".practice-again"), "a missed-cards rerun is offered");

    // The rerun deck contains exactly the missed card.
    (doc.querySelector(".practice-again") as any).click();
    await waitFor(() => doc.querySelector(".practice-card") || null);
    assert.equal((doc.querySelector(".practice-progress") as any).textContent, "Card 1 of 1");
  }));

Deno.test("the guide search narrows cards by text", () =>
  withApp(async ({ handler, client }) => {
    const course = await seedGuide(client);
    const dom = loadPage(handler, `/c/${course.slug}`);
    const doc = dom.window.document;
    await waitFor(() => doc.querySelectorAll(".card").length === 3 || null);

    const search = doc.querySelector(".guide-search") as any;
    search.value = "mitochondrion";
    search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    const visible = Array.prototype.filter.call(doc.querySelectorAll(".card"), (c: any) => !c.hidden);
    assert.equal(visible.length, 1);
    assert.equal(
      (visible[0] as any).querySelector(".question").textContent,
      "What is the mitochondrion known for?",
    );
  }));

Deno.test("the topics editor adds, renames, and removes topics without touching questions", () =>
  withApp(async ({ handler, client }) => {
    await client.call("POST", "/api/login", { json: { password: ADMIN_PASSWORD } });
    const course = (await client.call("POST", "/api/courses", {
      json: { title: "Topics Course", topics: ["Alpha", "Beta"] },
    })).data.course;
    await client.call("POST", `/api/course/${course.slug}/questions`, {
      json: {
        name: "Alpha Student", topic: "Alpha",
        question: "A question filed under Alpha for the editor test.",
        answer: "An answer filed under Alpha for the editor test.",
      },
    });

    const dom = loadPage(handler, "/");
    const doc = dom.window.document;
    await waitFor(() => doc.querySelector(".login-form") || null);
    (doc.querySelector('[name="password"]') as any).value = ADMIN_PASSWORD;
    (doc.querySelector(".login-form") as any)
      .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => doc.querySelector(".course-row") || null);
    (doc.querySelector(".open-course") as any).click();
    await waitFor(() => doc.querySelector("#settings-panel .topics-editor") || null);

    function topicRow(name: string) {
      return Array.prototype.find.call(
        doc.querySelectorAll("#settings-panel .topic-row"),
        (r: any) => r.getAttribute("data-topic") === name,
      ) as any;
    }

    // Add a topic.
    (doc.querySelector(".topic-add-input") as any).value = "Gamma";
    (doc.querySelector(".topic-add") as any).click();
    await waitFor(() => topicRow("Gamma") || null);

    // Rename Alpha; the question follows the rename.
    topicRow("Alpha").querySelector(".topic-rename").click();
    const renameInput = await waitFor(() => doc.querySelector(".topic-rename-input") || null);
    (renameInput as any).value = "Cell Structure";
    (doc.querySelector(".topic-rename-save") as any).click();
    await waitFor(() => topicRow("Cell Structure") || null);

    // Remove Beta; the configured list shrinks but questions are untouched.
    topicRow("Beta").querySelector(".topic-remove").click();
    await waitFor(() => (topicRow("Beta") ? null : true));

    const fresh = (await client.call("GET", "/api/courses")).data.courses
      .find((c: any) => c.id === course.id);
    assert.deepEqual(fresh.topics, ["Cell Structure", "Gamma"]);
    const list = (await client.call("GET", `/api/courses/${course.id}/questions`)).data.questions;
    const q = list.find((x: any) => x.author === "Alpha Student");
    assert.equal(q.topic, "Cell Structure", "the question followed the rename");
    assert.equal(list.length, 1, "no questions were deleted");
  }));

Deno.test("the theme toggle pins dark mode and remembers the choice", () =>
  withApp(async ({ handler, client }) => {
    const course = await seedGuide(client);
    const dom = loadPage(handler, `/c/${course.slug}`);
    const doc = dom.window.document;
    await waitFor(() => doc.querySelector(".theme-toggle") || null);

    const toggle = doc.querySelector(".theme-toggle") as any;
    assert.equal(toggle.textContent, "Dark mode", "with no preference the page offers dark mode");
    assert.equal(doc.documentElement.getAttribute("data-theme"), null, "no theme is pinned by default");

    toggle.click();
    assert.equal(doc.documentElement.getAttribute("data-theme"), "dark", "the choice is pinned on the root");
    assert.equal(dom.window.localStorage.getItem("telos-theme"), "dark", "the choice is remembered");
    assert.equal(toggle.textContent, "Light mode");

    toggle.click();
    assert.equal(doc.documentElement.getAttribute("data-theme"), "light");
    assert.equal(dom.window.localStorage.getItem("telos-theme"), "light");
  }));

Deno.test("the student page carries the Telos wordmark and definition", () =>
  withApp(async ({ handler, client }) => {
    const course = await seedGuide(client);
    const doc = loadPage(handler, `/c/${course.slug}`).window.document;
    await waitFor(() => doc.querySelector(".wordmark") || null);
    assert.equal((doc.querySelector(".wordmark-name") as any).textContent, "Telos");
    assert.equal((doc.querySelector(".wordmark-greek") as any).textContent, "τέλος");
    assert.ok(
      (doc.querySelector(".site-footer") as any).textContent.includes("an end, an aim"),
      "the footer carries the definition",
    );
  }));

// --- test builder ---

async function openCourseConsole(handler: Handler, client: Client, courseTitle: string) {
  const dom = loadPage(handler, "/");
  const doc = dom.window.document;
  await waitFor(() => doc.querySelector(".login-form") || null);
  (doc.querySelector('[name="password"]') as any).value = ADMIN_PASSWORD;
  (doc.querySelector(".login-form") as any)
    .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => doc.querySelector(".course-row") || null);
  const row = Array.prototype.find.call(
    doc.querySelectorAll(".course-row"),
    (r: any) => r.querySelector(".course-title")?.textContent === courseTitle,
  ) as any;
  row.querySelector(".open-course").click();
  // The course view loads asynchronously; wait for its tabs to exist.
  await waitFor(() => doc.querySelector("#test-panel") || null);
  return dom;
}

function pickByText(doc: any, text: string) {
  const label = Array.prototype.find.call(
    doc.querySelectorAll(".tb-pick"),
    (l: any) => l.querySelector(".tb-pick-text").textContent === text,
  ) as any;
  label.querySelector(".tb-check").checked = true;
}

Deno.test("the test builder groups edited questions into numbered blocks", () =>
  withApp(async ({ handler, client }) => {
    const course = await seedGuide(client);
    const dom = await openCourseConsole(handler, client, "UI Biology");
    const doc = dom.window.document;

    // Open the Test builder tab and wait for the picker to list all three
    // released questions.
    (Array.prototype.find.call(
      doc.querySelectorAll(".tab"),
      (t: any) => t.textContent === "Test builder",
    ) as any).click();
    await waitFor(() => (doc.querySelectorAll(".tb-pick").length === 3 ? true : null));

    // Block 1: the two cell questions, added one at a time so their order in
    // the block is explicit.
    pickByText(doc, "What is the mitochondrion known for?");
    (doc.querySelector(".tb-add") as any).click();
    await waitFor(() => (doc.querySelectorAll(".tb-row").length === 1 ? true : null));
    pickByText(doc, "What surrounds and protects the cell?");
    (doc.querySelector(".tb-add") as any).click();
    await waitFor(() => (doc.querySelectorAll(".tb-row").length === 2 ? true : null));

    // Block 2: the genetics question in a new block.
    pickByText(doc, "What molecule carries genetic information?");
    (doc.querySelector(".tb-block-select") as any).value = "new";
    (doc.querySelector(".tb-add") as any).click();
    await waitFor(() => (doc.querySelectorAll(".tb-block").length === 2 ? true : null));

    // Edit the first question's wording for the test only.
    const firstArea = doc.querySelector('.tb-block[data-block="0"] .tb-text') as any;
    firstArea.value = "Explain the main function of the mitochondrion.";
    firstArea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    // Block 1 preview: numbered 1 and 2, single spaced, with the edit applied.
    const preview1 = (doc.querySelector('.tb-block[data-block="0"] .test-output') as any).textContent;
    assert.equal(
      preview1,
      "1. Explain the main function of the mitochondrion.\n2. What surrounds and protects the cell?",
    );

    // Block 2 numbering restarts at 1.
    const preview2 = (doc.querySelector('.tb-block[data-block="1"] .test-output') as any).textContent;
    assert.equal(preview2, "1. What molecule carries genetic information?");

    // The edit stayed in the draft: the study guide record is untouched.
    const list = (await client.call("GET", `/api/courses/${course.id}/questions`)).data.questions;
    const original = list.find((q: any) => q.question === "What is the mitochondrion known for?");
    assert.ok(original, "the guide question keeps its original wording");
    assert.equal(original.edited_question, null);

    // The draft persists in the browser under the course key.
    const draft = dom.window.localStorage.getItem(`telos-test-${course.id}`);
    assert.ok(draft, "a draft was saved");
    assert.ok(draft!.includes("Explain the main function of the mitochondrion."));
  }));

Deno.test("test builder rows reorder and remove, and the draft survives a reload", () =>
  withApp(async ({ handler, client }) => {
    const course = await seedGuide(client);
    const dom = await openCourseConsole(handler, client, "UI Biology");
    const doc = dom.window.document;

    (Array.prototype.find.call(
      doc.querySelectorAll(".tab"),
      (t: any) => t.textContent === "Test builder",
    ) as any).click();
    await waitFor(() => (doc.querySelectorAll(".tb-pick").length === 3 ? true : null));

    pickByText(doc, "What is the mitochondrion known for?");
    (doc.querySelector(".tb-add") as any).click();
    await waitFor(() => (doc.querySelectorAll(".tb-row").length === 1 ? true : null));
    pickByText(doc, "What surrounds and protects the cell?");
    (doc.querySelector(".tb-add") as any).click();
    await waitFor(() => (doc.querySelectorAll(".tb-row").length === 2 ? true : null));

    // Move the second question up; the preview order flips.
    const rows = doc.querySelectorAll(".tb-row");
    (rows[1].querySelector(".tb-up") as any).click();
    const preview = (doc.querySelector(".test-output") as any).textContent;
    assert.equal(
      preview,
      "1. What surrounds and protects the cell?\n2. What is the mitochondrion known for?",
    );

    // Remove the first row; one question remains, renumbered from 1.
    (doc.querySelector(".tb-row .tb-remove") as any).click();
    await waitFor(() => (doc.querySelectorAll(".tb-row").length === 1 ? true : null));
    assert.equal(
      (doc.querySelector(".test-output") as any).textContent,
      "1. What is the mitochondrion known for?",
    );

    // A fresh page load restores the draft from storage. The draft must be in
    // the new page's storage before the course opens, since the builder reads
    // it when the course view renders.
    const saved = dom.window.localStorage.getItem(`telos-test-${course.id}`);
    const dom2 = loadPage(handler, "/");
    const doc2 = dom2.window.document;
    dom2.window.localStorage.setItem(`telos-test-${course.id}`, saved!);
    await waitFor(() => doc2.querySelector(".login-form") || null);
    (doc2.querySelector('[name="password"]') as any).value = ADMIN_PASSWORD;
    (doc2.querySelector(".login-form") as any)
      .dispatchEvent(new dom2.window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => doc2.querySelector(".course-row") || null);
    (doc2.querySelector(".open-course") as any).click();
    await waitFor(() => doc2.querySelector("#test-panel") || null);
    (Array.prototype.find.call(
      doc2.querySelectorAll(".tab"),
      (t: any) => t.textContent === "Test builder",
    ) as any).click();
    await waitFor(() => (doc2.querySelectorAll(".tb-row").length === 1 ? true : null));
    assert.equal(
      (doc2.querySelector(".test-output") as any).textContent,
      "1. What is the mitochondrion known for?",
    );
  }));
