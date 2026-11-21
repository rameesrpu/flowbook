#include "rt.h"

/* Shape C: a transition table per source state; the table-to-state map is in machines.jsonl. */
enum { CM_ST_INIT, CM_ST_RUN, CM_ST_DONE };
enum { CM_EV_START, CM_EV_SKIP, CM_EV_STOP, CM_EV_RESET };

struct cm_row {
  int event;
  int to;
  void (*action)(void);
};

static void cm_start(void) { event_set(EVT_SAVE); }
static void cm_stop(void) {}

static const struct cm_row cm_trans_s0[] = {
    {CM_EV_START, CM_ST_RUN, cm_start}, /* T1 */
    {CM_EV_SKIP, CM_ST_DONE, cm_stop},  /* T2 */
};

static const struct cm_row cm_trans_s1[] = {
    {CM_EV_STOP, CM_ST_DONE, cm_stop},  /* T3 */
    {CM_EV_RESET, CM_ST_INIT, cm_stop}, /* T4 */
};
