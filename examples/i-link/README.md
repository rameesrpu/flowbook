# i-link example

Connection rules for [i-link](https://github.com/rtlabs-com/i-link), an IO-Link master stack in
C, pinned at `9f5fe0f7c6a45fa96a8d2439dcbe60bb2415793d`. There are no flows yet; the example
shows what `flowbook sites` and the editor lenses find in a real stack: jobs posted to the master
thread and dispatched by a `switch`, the master's mailboxes, and the event flags that wake each
DL thread.

| Rule       | Mechanism                                                                                                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `job`      | `iolink_post_job_with_type_and_callback (port, job, type, cb)` and three wrappers that pass the type through a parameter; received by `case IOLINK_JOB_…:` in `iolink_main` |
| `mbox`     | `os_mbox_post` / `os_mbox_fetch`; the job mailbox is paired by the anchored connection `master-mbox`                                                                        |
| `dl-event` | `os_event_set (dl->event, IOLINK_DL_EVENT_…)` and the PL driver's `IOLINK_PL_EVENT_…`; received by the flag tests in `dl_main`                                              |

Each job type and event flag the dispatcher handles has a keyed connection (verified by reading
`iolink_main` and `dl_main`), so those reactors show as confirmed.

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
job: 51 send, 39 receive, 38 keys paired (38 confirmed), 11 unpaired
mbox: 9 send, 4 receive, 4 sends paired (4 confirmed), 8 unpaired
dl-event: 21 send, 10 receive, 8 keys paired (8 confirmed), 5 unpaired
```

Against the grep counts in the design (27 job types at `iolink_post_job_with_type_and_callback`,
39 `case IOLINK_JOB_` labels):

- The 34 calls to `iolink_post_job_with_type_and_callback` carry the same 27 constant job types,
  plus two parameters (`type`, `job_type`) inside wrappers. All 27 have a reactor; 26 reach their
  `case` in `iolink_main`. `IOLINK_JOB_AL_EVENT_REQ` (posted by `AL_Event_req`, which nothing
  calls) has no `case`, so only its handler is listed; at run time the job would hit the
  dispatcher's `default` assertion.
- The wrapper matchers (`init_and_post_job`, `ode_SMI_rw_req`, `ode_SMI_DeviceReadWrite_req`)
  and `job->type = …` add the 9 SMI job types, `PD_EVENT` and `EXIT`: 37 job types are sent in
  all, 36 reach a `case`.
- The 39 receive sites are exactly the 39 labels in `iolink_main`. The 4 `case IOLINK_JOB_…`
  labels in `iolink_al.c` test a pending job's type and are excluded with `files`.

### Unpaired sites

| Site                                                               | Why                                                                               |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `iolink_cm.c:1137`, `iolink_ode.c:616` job send `type`             | inside a wrapper; its callers are matched by the wrapper matchers                 |
| `iolink_main.c:310` job send `type`                                | `job->type = type` inside the post helper itself                                  |
| `iolink_main.c` 184, 220, 237, 531, 537 job send `IOLINK_JOB_NONE` | `job->type = IOLINK_JOB_NONE` resets a finished job; a matcher cannot filter keys |
| `iolink_main.c` 197, 198, 208 job receive                          | `DL_PDINPUT_TRANS_IND`, `AL_CONTROL_CNF`, `DS_INIT` are handled but never posted  |
| `iolink_main.c` 186, 222, 239, 532, 538 mbox send                  | return a job to a free pool (`mbox_avail`, `mbox_api_avail`)                      |
| `iolink_main.c` 264, 284, 326 mbox receive                         | take a job from a free pool                                                       |
| `iolink_dl.c:3387` dl-event send `TIMEOUT_TCYC`                    | in `dl_main`'s wait mask, but no branch tests it: it only wakes the thread        |
| `iolink_dl.c:3534` dl-event receive `IOLINK_PL_EVENT`              | set through a variable (see next line)                                            |
| `iolink_max14819_pl.c` 705, 1031 dl-event send `iolink->pl_flag`   | the flag value is configured at run time (`IOLINK_PL_EVENT`)                      |
| `iolink_dl.c:3571` dl-event receive `PL_EVENT_STATUS`              | empty branch; nothing sets the flag                                               |

The free-pool mailbox sites stay unpaired on purpose. `iolink_main` posts to two different
pools, and an anchored connection pairs every send in a function with every receive in the
other, so it would join the API pool to the plain pool. The mailbox handle cannot be the key
either: it is written `master->mbox_avail` in one place and `port->master->mbox_avail` in another.

## Licence

i-link is GPLv3 or commercial (rt-labs). Its sources are not part of this repository;
`fetch.sh` downloads them into the gitignored `src/`. Only the rule file and this README are
ours.
