import { createRequire } from 'node:module';
import { join } from 'node:path';
import { normalizeSig, type Anchor } from '@flowbook/core';
import { Language, Parser } from 'web-tree-sitter';
import { collectSymbols, type SymbolInfo } from './symbols.js';

export type Resolution =
  | { status: 'ok'; symbol: SymbolInfo }
  | { status: 'ambiguous'; candidates: SymbolInfo[] }
  | { status: 'missing'; suggestions: SymbolInfo[] };

export interface ResolverOptions {
  /**
   * Directory containing web-tree-sitter.wasm, tree-sitter-c.wasm and tree-sitter-cpp.wasm.
   * Defaults to the installed npm packages; bundles pass the directory they copied them to.
   */
  wasmDir?: string;
}

const C_EXTENSIONS = /\.c$/i;
export const SOURCE_EXTENSIONS = /\.(c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|h\+\+|inl|ipp|tpp)$/i;

function defaultWasmPaths() {
  const require = createRequire(import.meta.url);
  return {
    runtime: require.resolve('web-tree-sitter/web-tree-sitter.wasm'),
    c: require.resolve('tree-sitter-c/tree-sitter-c.wasm'),
    cpp: require.resolve('tree-sitter-cpp/tree-sitter-cpp.wasm'),
  };
}

/** Finds C/C++ definitions in source text. Create once and reuse; parsing is synchronous. */
export class Resolver {
  private constructor(
    private readonly cParser: Parser,
    private readonly cppParser: Parser,
  ) {}

  static async create(options: ResolverOptions = {}): Promise<Resolver> {
    const paths = options.wasmDir
      ? {
          runtime: join(options.wasmDir, 'web-tree-sitter.wasm'),
          c: join(options.wasmDir, 'tree-sitter-c.wasm'),
          cpp: join(options.wasmDir, 'tree-sitter-cpp.wasm'),
        }
      : defaultWasmPaths();
    await Parser.init({ locateFile: () => paths.runtime });
    const [c, cpp] = await Promise.all([Language.load(paths.c), Language.load(paths.cpp)]);
    const cParser = new Parser();
    cParser.setLanguage(c);
    const cppParser = new Parser();
    cppParser.setLanguage(cpp);
    return new Resolver(cParser, cppParser);
  }

  /** All definitions in a file. `.c` files use the C grammar, everything else C++. */
  listSymbols(path: string, text: string): SymbolInfo[] {
    const parser = C_EXTENSIONS.test(path) ? this.cParser : this.cppParser;
    const tree = parser.parse(text);
    if (!tree) return [];
    try {
      return collectSymbols(tree);
    } finally {
      tree.delete();
    }
  }

  resolve(anchor: Anchor, text: string): Resolution {
    return match(anchor, this.listSymbols(anchor.file, text));
  }
}

const lastSegment = (s: string) => s.slice(s.lastIndexOf(':') + 1);

/** Picks the definition an anchor refers to from a file's symbols. */
export function match(anchor: Anchor, symbols: SymbolInfo[]): Resolution {
  const named = symbols.filter((s) => s.symbol === anchor.symbol);
  const candidates =
    anchor.sig === undefined ? named : named.filter((s) => s.sig === normalizeSig(anchor.sig!));
  if (candidates.length === 1) return { status: 'ok', symbol: candidates[0]! };
  if (candidates.length > 1) return { status: 'ambiguous', candidates };
  const leaf = lastSegment(anchor.symbol);
  const suggestions = named.length
    ? named
    : symbols.filter((s) => lastSegment(s.symbol) === leaf || s.symbol.endsWith(anchor.symbol));
  return { status: 'missing', suggestions };
}
