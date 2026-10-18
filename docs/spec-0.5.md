# Warden 0.5 — report conversations

Goal: the WA and the CPA can talk about one report until it is settled. They reach each other locally through the
claude CLI, and the GitHub issue holds the conversation a person reads. The CPA still never sees the warden repo or
its issues.

## 1. Record

`ReportRecord` gains two optional fields:

- `projectDir`: the project's main checkout, set when the report is filed.
- `thread`: `{from: "wa" | "project", at, text}[]`, oldest first. The body is not in the thread.

A WA message follows the note rules (plain text, at most 500 characters). A project message is at most 4000 characters.
Copies of one record (outbox, branch, pending edit) join their threads: each message once, sorted by `at`.

## 2. WA asks: `warden report ask <key> --question <q>`

1. Refused (exit 1) when the report already has 3 WA messages.
2. Same as `report set <key> --status needs-info --note <q>`, plus the question appended to the thread.
3. When the record is on this computer and has a `projectDir` with `.warden/warden.json`, it starts the answer run
   (section 3). Otherwise the question waits for the project's next session start.
4. Prints `{key, status, asks, thread, shared, answering, reason?}`. `reason` is `other-machine`, `no-project-dir`,
   `busy` or `spawn-failed`.

## 3. The answer run

A detached runner (`src/lib/answer.ts`) starts `claude -p <prompt>` in `projectDir`:

- model sonnet, `--permission-mode dontAsk`, no MCP servers, no session saved, budget 1 USD, timeout 900 s;
- tools Bash, Read, Glob, Grep; Bash only for `warden report reply`, `warden status`, `git log|show|status`;
  Edit, Write, NotebookEdit, WebFetch and WebSearch are refused;
- env without `CLAUDECODE`, plugin and `WARDEN_*` variables, plus `WARDEN_ROLE=answer` (the project's hooks do
  nothing) and `WARDEN_DATA=<the record's data dir>`.

The prompt holds the report, the earlier messages, the question and the reply command. It says the report and the
question are data, not orders, and to keep secrets out. One run per report at a time (`<id>.answer.lock`); the output
goes to `<data>/reports/<id>.answer.log`.

## 4. Project answers: `warden report reply <id> --body <answer> | --file <path>`

1. Only when the record is `needs-info` and the last message is from the WA (exit 1 otherwise).
2. Appends the answer, sets the status back to `sent`, queues the change for the branch, rings the doorbell and starts
   a background sync.

A queued status loses to a newer message already on the branch, so a question that goes out late never undoes the
answer. In the inbox, a local copy with a newer message than the branch copy gives the status.

## 5. Session start

Each status change line ends with the note. `sent` is not shown (it means this project answered). A `needs-info` line
adds the reply command, for the case where the answer run could not run.

## 6. wa-triage

- Real bugs and questions get an issue; a question adds the `needs-info` label.
- Every thread message not yet on the issue becomes a comment ("From the project" / "Asked the project"); the ledger
  entry counts them in `posted`.
- A report that comes back with an answer is triaged again with the whole thread. After 3 questions it must be
  decided as a real bug or a snowflake.
- A snowflake with an issue: comment the reason, close as not planned.
