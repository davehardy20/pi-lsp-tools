/**
 * LSP Server Resolver
 *
 * Maps file extensions to LSP server commands.
 * Supports configuration overrides from ~/.pi/lsp-config.yaml.
 *
 * Package-local copy for pi-lsp-tools.
 * Original: ~/.pi/agent/extensions/shared/lsp-server-resolver.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as yamlParse } from "yaml";

export interface LSPServerConfig {
  id: string;
  command: string[];
  extensions: string[];
  disabled?: boolean;
}

interface LSPConfigFile {
  autoInstall?: boolean;
  installationTimeoutMs?: number;
  servers?: Record<string, Omit<LSPServerConfig, "id">>;
}

// Built-in server definitions
const BUILTIN_SERVERS: LSPServerConfig[] = [
  {
    id: "typescript",
    command: ["typescript-language-server", "--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
  },
  {
    id: "python",
    command: ["pyright-langserver", "--stdio"],
    extensions: [".py", ".pyi"],
  },
  {
    id: "rust",
    command: ["rust-analyzer"],
    extensions: [".rs"],
  },
  {
    id: "go",
    command: ["gopls"],
    extensions: [".go"],
  },
  {
    id: "bash",
    command: ["bash-language-server", "start"],
    extensions: [".sh", ".bash", ".zsh"],
  },
  {
    id: "yaml",
    command: ["yaml-language-server", "--stdio"],
    extensions: [".yaml", ".yml"],
  },
  {
    id: "json",
    command: ["vscode-json-language-server", "--stdio"],
    extensions: [".json", ".jsonc"],
  },
];

let cachedConfig: LSPConfigFile | null = null;
let cachedMergedServers: LSPServerConfig[] | null = null;

function loadConfigFile(): LSPConfigFile {
  const configPath = path.join(os.homedir(), ".pi", "lsp-config.yaml");
  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, "utf8");
      return yamlParse(content) as LSPConfigFile;
    }
  } catch {
    // ignore config load errors
  }
  return {};
}

function getConfig(): LSPConfigFile {
  if (!cachedConfig) {
    cachedConfig = loadConfigFile();
  }
  return cachedConfig;
}

export function getAutoInstallEnabled(): boolean {
  return getConfig().autoInstall !== false;
}

export function getInstallationTimeoutMs(): number {
  return getConfig().installationTimeoutMs ?? 60_000;
}

export function getMergedServers(): LSPServerConfig[] {
  if (cachedMergedServers) return cachedMergedServers;

  const config = getConfig();
  const overrides = config.servers ?? {};
  const merged = new Map<string, LSPServerConfig>();

  for (const server of BUILTIN_SERVERS) {
    merged.set(server.id, { ...server });
  }

  for (const [id, override] of Object.entries(overrides)) {
    const existing = merged.get(id);
    if (existing) {
      merged.set(id, {
        ...existing,
        command: override.command ?? existing.command,
        extensions: override.extensions ?? existing.extensions,
        disabled: override.disabled ?? existing.disabled,
      });
    } else {
      merged.set(id, {
        id,
        command: override.command ?? ["unknown"],
        extensions: override.extensions ?? [],
        disabled: override.disabled,
      });
    }
  }

  cachedMergedServers = Array.from(merged.values()).filter((s) => !s.disabled);
  return cachedMergedServers;
}

export function resetCache(): void {
  cachedConfig = null;
  cachedMergedServers = null;
}

export function findServerForExtension(
  ext: string,
): LSPServerConfig | undefined {
  const servers = getMergedServers();
  return servers.find((s) => s.extensions.includes(ext));
}

export function findServerForFile(
  filePath: string,
): LSPServerConfig | undefined {
  const ext = path.extname(filePath).toLowerCase();
  return findServerForExtension(ext);
}

export function findWorkspaceRoot(filePath: string): string {
  let dir = path.resolve(path.dirname(filePath));
  const markers = [
    ".git",
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
  ];

  let prevDir = "";
  while (dir !== prevDir) {
    for (const marker of markers) {
      if (fs.existsSync(path.join(dir, marker))) {
        return dir;
      }
    }
    prevDir = dir;
    dir = path.dirname(dir);
  }

  return path.dirname(path.resolve(filePath));
}
