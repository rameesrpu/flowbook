#include "rt.h"

/* Shape B: one function per state; it assigns the state variable. */
enum { DL_ST_STARTUP, DL_ST_PREOP, DL_ST_OPERATE };

struct dl {
  int dl_state;
  int cmd;
};

static void dl_startup(struct dl *d) {
  if (d->cmd == 1) {
    d->dl_state = DL_ST_PREOP;
  }
}

static void dl_preop(struct dl *d) {
  if (d->cmd == 2) {
    d->dl_state = DL_ST_OPERATE;
  }
}

void dl_run(struct dl *d) {
  switch (d->dl_state) {
  case DL_ST_STARTUP:
    dl_startup(d);
    break;
  case DL_ST_PREOP:
    dl_preop(d);
    break;
  default:
    break;
  }
}
