#pragma once
#include <stddef.h>
#include <stdint.h>

struct config {
  int port;
  int verbose;
};

#ifdef __cplusplus
extern "C" {
#endif
int server_run(const struct config *cfg);
#ifdef __cplusplus
}
#endif
