# Lua 5.4.7 example

Flowbook flows documenting the [Lua](https://www.lua.org) 5.4.7 interpreter, a compact C
codebase with a parser, a bytecode compiler, a VM and a garbage collector.

| Flow            | What it shows                                                                          |
| --------------- | -------------------------------------------------------------------------------------- |
| `run-script`    | `lua script.lua`: from `main` in `lua.c` through loading the file to the VM running it |
| `compile-chunk` | how the one-pass parser and code generator turn source into a `Proto`                  |
| `call-function` | `OP_CALL`: frame setup, stack growth, Lua vs C callees, returning results              |

`run-script` drills down into the other two.

## Layout

```
examples/lua/
  fetch.sh            clones Lua v5.4.7 into src/
  src/                Lua sources (not committed, gitignored)
  .flowbook/          the flows (committed); anchors are relative to examples/lua/, e.g. src/lua.c
```

## Fetch the source

The flows anchor to code in `src/`, which is not committed. Fetch it first:

```sh
cd examples/lua
./fetch.sh
```

## Open it

Open the `examples/lua` folder (not the repository root) in VS Code with the Flowbook
extension installed. The extension finds `.flowbook/` and resolves anchors against `src/`.

To validate from the command line:

```sh
flowbook check --root examples/lua
```
