# p-net example

Connection rules for [p-net](https://github.com/rtlabs-com/p-net), a PROFINET device stack in C,
pinned at `1c3b0b435b2ee2c6cea86849c14ee98f6ee579f1`. There are no flows yet; the example shows
what `flowbook sites` and the editor lenses find in a real stack: scheduler timeouts, callbacks
into the application, and the background worker's event flags.

| Rule     | Mechanism                                                                                                 |
| -------- | --------------------------------------------------------------------------------------------------------- |
| `sched`  | `pf_scheduler_add (net, delay, cb, arg, handle)` and `pf_scheduler_restart`; the handler is argument 3    |
| `app-cb` | the stack calls `net->fspm_cfg.<name>_cb (…)`; the application registers `cfg.<name>_cb = fn`             |
| `bg`     | `os_event_set (net->pf_bg_worker.events, BG_JOB_EVENT_…)`; received by the flag tests in `bg_worker_task` |

The background worker's flags have keyed connections. The callback registrations are not
confirmed: this repository contains no application, so the only registrations are in the
integration test fixture (`test/utils_for_testing.cpp`).

## Layout

```
examples/p-net/
  fetch.sh                  clones p-net into src/ and checks out the pinned commit
  src/                      p-net sources (not committed, gitignored); the stack itself is src/src/
  .flowbook/connections.jsonl  rules and connections (committed); paths are relative to examples/p-net/
```

## Fetch the source

```sh
examples/p-net/fetch.sh
pnpm flowbook sites --root examples/p-net
pnpm flowbook check --root examples/p-net
```

Open `examples/p-net` (not the repository root) in VS Code to see the lenses.

## Results

`flowbook sites --root examples/p-net` ends with:

```
sched: 42 send, 0 receive, 41 sends paired (41 confirmed), 1 unpaired
app-cb: 16 send, 13 receive, 13 keys paired (0 confirmed), 3 unpaired
bg: 10 send, 11 receive, 10 keys paired (10 confirmed), 0 unpaired
```

Against the grep counts in the design (17 scheduler handlers, 16 `fspm_cfg` callback fields):

- Every handler resolves to exactly one definition. The 17 distinct handlers passed to
  `pf_scheduler_add` are in `src/src/device` (5), `src/src/common` (7) and `src/src/drivers` (5);
  the design's "under `src/device` and `src/common`" covers 12 of them. `pf_scheduler_restart`
  adds 3 more (`pf_cmsm_timeout`, `pf_session_call_timeout`, `pf_dcp_clear_sam`). The unit tests
  in `src/test` add 7 sites with 2 test handlers.
- All 16 callback fields of `pnet_cfg_t` have exactly one invoke site (15 in `pf_fspm.c`,
  `sm_released_cb` in `pf_plugsm.c`). No other `…_cb` field is invoked, so the rule needs no
  `files` limit.
- `bg_worker_task` tests `BG_JOB_EVENT_UPDATE_PORTS_STATUS` twice; one of the two is a log
  condition inside `#ifdef BG_WORKER_LOG_JOBS`, hence 11 receive sites for 10 flags.

### Unpaired sites

| Site                                            | Why                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| `pf_scheduler.c:267` sched send `cb`            | `pf_scheduler_restart` forwarding its own parameter; its callers are matched directly |
| `pf_fspm.c:1363` app-cb send `alarm_ack_cnf_cb` | the test fixture does not register it                                                 |
| `pf_plugsm.c:117` app-cb send `sm_released_cb`  | the test fixture does not register it                                                 |
| `pf_fspm.c:1389` app-cb send `reset_cb`         | the test fixture only assigns `NULL`, which is not a registration                     |

## Scan times

Measured on 2026-11-15 on the development machine (Intel Core i3-8145U, 4 threads, Node 22),
medians of three runs. The root holds 117 source files (about 71,000 lines including the C++
tests); the prefilter lets 29 of them through to the parser.

| What                                                                            | Time   | Target |
| ------------------------------------------------------------------------------- | ------ | ------ |
| `node packages/cli/dist/flowbook.js sites --root examples/p-net` (cold process) | 1.16 s | < 10 s |
| first `scanRoot` with an empty cache, inside one process                        | 1.01 s |        |
| second `scanRoot` with the same cache (nothing changed)                         | 12 ms  | < 1 s  |
| `buildConnectionIndex` over all scans                                           | 0.7 ms |        |
| rescan of `pf_cmrpc.c` (5,681 lines) plus a new index, as for an unsaved edit   | 102 ms |        |

Parsing dominates the cold scan. A rule whose names have no literal fragment (every file is
parsed) takes the first scan to 1.5 s.

## Licence

p-net is GPLv3 or commercial (rt-labs). Its sources are not part of this repository;
`fetch.sh` downloads them into the gitignored `src/`. Only the rule file and this README are
ours.
