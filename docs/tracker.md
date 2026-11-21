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

## Current state (2026-11-21, end of session 2)

- `main` (local) holds design 1b and the design 2 docs, merged from `design-1b-rule-format`
  (`3bebdd6`) on top of the local A5/A1/B1 commits. **Not pushed**; `origin/main` is at the PR #1
  merge. CI sequence green on the merge (253 tests).
- Design 2 (state machines) is designed and planned, not built. User: build it when the timing is
  right; CLI and editor lenses first, no webview diagram yet.
- Next: build design 2 from `docs/superpowers/plans/2026-11-21-state-machines.md` on a branch
  `design-2-state-machines` when the user says so.

## Waiting on the user

- [x] Branches: `design-1b-rule-format` merged into local `main` (`3bebdd6`); push still waits
      for the user.
- [x] Design 2 skimmed: CLI + lenses first, webview diagram later; build when the timing is right.
- [ ] Push local `main` to `origin` (and delete the merged branches) — waits for the user.
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

- [x] F1–F4 rule format gaps → design 1b. F5 deferred (see design 1b).
- [ ] F6 callback slots without the application (document in the skill; multi-directory root?).
- [ ] F7 small items, including timing the scan inside VS Code on a root with thousands of files.

Measured: p-net (~59k lines) cold `flowbook sites` 1.2 s, unchanged rescan 12 ms; i-link job
queue 36 keys paired; p-net scheduler 41/42 handlers resolved.

## Design 1b — Rule format follow-ups (done)

Design `docs/superpowers/specs/2026-11-21-rule-format-followups-design.md`, plan
`docs/superpowers/plans/2026-11-21-rule-format-followups.md`. Matchers gain `keyMember` and
`keys`; send sites forwarding a parameter are marked and counted apart; dispatcher connections
(`receive` anchors only) confirm every key handled in a function.

Rulings:

1. Branch named `design-1b-rule-format` (user: "name branches properly"); one branch per design.
   Cost: none; rename is free.
2. F1 member keys are opt-in (`keyMember`), not the default. Cost: agents must know to set it.
3. F2 marks forwarding sites and warns with the matcher to add, instead of deriving wrapper
   matchers automatically. Cost: wrappers still need one manual matcher each.
4. F3 `keys` applies to every site of a matcher, including forwarding ones. Cost: a filtered
   wrapper site raises no forwarding warning.
5. F4 dispatcher form (names the function read) instead of a regex key. Cost: per-key titles are
   lost unless a keyed connection is added.
6. F5 (exclude one receive site, run-time flag values) deferred: one harmless case each.
7. `post(&m)` with parameter `m` counts as forwarding. Registration assigns (`as: "handler"`)
   never forward. Cost: callback-registration wrappers stay unresolved.
8. Every forwarding send site counts under `forwarding`, never as a paired key (final review).
9. Task reviewers only on Tasks 2 and 3; final review on Fable as the most capable model; Task 3
   dispatched while Task 2 was in review (different files). Cost: unreviewed bugs in 1, 4, 5 —
   the final review found one crash (fixed).
10. Implementers don't commit; the coordinator runs CI and commits per task.

Open points:

- [ ] F5 stays in the backlog. F7 gains: forwarding hint lists only the key position; lambda
      parameters; overload duplicate warnings; qualified C++ names in the hint.

Measured: i-link records 48 → 8 (mbox 13/13 paired, 0 unpaired; job 36 keys, 3 forwarding); p-net 13 → 4. Numbers in both
READMEs.

## Design 2 — State machines (designed, not built)

Design `docs/superpowers/specs/2026-11-21-state-machines-design.md`, plan
`docs/superpowers/plans/2026-11-21-state-machines.md`.

Rulings:

1. `machine` and `scope` records live in a separate `.flowbook/machines.jsonl` but load into the
   existing `Connections` object, so scan, cache key and loader need no new plumbing. Cost: a
   later split if machines grow their own lifecycle.
2. Source state derived in order: enclosing state `case`, `scope` record, unique calling state
   `case`, else `*`. Transition tables need an agent-written `from` map. Cost: tables whose
   index→state map changes go stale silently until `check` sees an unknown state.
3. No per-transition confirmation records (F4 lesson). Cost: nothing marks a single transition
   as reviewed.
4. Unknown source states are counted, not warned. Cost: they can be ignored.
5. Build order puts the editor lenses last; milestones 1–4 ship without the editor.
6. Guards stay in, display only: two transitions from one state and event differ only by their
   `if`, and without the condition they look contradictory. Cost: one more field, about one
   test; drop it if the lenses get too long.

Open points (questions for the user, also in the session summary):

- [x] Diagram view: not in the first cut (user, 2026-11-21); spec "Later" section.
- [x] Guards: kept as display-only source text (ruling 6 below; user asked what they are, the spec
      now explains with an i-link example).
