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

One dispatcher connection, `bg.dispatch` on `bg_worker_task`, confirms every background worker
flag tested there (verified by reading the function); it replaces the 10 keyed connections the
file used to have (13 records → 4). The callback registrations are not
confirmed: this repository contains no application, so the only registrations are in the
integration test fixture (`test/utils_for_testing.cpp`).

## Layout

```
examples/p-net/
  fetch.sh                  clones p-net into src/ and checks out the pinned commit
  src/                      p-net sources (not committed, gitignored); the stack itself is src/src/
  .flowbook/connections.jsonl  rules and connections (committed); paths are relative to examples/p-net/
  .flowbook/machines.jsonl     state machines and scopes (committed)
```

## Fetch the source

```sh
examples/p-net/fetch.sh
pnpm flowbook sites --root examples/p-net
pnpm flowbook check --root examples/p-net
pnpm flowbook states --root examples/p-net
```

Open `examples/p-net` (not the repository root) in VS Code to see the lenses.

## Results

`flowbook sites --root examples/p-net` ends with:

```
sched: 42 send, 0 receive, 41 sends paired (41 confirmed), 0 unpaired, 1 forwarding
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
  condition inside `#ifdef BG_WORKER_LOG_JOBS`, hence 11 receive sites for 10 flags. The
  dispatcher confirms both, so the send line lists `bg_worker_task` twice.
- `BG_JOB_EVENT_CLEAR_SNMP_SYSTEM_LOCATION_NVM_DATA` is tested and handled in `bg_worker_task`
  but is not in its wait `mask`; Flowbook pairs the test, it does not check the mask.

### Forwarding site

`pf_scheduler.c:267` (`pf_scheduler_restart` passing its own `cb` parameter to
`pf_scheduler_add`) is listed as `→ forwards parameter cb (argument 3 of pf_scheduler_restart)`
and counted as `1 forwarding`, not as unpaired. The second send matcher matches the callers of
`pf_scheduler_restart`, so `check` has no warning for it.

### Unpaired sites

| Site                                            | Why                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| `pf_fspm.c:1363` app-cb send `alarm_ack_cnf_cb` | the test fixture does not register it                             |
| `pf_plugsm.c:117` app-cb send `sm_released_cb`  | the test fixture does not register it                             |
| `pf_fspm.c:1389` app-cb send `reset_cb`         | the test fixture only assigns `NULL`, which is not a registration |

## State machines

`.flowbook/machines.jsonl` has six machines, one per state variable, each found by its setter
call (`pf_<x>_set_state (…, STATE)`), and one `scope` record (two functions). Measured on 2026-11-21 with
`flowbook states --root examples/p-net`:

| Machine | States | Transitions | Source state found by               | Sets off |
| ------- | ------ | ----------- | ----------------------------------- | -------- |
| `cmsm`  | 2      | 4           | 4 case                              | 1        |
| `cmdev` | 11     | 22          | 11 case, 7 test, 2 scope, 2 unknown | 0        |
| `cmpbe` | 7      | 16          | 14 case, 2 test                     | 0        |
| `cmio`  | 4      | 8           | 8 case                              | 3        |
| `ppm`   | 2      | 2           | 2 unknown                           | 0        |
| `cpm`   | 3      | 9           | 6 case, 3 unknown                   | 1        |

"case" is the enclosing state `case`; "test" is a setter inside `if (<state> == STATE)`. A setter
under several state labels gives one transition per label (`pf_cmdev_rm_release_ind`: one call,
five transitions), and a fall-through group of event labels one per event.
`flowbook check --strict` stays clean and ends with `7 unknown source states`.

Success checks from the design:

- CMSM: exactly the four transitions a reader finds: `IDLE → RUN on PNET_EVENT_STARTUP · sets
off sched → pf_cmsm_timeout`, `RUN → IDLE on PNET_EVENT_DATA`, `RUN → IDLE on
PNET_EVENT_ABORT`, and `RUN → IDLE in pf_cmsm_timeout` (source from the timeout's own `case`,
  no scope needed).
- CMDEV: 18 setter calls (19 with the definition), 22 transitions. Without scopes 18 of 22
  (82 %) have a known source, short of the 90 % target. With the scope `cmdev-connect` 20 of 22
  (91 %): `pf_cmdev_rm_connect_ind` and `pf_cmdev_cm_connect_rsp_neg` (read: the AR is zeroed by
  `pf_ar_allocate` just before `pf_cmdev_rm_connect_ind`, and `…_rsp_neg` is only called from
  its failure branch, so both run in `POWER_ON`). With the genuine any-state abort
  `pf_cmdev_cm_abort` left out: 18 of 21 (86 %) without scopes, 20 of 21 (95 %) with them.

Unknown source states (7):

| Site                                                   | Why                                                      |
| ------------------------------------------------------ | -------------------------------------------------------- |
| `pf_cmdev.c:1495` `pf_cmdev_cm_abort` → ABORT          | any state (the code says so)                             |
| `pf_cmdev.c:4819` `…_cm_connect_rsp_pos` → W_CIND      | `else` of `if (cmdev_state == W_CRES)`: any other state  |
| `pf_ppm.c:377` `pf_ppm_activate_req` → RUN             | returns early in RUN, so the source is W_START; not read |
| `pf_ppm.c:415`, `pf_cpm.c:161` `…_close_req` → W_START | any state                                                |
| `pf_cpm.c:136` `pf_cpm_create` → W_START               | initialisation, no state yet                             |
| `pf_cpm_driver_lan9662.c:204` `…_ci_timeout` → W_START | data hold timer expired; any running state               |

Two things to know when reading the list: the source is the state on entry, so
`pf_cmdev.c:4992` shows `W_PEIND → W_ARDY` although the line before it set `W_PERES`; and
"sets off" counts every send in the transition's `case`, including sends in sibling branches
(a known limit, on the backlog): the three `cmio` transitions out of `STARTUP` all list
`sched → pf_cmio_timer_expired`, which only the `PNET_EVENT_PRMEND` branch posts, so `cmio`'s
3 is really 1.

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
| cold `sites` with machines, relative to rules only (2026-11-21, under load)     | +4.5 % | ≤ 10 % |

The 2026-11-21 row comes from alternating runs with and without `machines.jsonl` (9 each) on a
busy machine (load average 3–5): medians 3.22 s with machines, 3.08 s without; cold `states`
2.93 s. Two earlier sets gave +2.4 % and +7.7 %. Absolute times on this laptop moved between
1.4 s and 3.1 s with load during the day, so only the relative cost is meaningful; re-time on a
quiet machine.

Parsing dominates the cold scan. A rule whose names have no literal fragment (every file is
parsed) takes the first scan to 1.5 s. The machines let 3 more files through the prefilter (32
instead of 29: `pf_cmpbe.c`, `pf_ppm.c`, `pf_cpm.c`, which hold setters); `states` uses the
same single scan.

## Licence

p-net is GPLv3 or commercial (rt-labs). Its sources are not part of this repository;
`fetch.sh` downloads them into the gitignored `src/`. Only the rule file and this README are
ours.
