# Flowbook tracker

The memory between conversations. Read this first in every new session; update it before
ending one. Direction and order: [roadmap.md](roadmap.md). Ready-to-run briefs:
[agent-workflows/backlog.md](agent-workflows/backlog.md).

How to use it:

- **Current state** says where work stopped and what is next. Overwrite it each session.
- Each feature gets a section with its **rulings** (decisions made without the user, each with
  what it costs if wrong), **open points** (`- [ ]`, ticked when resolved, with the commit) and
  **waiting on the user**.
- Keep entries one or two lines. Detail belongs in the design doc, the plan or the commit.

## Current state (2026-11-21)

- Branch `ccr-576e715a-wiy3tf`, 13 commits ahead of `main` (`bdd6dfc..6f733c7`) plus the roadmap
  and tracker commit. Not pushed, not merged. CI sequence green; 210 tests; e2e passing.
- Next: design 1b (rule format follow-ups, backlog F1–F5), then design 2 (state machines).

## Waiting on the user

- [ ] Branch: merge into `main` locally, push and open a PR, or keep. Nothing is pushed until the
      user says so.
- [ ] Publishing name (npm `flowbook` / `flowbook-cli` are taken) — only needed before release.

## Design 1 — Connection points and the editor jump (done)

Design `docs/superpowers/specs/2026-11-15-connection-points-design.md`, plan
`docs/superpowers/plans/2026-11-15-connection-points.md`.

Rulings:

1. Implementers don't commit; the coordinator runs CI and commits (CLAUDE.md over the skill).
2. No separate worktree; worked on the existing branch.
3. Models: Sonnet for mechanical tasks, Opus for integration tasks and reviews, the most capable
   model only for planning. Reviewers only on the riskiest tasks plus one final review (token
   budget). Cost: the final review found four important issues in unreviewed tasks (all fixed).
4. `Go to Reactor` opens the `case` directly when the only other target is its handler.
5. `&fn` and `(fn)` count as naming a handler.
6. The scan cache (`{rulesKey, files}`) invalidates itself when rules change.
7. A keyed connection on a rule with receive matchers needs a receive site with that key.
8. A handler is unconfirmed when its dispatch `case` is missing; `NULL`/`nullptr`/`0` is not a
   registration.
9. Matchers with an invalid regex are skipped by the scan and reported by `check`.
10. `flowbook sites` exits 1 when the rule file has errors.
11. Files over 2 MB or that fail to parse are skipped with a warning and not cached.
12. Follow-ups found on real stacks were recorded, not built (backlog F1–F7).

Open points:

- [ ] F1–F5 rule format gaps → design 1b.
- [ ] F6 callback slots without the application (document in the skill; multi-directory root?).
- [ ] F7 small items, including timing the scan inside VS Code on a root with thousands of files.

Measured: p-net (~59k lines) cold `flowbook sites` 1.2 s, unchanged rescan 12 ms; i-link job
queue 36 keys paired; p-net scheduler 41/42 handlers resolved.

## Design 1b — Rule format follow-ups (next)

Scope: backlog F1–F5 (and F7 items that touch the same code). Not started.
