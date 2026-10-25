import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Resolver } from './resolver.js';

const fixture = fileURLToPath(new URL('../../../fixtures/cpp-sample/', import.meta.url));
const read = (file: string) => readFileSync(fixture + file, 'utf8');

let resolver: Resolver;
beforeAll(async () => {
  resolver = await Resolver.create();
});

const names = (file: string, text = read(file)) =>
  resolver.listSymbols(file, text).map((s) => `${s.kind} ${s.symbol}${s.sig}`);

describe('listSymbols', () => {
  it('qualifies out-of-line methods with their namespace and keeps overloads apart', () => {
    expect(names('src/net/event_loop.cpp')).toEqual([
      'function net::EventLoop::add(int,Callback,void*)',
      'function net::EventLoop::add(Timer*)',
      'function net::EventLoop::run()',
      'function net::EventLoop::dispatch(int)',
    ]);
  });

  it('finds inline methods, templates, conversion operators and classes in headers', () => {
    expect(names('src/proto/parser.hpp')).toEqual([
      'function proto::read_be(const uint8_t*)',
      'type proto::Parser',
      'function proto::Parser::operator bool()const',
    ]);
  });

  it('handles macros, anonymous namespaces and destructors', () => {
    expect(names('src/proto/parser.cpp')).toEqual([
      'macro CHECK_LEN(len,n)',
      'function valid_type(uint16_t)',
      'function proto::Parser::~Parser()',
      'function proto::Parser::feed(const uint8_t*,size_t)',
    ]);
  });

  it('parses .c files with the C grammar and marks static functions', () => {
    const syms = resolver.listSymbols('src/util/log.c', read('src/util/log.c'));
    expect(syms.map((s) => [s.symbol, s.isStatic])).toEqual([
      ['helper', true],
      ['log_init', false],
      ['log_write', false],
    ]);
  });

  it('strips default arguments, parameter names and (void)', () => {
    const src = 'int f(void) { return 0; }\nint g(int a = 3, char *const *b) { return a; }\n';
    expect(names('x.cpp', src)).toEqual(['function f()', 'function g(int,char*const*)']);
  });

  it('reports 0-based ranges covering a template declaration', () => {
    const [readBe] = resolver.listSymbols('src/proto/parser.hpp', read('src/proto/parser.hpp'));
    expect(readBe).toMatchObject({ startLine: 6, endLine: 10, nameLine: 6 });
  });
});

describe('fingerprint', () => {
  const fp = (src: string) => resolver.listSymbols('x.c', src)[0]!.fp;

  it('ignores comments and formatting', () => {
    expect(fp('int f(int a) { return a + 1; }')).toBe(
      fp('int f(int a)\n{\n  // add one\n  return a /* x */ + 1;\n}\n'),
    );
  });

  it('changes when the body changes', () => {
    expect(fp('int f(int a) { return a + 1; }')).not.toBe(fp('int f(int a) { return a + 2; }'));
  });
});

describe('resolve', () => {
  it('resolves a unique symbol without a signature', () => {
    const r = resolver.resolve(
      { file: 'src/net/event_loop.cpp', symbol: 'net::EventLoop::run' },
      read('src/net/event_loop.cpp'),
    );
    expect(r).toMatchObject({ status: 'ok', symbol: { nameLine: 12 } });
  });

  it('needs a signature for overloads, and matches it loosely', () => {
    const text = read('src/net/event_loop.cpp');
    const file = 'src/net/event_loop.cpp';
    expect(resolver.resolve({ file, symbol: 'net::EventLoop::add' }, text).status).toBe(
      'ambiguous',
    );
    const r = resolver.resolve({ file, symbol: 'net::EventLoop::add', sig: '( Timer * )' }, text);
    expect(r).toMatchObject({ status: 'ok', symbol: { sig: '(Timer*)' } });
  });

  it('suggests qualified names for unqualified or misspelled anchors', () => {
    const r = resolver.resolve(
      { file: 'src/net/event_loop.cpp', symbol: 'run' },
      read('src/net/event_loop.cpp'),
    );
    expect(r.status).toBe('missing');
    expect(r.status === 'missing' && r.suggestions.map((s) => s.symbol)).toEqual([
      'net::EventLoop::run',
    ]);
  });

  it('keeps same-named statics in different files apart', () => {
    const a = resolver.resolve(
      { file: 'src/util/log.c', symbol: 'helper' },
      read('src/util/log.c'),
    );
    const b = resolver.resolve(
      { file: 'src/net/server.cpp', symbol: 'helper' },
      read('src/net/server.cpp'),
    );
    expect(a.status === 'ok' && b.status === 'ok' && a.symbol.fp !== b.symbol.fp).toBe(true);
  });
});
