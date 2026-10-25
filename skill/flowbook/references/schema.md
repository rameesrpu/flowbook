# Flowbook record reference

Every line of a `.jsonl` file is one JSON object with a `kind`. Unknown fields are errors, so
typos are caught by `flowbook check`. The machine-readable JSON Schema is
`schema/flowbook.schema.json` in the Flowbook repository.

Ids (`id`, and every reference to one) use letters, digits, `.`, `_`, `-` and start with a letter
or digit. Node, step and block ids share one namespace per flow.

## `flow` — exactly one per file, first line

| Field     | Type                             | Notes                                                      |
| --------- | -------------------------------- | ---------------------------------------------------------- |
| `kind`    | `"flow"`                         |                                                            |
| `id`      | id                               | must equal the file name without `.jsonl`                  |
| `title`   | string                           | e.g. `"Packet handling"`                                   |
| `summary` | markdown?                        | one short paragraph: trigger, outcome, why it matters      |
| `entry`   | node id?                         | where the scenario starts                                  |
| `tags`    | string[]?                        | groups flows in the extension's tree, e.g. `["lifecycle"]` |
| `layout`  | `{ "direction": "LR" \| "TB" }`? | flowchart direction, default `LR`                          |

## `node` — a function, macro, class or external actor

| Field            | Type      | Notes                                                                                                 |
| ---------------- | --------- | ----------------------------------------------------------------------------------------------------- |
| `kind`           | `"node"`  |                                                                                                       |
| `id`             | id        | short and stable, e.g. `"feed"`                                                                       |
| `title`          | string    | what it does, in words                                                                                |
| `notes`          | markdown? | invariants, gotchas, threading — not a restatement of the code                                        |
| `anchor`         | object?   | omit for external actors                                                                              |
| `anchor.file`    | string    | repo-relative POSIX path of the **definition**                                                        |
| `anchor.symbol`  | string    | qualified name without template args: `ns::Class::method`, `free_fn`, `MACRO`                         |
| `anchor.sig`     | string?   | parameter types, only to pick an overload: `"(int, Callback, void*)"`; `const` methods end in `const` |
| `flow`           | flow id?  | drill-down: another flow that details this node                                                       |
| `fp`, `verified` | string?   | written by `flowbook stamp`; never edit                                                               |

Symbols in anonymous namespaces have no namespace prefix. `static` functions are told apart by
`anchor.file`. Conversion operators are named like `proto::Parser::operator bool`.

## `step` — one arrow, in scenario order

| Field        | Type                                                              | Notes                                                                 |
| ------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------- |
| `kind`       | `"step"`                                                          |                                                                       |
| `id`         | id                                                                | e.g. `"s3"`                                                           |
| `seq`        | integer ≥ 1                                                       | 1..N without gaps; alternatives in one `alt` block may share a number |
| `from`, `to` | node id                                                           |                                                                       |
| `label`      | string                                                            | intent: `"need 4-byte header"`                                        |
| `type`       | `call` (default) \| `return` \| `async` \| `callback` \| `signal` |                                                                       |
| `guard`      | string?                                                           | condition, e.g. `"malformed"`                                         |
| `notes`      | markdown?                                                         |                                                                       |

## `block` — UML-style fragment over steps

| Field   | Type                     | Notes                                                |
| ------- | ------------------------ | ---------------------------------------------------- |
| `kind`  | `"block"`                |                                                      |
| `id`    | id                       |                                                      |
| `type`  | `loop` \| `alt` \| `par` |                                                      |
| `label` | string                   | `"for each fd"`, `"auth result"`, `"worker threads"` |
| `steps` | step id[]                | blocks nest or are disjoint, never partially overlap |

## `.flowbook/config.jsonl`

```json
{"kind":"config","version":1}
{"kind":"group","name":"Networking","paths":["src/net/**"]}
```

`group` maps path globs to a named component shown as the top-level box in diagrams; the first
matching group wins. Unmatched files are grouped by their first directory below the common root.
