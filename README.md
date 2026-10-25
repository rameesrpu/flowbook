# Flowbook

Understand C/C++ codebases through flow diagrams that live in the repo.

Flowbook diagrams are JSONL files stored under `.flowbook/` in the codebase they describe, so the
documentation is reviewed, diffed and versioned with the code. Each **flow** is a named scenario
("Server startup", "Packet handling") made of **nodes** (functions, anchored by file + symbol,
never by line number) and ordered **steps** (calls, returns, async hand-offs, callbacks),
optionally grouped into `loop` / `alt` / `par` **blocks**.

- **Agents write flows** using the [Flowbook skill](skill/flowbook/SKILL.md) and the `flowbook` CLI.
- **Humans read them** in the VS Code extension: a flowchart and a sequence view, jump-to-code,
  and staleness markers when the code behind a node has changed since it was verified.

Everything runs locally: the extension and CLI make no network requests.

## Install from source

Requirements: [Node.js](https://nodejs.org) 22 or newer, git, VS Code 1.90 or newer.

```bash
git clone https://github.com/rameesrpu/flowbook.git
cd flowbook
corepack enable          # provides pnpm (or: npm install -g pnpm@10)
pnpm install             # needs access to the npm registry
pnpm build
pnpm --filter flowbook package   # → packages/extension/flowbook-<version>.vsix
```

Install the extension: in VS Code, **Extensions view → `⋯` → Install from VSIX…** and pick the
`.vsix`, or run `code --install-extension packages/extension/flowbook-<version>.vsix`.

To update later: `git pull`, then repeat `pnpm install`, `pnpm build`, `package` and install.

### Put the CLI on your PATH

The CLI is a single file, `packages/cli/dist/flowbook.js` (with its `.wasm` files next to it).
Agents call it as `flowbook`, so add a small wrapper.

Linux / macOS (replace the path with your clone):

```bash
mkdir -p ~/.local/bin
printf '#!/bin/sh\nexec node "%s" "$@"\n' "$HOME/src/flowbook/packages/cli/dist/flowbook.js" > ~/.local/bin/flowbook
chmod +x ~/.local/bin/flowbook
flowbook --help
```

Windows: create `flowbook.cmd` in a folder on your `PATH`:

```bat
@node "C:\src\flowbook\packages\cli\dist\flowbook.js" %*
```

| Command                            | What it does                                                  |
| ---------------------------------- | ------------------------------------------------------------- |
| `flowbook resolve <file> [symbol]` | list definitions in a file as ready-to-paste anchors          |
| `flowbook check [--strict]`        | validate schema, references and anchors (exit 1 on errors)    |
| `flowbook stamp <flow-id>\|--all`  | record each node's code fingerprint + the verified git commit |
| `flowbook stale`                   | list nodes whose code changed since they were stamped         |

All commands accept `--root <dir>`; by default the nearest parent directory containing
`.flowbook/` is used.

## Set up the agent skill

The skill is three small Markdown/JSONL files in [`skill/flowbook/`](skill/flowbook/):
`SKILL.md` (workflow and style rules), `references/schema.md` (record reference) and
`references/example.jsonl` (a complete valid flow).

**Claude Code** — copy or symlink the folder into a skills directory:

```bash
# for you, in every repo
ln -s ~/src/flowbook/skill/flowbook ~/.claude/skills/flowbook
# or for one repo, shared with everyone who clones it
cp -r ~/src/flowbook/skill/flowbook <repo>/.claude/skills/flowbook
```

Then ask, for example: _"Use the Flowbook skill to document the startup sequence."_

**Other agents** (Copilot, Cline, Continue, Codex, OpenCode, local models, …) — the skill is plain
Markdown. Point the agent at it in its instructions file (`AGENTS.md`,
`.github/copilot-instructions.md`, …):

```markdown
When asked to create or update Flowbook flows, first read
/path/to/flowbook/skill/flowbook/SKILL.md and the files in its references/ folder, and follow it.
```

The agent needs a shell tool to run the CLI. The `check` → fix → `check` loop is what keeps flows
valid, so smaller models work too as long as they run it and act on its errors.

## Your first flow

1. Open a C/C++ repository in VS Code and ask your agent to write a flow for one scenario. It will
   create `.flowbook/flows/<id>.jsonl`, run `flowbook check` and `flowbook stamp <id>`.
2. The **Flowbook** view appears in the activity bar. Open a flow to see the flowchart; switch to
   the sequence view; click a node to see its notes and code in the side panel, and click the
   file link or the code to jump to the definition.
3. C/C++ definitions that appear in flows get a "Flowbook: in N flows" CodeLens.
4. When code changes, nodes turn stale. Run `flowbook stale` (or use **Copy agent prompt** in the
   extension) and let the agent re-verify and re-stamp.

To try it without writing anything, open [`fixtures/cpp-sample`](fixtures/cpp-sample) in VS Code
after installing the extension.

## File format

```
.flowbook/
  config.jsonl          optional: named components (path globs → groups)
  flows/<flow-id>.jsonl one scenario per file: a flow record, nodes, steps, blocks
```

Full reference: [skill/flowbook/references/schema.md](skill/flowbook/references/schema.md). JSON
Schema: [schema/flowbook.schema.json](schema/flowbook.schema.json).

## Development

See [CLAUDE.md](CLAUDE.md) for the package layout, design rules and the full command list
(build, typecheck, lint, test, webview dev harness, end-to-end test).

| Package              | Purpose                                                   |
| -------------------- | --------------------------------------------------------- |
| `packages/core`      | Schema, JSONL parsing, validation, grouping               |
| `packages/resolver`  | Tree-sitter C/C++ symbol resolution and body fingerprints |
| `packages/cli`       | `flowbook check / resolve / stamp / stale`                |
| `packages/webview`   | React Flow + ELK flowchart and sequence views             |
| `packages/extension` | VS Code extension host                                    |
| `skill/flowbook`     | Agent skill for authoring flows                           |

## License

[MIT](LICENSE)
