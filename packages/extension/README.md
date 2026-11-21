# Flowbook for VS Code

Understand C/C++ codebases through flow diagrams that live next to the code, in
`.flowbook/flows/<id>.jsonl`.

- **Flows view** in the activity bar lists every flow in the workspace, grouped by tag, and flags
  flows with stale or broken anchors.
- **Flow panel** shows the flow as a diagram. Selecting a node shows its notes, the live code
  snippet, the other flows that use the same symbol and, for stale nodes, a diff of the
  definition since it was last verified.
- **CodeLens** above C/C++ definitions that appear in flows ("Flowbook: in 2 flows").
- **Problems**: `Flowbook: Check` reports schema errors and stale or missing anchors on the flow
  files. Everything reloads when flow files or sources are saved.

## Connections

When the root has a `.flowbook/connections.jsonl` with rules, the extension scans the C/C++
sources in the background and puts a lens on every line that posts, sets or schedules something,
showing where it will run (`↳ rt_main · case JOB_READ_CNF (rt main task) → then read_done`), and
on handlers and receive sites, showing who posts to them (`↳ posted from 2 places`). Pairings no
connection record confirms end in `· unconfirmed`; a send nothing reacts to shows
`↳ no reactor found` and offers an agent prompt. `Flowbook: Go to Reactor` and
`Flowbook: Go to Sender` jump from the cursor line; several targets open a references peek. The
lenses follow unsaved edits; the scan is refreshed when a source file or `connections.jsonl` is
saved.

Flows are written by agents using the Flowbook skill and the `flowbook` CLI; the extension is a
read-only viewer.

## Settings

- `flowbook.codeLens.enabled` (default `true`): show CodeLens on C/C++ definitions.
- `flowbook.connections.codeLens.enabled` (default `true`): show where a post, event or timer is
  handled, and who posts to a handler.
