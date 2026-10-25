#pragma once

enum log_level { LOG_INFO, LOG_WARN };

#ifdef __cplusplus
extern "C" {
#endif
void log_init(int verbose);
void log_write(enum log_level level, const char *msg);
#ifdef __cplusplus
}
#endif
