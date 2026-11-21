#include "rt.h"

/* Runtime mailbox: posted through the runtime, fetched through a task's context. */
void rt_send(struct rt *rt, void *msg) { mbox_post(rt->box, msg); }

void rt_poll(struct rt_ctx *ctx) {
  void *msg;
  mbox_fetch(ctx->rt->box, &msg);
}
