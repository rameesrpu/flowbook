#include "server.h"
#include "event_loop.hpp"
#include "../proto/parser.hpp"
#include "../util/log.h"

static proto::Parser g_parser;

// Same name as the static helper in util/log.c; anchors disambiguate by file.
static int helper(int fd) { return fd >= 0 ? fd : -1; }

static void on_packet(void *ctx, const uint8_t *buf, size_t len) {
  auto *loop = static_cast<net::EventLoop *>(ctx);
  if (!g_parser.feed(buf, len)) {
    log_write(LOG_WARN, "bad packet");
    loop->stop();
  }
}

static int accept_conn(int listen_fd) {
  int fd = helper(listen_fd);
  log_write(LOG_INFO, "accepted");
  return fd;
}

extern "C" int server_run(const struct config *cfg) {
  net::EventLoop loop;
  int fd = accept_conn(cfg->port);
  loop.add(fd, &on_packet, &loop);
  loop.add(new net::Timer{1000});
  loop.run();
  return 0;
}
