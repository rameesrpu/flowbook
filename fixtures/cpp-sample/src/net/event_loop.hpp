#pragma once
#include <cstddef>
#include <cstdint>
#include <vector>

namespace net {

using Callback = void (*)(void *ctx, const uint8_t *buf, size_t len);

struct Timer {
  int ms;
};

class EventLoop {
public:
  void add(int fd, Callback cb, void *ctx);
  void add(Timer *timer);
  void run();
  void stop() { running_ = false; }

private:
  void dispatch(int fd);
  bool running_ = true;
  std::vector<int> fds_;
};

} // namespace net
