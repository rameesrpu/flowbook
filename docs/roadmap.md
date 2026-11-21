# Flowbook roadmap

Where Flowbook is going and in what order. Detailed, ready-to-run briefs live in
[agent-workflows/backlog.md](agent-workflows/backlog.md); per-feature decisions and open points
live in [tracker.md](tracker.md).

## Direction (chosen 2026-11-15)

- **Audience:** embedded and firmware teams working on large C/C++ protocol stacks on an RTOS
  (state machines, mailboxes, queues, tasks, events posted in one place and handled in another).
- **Deployment:** local and CI only. No server; git is the database.
- **Authoring:** bring-your-own agent (skill + CLI, later an MCP server). The UI stays read-only.
- **License and business:** free open source, MIT throughout.
- **"Enterprise" means:** flows you can verify against the code, CI checks, exports beyond VS Code,
  traceability to requirements and specifications, and speed on large codebases. It does not
  mean SSO, hosted portals, in-UI editing or paid tiers.

Approach for every feature: **rules find the sites in the code, the agent explains and confirms
the pairings, `flowbook check` keeps them honest.**

## Order of designs

Each design goes through brainstorm → design doc (`docs/superpowers/specs/`) → plan
(`docs/superpowers/plans/`) → subagent-driven build → final review.

| #   | Design                                                                                                       | Status                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 1   | Connection points and the editor jump (`Go to Reactor` / `Go to Sender`, `flowbook sites`)                   | Done 2026-11-15 (`bdd6dfc..6f733c7`)                                                       |
| 1b  | Rule format follow-ups: mailbox keys, wrappers, key filters, bulk confirmation (backlog F1–F5)               | Done 2026-11-21 (`design-1b-rule-format`)                                                  |
| 2   | State machines: states, transitions and what each transition triggers, found by rules and confirmed by agent | Done 2026-11-21 (`design-2-state-machines`): CLI + lenses; diagram view later (backlog G1) |
| 3   | Walkthrough mode and "you are here": step through a sequence in the editor; minimap of the stack             | Planned                                                                                    |
| 4   | MCP server: structured retrieval for agents (flows, sites, pairings, state machines)                         | Planned                                                                                    |
| 5   | Spec references: link flows, states and sites to clauses of a machine-readable specification                 | Planned                                                                                    |

Why 1b before 2: state machines reuse the same rule matchers, and mailboxes pair poorly today
(8 of 13 mailbox sites unpaired in `examples/i-link`).

## Later

- Log replay: follow a recorded trace through the diagrams.
- Marketplace / Open VSX publishing ([publishing.md](publishing.md)). The npm names `flowbook`
  and `flowbook-cli` are taken; pick another name before publishing.
- Backlog tracks A–E (webview polish, CLI shipped with the extension, examples in CI, README,
  RTOS notation).

## Out of scope

Embedding-based RAG inside Flowbook (spec search is a separate tool, linked by clause
references in design 5); languages other than C/C++; servers or accounts.
