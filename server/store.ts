// Data layer backed by Deno KV. On Deno Deploy this is the managed, built-in
// key value store, so there is no separate database to create or configure.
//
// Key layout:
//   ["seq", name]                 -> KvU64 counter for integer ids
//   ["course", id]                -> Course
//   ["slug", slug]                -> course id (unique lookup)
//   ["question", id]              -> Question (source of truth)
//   ["qbycourse", courseId, id]   -> id (membership index for listing)
//   ["rate", key]                 -> { count, reset_at } (auto expiring)

export interface Course {
  id: number;
  slug: string;
  title: string;
  topics: string[];
  accepting: boolean;
  show_authors: boolean;
  archived: boolean;
  created_at: number;
}

export type Status = "pending" | "released" | "rejected";

export interface Question {
  id: number;
  course_id: number;
  author: string;
  topic: string;
  question: string;
  answer: string;
  edited_question: string | null;
  edited_answer: string | null;
  status: Status;
  notes: string;
  created_at: number;
  released_at: number | null;
}

// Allocate the next integer id for a kind, using an atomic counter so
// concurrent requests never collide.
async function nextId(kv: Deno.Kv, name: string): Promise<number> {
  const key = ["seq", name];
  while (true) {
    const cur = await kv.get<Deno.KvU64>(key);
    const value = (cur.value ? cur.value.value : 0n) + 1n;
    const ok = await kv.atomic().check(cur).set(key, new Deno.KvU64(value)).commit();
    if (ok.ok) return Number(value);
  }
}

export async function getCourse(kv: Deno.Kv, id: number): Promise<Course | null> {
  const r = await kv.get<Course>(["course", id]);
  return r.value;
}

export async function getCourseBySlug(kv: Deno.Kv, slug: string): Promise<Course | null> {
  const s = await kv.get<number>(["slug", slug]);
  if (!s.value) return null;
  return getCourse(kv, s.value);
}

export async function listCourses(kv: Deno.Kv): Promise<Course[]> {
  const out: Course[] = [];
  for await (const entry of kv.list<Course>({ prefix: ["course"] })) {
    out.push(entry.value);
  }
  // Active courses first, then newest first.
  out.sort((a, b) => Number(a.archived) - Number(b.archived) || b.created_at - a.created_at);
  return out;
}

export async function createCourse(
  kv: Deno.Kv,
  data: { title: string; topics: string[]; accepting: boolean; show_authors: boolean },
  slugFor: (title: string) => string,
): Promise<Course | null> {
  const id = await nextId(kv, "course");
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = slugFor(data.title);
    const slugKey = ["slug", slug];
    const existing = await kv.get(slugKey);
    if (existing.value) continue;
    const course: Course = {
      id,
      slug,
      title: data.title,
      topics: data.topics,
      accepting: data.accepting,
      show_authors: data.show_authors,
      archived: false,
      created_at: Date.now(),
    };
    const ok = await kv
      .atomic()
      .check(existing)
      .set(slugKey, id)
      .set(["course", id], course)
      .commit();
    if (ok.ok) return course;
  }
  return null;
}

export async function saveCourse(kv: Deno.Kv, course: Course): Promise<void> {
  await kv.set(["course", course.id], course);
}

export async function deleteCourse(kv: Deno.Kv, course: Course): Promise<void> {
  const ids: number[] = [];
  for await (const entry of kv.list<number>({ prefix: ["qbycourse", course.id] })) {
    ids.push(entry.value);
  }
  // KV atomic operations are bounded, so remove questions in small batches.
  for (let i = 0; i < ids.length; i += 10) {
    let tx = kv.atomic();
    for (const qid of ids.slice(i, i + 10)) {
      tx = tx.delete(["question", qid]).delete(["qbycourse", course.id, qid]);
    }
    await tx.commit();
  }
  await kv.atomic().delete(["course", course.id]).delete(["slug", course.slug]).commit();
}

export async function createQuestion(
  kv: Deno.Kv,
  data: { course_id: number; author: string; topic: string; question: string; answer: string },
): Promise<Question> {
  const id = await nextId(kv, "question");
  const q: Question = {
    id,
    course_id: data.course_id,
    author: data.author,
    topic: data.topic,
    question: data.question,
    answer: data.answer,
    edited_question: null,
    edited_answer: null,
    status: "pending",
    notes: "",
    created_at: Date.now(),
    released_at: null,
  };
  await kv.atomic().set(["question", id], q).set(["qbycourse", data.course_id, id], id).commit();
  return q;
}

export async function getQuestion(kv: Deno.Kv, id: number): Promise<Question | null> {
  const r = await kv.get<Question>(["question", id]);
  return r.value;
}

export async function saveQuestion(kv: Deno.Kv, q: Question): Promise<void> {
  await kv.set(["question", q.id], q);
}

export async function listQuestions(kv: Deno.Kv, courseId: number): Promise<Question[]> {
  const keys: Deno.KvKey[] = [];
  for await (const entry of kv.list<number>({ prefix: ["qbycourse", courseId] })) {
    keys.push(["question", entry.value]);
  }
  const out: Question[] = [];
  // getMany is capped at 10 keys per call.
  for (let i = 0; i < keys.length; i += 10) {
    const rows = await kv.getMany<Question[]>(keys.slice(i, i + 10));
    for (const r of rows) if (r.value) out.push(r.value as Question);
  }
  return out;
}

// Fixed-window rate limit. The stored row auto expires so old buckets do not
// accumulate.
export async function enforceRateLimit(
  kv: Deno.Kv,
  key: string,
  limit: number,
  windowMs: number,
): Promise<{ allowed: boolean; retryAfter: number }> {
  const now = Date.now();
  const k = ["rate", key];
  while (true) {
    const cur = await kv.get<{ count: number; reset_at: number }>(k);
    let count: number;
    let reset_at: number;
    if (!cur.value || cur.value.reset_at <= now) {
      count = 1;
      reset_at = now + windowMs;
    } else {
      count = cur.value.count + 1;
      reset_at = cur.value.reset_at;
    }
    const ok = await kv
      .atomic()
      .check(cur)
      .set(k, { count, reset_at }, { expireIn: windowMs + 60_000 })
      .commit();
    if (ok.ok) {
      return { allowed: count <= limit, retryAfter: Math.max(1, Math.ceil((reset_at - now) / 1000)) };
    }
  }
}
