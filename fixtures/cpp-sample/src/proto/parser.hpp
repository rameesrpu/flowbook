#pragma once
#include <cstddef>
#include <cstdint>

namespace proto {

template <typename T> T read_be(const uint8_t *p) {
  T v = 0;
  for (size_t i = 0; i < sizeof(T); i++) v = (v << 8) | p[i];
  return v;
}

class Parser {
public:
  ~Parser();
  bool feed(const uint8_t *buf, size_t len);
  explicit operator bool() const { return ok_; }

private:
  bool ok_ = true;
};

} // namespace proto
