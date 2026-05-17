# LSP Runtime Strategy for @davehardy20/pi-lsp-tools

## Overview

This document captures the explicit LSP runtime strategy for the
`@davehardy20/pi-lsp-tools` package. It defines how language servers are
discovered, started, managed, and shut down, and how the package interacts
with the Pi extension runtime.

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌──────────────────┐
│  Pi tools   │────▶│  lsp-service  │────▶│  lsp-server-     │
│  (index.ts) │     │  (cache mgr)  │     │  resolver.ts     │
└─────────────┘     └──────┬───────┘     └──────────────────┘
                           │
                    ┌──────▼───────┐
                    │  lsp-client   │
                    │  (JSON-RPC)   │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  Language     │
                    │  server proc  │
                    └──────────────┘
```

### Module responsibilities

| Module | Responsibility |
| --- | --- |
| `index.ts` | Extension entrypoint. Registers tools, commands, and lifecycle hooks. |
| `lsp-client.ts` | Manages JSON-RPC communication with a single language server process via `vscode-jsonrpc`. |
| `lsp-service.ts` | Owns the client cache (`Map<serverId:root, LSPClient>`). Handles startup, deduplication, and shutdown orchestration. |
| `lsp-server-resolver.ts` | Maps file extensions to server commands. Reads `~/.pi/lsp-config.yaml` for overrides. |
| `lsp-auto-installer.ts` | Attempts to install missing language server binaries. Falls back gracefully. |
| `lsp-utils.ts` | File filtering and grouping by server/workspace. Used by post-turn-linter too. |
| `path-utils.ts` | Path normalization, URI conversion, and comparison utilities. |

## Server discovery and resolution

1. **File → server mapping**: `lsp-server-resolver.ts` maps file extensions
   to language server configurations using built-in defaults:
   - TypeScript/JavaScript → `typescript-language-server --stdio`
   - Python → `pyright-langserver --stdio`
   - Rust → `rust-analyzer`
   - Go → `gopls`
   - Bash → `bash-language-server start`
   - YAML → `yaml-language-server --stdio`
   - JSON → `vscode-json-language-server --stdio`

2. **Configuration overrides**: Users can override server commands, add custom
   servers, or disable servers via `~/.pi/lsp-config.yaml`:
   ```yaml
   autoInstall: true
   servers:
     typescript:
       command: ["custom-ts-server", "--stdio"]
       extensions: [".ts", ".tsx"]
     custom:
       command: ["my-lang-server"]
       extensions: [".xyz"]
   ```

3. **Workspace root discovery**: The resolver walks up from the file path
   looking for project markers (`.git`, `package.json`, `Cargo.toml`,
   `go.mod`, etc.) to determine the workspace root for the language server.

## Client lifecycle

### Startup flow

1. Tool calls `getLspClient(filePath, ctx)` in `lsp-service.ts`.
2. Service resolves the file to a server via `lsp-server-resolver.ts`.
3. Service computes the cache key: `serverId:workspaceRoot`.
4. If a cached client exists and is alive → return it immediately.
5. If a pending start exists for the same key → return the existing promise
   (prevents concurrent starts for the same server+root).
6. Service checks if the server binary exists on `PATH`.
7. If not found and `autoInstall` is enabled → attempt auto-install via
   `lsp-auto-installer.ts`.
8. Service creates an `LSPClient` and calls `start()`.
9. `LSPClient.start()`:
   - Spawns the language server process with `stdio: ['pipe', 'pipe', 'pipe']`.
   - Creates a JSON-RPC `MessageConnection` over stdin/stdout.
   - Sends `initialize` request with workspace root URI and capabilities.
   - Sends `initialized` notification.
   - Waits 300ms for server readiness.
10. Client is cached and returned.

### Shutdown flow

1. Pi fires `session_shutdown` event.
2. Extension calls `stopAllLspClients(ctx)`.
3. For each cached client:
   - Closes all open documents via `textDocument/didClose`.
   - Sends `shutdown` request.
   - Sends `exit` notification.
   - Disposes the connection.
   - Kills the process with `SIGTERM`.
   - Force-kills with `SIGKILL` after 5 seconds if still alive.
4. Client cache is cleared.
5. Shutdown errors from already-destroyed streams are suppressed to allow
   downstream handlers (e.g., orchestrator recovery) to run cleanly.

### Client caching strategy

- **Key**: `serverId:workspaceRoot` — one client per language server per project root.
- **Concurrency safety**: Pending start promises are deduplicated. Only one
  startup attempt runs at a time per key.
- **Alive check**: Cached clients are validated with `isAlive()` before reuse.
  Dead clients are transparently replaced.

## Auto-install strategy

When a language server binary is not found on `PATH`:

1. If `autoInstall` is disabled in `~/.pi/lsp-config.yaml` → skip.
2. Notify the user that auto-install is being attempted.
3. **rust-analyzer**: Use `rustup component add rust-analyzer`.
4. **gopls**: Use `go install golang.org/x/tools/gopls@latest`.
5. **npm-based servers**: Try `npm install -g <package>`, then fall back to
   local project install using the detected package manager.
6. If install succeeds → continue with startup.
7. If install fails → notify the user with manual install instructions and
   return null (no client).

## Document synchronization

The `LSPClient` manages document synchronization:

- **Open**: `textDocument/didOpen` with language ID inferred from file extension.
- **Change**: `textDocument/didChange` with full content (incremental sync is
  not used for simplicity).
- **Close**: `textDocument/didClose` during shutdown.
- **Version tracking**: Each document gets an incrementing version number.

Before each LSP request (definition, references, etc.), the client:
1. Reads the current file content.
2. Syncs the document to the language server.
3. Waits 300ms for diagnostics to settle.
4. Sends the actual request.

## Runtime dependencies

### npm dependencies (bundled with the package)

| Package | Purpose |
| --- | --- |
| `vscode-jsonrpc` | JSON-RPC protocol over stdio for LSP communication |
| `yaml` | Parsing `~/.pi/lsp-config.yaml` |

### Peer dependencies (provided by Pi runtime)

| Package | Purpose |
| --- | --- |
| `@earendil-works/pi-coding-agent` | Extension API types (`ExtensionAPI`, `ExtensionContext`) |
| `typebox` | Tool parameter schema definitions |

### External runtime dependencies (not bundled, must be on PATH)

Language server binaries are external processes. The package does not bundle
them. Each must be installed separately and available on the system `PATH`.

## Configuration model

### `~/.pi/lsp-config.yaml`

```yaml
# Enable/disable auto-install (default: true)
autoInstall: true

