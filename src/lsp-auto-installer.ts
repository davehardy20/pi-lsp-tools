/**
 * LSP Auto-Installer
 *
 * Attempts to install missing language servers using the detected package manager.
 * Fallback chain: global npm install → local project install → npx.
 *
 * Package-local copy for pi-lsp-tools.
 * Original: ~/.pi/agent/extensions/shared/lsp-auto-installer.ts
 */

import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "unknown";

const INSTALL_COMMANDS: Record<string, string[]> = {
  "typescript-language-server": [
    "npm",
    "install",
    "-g",
    "typescript-language-server",
    "typescript",
  ],
  "pyright-langserver": ["npm", "install", "-g", "pyright"],
  "rust-analyzer": [], // handled by rustup
  gopls: [], // handled by go install
  "bash-language-server": ["npm", "install", "-g", "bash-language-server"],
  "yaml-language-server": ["npm", "install", "-g", "yaml-language-server"],
  "vscode-json-language-server": [
    "npm",
    "install",
    "-g",
    "vscode-langservers-extracted",
  ],
};

function detectPackageManager(cwd: string): PackageManager {
  if (
    fs.existsSync(path.join(cwd, "bun.lockb")) ||
    fs.existsSync(path.join(cwd, "bun.lock"))
  ) {
    return "bun";
  }
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) {
    return "yarn";
  }
  if (fs.existsSync(path.join(cwd, "package-lock.json"))) {
    return "npm";
  }
  // Check for global availability
  try {
    execSync("bun --version", { stdio: "ignore" });
    return "bun";
  } catch {
    /* ignore */
  }
  try {
    execSync("pnpm --version", { stdio: "ignore" });
    return "pnpm";
  } catch {
    /* ignore */
  }
  try {
    execSync("npm --version", { stdio: "ignore" });
    return "npm";
  } catch {
    /* ignore */
  }
  return "unknown";
}

function isOnPath(command: string): boolean {
  const isWindows = process.platform === "win32";
  try {
    const result = spawnSync(isWindows ? "where" : "which", [command], {
      stdio: "ignore",
      shell: false,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function isWindows(): boolean {
  return process.platform === "win32";
}

function findBinary(command: string): string | undefined {
  if (isOnPath(command)) return command;
  // Check npm global
  try {
    const prefix = execSync("npm prefix -g", { encoding: "utf-8" }).trim();
    const binDir = isWindows() ? prefix : path.join(prefix, "bin");
    const candidates = isWindows()
      ? [
          path.join(binDir, `${command}.cmd`),
          path.join(binDir, `${command}.exe`),
          path.join(binDir, command),
        ]
      : [path.join(binDir, command)];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * Install a language server. Returns the command path if successful.
 */
export async function installLanguageServer(
  _serverId: string,
  binaryName: string,
  cwd: string,
): Promise<string | undefined> {
  // Already installed?
  const existing = findBinary(binaryName);
  if (existing) return existing;

  // rust-analyzer: use rustup
  if (binaryName === "rust-analyzer") {
    if (isOnPath("rustup")) {
      try {
        execSync("rustup component add rust-analyzer", { stdio: "ignore" });
        const after = findBinary("rust-analyzer");
        if (after) return after;
      } catch {
        /* ignore */
      }
    }
    return undefined;
  }

  // gopls: use go install
  if (binaryName === "gopls") {
    if (isOnPath("go")) {
      try {
        execSync("go install golang.org/x/tools/gopls@latest", {
          stdio: "ignore",
        });
        const after = findBinary("gopls");
        if (after) return after;
      } catch {
        /* ignore */
      }
    }
    return undefined;
  }

  // npm-based servers
  const installCmd = INSTALL_COMMANDS[binaryName];
  if (!installCmd) return undefined;

  // Try global install
  try {
    execSync(installCmd.join(" "), { stdio: "ignore", timeout: 60_000 });
    const after = findBinary(binaryName);
    if (after) return after;
  } catch {
    /* ignore */
  }

  // Try local install in project
  const pm = detectPackageManager(cwd);
  if (pm !== "unknown") {
    const pkgName = installCmd[installCmd.length - 1];
    const localCmd =
      pm === "bun"
        ? ["bun", "add", "-d", pkgName]
        : pm === "pnpm"
          ? ["pnpm", "add", "-D", pkgName]
          : pm === "yarn"
            ? ["yarn", "add", "-D", pkgName]
            : ["npm", "install", "-D", pkgName];
    try {
      execSync(localCmd.join(" "), { cwd, stdio: "ignore", timeout: 60_000 });
      const localBin = path.join(cwd, "node_modules", ".bin", binaryName);
      if (fs.existsSync(localBin)) return localBin;
      if (isWindows()) {
        const localBinCmd = `${localBin}.cmd`;
        if (fs.existsSync(localBinCmd)) return localBinCmd;
      }
    } catch {
      /* ignore */
    }
  }

  return undefined;
}

/**
 * Get installation instructions for a server.
 */
export function getInstallInstructions(binaryName: string): string {
  const commands: Record<string, string> = {
    "typescript-language-server":
      "npm install -g typescript-language-server typescript",
    "pyright-langserver": "npm install -g pyright",
    "rust-analyzer": "rustup component add rust-analyzer",
    gopls: "go install golang.org/x/tools/gopls@latest",
    "bash-language-server": "npm install -g bash-language-server",
    "yaml-language-server": "npm install -g yaml-language-server",
    "vscode-json-language-server":
      "npm install -g vscode-langservers-extracted",
  };
  return (
    commands[binaryName] ??
    `Install '${binaryName}' and ensure it's in your PATH`
  );
}
