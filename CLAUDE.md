# Flowbook

VS Code extension + CLI for understanding C/C++ codebases through flow diagrams. Diagrams are
agent-written JSONL files stored in the documented repo under `.flowbook/`, so they travel with
the code. Agents write flows (via `skill/flowbook/SKILL.md` + the CLI); humans read them in the
extension. The UI is read-only by design.

Pending work and ready-to-use agent briefs: [docs/agent-workflows/backlog.md](docs/agent-workflows/backlog.md).

## Environment

Node 22 comes from nvm and is **not on PATH in non-interactive shells**. Prefix commands with:

```bash
export PATH=$HOME/.nvm/versions/node/v22.23.4/bin:$PATH
```

pnpm 10 workspaces. Commits use the global git identity; push over SSH to
`git@github.com:rameesrpu/flowbook.git` (`main`).

## Commands

```bash
pnpm build                 # core → resolver → cli → webview → extension (order matters)
pnpm typecheck             # tsc -b (core/resolver/cli) + extension tsc --noEmit
pnpm lint                  # eslint
pnpm exec prettier --check .
pnpm test                  # vitest: packages/*/src/**/*.test.ts (needs core/resolver built)
pnpm flowbook check --strict --root fixtures/cpp-sample   # CLI from packages/cli/dist
pnpm --filter @flowbook/webview dev                       # webview harness on the fixture
pnpm --filter flowbook package                            # → packages/extension/flowbook-*.vsix
pnpm --filter flowbook test:e2e                           # real VS Code smoke test (needs a display)
```

CI (`.github/workflows/ci.yml`) runs exactly: install → build → typecheck → lint → prettier →
test → strict fixture check → package. Run that sequence before pushing.

## Layout

| Path                  | What                                                                                                                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core`       | zod schema (→ `schema/flowbook.schema.json`), JSONL parse with line diagnostics, validation, grouping (`buildGroups`, `collapseBelow`), `project` (edge aggregation for collapsed groups), host↔webview `protocol.ts` (types only). Browser-safe: no Node imports. |
| `packages/resolver`   | Node-only. web-tree-sitter C/C++ symbol resolution + fingerprints (`symbols.ts`), `Resolver`/`match`, `checkAnchors`/`anchorDiagnostics`, fs + git helpers. Shared by CLI and extension.                                                                           |
| `packages/cli`        | `flowbook check / resolve / stamp / stale`; esbuild bundle + wasm copied into `dist/`.                                                                                                                                                                             |
| `packages/webview`    | React 18 + @xyflow/react + elkjs (main thread). Flowchart, sequence view, side panel. Builds to fixed names `dist/webview.{js,css}` — the extension depends on them.                                                                                               |
| `packages/extension`  | VS Code host. `model.ts`/`diff.ts` are pure (unit-tested, must not import `vscode`); `panel.ts`, `tree.ts`, `codelens.ts`, `host.ts` use the API. Bundled to `dist/extension.cjs`.                                                                                 |
| `skill/flowbook`      | Agent skill: `SKILL.md`, `references/schema.md`, `references/example.jsonl`.                                                                                                                                                                                       |
| `fixtures/cpp-sample` | Synthetic C/C++ project + stamped flows; the test fixture for everything.                                                                                                                                                                                          |
| `examples/lua`        | Real-world example (Lua 5.4.7); sources fetched by `fetch.sh`, gitignored.                                                                                                                                                                                         |

## Design rules

- **Anchors are `file + symbol (+ sig)`; never store line numbers.** Lines are resolved live.
  `sig` only when the name is overloaded in that file.
- **Staleness = fingerprint** (sha1 of the definition with comments/whitespace normalized) +
  `verified` commit of the git repo _containing the source file_ (`headCommitFor`).
- `fp`/`verified` are written only by `flowbook stamp`, which rewrites node lines only.
- Flow files: one `flow` record, then nodes, steps (`seq` 1..N; alternatives in one `alt` may
  share a seq), blocks (`loop|alt|par`, nest or disjoint). Unknown fields are errors (`.strict()`).
- Schema changes: update `core/src/schema.ts`, `skill/flowbook/references/schema.md`, and the
  fixture/examples together; rebuild core to regenerate the JSON Schema.
- Protocol changes (`core/src/protocol.ts`) touch both webview and extension — change both in one go.
- Webview runs under a strict CSP (nonce script only, no workers, no wasm). Keep it a single
  bundle; shiki must use the JS regex engine.
- Keep core free of Node APIs (the webview bundles it).

## Testing conventions

- Unit tests sit next to code (`*.test.ts`). CLI tests copy the fixture to a temp dir and edit it.
- After changing the fixture's sources or flows, re-run `pnpm flowbook stamp --all --root fixtures/cpp-sample`
  and check `--strict` stays clean.
- UI changes: verify visually. Run the webview dev server and screenshot with headless Chrome:
  `google-chrome --headless=new --disable-gpu --hide-scrollbars --window-size=1440,900 --virtual-time-budget=8000 --screenshot=out.png 'http://localhost:5179/?flow=packet-handling&view=flow&level=all&select=valid-type&theme=dark'`
  (params: `flow`, `view=flow|sequence`, `level=modules|folders|files|all`, `select`, `theme=light|dark`, `diag=1`, `panel=0`).

## Working with subagents

Parallel agents work well when each owns one package. Rules that avoided trouble before: only
the coordinator runs `pnpm add`/`install` (concurrent installs corrupt the lockfile — preinstall
deps first), agents don't commit, and the coordinator reviews and runs the CI sequence before
committing.
