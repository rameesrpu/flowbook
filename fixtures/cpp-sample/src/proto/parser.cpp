#include "parser.hpp"

#define CHECK_LEN(len, n)                                                                      \
  do {                                                                                         \
    if ((len) < (n)) return false;                                                             \
  } while (0)

namespace {
bool valid_type(uint16_t type) { return type < 16; }
} // namespace

namespace proto {

Parser::~Parser() = default;

bool Parser::feed(const uint8_t *buf, size_t len) {
  CHECK_LEN(len, 4);
  uint16_t type = read_be<uint16_t>(buf);
  uint16_t size = read_be<uint16_t>(buf + 2);
  ok_ = valid_type(type) && size <= len;
  return ok_;
}

} // namespace proto
