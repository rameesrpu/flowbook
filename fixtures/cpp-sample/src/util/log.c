#include "log.h"
#include <stdio.h>

static int g_verbose;

static int helper(enum log_level level) { return level == LOG_WARN || g_verbose; }

void log_init(int verbose) { g_verbose = verbose; }

void log_write(enum log_level level, const char *msg) {
  if (helper(level)) fprintf(stderr, "%s\n", msg);
}
