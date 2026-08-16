# Study guide

A small web app for collecting, curating, and publishing student study
questions. Students submit an exam question along with their own answer. The
instructor reviews a queue, edits the wording, and releases the good ones.
Released questions appear as a topic-grouped study guide with answers hidden
until clicked.

One deployment holds every course the instructor teaches. Each course has its
own unguessable student URL that gets pasted into Canvas. Students never log in.

Built as a single Cloudflare Worker with a D1 database. Vanilla JavaScript, no
build step, no framework. The only dependencies are `wrangler` and `jsdom`, and
both are development-only.

## Requirements

- Node.js 18 or newer
- A Cloudflare account
- `npm install` to pull in `wrangler` and `jsdom`

## Local development

1. Copy the example secrets file and edit the values:

   ```
   cp .dev.vars.example .dev.vars
   ```

   Set `ADMIN_PASSWORD` to the instructor password and `SESSION_SECRET` to a
   long random string.

2. Apply the database migration to the local D1 database:

   ```
   npm run migrate:local
   ```

3. Start the worker:

   ```
   npm run dev
   ```

   The instructor console is at `/`. A course guide is at `/c/<slug>`.

## Tests

The tests run against a real local worker, not mocks. Each suite boots
`wrangler dev` against a clean, freshly migrated database.

```
npm test
```

`test/api.test.mjs` covers the worker routes. `test/ui.test.mjs` loads the real
`public/` files in jsdom and drives them against a running worker.

## Deploy

1. Create the D1 database:

   ```
   npx wrangler d1 create study-guide
   ```

2. Copy the `database_id` that the command prints and paste it into
   `wrangler.jsonc`, replacing the placeholder in the `d1_databases` block.

3. Apply the migration to the remote database:

   ```
   npm run migrate:remote
   ```

4. Set the two secrets. These live in Cloudflare, not in the repository:

   ```
   npx wrangler secret put ADMIN_PASSWORD
   npx wrangler secret put SESSION_SECRET
   ```

   Use a long random value for `SESSION_SECRET`. If you ever change it, every
   instructor session is signed out.

5. Deploy:

   ```
   npx wrangler deploy
   ```

The hourly submission ceiling per IP defaults to 200 and can be overridden with
the `RATE_LIMIT_SUBMISSIONS_PER_HOUR` variable in `wrangler.jsonc`. It is a
whole-class brake, not a per-student quota, because a lab section usually shares
one campus IP address. Do not set it below about 100 or you can lock out a class
on the first day.

## Adding a course and sharing the link

1. Sign in at `/` with the instructor password.
2. Under **Courses**, create a course with a title and a comma separated list of
   topics.
3. Open the course and go to the **Settings** tab.
4. Copy the student link. It looks like `https://your-worker.example/c/<slug>`.
5. Paste that link into Canvas, for example as an external URL in a module or in
   an announcement.

Students open the link, read the guide, and submit questions from the second
tab. Nothing they do requires a login.

You review submissions in the course **Queue**: edit the wording in place, then
save and release, reject, or pull a released question back out of the guide.
Multi-select and bulk release are there for clearing a backlog quickly.

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
