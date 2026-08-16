# Telos

Telos (from the Greek word for an ultimate aim) is a small web app for
collecting, curating, and publishing student study questions. Students submit
an exam question along with their own answer. The instructor reviews a queue,
edits the wording, and releases the good ones. Released questions appear as a
topic-grouped study guide with answers hidden until clicked, and a practice
tab lets students quiz themselves on the topics they choose.

One deployment holds every course the instructor teaches. Each course has its
own unguessable student URL that gets pasted into Canvas. Students never log in.

Built as a single Deno server with the built-in Deno KV store. Vanilla
JavaScript on the front end, no build step, no framework. The server has zero
runtime dependencies; the only development dependency is `jsdom`, used by the
tests.

## Requirements

- [Deno](https://deno.com) 2.x (`curl -fsSL https://deno.land/install.sh | sh`)
- A free [Deno Deploy](https://deno.com/deploy) account for hosting

## Local development

1. Copy the example environment file and edit the values:

   ```
   cp .env.example .env
   ```

   Set `ADMIN_PASSWORD` to the instructor password and `SESSION_SECRET` to a
   long random string.

2. Start the server:

   ```
   deno task dev
   ```

   It listens on http://localhost:8000. The instructor console is at `/`, and a
   course guide is at `/c/<slug>`. Data is stored in a local Deno KV database
   automatically; there is nothing else to set up.

## Tests

The tests run the real request handler in-process against a fresh in-memory KV
database, so there is no server to start and no external services.

```
deno task test
```

`test/api_test.ts` covers the routes. `test/ui_test.ts` loads the real
`public/` files in jsdom and drives them against the handler.

## Deploy to Deno Deploy

There is no database to create and no `database_id` to paste. Deno Deploy
provisions the KV store for the project automatically.

1. Push this repository to GitHub.

2. In the Deno Deploy dashboard, create a new project and link it to the GitHub
   repository. Set the entry point to `main.ts`.

3. Add two environment variables to the project (Settings, then Environment
   Variables):

   - `ADMIN_PASSWORD`: the instructor password
   - `SESSION_SECRET`: a long random string. If you change it later, every
     instructor session is signed out.

4. Deploy. Deno Deploy builds on every push to the linked branch, so future
   updates go out by pushing to GitHub.

The hourly submission ceiling per IP defaults to 200 and can be raised or
lowered with the `RATE_LIMIT_SUBMISSIONS_PER_HOUR` environment variable. It is a
whole-class brake, not a per-student quota, because a lab section usually shares
one campus IP address. Do not set it below about 100 or you can lock out a class
on the first day it is used.

## Adding a course and sharing the link

1. Sign in at `/` with the instructor password.
2. Under **Courses**, create a course with a title and a comma separated list of
   topics.
3. Open the course and go to the **Settings** tab.
4. Copy the student link. It looks like `https://your-project.deno.dev/c/<slug>`.
5. Paste that link into Canvas, for example as an external URL in a module or in
   an announcement.

Students open the link, read the guide, and submit questions from the second
tab. Nothing they do requires a login.

You review submissions in the course **Queue**: edit the wording in place, then
save and release, reject, or pull a released question back out of the guide.
Multi-select and bulk release are there for clearing a backlog quickly.

Topics are managed from the **Settings** tab. Adding or removing a topic never
touches existing questions: a removed topic's questions keep their label and
stay in the guide. Renaming a topic updates every question that carries it.

Students get three tabs on the course page: the study guide with topic filters
and search, a **Practice** tab where they pick topics and work through a
shuffled deck of self-graded flashcards, and the submission form.

## What this tool does not do

Read this section before you use the tool for anything that matters.

- **There is one shared password and no TA role.** Everyone who administers the
  app uses the same `ADMIN_PASSWORD`. There is no per-user login, no audit trail
  of who changed what, and no way to give a teaching assistant limited access.

- **Student names are self-reported and unverified.** The name on a submission is
  whatever the student typed. Anyone with the course link can submit under any
  name. Do not treat a name as proof of who wrote something, and do not use this
  tool to assign credit or grades.

- **The course link is a capability, not access control.** The random suffix in
  the slug is what keeps a course page from being found by people who were not
  given the link. Anyone who has the link can view the guide and submit to it,
  and anyone they forward it to can as well. There is no per-student
  authentication and no way to revoke access for one person short of archiving
  the course and creating a new one.

- **Nothing FERPA-sensitive belongs in it.** Because names are unverified, the
  link is shareable, and there is no role separation, this tool is not a place
  for grades, feedback tied to a specific student, disciplinary notes, or any
  other protected education record. Keep it to study questions and answers.
