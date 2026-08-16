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
