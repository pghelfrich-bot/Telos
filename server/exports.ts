// Exports. Markdown is the public study guide grouped by topic; CSV is the full
// instructor record including rejected questions and private notes.

import { badRequest, effective, json } from "./lib.ts";
import { getCourse, listQuestions, type Course, type Question } from "./store.ts";
import type { Ctx } from "./types.ts";

// GET /api/courses/:id/export?format=md|csv
export async function exportCourse(ctx: Ctx, id: number, url: URL): Promise<Response> {
  const course = await getCourse(ctx.kv, id);
  if (!course) return json({ error: "course not found" }, 404);

  const format = url.searchParams.get("format") || "md";
  const questions = await listQuestions(ctx.kv, id);
  if (format === "md") return exportMarkdown(course, questions);
  if (format === "csv") return exportCsv(course, questions);
  return badRequest("format must be md or csv", 422);
}

function exportMarkdown(course: Course, all: Question[]): Response {
  const rows = all
    .filter((q) => q.status === "released")
    .sort((a, b) => (b.released_at || 0) - (a.released_at || 0) || b.created_at - a.created_at);

  const groups = new Map<string, Question[]>();
  for (const r of rows) {
    const key = r.topic || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  // Configured topics first, in their configured order; then any extra topics
  // that appear on questions, with the untitled group last.
  const orderedKeys: string[] = [];
  for (const t of course.topics) if (groups.has(t)) orderedKeys.push(t);
  const extras = [...groups.keys()].filter((k) => k !== "" && !course.topics.includes(k)).sort();
  orderedKeys.push(...extras);
  if (groups.has("")) orderedKeys.push("");

  let md = `# ${course.title}\n`;
  for (const key of orderedKeys) {
    md += `\n## ${key === "" ? "Other" : key}\n`;
    for (const r of groups.get(key)!) {
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
function csvField(value: unknown): string {
  const s = value == null ? "" : String(value);
  return '"' + s.replace(/"/g, '""') + '"';
}

function exportCsv(course: Course, all: Question[]): Response {
  const rows = [...all].sort((a, b) => a.created_at - b.created_at || a.id - b.id);

  const columns: (keyof Question)[] = [
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
  for (const r of rows) {
    out += columns.map((c) => csvField(r[c])).join(",") + "\r\n";
  }

  return new Response(out, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${course.slug}.csv"`,
    },
  });
}
