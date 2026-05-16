/**
 * LSP Tools Extension for Pi
 *
 * Registers LSP-based tools:
 * - lsp_goto_definition
 * - lsp_find_references
 * - lsp_diagnostics
 * - lsp_symbols
 * - lsp_prepare_rename
 * - lsp_rename
 *
 * Auto-installs missing language servers when enabled in ~/.pi/lsp-config.yaml.
 *
 * Package: @davehardy20/pi-lsp-tools
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
  LSPClient,
  LSPDiagnostic,
  LSPDocumentSymbol,
  LSPLocation,
  LSPWorkspaceEdit,
} from "./lsp-client.js";
import { getLspClient, stopAllLspClients } from "./lsp-service.js";
import { uriToNormalizedPath } from "./path-utils.js";

// ── Package metadata ───────────────────────────────────────────────────

interface PackageMetadata {
  name: string;
  version: string;
  packageRoot: string;
  sourcePath: string;
}

const sourcePath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(sourcePath), "..");
let cachedPackageMetadata: PackageMetadata | null = null;

function getPackageMetadata(): PackageMetadata {
  if (cachedPackageMetadata) return cachedPackageMetadata;

  let name = "@davehardy20/pi-lsp-tools";
  let version = "0.1.0";

  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    ) as { name?: string; version?: string };
    name = packageJson.name ?? name;
    version = packageJson.version ?? version;
  } catch {
    // best-effort metadata only
  }

  cachedPackageMetadata = { name, version, packageRoot, sourcePath };
  return cachedPackageMetadata;
}

// ── Formatters ─────────────────────────────────────────────────────────

export function formatLocation(loc: LSPLocation): string {
  const filePath = uriToNormalizedPath(loc.uri);
  const line = loc.range.start.line + 1;
  const char = loc.range.start.character;
  return `${filePath}:${line}:${char}`;
}

function formatSymbol(symbol: LSPDocumentSymbol, indent = 0): string {
  const prefix = "  ".repeat(indent);
  const line = (symbol.range?.start?.line ?? 0) + 1;
  let result = `${prefix}${symbol.name} (kind:${symbol.kind}) - line ${line}`;
  if (symbol.children) {
    for (const child of symbol.children) {
      result += `\n${formatSymbol(child, indent + 1)}`;
    }
  }
  return result;
}

function formatDiagnostic(filePath: string, diag: LSPDiagnostic): string {
  const sev =
    diag.severity !== undefined
      ? (["error", "warning", "info", "hint"][diag.severity - 1] ?? "unknown")
      : "unknown";
  const line = diag.range.start.line + 1;
  const col = diag.range.start.character + 1;
  return `${filePath}:${line}:${col} [${sev}] ${diag.message}`;
}

// ── Workspace Edit Application ─────────────────────────────────────────

interface TextEdit {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  newText: string;
}

interface TextDocumentEdit {
  textDocument: { uri: string; version?: number };
  edits: TextEdit[];
}

type DocumentChange =
  | TextDocumentEdit
  | { kind: "create"; uri: string }
  | { kind: "rename"; oldUri: string; newUri: string }
  | { kind: "delete"; uri: string };

function isTextDocumentEdit(change: unknown): change is TextDocumentEdit {
  return (
    typeof change === "object" &&
    change !== null &&
    "textDocument" in change &&
    "edits" in change &&
    Array.isArray((change as TextDocumentEdit).edits)
  );
}

function isCreateFile(
  change: unknown,
): change is { kind: "create"; uri: string } {
  return (
    typeof change === "object" &&
    change !== null &&
    (change as Record<string, unknown>).kind === "create" &&
    typeof (change as Record<string, unknown>).uri === "string"
  );
}

function isRenameFile(
  change: unknown,
): change is { kind: "rename"; oldUri: string; newUri: string } {
  return (
    typeof change === "object" &&
    change !== null &&
    (change as Record<string, unknown>).kind === "rename" &&
    typeof (change as Record<string, unknown>).oldUri === "string" &&
    typeof (change as Record<string, unknown>).newUri === "string"
  );
}

function isDeleteFile(
  change: unknown,
): change is { kind: "delete"; uri: string } {
  return (
    typeof change === "object" &&
    change !== null &&
    (change as Record<string, unknown>).kind === "delete" &&
    typeof (change as Record<string, unknown>).uri === "string"
  );
}

function applyTextEditsToFile(filePath: string, edits: TextEdit[]): string {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const sorted = [...edits].sort((a, b) => {
    if (b.range.start.line !== a.range.start.line)
      return b.range.start.line - a.range.start.line;
    return b.range.start.character - a.range.start.character;
  });
  for (const e of sorted) {
    const startLine = e.range.start.line;
    const startChar = e.range.start.character;
    const endLine = e.range.end.line;
    const endChar = e.range.end.character;
    if (startLine === endLine) {
      const line = lines[startLine] ?? "";
      lines[startLine] =
        line.substring(0, startChar) + e.newText + line.substring(endChar);
    } else {
      const firstLine = lines[startLine] ?? "";
      const lastLine = lines[endLine] ?? "";
      const newContent =
        firstLine.substring(0, startChar) +
        e.newText +
        lastLine.substring(endChar);
      lines.splice(
        startLine,
        endLine - startLine + 1,
        ...newContent.split("\n"),
      );
    }
  }
  return lines.join("\n");
}

export function applyWorkspaceEdit(edit: LSPWorkspaceEdit): {
  report: string;
  modifiedFiles: string[];
} {
  const results: string[] = [];
  const modifiedFiles: string[] = [];

  // Prefer documentChanges (LSP 3.0+) over changes
  if (edit.documentChanges && edit.documentChanges.length > 0) {
    for (const change of edit.documentChanges as DocumentChange[]) {
      if (isTextDocumentEdit(change)) {
        const filePath = uriToNormalizedPath(change.textDocument.uri);
        try {
          const newContent = applyTextEditsToFile(filePath, change.edits);
          fs.writeFileSync(filePath, newContent, "utf-8");
          modifiedFiles.push(filePath);
          results.push(`  ✓ ${filePath} (${change.edits.length} edit(s))`);
        } catch (err) {
          results.push(
            `  ✗ ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else if (isCreateFile(change)) {
        const filePath = uriToNormalizedPath(change.uri);
        try {
          fs.writeFileSync(filePath, "", "utf-8");
          modifiedFiles.push(filePath);
          results.push(`  ✓ ${filePath} (created)`);
        } catch (err) {
          results.push(
            `  ✗ ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else if (isRenameFile(change)) {
        const oldPath = uriToNormalizedPath(change.oldUri);
        const newPath = uriToNormalizedPath(change.newUri);
        try {
          fs.renameSync(oldPath, newPath);
          modifiedFiles.push(newPath);
          results.push(`  ✓ ${oldPath} → ${newPath} (renamed)`);
        } catch (err) {
          results.push(
            `  ✗ ${oldPath} → ${newPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else if (isDeleteFile(change)) {
        const filePath = uriToNormalizedPath(change.uri);
        try {
          fs.unlinkSync(filePath);
          results.push(`  ✓ ${filePath} (deleted)`);
        } catch (err) {
          results.push(
            `  ✗ ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        results.push(`  ✗ Unknown document change type`);
      }
    }

    return {
      report: results.join("\n") || "No document changes applied",
      modifiedFiles,
    };
  }

  // Fallback to legacy changes format
  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      const filePath = uriToNormalizedPath(uri);
      try {
        const newContent = applyTextEditsToFile(filePath, edits);
        fs.writeFileSync(filePath, newContent, "utf-8");
        modifiedFiles.push(filePath);
        results.push(`  ✓ ${filePath} (${edits.length} edit(s))`);
      } catch (err) {
        results.push(
          `  ✗ ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  if (results.length === 0) {
    return { report: "No changes to apply", modifiedFiles: [] };
  }

  return { report: results.join("\n"), modifiedFiles };
}

// ── Shared tool helpers ────────────────────────────────────────────────

async function withLspClient(
  ctx: ExtensionContext,
  filePath: string,
): Promise<LSPClient> {
  const resolved = path.resolve(ctx.cwd, filePath);
  const client = await getLspClient(resolved, ctx);
  if (!client) {
    throw new Error(`No LSP server available for ${path.basename(resolved)}`);
  }
  return client;
}

function makeFilePathParams() {
  return Type.Object({
    filePath: Type.String({
      description: "Path to the file containing the symbol",
    }),
    line: Type.Number({ description: "Line number (1-based)", minimum: 1 }),
    character: Type.Number({
      description: "Character offset (1-based)",
      minimum: 0,
    }),
  });
}

// ── Extension ──────────────────────────────────────────────────────────

export default function lspToolsExtension(pi: ExtensionAPI) {
  // Cleanup on shutdown
  // stopAllLspClients is narrow: only LSP client processes and the LSP
  // client cache. It never throws (suppresses stream-destroyed errors),
  // so downstream session_start handlers (e.g. orchestrator recovery)
  // always get a chance to run after /reload.
  pi.on("session_shutdown", async (_event, ctx) => {
    await stopAllLspClients(ctx);
  });

  // Status/debug command
  pi.registerCommand("lsp-status", {
    description: "Show LSP tools package status",
    handler: async (_args, _ctx: ExtensionContext) => {
      const metadata = getPackageMetadata();
      pi.sendMessage({
        customType: "package-output",
        content: [
          `${metadata.name} v${metadata.version}`,
          `source: ${metadata.sourcePath}`,
        ].join("\n"),
        details: metadata,
        display: true,
      });
    },
  });

  // Register tools
  pi.registerTool({
    name: "lsp_goto_definition",
    label: "LSP Go to Definition",
    description: "Jump to where a symbol is defined using LSP.",
    promptSnippet: "Use lsp_goto_definition to find where a symbol is defined.",
    promptGuidelines: [
      "Use lsp_goto_definition over grep when a language server is available for the file type.",
    ],
    parameters: makeFilePathParams(),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const client = await withLspClient(ctx, params.filePath);
      const locations = await client.definition(
        path.resolve(ctx.cwd, params.filePath),
        params.line,
        params.character,
      );
      if (locations.length === 0) {
        return {
          content: [{ type: "text", text: "No definition found" }],
          details: { locations: [] },
        };
      }
      return {
        content: [
          { type: "text", text: locations.map(formatLocation).join("\n") },
        ],
        details: { locations },
      };
    },
  });

  pi.registerTool({
    name: "lsp_find_references",
    label: "LSP Find References",
    description: "Find all references to a symbol using LSP.",
    promptSnippet: "Use lsp_find_references to find all usages of a symbol.",
    promptGuidelines: [
      "Use lsp_find_references before refactoring to find all usages of a symbol across the workspace.",
      "Results are capped at 50 by default. Use limit:0 for uncapped results only when necessary.",
    ],
    parameters: Type.Object({
      ...makeFilePathParams().properties,
      limit: Type.Optional(
        Type.Number({
          description: "Maximum references to return (0 = unlimited)",
          default: 50,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const client = await withLspClient(ctx, params.filePath);
      const locations = await client.references(
        path.resolve(ctx.cwd, params.filePath),
        params.line,
        params.character,
      );
      if (locations.length === 0) {
        return {
          content: [{ type: "text", text: "No references found" }],
          details: { locations: [] },
        };
      }
      const limit = params.limit ?? 50;
      const capped = limit > 0 && locations.length > limit;
      const display = limit > 0 ? locations.slice(0, limit) : locations;
      const lines = display.map(formatLocation);
      if (capped) {
        lines.push(
          `\n... and ${locations.length - limit} more (use limit:0 for all)`,
        );
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { locations: display, total: locations.length, capped },
      };
    },
  });

  pi.registerTool({
    name: "lsp_diagnostics",
    label: "LSP Diagnostics",
    description: "Get errors and warnings for a file using LSP diagnostics.",
    promptSnippet: "Use lsp_diagnostics to check for errors before building.",
    promptGuidelines: [
      "Use lsp_diagnostics to check for errors before running build or test commands.",
    ],
    parameters: Type.Object({
      filePath: Type.String({ description: "Path to the file to check" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const client = await withLspClient(ctx, params.filePath);
      const diagnostics = await client.diagnostics(
        path.resolve(ctx.cwd, params.filePath),
      );
      if (diagnostics.length === 0) {
        return {
          content: [{ type: "text", text: "No diagnostics found" }],
          details: { diagnostics: [] },
        };
      }
      const filePath = path.resolve(ctx.cwd, params.filePath);
      return {
        content: [
          {
            type: "text",
            text: diagnostics
              .map((d) => formatDiagnostic(filePath, d))
              .join("\n"),
          },
        ],
        details: { diagnostics },
      };
    },
  });

  pi.registerTool({
    name: "lsp_symbols",
    label: "LSP Document Symbols",
    description: "List all symbols (functions, classes, variables) in a file.",
    promptSnippet: "Use lsp_symbols to explore the structure of a file.",
    promptGuidelines: [
      "Use lsp_symbols to explore the structure of a file when you need to understand its organization.",
    ],
    parameters: Type.Object({
      filePath: Type.String({ description: "Path to the file to analyze" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const client = await withLspClient(ctx, params.filePath);
      const symbols = await client.documentSymbol(
        path.resolve(ctx.cwd, params.filePath),
      );
      if (symbols.length === 0) {
        return {
          content: [{ type: "text", text: "No symbols found" }],
          details: { symbols: [] },
        };
      }
      return {
        content: [
          {
            type: "text",
            text: symbols.map((s) => formatSymbol(s)).join("\n"),
          },
        ],
        details: { symbols },
      };
    },
  });

  pi.registerTool({
    name: "lsp_prepare_rename",
    label: "LSP Prepare Rename",
    description:
      "Check if a symbol can be renamed at a position. Use BEFORE lsp_rename.",
    promptSnippet:
      "Use lsp_prepare_rename to validate a rename before applying it.",
    promptGuidelines: [
      "Always use lsp_prepare_rename before lsp_rename to validate that a rename is safe at the target position.",
    ],
    parameters: makeFilePathParams(),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const client = await withLspClient(ctx, params.filePath);
      const result = await client.prepareRename(
        path.resolve(ctx.cwd, params.filePath),
        params.line,
        params.character,
      );
      if (!result) {
        return {
          content: [{ type: "text", text: "Cannot rename at this position" }],
          details: { result: null },
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { result },
      };
    },
  });

  pi.registerTool({
    name: "lsp_rename",
    label: "LSP Rename",
    description:
      "Rename a symbol across the workspace using LSP. APPLIES changes.",
    promptSnippet: "Use lsp_rename to rename symbols across files.",
    promptGuidelines: [
      "Use lsp_rename for safe cross-file symbol renaming after validating with lsp_prepare_rename.",
    ],
    parameters: Type.Object({
      ...makeFilePathParams().properties,
      newName: Type.String({ description: "New symbol name" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const client = await withLspClient(ctx, params.filePath);
      const edit = await client.rename(
        path.resolve(ctx.cwd, params.filePath),
        params.line,
        params.character,
        params.newName,
      );
      if (!edit) {
        return {
          content: [{ type: "text", text: "No rename edits produced" }],
          details: { edit: null },
        };
      }
      const { report, modifiedFiles } = applyWorkspaceEdit(edit);
      return {
        content: [{ type: "text", text: report }],
        details: { edit, modifiedFiles },
      };
    },
  });
}

export const __test__ = {
  formatDiagnostic,
};
