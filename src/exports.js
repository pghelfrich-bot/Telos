// Exports. Markdown is the public study guide grouped by topic; CSV is the full
// instructor record including rejected questions and private notes.

import { json, badRequest, parseTopics, effective } from "./lib.js";

// GET /api/courses/:id/export?format=md|csv
export async function exportCourse(env, id, url) {
  const course = await env.DB.prepare(`SELECT * FROM courses WHERE id = ?`).bind(id).first();
  if (!course) return json({ error: "course not found" }, 404);

  const format = url.searchParams.get("format") || "md";
  if (format === "md") return exportMarkdown(env, course);
  if (format === "csv") return exportCsv(env, course);
  return badRequest("format must be md or csv", 422);
}

async function exportMarkdown(env, course) {
  const rows = await env.DB.prepare(
    `SELECT topic, question, answer, edited_question, edited_answer
       FROM questions
       WHERE course_id = ? AND status = 'released'
       ORDER BY released_at DESC, created_at DESC`
  )
    .bind(course.id)
    .all();

  const groups = new Map();
  for (const r of rows.results) {
    const key = r.topic || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  // Configured topics first, in their configured order; then any extra topics
  // that appear on questions, with the untitled group last.
  const configured = parseTopics(course.topics);
  const orderedKeys = [];
  for (const t of configured) if (groups.has(t)) orderedKeys.push(t);
  const extras = [...groups.keys()].filter((k) => k !== "" && !configured.includes(k)).sort();
  orderedKeys.push(...extras);
  if (groups.has("")) orderedKeys.push("");

  let md = `# ${course.title}\n`;
  for (const key of orderedKeys) {
    md += `\n## ${key === "" ? "Other" : key}\n`;
    for (const r of groups.get(key)) {
      md += `\n### ${effective(r.edited_question, r.question)}\n\n${effective(r.edited_answer, r.answer)}\n`;
    }
  }

  return new Response(md, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${course.slug}.md"`,
    },
  });
}

// Quote every field per RFC 4180: wrap in double quotes and double any quotes
// inside. This keeps embedded commas, quotes, and newlines intact.
function csvField(value) {
  const s = value == null ? "" : String(value);
  return '"' + s.replace(/"/g, '""') + '"';
}

async function exportCsv(env, course) {
  const rows = await env.DB.prepare(
    `SELECT id, status, topic, author, question, answer, edited_question, edited_answer, notes, created_at, released_at
       FROM questions
       WHERE course_id = ?
       ORDER BY created_at ASC, id ASC`
  )
    .bind(course.id)
    .all();

  const columns = [
    "id",
    "status",
    "topic",
    "author",
    "question",
    "answer",
    "edited_question",
    "edited_answer",
    "notes",
    "created_at",
    "released_at",
  ];

  let out = columns.map(csvField).join(",") + "\r\n";
  for (const r of rows.results) {
    out += columns.map((c) => csvField(r[c])).join(",") + "\r\n";
  }

  return new Response(out, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${course.slug}.csv"`,
    },
  });
}
