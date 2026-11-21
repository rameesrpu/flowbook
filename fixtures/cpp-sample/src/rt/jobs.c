#include "rt.h"

static struct mbox *main_box;
static struct job read_job, write_job, tick_job;

/* Queue a job for the main task. */
void job_post(struct job *job, job_type_t type, job_cb_t callback) {
  job->type = type;
  job->callback = callback;
  mbox_post(main_box, job);
}

static void read_done(struct job *job) { job->type = JOB_NONE; }
static void write_done(struct job *job) { job->type = JOB_NONE; }

void request_read(void) { job_post(&read_job, JOB_READ_CNF, read_done); }
void request_write(void) { job_post(&write_job, JOB_WRITE_CNF, write_done); }

static void on_poll_timeout(void *arg) {
  (void)arg;
  event_set(EVT_SAVE);
}

void start_poll(void) { timer_add(100, on_poll_timeout, 0); }

void notify_state(struct app_cfg *cfg) { cfg->state_cb(1); }

/* Main task: runs every job, then handles pending events. */
void rt_main(void) {
  for (;;) {
    void *msg;
    mbox_fetch(main_box, &msg);
    struct job *job = msg;
    switch (job->type) {
    case JOB_READ_CNF:
    case JOB_WRITE_CNF:
      job->callback(job);
      break;
    case JOB_TICK:
      break;
    default:
      break;
    }
    unsigned flags = event_wait();
    if (flags & EVT_SAVE) {
      flags = 0;
    }
  }
}

/* The tick job queues itself again when it is done. */
static void tick_done(struct job *job) {
  job->type = JOB_TICK;
  mbox_post(main_box, job);
}

/* Queue the tick job; the caller picks its type and callback. */
void job_post_typed(job_type_t type, job_cb_t done) { job_post(&tick_job, type, done); }

void start_tick(void) { job_post_typed(JOB_TICK, tick_done); }
