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
```

## Fetch the source

```sh
examples/i-link/fetch.sh
pnpm flowbook sites --root examples/i-link
pnpm flowbook check --root examples/i-link
```

Open `examples/i-link` (not the repository root) in VS Code to see the lenses.

## Results

`flowbook sites --root examples/i-link` ends with:

```
job: 45 send, 39 receive, 37 keys paired (37 confirmed), 3 unpaired, 1 without receive site, 2 forwarding
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
  all, 36 reach a `case`. The 37th paired key is the `job_type` parameter of the
  `iolink_ode.c:447` wrapper: it forwards the type, but also names its handler
  (`SMI_rw_req_cb`), which is a confirmed reactor.
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

Two send sites are listed as `→ forwards parameter …` and counted as `2 forwarding`, not as
unpaired: `iolink_cm.c:1137` (`type`, argument 2 of `init_and_post_job`) and `iolink_ode.c:616`
(`type`, argument 6 of `ode_SMI_DeviceReadWrite_req`). Their keys come from the callers, which
the wrapper matchers match, so `check` has no warning for them.

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

## Licence

i-link is GPLv3 or commercial (rt-labs). Its sources are not part of this repository;
`fetch.sh` downloads them into the gitignored `src/`. Only the rule file and this README are
ours.
