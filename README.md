# Flowbook

Understand large codebases through flow diagrams that live in the repo.

Flowbook diagrams are agent-written JSONL files stored under `.flowbook/` in the codebase they
describe, so the documentation travels with the code. Each **flow** is a named scenario (e.g.
"TLS handshake") made of **nodes** (functions, anchored by file + symbol) and ordered **steps**
(calls, returns, async hand-offs), optionally grouped into loop/alt/par **blocks**.

## Packages

| Package              | Purpose                                                   |
| -------------------- | --------------------------------------------------------- |
| `packages/core`      | Schema, JSONL parsing, validation, grouping               |
| `packages/resolver`  | Tree-sitter C/C++ symbol resolution and body fingerprints |
| `packages/cli`       | `flowbook check / resolve / stamp / stale`                |
| `packages/webview`   | React Flow + ELK flowchart and sequence views             |
| `packages/extension` | VS Code extension host                                    |
| `skill/flowbook`     | Agent skill for authoring flows                           |

## Status

Early rebuild — see milestones in the project plan.
