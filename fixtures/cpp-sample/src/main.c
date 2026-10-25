#include "net/server.h"
#include "util/log.h"

/* Entry point: parse flags, then hand over to the server loop. */
int main(int argc, char **argv) {
  struct config cfg = {.port = 7000, .verbose = argc > 1};
  log_init(cfg.verbose);
  return server_run(&cfg);
}
