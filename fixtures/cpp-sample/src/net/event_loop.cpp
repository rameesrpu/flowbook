#include "event_loop.hpp"

namespace net {

void EventLoop::add(int fd, Callback cb, void *ctx) {
  fds_.push_back(fd);
  (void)cb;
  (void)ctx;
}

void EventLoop::add(Timer *timer) { (void)timer; }

void EventLoop::run() {
  while (running_) {
    for (int fd : fds_) {
      dispatch(fd);
    }
  }
}

void EventLoop::dispatch(int fd) {
  // Real code would read from fd and invoke the registered callback.
  (void)fd;
}

} // namespace net
