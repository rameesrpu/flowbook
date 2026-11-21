# i-link example

Connection rules for [i-link](https://github.com/rtlabs-com/i-link), an IO-Link master stack in
C, pinned at `9f5fe0f7c6a45fa96a8d2439dcbe60bb2415793d`. There are no flows yet; the example
shows what `flowbook sites` and the editor lenses find in a real stack: jobs posted to the master
thread and dispatched by a `switch`, the master's mailboxes, and the event flags that wake each
DL thread.

| Rule       | Mechanism                                                                                                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `job`      | `iolink_post_job_with_type_and_callback (port, job, type, cb)` and three wrappers that pass the type through a parameter; received by `case IOLINK_JOB_…:` in `iolink_main` |
| `mbox`     | `os_mbox_post` / `os_mbox_fetch`, keyed by the mailbox's member name (`keyMember`): `mbox`, `mbox_avail`, `mbox_api_avail`                                                  |
| `dl-event` | `os_event_set (dl->event, IOLINK_DL_EVENT_…)` and the PL driver's `IOLINK_PL_EVENT_…`; received by the flag tests in `dl_main`                                              |

Two dispatcher connections, `job.dispatch` on `iolink_main` and `dl-event.dispatch` on
`dl_main`, confirm every job type and event flag handled there (verified by reading both
functions), so those reactors show as confirmed. Three keyed connections name the mailboxes:
"Master job mailbox", "Free job pool" and "Free API job pool". The file has 8 records (3 rules,
5 connections), down from 48 (3 rules, 45 connections).

## Layout

```
examples/i-link/
  fetch.sh                  clones i-link into src/ and checks out the pinned commit
  src/                      i-link sources (not committed, gitignored); the stack itself is src/src/
  .flowbook/connections.jsonl  rules and connections (committed); paths are relative to examples/i-link/
  .flowbook/machines.jsonl     state machines and scopes (committed)
```

## Fetch the source

```sh
examples/i-link/fetch.sh
pnpm flowbook sites --root examples/i-link
pnpm flowbook check --root examples/i-link
pnpm flowbook states --root examples/i-link
```

Open `examples/i-link` (not the repository root) in VS Code to see the lenses.

## Results

`flowbook sites --root examples/i-link` ends with:

```
job: 45 send, 39 receive, 36 keys paired (36 confirmed), 3 unpaired, 1 without receive site, 3 forwarding
mbox: 9 send, 4 receive, 3 keys paired (3 confirmed), 0 unpaired
dl-event: 21 send, 10 receive, 8 keys paired (8 confirmed), 5 unpaired
```

Against the grep counts in the design (27 job types at `iolink_post_job_with_type_and_callback`,
39 `case IOLINK_JOB_` labels):

- The 34 calls to `iolink_post_job_with_type_and_callback` carry the same 27 constant job types,
  plus two parameters (`type`, `job_type`) inside wrappers. 26 of the 27 reach their `case` in
  `iolink_main`. `IOLINK_JOB_AL_EVENT_REQ` (posted by `AL_Event_req`, which nothing calls) has no
  `case`: at run time the job would hit the dispatcher's `default` assertion, so its handler is
  listed as unconfirmed and the send line ends with `· no receive site for IOLINK_JOB_AL_EVENT_REQ`.
  It is the one key counted "without receive site".
- The wrapper matchers (`init_and_post_job`, `ode_SMI_rw_req`, `ode_SMI_DeviceReadWrite_req`)
  and `job->type = …` add the 9 SMI job types, `PD_EVENT` and `EXIT`: 37 job types are sent in
  all, and the 36 that reach a `case` are the 36 keys paired.
- The `assign` matcher has `keys: "IOLINK_JOB_(PD_EVENT|EXIT)"`, so of the 8 assignments to
  `job->type` in `iolink_main.c` only the two real posts remain; the five assignments of
  `IOLINK_JOB_NONE` (resets in `iolink_main`, initialisation in `iolink_m_init`) and `job->type = type` inside the post helper give no site (51 → 45 sends).
- The 39 receive sites are exactly the 39 labels in `iolink_main`. The 4 `case IOLINK_JOB_…`
  labels in `iolink_al.c` test a pending job's type and are excluded with `files`.
- Mailboxes: all 13 sites pair by member key. `mbox` has 4 posts (`iolink_post_job_with_type_and_callback`,
  its unit-test variant `iolink_post_job`, `iolink_post_job_pd_event`, and the exit job in
  `iolink_m_deinit`) and one fetch, in
  `iolink_main`. `mbox_avail` has 3 posts (`iolink_m_init` fills the pool, `iolink_main`
  returns finished jobs twice) and 2 fetches (`iolink_fetch_avail_job`,
  `iolink_post_job_pd_event`). `mbox_api_avail` has 2 posts (`iolink_m_init`, `iolink_main`)
  and one fetch (`iolink_fetch_avail_api_job`).

### Forwarding sites

Three send sites forward a parameter of their function and are counted as `3 forwarding`, not
as unpaired and not as keys. Two are listed as `→ forwards parameter …`: `iolink_cm.c:1137`
(`type`, argument 2 of `init_and_post_job`) and `iolink_ode.c:616` (`type`, argument 6 of
`ode_SMI_DeviceReadWrite_req`). The third, `iolink_ode.c:447` (`job_type`, argument 1 of `ode_SMI_rw_req`),
also names its handler, so it is listed with that reactor (`→ SMI_rw_req_cb`). Their keys come
from the callers, which the wrapper matchers match, so `check` has no warning for them.

### Unpaired sites

| Site                                                             | Why                                                                              |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `iolink_main.c` 197, 198, 208 job receive                        | `DL_PDINPUT_TRANS_IND`, `AL_CONTROL_CNF`, `DS_INIT` are handled but never posted |
| `iolink_dl.c:3387` dl-event send `TIMEOUT_TCYC`                  | in `dl_main`'s wait mask, but no branch tests it: it only wakes the thread       |
| `iolink_dl.c:3534` dl-event receive `IOLINK_PL_EVENT`            | set through a variable (see next line)                                           |
| `iolink_max14819_pl.c` 705, 1031 dl-event send `iolink->pl_flag` | the flag value is configured at run time (`IOLINK_PL_EVENT`)                     |
| `iolink_dl.c:3571` dl-event receive `PL_EVENT_STATUS`            | empty branch; nothing sets the flag                                              |

`iolink_al.c:1274` (`IOLINK_JOB_AL_EVENT_REQ`) is also listed by `--unpaired`, as the send
missing its receive site described above.

The free-pool mailboxes used to stay unpaired: the handle is written `master->mbox_avail` in
one place and `port->master->mbox_avail` in another, and `iolink_main` posts to two different
pools, so an anchored connection would have joined the API pool to the plain pool. With
`keyMember` both spellings give the key `mbox_avail`, and each pool pairs only with itself.

## State machines

`.flowbook/machines.jsonl` has three machines and two `scope` records. The DL handlers set
their state by assignment (`dl->message_handler.state = …`) inside one function per state; the
CM is table-driven (`cm_trans_s0..7`, one array per source state, rows
`{event, next state, action}`), and its `from` map was read from the comments in
`iolink_cm_fsm[]` ("the index is the state in this array"). Measured on 2026-11-21 with
`flowbook states --root examples/i-link`:

| Machine   | States | Transitions | Source state found by         | Sets off |
| --------- | ------ | ----------- | ----------------------------- | -------- |
| `dl-mh`   | 18     | 33          | 30 caller, 2 scope, 1 unknown | 14       |
| `dl-mode` | 5      | 8           | 2 caller, 3 scope, 3 unknown  | 2        |
| `cm`      | 8      | 33          | 32 table, 1 unknown           | 0        |

`flowbook check --strict` stays clean and ends with `5 unknown source states`.

Success checks from the design:

- DL message handler: 33 assignments. Without scopes 30 of 33 (91 %) have a known source, all
  from the `case` in `iolink_dl_message_h_sm` that calls the per-state function (target 90 %).
  With the scope `dl-mh-wurq` 32 of 33 (97 %).
- CM: the 32 rows of `cm_trans_s0..7` give 32 transitions, each with its source from the
  8-entry `from` map, its event, the row comment as label (`T1`, `T13`, `Not in FSM`) and its
  action function linked (13 distinct functions). The actions call other modules directly
  (`SM_SetPortConfig_req`, `DS_Delete`, …), not through a rule, so nothing is "set off". The
  33rd transition is the initial assignment in `iolink_cm_init`.

Scopes: `iolink_dl_wurq_recv` runs when the PL driver reports a finished wake-up request, which the
mode handler starts in `ESTCOM_1` while the message handler is `INACTIVE_0`; the code's own
comments name the transitions `mdh_T2/T3/T4`, `mdh_T5` and `mh_T1`. `dl-mh-wurq` and
`dl-mode-wurq` give its sites those sources (the mode handler goes from 2 to 5 of 8 known).

Unknown source states (5):

| Site                                                 | Why                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| `iolink_dl.c:768` `iolink_dl_mh_handle_com_lost`     | helper called from ERRORHANDLING_10, AW_REPLY_16, ERRORHANDLING_17 |
| `iolink_dl.c:525` `iolink_dl_mode_h_sm_goto_operate` | helper called from the STARTUP_2 and PREOPERATE_3 functions        |
| `iolink_dl.c:546` `iolink_dl_mode_h_sm_goto_idle`    | helper called from STARTUP_2, PREOPERATE_3 and OPERATE_4           |
| `iolink_dl.c:556` `iolink_dl_mode_h_sm_goto_startup` | helper called from PREOPERATE_3 and OPERATE_4                      |
| `iolink_cm.c:1073` `iolink_cm_init`                  | initialisation, no state yet                                       |

"Sets off" counts every send in the per-state function, so all transitions out of a function
that has one `os_event_set` list it, whichever branch posts it (a known limit, on the backlog).

Cold `sites` with machines (2026-11-21, busy machine, 7 alternating runs): median 2.57 s with machines, 2.59 s without. The machines parse no extra files.

## Licence

i-link is GPLv3 or commercial (rt-labs). Its sources are not part of this repository;
`fetch.sh` downloads them into the gitignored `src/`. Only the rule file and this README are
ours.
