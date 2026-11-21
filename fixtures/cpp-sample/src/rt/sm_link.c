#include "rt.h"

/* Shape A: the setter sits in a state case, the event is a nested case. */
enum { LINK_ST_IDLE, LINK_ST_RUN, LINK_ST_FAIL };
enum { LINK_EV_START, LINK_EV_ERROR, LINK_EV_STOP };

struct link {
  int state;
  int retries;
};
void link_set_state(struct link *l, int state);

void link_ind(struct link *l, int event) {
  switch (l->state) {
  case LINK_ST_IDLE:
    switch (event) {
    case LINK_EV_START:
      event_set(EVT_SAVE);
      link_set_state(l, LINK_ST_RUN);
      break;
    default:
      break;
    }
    break;
  case LINK_ST_RUN:
    switch (event) {
    case LINK_EV_ERROR:
      if (l->retries > 3) {
        link_set_state(l, LINK_ST_FAIL);
      }
      break;
    case LINK_EV_STOP:
      link_set_state(l, LINK_ST_IDLE);
      break;
    default:
      break;
    }
    break;
  default:
    break;
  }
}
