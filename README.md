# @davehardy20/pi-lsp-tools

Pi package for LSP-powered code navigation: goto definition, find references, diagnostics, symbols, and rename.

## What it adds

On Pi 0.83 or newer, startup exposes one lightweight loader tool:

- `lsp_tool_search` — activates only the LSP operation needed for the task

The loader can activate these six tools on demand:

| Tool | Description |
| --- | --- |
| `lsp_goto_definition` | Jump to where a symbol is defined |
| `lsp_find_references` | Find all references to a symbol across the workspace |
| `lsp_diagnostics` | Get errors and warnings for a file |
| `lsp_symbols` | List all symbols (functions, classes, variables) in a file |
| `lsp_prepare_rename` | Check if a symbol can be renamed at a position |
| `lsp_rename` | Rename a symbol across the workspace (applies changes) |

For example, `lsp_tool_search({ "query": "references" })` activates only
`lsp_find_references`. A general rename request activates both
`lsp_prepare_rename` and `lsp_rename` so validation remains available before
mutation. Existing active tools from Pi and other extensions are preserved.
Deferred tools omit system-prompt snippets and guidelines, so activation does
not change the system prompt. Providers with native deferred-tool support can
also preserve the cached prompt prefix when adding schemas. Older Pi runtimes
retain eager availability of all tools as a compatibility fallback.

One command:

- `/lsp-status` — show package name, version, and loaded source path

## Supported languages

The package ships built-in support for these language servers:

| Language | Server binary | File extensions |
| --- | --- | --- |
| TypeScript/JavaScript | `typescript-language-server` | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts` |
| Python | `pyright-langserver` | `.py`, `.pyi` |
| Rust | `rust-analyzer` | `.rs` |
| Go | `gopls` | `.go` |
| Bash | `bash-language-server` | `.sh`, `.bash`, `.zsh` |
| YAML | `yaml-language-server` | `.yaml`, `.yml` |
| JSON | `vscode-json-language-server` | `.json`, `.jsonc` |

## LSP runtime requirements

This package requires the language server binaries to be available in your
`PATH`. It does **not** bundle the language servers themselves — they are
external processes managed outside of Pi.

### Auto-install

By default, the package attempts to auto-install missing language servers
using `npm install -g`, `rustup`, or `go install` as appropriate. This can
be disabled or configured via `~/.pi/lsp-config.yaml`:

```yaml
autoInstall: false
```

### Manual install

```bash
# TypeScript
npm install -g typescript-language-server typescript

# Python
npm install -g pyright

# Rust
rustup component add rust-analyzer

# Go
go install golang.org/x/tools/gopls@latest

# Bash
npm install -g bash-language-server

# YAML
npm install -g yaml-language-server

# JSON
npm install -g vscode-langservers-extracted
```

### Custom server configuration

You can override server commands or add custom servers in
`~/.pi/lsp-config.yaml`:

```yaml
servers:
  typescript:
    command: ["my-custom-ts-server", "--stdio"]
    extensions: [".ts", ".tsx"]
  custom:
    command: ["my-lang-server"]
    extensions: [".xyz"]
```

## Install

From npm:

```bash
pi install npm:@davehardy20/pi-lsp-tools
```

From git:

```bash
pi install git:github.com/davehardy20/pi-lsp-tools
```

From a local checkout during development:

```bash
pi install /Users/dave/tools/pi-lsp-tools
```

For one run only:

```bash
pi -e /Users/dave/tools/pi-lsp-tools
```

## Settings

No Pi-level settings required. Language server configuration lives in
`~/.pi/lsp-config.yaml`.

## Update flow

1. Update the package repo
2. Push to GitHub
3. Run `pi update --extensions` or reinstall the package
4. Run `/reload`

`/reload` alone does not fetch newer package commits.

## Troubleshooting

Run `/lsp-status` to confirm:

- Package name and version
- Loaded source path

If LSP tools appear twice, Pi may be loading both the package and the old
local extension. Disable or remove the old local auto-discovered extension
before reload verification.

If a language server fails to start, check:

1. The server binary is installed and on your `PATH`
2. `~/.pi/lsp-config.yaml` has correct server entries if customized
3. The workspace root contains a recognizable project marker (e.g.
   `package.json`, `Cargo.toml`, `go.mod`)

## LSP runtime strategy

See [docs/lsp-runtime-strategy.md](docs/lsp-runtime-strategy.md) for the
explicit LSP runtime strategy covering server discovery, client lifecycle,
auto-install, document synchronization, error handling, and cross-package
coupling notes.

## Build and test

```bash
npm run typecheck
npm run build
npm test
```

## Package-local source layout

```text
src/
├── index.ts              # Main extension entrypoint + tool registrations
├── lsp-client.ts         # JSON-RPC LSP client (vscode-jsonrpc)
├── lsp-service.ts        # Client cache, startup, shutdown
├── lsp-server-resolver.ts # File→server mapping + config from lsp-config.yaml
├── lsp-auto-installer.ts # Auto-installs missing language servers
├── lsp-utils.ts          # File filtering and grouping helpers
└── path-utils.ts         # Path normalization utilities
```

All helpers are package-local. This package does **not** import from
`~/.pi/agent/extensions/shared/*`.
