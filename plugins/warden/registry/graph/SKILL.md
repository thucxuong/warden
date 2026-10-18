---
name: graph
description: Ask a code graph of the repository (files, functions, imports, calls) before searching the whole repo.
---

# graph

Run the script with Bun. It needs `graphify` and `git` on PATH. The graph lives in the main checkout under `.warden/state/_graph/` and is not committed. Worktrees share it.

## Ask the graph

Before a broad search of the repo (Grep or Glob over everything), ask the graph first:

```
bun .claude/skills/graph/bin/graph.ts query "<question>" [--budget <n>]
bun .claude/skills/graph/bin/graph.ts explain "<name>"
bun .claude/skills/graph/bin/graph.ts path "<from>" "<to>"
```

- `query`: what is related to a question. Start here.
- `explain`: what one file or symbol is and what it connects to.
- `path`: how two things connect.

If the graph has no answer, fall back to a normal search.

## Build and status

```
bun .claude/skills/graph/bin/graph.ts build
bun .claude/skills/graph/bin/graph.ts status
```

`build` reads the code only (no API key) and is incremental. `status` prints the graph file, when it was built and its size. When a query says `no code graph yet`, run `build` once.

## Keep it fresh

Add a periodic check file to `.warden/checks/`, for example `.warden/checks/graph.md`:

```markdown
---
every: 1d
kind: command
run: bun .claude/skills/graph/bin/graph.ts build
auto: true
timeoutSec: 540
---
# Code graph
```

## Rules

- The graph can be out of date. Check a hit by reading the file before relying on it.
