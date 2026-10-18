# Warden

A simple Claude Code harness for software delivery: consumer projects install it, follow its workflows, report to it, and upgrade from it.

Design draft: [docs/design.html](docs/design.html)

## Install

Needs Bun 1.4 or newer and git access to this private repo.

```bash
claude plugin marketplace add chrisluuz/warden#stable
claude plugin install warden@warden-marketplace
```

Or inside Claude Code: `/plugin marketplace add chrisluuz/warden#stable`, then `/plugin install warden@warden-marketplace`, then `/reload-plugins`.
