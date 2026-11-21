#include "rt.h"

static void app_state(int state) { (void)state; }
static void app_data(int len) { (void)len; }

struct app_cfg app = {.state_cb = app_state};

void app_init(void) { app.data_cb = app_data; }
