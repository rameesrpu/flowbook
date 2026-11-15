#pragma once

typedef enum { JOB_NONE, JOB_READ_CNF, JOB_WRITE_CNF, JOB_TICK } job_type_t;

struct job;
typedef void (*job_cb_t)(struct job *job);
struct job {
  job_type_t type;
  job_cb_t callback;
};

struct mbox;
int mbox_post(struct mbox *box, void *msg);
int mbox_fetch(struct mbox *box, void **msg);

void job_post(struct job *job, job_type_t type, job_cb_t callback);
void timer_add(int delay_ms, void (*handler)(void *arg), void *arg);

#define EVT_SAVE 0x1
#define EVT_CLEAR 0x2
void event_set(unsigned flags);
unsigned event_wait(void);

struct app_cfg {
  void (*state_cb)(int state);
  void (*data_cb)(int len);
};
