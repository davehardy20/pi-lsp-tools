/**
 * Shared LSP service for Pi
 *
 * Owns the LSP client cache and provides helpers used by both
 * lsp-tools and post-turn-linter.
 *
 * Package-local copy for pi-lsp-tools.
 * Original: ~/.pi/agent/extensions/shared/lsp-service.ts
 */

import { spawnSync } from "node:child_process";
import {
  getInstallInstructions,
  installLanguageServer,
} from "./lsp-auto-installer.js";
import { LSPClient, type LSPDiagnostic } from "./lsp-client.js";
import {
  findServerForFile,
  findWorkspaceRoot,
  getAutoInstallEnabled,
} from "./lsp-server-resolver.js";

// ── Client cache ───────────────────────────────────────────────────────

const clients = new Map<string, LSPClient>(); // key: "serverId:root"
const pendingStarts = new Map<string, Promise<LSPClient | null>>();
let stoppingAllPromise: Promise<void> | null = null;
let shuttingDown = false;

/** Minimal context subset required by the LSP service. */
export interface LspServiceContext {
  ui: {
    notify: (message: string, type?: "info" | "warning" | "error") => void;
    setStatus: (key: string, text: string | undefined) => void;
  };
  hasUI: boolean;
}

export function getAliveLspClientKeys(): string[] {
  return Array.from(clients.entries())
    .filter(([, c]) => c.isAlive())
    .map(([k]) => k);
}

export function updateLspStatus(ctx: LspServiceContext): void {
  if (!ctx.hasUI) return;
  const alive = getAliveLspClientKeys();
  if (alive.length === 0) {
    ctx.ui.setStatus("lsp", undefined);
    return;
  }
  const names = alive.map((k) => k.split(":")[0]);
  const unique = [...new Set(names)];
  ctx.ui.setStatus("lsp", `🌐 LSP: ${unique.join(", ")}`);
}

export async function getLspClient(
  filePath: string,
  ctx: LspServiceContext,
): Promise<LSPClient | null> {
  if (shuttingDown || stoppingAllPromise) return null;

  const server = findServerForFile(filePath);
  if (!server) return null;

  const root = findWorkspaceRoot(filePath);
  const key = `${server.id}:${root}`;

  const existingClient = clients.get(key);
  if (existingClient?.isAlive()) return existingClient;

  const pendingStart = pendingStarts.get(key);
  if (pendingStart) return pendingStart;

  // Check if binary exists
  const binaryName = server.command[0];
  const isWindows = process.platform === "win32";
  let binaryExists = false;
  try {
    const checkCmd = isWindows ? "where" : "which";
    const result = spawnSync(checkCmd, [binaryName], { stdio: "ignore" });
    binaryExists = result.status === 0;
  } catch {
    binaryExists = false;
  }

  // Try auto-install
  if (!binaryExists && getAutoInstallEnabled()) {
    safeNotify(
      ctx,
      `🔧 LSP: ${server.id} not found. Attempting auto-install...`,
      "info",
    );
    const installed = await installLanguageServer(server.id, binaryName, root);
    if (!installed) {
      safeNotify(
        ctx,
        `❌ LSP: Failed to auto-install ${server.id}.\nInstall manually:\n  ${getInstallInstructions(binaryName)}`,
        "error",
      );
      return null;
    }
    safeNotify(ctx, `✅ LSP: ${server.id} installed successfully.`, "info");
  }

  const startupPromise = (async () => {
    const client = new LSPClient(root, server.command);
    try {
      await client.start();
      if (shuttingDown || stoppingAllPromise) {
        await stopClientForShutdown(client);
        return null;
      }
      clients.set(key, client);
      updateLspStatus(ctx);
      return client;
    } catch (err) {
      if (!(shuttingDown || stoppingAllPromise)) {
        safeNotify(
          ctx,
          `❌ LSP: Failed to start ${server.id}: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
      return null;
    } finally {
      pendingStarts.delete(key);
    }
  })();

  pendingStarts.set(key, startupPromise);
  return startupPromise;
}

export async function getCachedDiagnostics(
  filePath: string,
  ctx: LspServiceContext,
): Promise<LSPDiagnostic[]> {
  const client = await getLspClient(filePath, ctx);
  if (!client) return [];
  return client.getCachedDiagnostics(filePath);
}

export async function stopAllLspClients(ctx: LspServiceContext): Promise<void> {
  if (stoppingAllPromise) return stoppingAllPromise;

  shuttingDown = true;
  stoppingAllPromise = (async () => {
    await Promise.allSettled(
      Array.from(clients.values(), (client) => stopClientForShutdown(client)),
    );
    await Promise.allSettled(Array.from(pendingStarts.values()));
    clients.clear();
    updateLspStatus(ctx);
  })().finally(() => {
    clients.clear();
    stoppingAllPromise = null;
    shuttingDown = false;
  });

  return stoppingAllPromise;
}

async function stopClientForShutdown(client: LSPClient): Promise<void> {
  try {
    await client.stop();
  } catch (error) {
    // Only ignore stream/connection races during shutdown;
    // unexpected errors should still be logged.
    if (isIgnorableShutdownStopError(error)) {
      return;
    }
    console.error("[LSP] unexpected error stopping client:", error);
  }
}

function isIgnorableShutdownStopError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string }).code;
  return (
    code === "ERR_STREAM_DESTROYED" ||
    code === "EPIPE" ||
    error.message.includes("Connection is closed") ||
    error.message.includes("write after a stream was destroyed") ||
    error.message.includes("write EPIPE") ||
    error.message.includes("broken pipe")
  );
}

function safeNotify(
  ctx: LspServiceContext,
  message: string,
  level: "info" | "warning" | "error",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
  }
}
