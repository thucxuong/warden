---
name: git-pr
description: Open, view and merge a pull request for the current branch with git and gh.
---

# git-pr

Run the script with Bun. It needs `git` and `gh` on PATH, and `gh` must be logged in.

## Open a pull request

Write the description to a file first, then:

```
bun .claude/skills/git-pr/bin/pr.ts create --title "<title>" --body-file <file> [--base <branch>]
```

It pushes the current branch (`git push -u origin HEAD`) and opens the pull request. It prints the pull request URL. Keep that URL: the ship step records it.

## Merge a pull request

```
bun .claude/skills/git-pr/bin/pr.ts merge <pr>
```

`<pr>` is the number or the URL. It merges with a merge commit and prints the merge commit sha.

## View a pull request

```
bun .claude/skills/git-pr/bin/pr.ts view <pr>
```

## Rules

- Only the ship step opens or merges a pull request.
- If a command fails, read its message and report it. Do not retry with other flags.
