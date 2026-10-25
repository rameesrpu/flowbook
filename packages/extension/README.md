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

Flows are written by agents using the Flowbook skill and the `flowbook` CLI; the extension is a
read-only viewer.

## Settings

- `flowbook.codeLens.enabled` (default `true`): show CodeLens on C/C++ definitions.
