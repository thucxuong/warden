// `warden tools --usage` (0.10): what the agent ran, for the retro, read afterwards from Claude Code's own session
// transcripts. Warden writes nothing while the agent works. The sessions are the ones warden linked to this project
// (.warden/state/_sessions/*.json and each task's sessions.jsonl, subagents included). Claude Code keeps transcripts
// for about 30 days by default; a missing one is counted and skipped. Secrets are hidden in what is printed.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { sessionsDir, stateRoot } from "../state/paths.ts";

export interface UsageSummary {
  since: string | null;
  sessions: { read: number; missing: number };
  // `warden tools <name>` calls the agent made; failed: the Bash call ended in an error.
  tools: { tool: string; calls: number; failed: number }[];
  // Raw commands a project tool covers (replaces.json) that the agent ran anyway.
  raw: { tool: string; prefix: string; count: number }[];
  // Commands that ran at least twice with no tool, costliest (count x length) first.
  commands: { shape: string; count: number; avgChars: number; example: string }[];
}

const EXAMPLE_CHARS = 300;
const TOP = 20;

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

const VALUE = String.raw`(?:'[^']*'|"[^"]*"|\S+)`;
const SECRET_WORD = String.raw`(?:TOKEN|SECRET|PASS|PASSWORD|PASSWD|PWD|KEY|APIKEY|AUTH|CREDENTIALS?|PRIVATE|SESSION|COOKIE)`;
const SECRETS: [RegExp, string][] = [
  // NAME=value for names that hold or end in a secret word: API_TOKEN, STRIPE_KEY, PGPASSWORD, SSHPASS, APITOKEN
  [new RegExp(String.raw`\b([A-Za-z0-9_]*${SECRET_WORD}S?(?:_[A-Za-z0-9]+)*=)${VALUE}`, "gi"), "$1***"],
  // --token v, --auth-token=v, --client-secret v, --db-password v
  [new RegExp(String.raw`(--?(?:[A-Za-z]+-)*(?:token|password|passwd|secret|api-?key|credentials?)(?:=|\s+))${VALUE}`, "gi"), "$1***"],
  // a password flag after a login: `docker login -p v`, `mysql -pv`, `redis-cli -a v`, `curl -u user:v`, `--user user:v`
  [/(\b(?:login|mysql|mysqldump|mariadb)\b[^|;&\n]*\s-p\s*)(?!-)\S+/g, "$1***"],
  [/(\bredis-cli\b[^|;&\n]*\s-a\s+)\S+/g, "$1***"],
  [/((?:^|\s)(?:-u|--user)(?:=|\s+))(['"]?)([^\s:'"]+):[^\s'"]+\2/g, "$1$2$3:***$2"],
  // auth headers by their real names (not words like Co-Authored-By), and Bearer/Basic values anywhere
  [/\b((?:Proxy-)?Authorization|(?:X-)?Api-?Key|X-Auth-Token|Auth-Token|Private-Token|(?:Set-)?Cookie|X-[A-Za-z-]*-Token)(\s*:\s*)[^'"\n]+/gi, "$1$2***"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 ***"],
  // passwords in URLs: scheme://user:password@host
  [/(:\/\/[^\s/:@]+:)[^\s/@]+@/g, "$1***@"],
];

// Secrets in a command line become ***. A pattern only catches the forms it knows: nothing is stored, and the
// summary stays on this machine unless someone copies it out.
export function redact(text: string): string {
  return SECRETS.reduce((out, [re, to]) => out.replace(re, to), text);
}

// ---------------------------------------------------------------------------
// Reading a command line
// ---------------------------------------------------------------------------

// Splits a command line into simple commands at ;, &&, ||, |, &, newlines, `$(`, `)` and backticks outside single
// quotes. A `$( )` inside double quotes is its own command too.
export function simpleCommands(cmd: string): string[] {
  const parts: string[] = [];
  let current = "";
  let single = false;
  let double = false;
  const cut = () => {
    if (current.trim() !== "") parts.push(current.trim());
    current = "";
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (single) {
      if (c === "'") single = false;
      current += c;
    } else if (c === "\\") {
      current += c + (cmd[++i] ?? "");
    } else if (c === "'" && !double) {
      single = true;
      current += c;
    } else if (c === '"') {
      double = !double;
      current += c;
    } else if (cmd.startsWith("$(", i) && !cmd.startsWith("$((", i)) {
      cut();
      i++;
    } else if (c === "`" || (c === ")" && !double)) {
      cut();
    } else if (!double && (cmd.startsWith("&&", i) || cmd.startsWith("||", i))) {
      cut();
      i++;
    } else if (!double && (c === ";" || c === "\n" || c === "|" || c === "&")) {
      cut();
    } else {
      current += c;
    }
  }
  cut();
  return parts;
}

function unquote(word: string): string {
  return word.replace(/^(['"])(.*)\1$/, "$2").replace(/^["']|["']$/g, "");
}

const SHELL_WORDS = new Set(["then", "do", "else", "elif", "!", "{", "(", "time"]);
const WRAPPERS = new Set(["env", "command", "exec", "sudo", "nohup", "nice", "timeout", "xargs"]);
// Wrapper options that take a value: `sudo -u bob`, `env -u NAME`, `nice -n 10`, `timeout -s KILL`, `timeout -k 5`.
const VALUE_FLAGS: Record<string, Set<string>> = {
  sudo: new Set(["-u", "-g", "-C", "-h", "-p", "-U", "-D", "-r", "-t", "-T"]),
  env: new Set(["-u", "-C", "-S"]),
  nice: new Set(["-n"]),
  timeout: new Set(["-s", "-k"]),
  xargs: new Set(["-I", "-n", "-P", "-L", "-d", "-E", "-s"]),
};

// The words of a simple command from its program on: no leading VAR=value, shell keyword, wrapper or wrapper option;
// the program without its path. [] for a lookup (`command -v x`), a loop header (`for f in ...`) or nothing to run.
export function programWords(part: string): string[] {
  const words = part.split(/\s+/).filter((w) => w !== "").map(unquote);
  let i = 0;
  for (;;) {
    while (i < words.length && (/^[A-Za-z_]\w*=/.test(words[i]!) || SHELL_WORDS.has(words[i]!))) i++;
    if (i >= words.length) return [];
    const word = words[i]!.replace(/^.*\//, "");
    if (["for", "while", "until", "if", "case", "select"].includes(word) && words[i] === word) {
      if (word === "for" || word === "case" || word === "select") return [];
      i++; // while/until/if <command>
      continue;
    }
    if (!WRAPPERS.has(word)) break;
    i++;
    if (word === "command" && /^-[vV]$/.test(words[i] ?? "")) return [];
    while (i < words.length && words[i]!.startsWith("-")) i += VALUE_FLAGS[word]?.has(words[i]!) ? 2 : 1;
    if (word === "timeout" && /^\d/.test(words[i] ?? "")) i++; // the duration
  }
  const rest = words.slice(i);
  rest[0] = rest[0]!.replace(/^.*\//, "");
  return rest;
}

// Programs that only look around, and git, whose everyday commands are never worth a tool.
const LOOK_AROUND = new Set([
  "cd", "ls", "cat", "head", "tail", "sed", "wc", "sort", "uniq", "cut", "tr", "tree", "stat", "du", "file", "pwd", "echo", "printf",
  "grep", "rg", "find", "which", "type", "true", "false", "sleep", "test", "[", "git",
]);

// A `warden tools <name>` call: the name, else null.
function wardenTool(words: string[]): string | null {
  const at = words[0] === "warden" ? 1 : words[0] === "bun" && /cli\.ts$/.test(words[1] ?? "") ? 2 : -1;
  if (at < 0 || words[at] !== "tools") return null;
  const name = words[at + 1];
  return name !== undefined && !name.startsWith("-") ? name : null;
}

export interface CommandFacts {
  tools: string[];               // `warden tools <name>` calls in the line
  raw: { tool: string; prefix: string } | null;
  shape: string | null;          // what it does in a few words, null when it only looks around or calls warden
}

// What a command line ran, by the program of each simple command. `replaces`: tool -> raw commands it covers.
export function commandFacts(cmd: string, replaces: Record<string, string[]>): CommandFacts {
  const entries = Object.entries(replaces).flatMap(([tool, list]) => list.map((prefix) => ({ tool, words: prefix.trim().split(/\s+/) })));
  const facts: CommandFacts = { tools: [], raw: null, shape: null };
  for (const part of simpleCommands(stripHeredocBodies(cmd))) {
    const words = programWords(part);
    const program = words[0];
    if (!program) continue;
    const tool = wardenTool(words);
    if (tool !== null) facts.tools.push(tool);
    if (facts.raw === null) {
      const found = entries.find((entry) => entry.words.every((word, j) => words[j] === word));
      if (found) facts.raw = { tool: found.tool, prefix: found.words.join(" ") };
    }
    if (facts.shape === null && program !== "warden" && tool === null && !LOOK_AROUND.has(program)) {
      const subs: string[] = [];
      for (const word of words.slice(1)) {
        if (subs.length === 2 || !/^[a-z][a-z0-9:_-]*$/.test(word)) break;
        subs.push(word);
      }
      facts.shape = [program, ...subs].join(" ");
    }
  }
  return facts;
}

// The `<<` of a heredoc in a line, outside quotes and not `<<<` or a shift in `$(( ))`: its end word and whether
// tabs may come before it (`<<-`), else null.
function heredocOf(line: string): { end: string; dash: boolean } | null {
  let quote: string | null = null;
  let arithmetic = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote !== null) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (line.startsWith("$((", i)) {
      arithmetic++;
      i += 2;
    } else if (arithmetic > 0 && line.startsWith("))", i)) {
      arithmetic--;
      i++;
    } else if (arithmetic === 0 && line.startsWith("<<", i) && line[i - 1] !== "<" && line[i + 2] !== "<") {
      const m = /^<<(-?)\s*(['"]?)([A-Za-z_][\w.-]*)\2/.exec(line.slice(i));
      if (m) return { end: m[3]!, dash: m[1] === "-" };
      i++;
    }
  }
  return null;
}

// The statistics only: a heredoc's body is file contents, not commands. A `<<` with no end line is left as it is.
function stripHeredocBodies(cmd: string): string {
  const lines = cmd.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    kept.push(lines[i]!);
    const heredoc = heredocOf(lines[i]!);
    if (!heredoc) continue;
    const close = lines.findIndex((body, j) => j > i && (heredoc.dash ? body.replace(/^\t+/, "") : body) === heredoc.end);
    if (close > i) i = close;
  }
  return kept.join("\n");
}

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

// The transcripts of every session and subagent warden linked to this project.
export function transcriptPaths(main: string): string[] {
  const paths = new Set<string>();
  const add = (path: unknown) => {
    if (typeof path === "string" && path.endsWith(".jsonl")) paths.add(path);
  };
  const sessions = sessionsDir(main);
  if (existsSync(sessions)) {
    for (const file of readdirSync(sessions).filter((f) => f.endsWith(".json"))) {
      try {
        add((JSON.parse(readFileSync(join(sessions, file), "utf8")) as { transcriptPath?: unknown }).transcriptPath);
      } catch {
        // a half-written record
      }
    }
  }
  const root = stateRoot(main);
  if (existsSync(root)) {
    for (const task of readdirSync(root).filter((d) => !d.startsWith("_"))) {
      const links = join(root, task, "sessions.jsonl");
      if (!existsSync(links)) continue;
      for (const line of readFileSync(links, "utf8").split("\n")) {
        try {
          add((JSON.parse(line) as { transcriptPath?: unknown }).transcriptPath); // the session's, or a subagent's
        } catch {
          // a blank or half-written line
        }
      }
    }
  }
  // Claude Code keeps a session's subagents next to it: <session>/subagents/*.jsonl
  for (const path of [...paths]) {
    const dir = join(dirname(path), basename(path, ".jsonl"), "subagents");
    if (existsSync(dir)) for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) paths.add(join(dir, f));
  }
  return [...paths].sort();
}

export interface BashRun { at: string; command: string; failed: boolean }

interface Line {
  type?: string;
  timestamp?: string;
  permissionDecision?: { decision?: string };
  message?: { content?: unknown };
}

// The Bash commands of one transcript that ran: a call refused by a hook or by the person is left out.
export function bashRuns(path: string): BashRun[] {
  const uses = new Map<string, { at: string; command: string }>();
  const runs: BashRun[] = [];
  for (const text of readFileSync(path, "utf8").split("\n")) {
    if (text.trim() === "") continue;
    let line: Line;
    try {
      line = JSON.parse(text) as Line;
    } catch {
      continue; // a line cut short
    }
    const content = Array.isArray(line.message?.content) ? (line.message!.content as Record<string, unknown>[]) : [];
    for (const c of content) {
      if (line.type === "assistant" && c.type === "tool_use" && c.name === "Bash") {
        const command = (c.input as { command?: unknown } | undefined)?.command;
        if (typeof command === "string" && typeof c.id === "string") uses.set(c.id, { at: line.timestamp ?? "", command });
      } else if (line.type === "user" && c.type === "tool_result" && typeof c.tool_use_id === "string") {
        const use = uses.get(c.tool_use_id);
        if (!use || line.permissionDecision?.decision === "reject") continue;
        runs.push({ at: use.at || line.timestamp || "", command: use.command, failed: c.is_error === true });
      }
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function count<K>(map: Map<string, K>, key: string, make: () => K): K {
  const found = map.get(key);
  if (found !== undefined) return found;
  const made = make();
  map.set(key, made);
  return made;
}

// `since`: a date in this machine's timezone (the retro's `last`), counted from local midnight. `roles`: role -> tool,
// so a call through a role counts for its tool.
export function summarize(main: string, replaces: Record<string, string[]>, roles: Record<string, string>, since?: string): UsageSummary {
  const from = since === undefined ? null : new Date(`${since}T00:00:00`).getTime();
  const tools = new Map<string, { tool: string; calls: number; failed: number }>();
  const raw = new Map<string, { tool: string; prefix: string; count: number }>();
  const shapes = new Map<string, { shape: string; count: number; chars: number; example: string }>();
  const sessions = { read: 0, missing: 0 };
  for (const path of transcriptPaths(main)) {
    if (!existsSync(path)) {
      sessions.missing += 1;
      continue;
    }
    sessions.read += 1;
    for (const run of bashRuns(path)) {
      if (from !== null && !(Date.parse(run.at) >= from)) continue;
      const facts = commandFacts(run.command, replaces);
      for (const name of facts.tools) {
        const tool = Object.hasOwn(roles, name) && !Object.hasOwn(replaces, name) ? roles[name]! : name;
        const row = count(tools, tool, () => ({ tool, calls: 0, failed: 0 }));
        row.calls += 1;
        if (run.failed) row.failed += 1;
      }
      if (facts.raw) count(raw, `${facts.raw.tool}\0${facts.raw.prefix}`, () => ({ ...facts.raw!, count: 0 })).count += 1;
      else if (facts.shape !== null && facts.tools.length === 0) {
        const row = count(shapes, facts.shape, () => ({ shape: facts.shape!, count: 0, chars: 0, example: "" }));
        row.count += 1;
        row.chars += run.command.length;
        const example = redact(run.command);
        row.example = example.length > EXAMPLE_CHARS ? `${example.slice(0, EXAMPLE_CHARS)}…` : example;
      }
    }
  }
  return {
    since: since ?? null,
    sessions,
    tools: [...tools.values()].sort((a, b) => b.calls - a.calls),
    raw: [...raw.values()].sort((a, b) => b.count - a.count),
    commands: [...shapes.values()]
      .filter((row) => row.count >= 2)
      .sort((a, b) => b.chars - a.chars)
      .slice(0, TOP)
      .map((row) => ({ shape: redact(row.shape), count: row.count, avgChars: Math.round(row.chars / row.count), example: row.example })),
  };
}
