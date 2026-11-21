#include "rt.h"

/* Shape D: setters outside any state case; a scope record names the state of dev_init. */
enum { DEV_ST_POWER_ON, DEV_ST_READY, DEV_ST_ERROR };

struct dev {
  int state;
};
void dev_set_state(struct dev *d, int state);

void dev_init(struct dev *d) { dev_set_state(d, DEV_ST_READY); }

void dev_abort(struct dev *d) { dev_set_state(d, DEV_ST_POWER_ON); }

void dev_ind(struct dev *d) {
  switch (d->state) {
  case DEV_ST_READY:
    dev_set_state(d, DEV_ST_ERROR);
    break;
  default:
    break;
  }
}
