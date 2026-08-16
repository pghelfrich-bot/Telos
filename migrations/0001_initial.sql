-- Initial schema for the study guide app.
-- One deployment holds every course an instructor teaches.

-- A course is one class. The slug is public and pasted into Canvas; its random
-- suffix is what keeps the page unguessable. topics is a JSON array stored as
-- text. accepting, show_authors, and archived are 0/1 flags.
CREATE TABLE courses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  topics       TEXT NOT NULL DEFAULT '[]',
  accepting    INTEGER NOT NULL DEFAULT 1,
  show_authors INTEGER NOT NULL DEFAULT 0,
  archived     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- A question is one student submission. question and answer hold the student's
-- original text and are never overwritten. Instructor rewrites live in the
-- edited_* columns. notes are private to the instructor.
CREATE TABLE questions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id       INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  author          TEXT NOT NULL,
  topic           TEXT NOT NULL DEFAULT '',
  question        TEXT NOT NULL,
  answer          TEXT NOT NULL,
  edited_question TEXT,
  edited_answer   TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'released', 'rejected')),
  notes           TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  released_at     INTEGER
);

-- The instructor queue and the student guide both read by course and status,
-- newest first.
CREATE INDEX idx_questions_course_status_created
  ON questions (course_id, status, created_at DESC);

-- Simple fixed-window rate limiting keyed by action plus IP. reset_at is the
-- unix millisecond timestamp when the current window expires.
CREATE TABLE rate_limits (
  key      TEXT PRIMARY KEY,
  count    INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL
);
