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

## Current state (2026-11-21, end of session 3)

- Design 2 (state machines) built on `design-2-state-machines` (CLI + editor lenses; webview
  diagram is backlog G1), merged into local `main`. **Not pushed** — waits for the user.
  CI sequence green (324 tests, e2e lens smoke test passes).
- Next: user pushes `main`; then design 3 (walkthrough mode) or Track G follow-ups.

## Waiting on the user

- [x] Branches: `design-1b-rule-format` merged into local `main` (`3bebdd6`); push still waits
      for the user.
- [x] Design 2 skimmed: CLI + lenses first, webview diagram later; build when the timing is right.
- [x] Push local `main` to `origin` (2026-11-21). Merged branches `design-1b-rule-format` and
      `ccr-576e715a-wiy3tf` are kept; delete them when the user says so.
- [ ] Push local `main` (design 2 merge) to `origin`; delete merged branches when the user says so.
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

## Design 2 — State machines (done)

Design `docs/superpowers/specs/2026-11-21-state-machines-design.md`, plan
`docs/superpowers/plans/2026-11-21-state-machines.md`. Records in `.flowbook/machines.jsonl`;
transitions found in the scan; `flowbook states`; machine checks in `check`; transition lenses.

Design rulings (session 2):

1. `machine` and `scope` records live in a separate `.flowbook/machines.jsonl` but load into the
   existing `Connections` object. Cost: a later split if machines grow their own lifecycle.
2. Source state derived from code where possible; tables need an agent-written `from` map. Cost:
   a changed index→state map goes stale until `check` sees an unknown state.
3. No per-transition confirmation records (F4 lesson). Cost: nothing marks one transition reviewed.
4. Unknown source states are counted, not warned. Cost: they can be ignored.
5. Editor lenses built last; milestones 1–4 ship without the editor.
6. Guards are display-only source text. Cost: one more field.

Build rulings (session 3):

7. `Connections.machines`/`scopes` are optional fields. Cost: `?? []` at each reader.
8. Prefilter fragments also come from `states`, only inside each machine's `files` globs. Cost:
   p-net parses 32 files instead of 29.
9. Files named by `scope` anchors are always parsed and join the cache key. Cost: none.
10. Task 6 (lenses) on Opus, not Sonnet; Task 3 dispatched while Task 2 was in review. Cost: tokens.
11. Timing judged as relative cost (alternating runs with and without `machines.jsonl`), because
    absolute cold times on this laptop moved 1.4–3.1 s with load during the session. Measured
    +2.4 %, +7.7 %, +4.5 % (p-net). Cost: drift since 1b is not visible; re-time when quiet.
12. Event fallback is display-only: CLI and lens show `in <function>` when no event case. Cost:
    JSON consumers must do the same.
13. "`from` key matches no table" sees only tables with a kept row. Cost: a rare false error.
14. A fall-through group with several event labels gives one transition per event (p-net CMSM
    RUN → IDLE on DATA and on ABORT).
15. New source derivation `test` (setter inside `if (state == X)`), after `case`: not in the
    spec's a–d list, but it is the CMDEV/CMPBE shape and as strong as a case. `||` with a
    non-state operand, `!=` and `else` give no source. Cost: one more `via` value.
16. Guards drop comments; a guard equal to the test `if` is omitted; for a test source the
    guard and triggers come from the `if`'s consequence.
17. Triggers still count sends in sibling branches (backlog G2). Cost: "sets off" over-reports
    (p-net cmio 3 vs 1).
18. CMDEV reaches 18/22 (82 %) known without scopes against the spec's 90 %; 20/22 (91 %) with
    one scope; 18/21 (86 %) without the genuine any-state abort. Accepted, not chased with more
    rules (the `else` case needs negation). Cost: spec target missed by two transitions.
19. Lenses group transitions sharing site, target, event and guard (`A, B → C`); the CLI keeps
    one line each. A computed key `c ? A : B` gives two transitions.
20. Reviews: task reviewers only on Tasks 2 and 3 (plus scoped re-reviews of both fix rounds);
    final review on Fable. Cost: Tasks 1, 4, 5, 6 unreviewed until the final review, which found
    two wrong-source bugs (nested callers, `||` tests), both fixed.

Measured (2026-11-21): p-net 6 machines, 7 unknown sources; CMSM exactly the spec's 4
transitions incl. `sched → pf_cmsm_timeout`; i-link DL message handler 30/33 (91 %) known without
scopes, 32/33 with; CM 32 rows → 32 transitions with `from` map and actions. Numbers in both
READMEs.

Open points:

- [x] Diagram view: not in the first cut (user, 2026-11-21) → backlog G1.
- [x] Guards: kept as display-only source text.
- [ ] Track G follow-ups (G2 sibling-branch triggers, G3 small items).
