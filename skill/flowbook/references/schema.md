# Flowbook record reference

Every line of a `.jsonl` file is one JSON object with a `kind`. Unknown fields are errors, so
typos are caught by `flowbook check`. The machine-readable JSON Schema is
`schema/flowbook.schema.json` in the Flowbook repository.

Ids (`id`, and every reference to one) use letters, digits, `.`, `_`, `-` and start with a letter
or digit. Node, step and block ids share one namespace per flow.

## `flow` — exactly one per file, first line

| Field     | Type                             | Notes                                                                                                                                               |
| --------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`    | `"flow"`                         |                                                                                                                                                     |
| `id`      | id                               | must equal the file name without `.jsonl`                                                                                                           |
| `title`   | string                           | e.g. `"Packet handling"`                                                                                                                            |
| `summary` | markdown?                        | one short paragraph: trigger, outcome, why it matters                                                                                               |
| `entry`   | node id?                         | where the scenario starts                                                                                                                           |
| `tags`    | string[]?                        | first tag = the flow's section in the extension's tree (put the most useful classifier first); all tags are searchable, e.g. `["lifecycle", "net"]` |
| `layout`  | `{ "direction": "LR" \| "TB" }`? | flowchart direction, default `LR`                                                                                                                   |

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

## `.flowbook/connections.jsonl`

Connection points: rules that find where code posts to and receives from queues, events, timers and
callbacks, plus connections that name or pin down a pairing. One JSON object per line, strict.
Ids are unique within the file. Nothing here carries `fp` or `verified`; connections are re-checked
against the code on every scan.

### `rule`

| Field     | Type       | Notes                                                               |
| --------- | ---------- | ------------------------------------------------------------------- |
| `kind`    | `"rule"`   |                                                                     |
| `id`      | id         |                                                                     |
| `title`   | string     | e.g. `"Master job queue"`                                           |
| `type`    | enum       | `queue`, `event`, `timer`, `callback`, `request`. For display only. |
| `send`    | matcher[]  | at least one                                                        |
| `receive` | matcher[]? | omit when every send matcher names a handler                        |
| `context` | string?    | where reactors of this rule run, e.g. `"master thread"`             |
| `notes`   | markdown?  |                                                                     |

### Matchers

A matcher has exactly one of the five keys below, plus an optional `"files": [globs]` that limits
where it applies. Every name is a regular expression that must match the whole name, so a plain
name is an exact match. Argument positions are 1-based.

| Matcher                                     | Matches                                                        | Key                    | Handler      |
| ------------------------------------------- | -------------------------------------------------------------- | ---------------------- | ------------ |
| `{"call": name, "key"?: n, "handler"?: n}`  | a call to a function or function-like macro                    | argument `n`, if given | argument `n` |
| `{"case": name}`                            | a `case` label that is an identifier                           | the identifier         |              |
| `{"test": name}`                            | an identifier inside the condition of an `if`, `while` or `?:` | the identifier         |              |
| `{"assign": field, "as": "key"\|"handler"}` | an assignment or designated initializer of a struct field      | see below              | see below    |
| `{"invoke": field}`                         | a call through a struct field, `x->f (…)` or `x.f (…)`         | the field name         |              |

For `assign`, `"as": "key"` makes the right-hand side the key; `"as": "handler"` makes the
right-hand side the handler and the field name the key. A key taken from an argument or a
right-hand side is the identifier when it is one, otherwise the source text with whitespace
removed. A handler must be an identifier; otherwise the site is kept and reported as having an
unresolved handler.

```jsonl
{"kind":"rule","id":"job","title":"Master job queue","type":"queue","context":"master thread","send":[{"call":"iolink_post_job_with_type_and_callback","key":3,"handler":4}],"receive":[{"case":"IOLINK_JOB_.*"}]}
{"kind":"rule","id":"sched","title":"Scheduler timeout","type":"timer","send":[{"call":"pf_scheduler_add","handler":3}]}
{"kind":"rule","id":"app-cb","title":"Application callback","type":"callback","send":[{"invoke":".*_cb"}],"receive":[{"assign":".*_cb","as":"handler"}]}
{"kind":"rule","id":"mbox","title":"Mailbox","type":"queue","send":[{"call":"os_mbox_post"}],"receive":[{"call":"os_mbox_fetch"}]}
```

### `connection`

| Field     | Type           | Notes                                           |
| --------- | -------------- | ----------------------------------------------- |
| `kind`    | `"connection"` |                                                 |
| `id`      | id             |                                                 |
| `rule`    | id             | the rule it belongs to                          |
| `title`   | string         | e.g. `"AL read confirmation"`                   |
| `key`     | string?        | keyed form                                      |
| `send`    | anchor[]?      | anchored form: functions with the send sites    |
| `receive` | anchor[]?      | anchored form: functions with the receive sites |
| `context` | string?        | overrides the rule's `context`                  |
| `notes`   | markdown?      |                                                 |

Exactly one form: **keyed** (`key` only; names and confirms the pairing derived for that rule and
key) or **anchored** (non-empty `send` and `receive` only; pairs every send site of the rule inside
the `send` functions with every receive site inside the `receive` functions, which is how plain
queues are paired). Anchors are the usual `file` + `symbol` (+ `sig`).