# Timeout for install commands in ms (default: 60000)
installationTimeoutMs: 60000

# Server overrides and custom servers
servers:
  typescript:
    command: ["typescript-language-server", "--stdio"]
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]
    disabled: false
  custom-language:
    command: ["my-lang-server", "--stdio"]
    extensions: [".xyz"]
```

### Config caching

The server resolver caches the parsed config and merged server list in memory.
The cache is reset when `resetCache()` is called (used in tests). Config is
read once per process lifetime unless explicitly reset.

## Error handling

| Scenario | Behavior |
| --- | --- |
| No server for file extension | Tool returns "No LSP server available" error |
| Server binary not found | Auto-install attempted; if fails, tool returns error with manual install instructions |
| Server fails to start | Error notification to user; tool returns null |
| Request timeout (15s default) | `LSPRequestTimeout` error thrown |
| Server crashes mid-session | Client marked as not alive; next request creates a new client |
| Shutdown stream errors | Suppressed (EPIPE, ERR_STREAM_DESTROYED, "Connection is closed") |

## Package boundary

### What is packaged

All LSP runtime code is package-local within `@davehardy20/pi-lsp-tools`:

```
src/
├── index.ts              # Extension entrypoint + tool registrations
├── lsp-client.ts         # JSON-RPC LSP client
├── lsp-service.ts        # Client cache, startup, shutdown
├── lsp-server-resolver.ts # File→server mapping + config
├── lsp-auto-installer.ts # Auto-installs missing language servers
├── lsp-utils.ts          # File filtering and grouping helpers
└── path-utils.ts         # Path normalization utilities
```

### What is NOT packaged

- **Language server binaries**: External processes managed outside Pi.
- **LSP config file**: Lives at `~/.pi/lsp-config.yaml`, owned by the user.
- **Pi runtime**: Provided by peer dependencies.

### No imports from `~/.pi/agent/extensions/shared/*`

The package is fully self-contained. No runtime imports reach back into
the Pi local extension shared helpers directory.

## Cross-package coupling note

The `post-turn-linter` extension (part of the future `pi-quality-gates`
bundle) also uses LSP diagnostics via `lsp-service.ts` and `lsp-utils.ts`.
When `pi-quality-gates` is packaged:

1. It will receive its own package-local copies of `lsp-service.ts`,
   `lsp-utils.ts`, and `path-utils.ts`.
2. Each package will manage its own independent client cache.
3. Both packages listening to `session_shutdown` ensures cleanup during reload.
4. Having two LSP client caches is acceptable because:
   - Each cache is keyed by `serverId:root`, so duplicate keys are unlikely
     unless both packages process the same file.
   - If both packages serve the same file type, the worst case is two server
     processes for the same root, which is functionally correct.
5. If shared LSP state becomes a real problem (e.g., excessive memory from
     duplicate servers), a future `@davehardy20/pi-lsp-core` shared package
     could be extracted. This decision should be deferred until the coupling
     is measured in practice.

## Headless safety

The package does **not** depend on `@earendil-works/pi-tui`. All
notifications and status updates check `ctx.hasUI` before interacting
with the UI layer. This makes the package safe for headless Pi usage.

## Security considerations

1. **Workspace edit application**: The `lsp_rename` tool applies workspace
   edits directly to the filesystem (create, rename, delete files). This is
   by design — the rename tool is explicitly marked as "APPLIES changes."
2. **Auto-install**: Executes system commands (`npm install -g`, `rustup`,
   `go install`) when auto-install is enabled. This can be disabled via
   config.
3. **Process spawning**: Language servers are spawned with `shell: false`
   and communicate over stdio pipes only.

## Status/debug

Run `/lsp-status` in Pi to see:
- Package name and version
- Loaded source path

This helps diagnose stale package copies or duplicate registrations.
