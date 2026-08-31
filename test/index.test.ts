import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import lspToolsExtension, { __test__ } from "../src/index.js";
import { getInstallInstructions } from "../src/lsp-auto-installer.js";
import type {
  LSPDiagnostic,
  LSPDocumentSymbol,
  LSPLocation,
  LSPWorkspaceEdit,
} from "../src/lsp-client.js";
import {
  findServerForExtension,
  findServerForFile,
  getAutoInstallEnabled,
  getMergedServers,
  resetCache,
} from "../src/lsp-server-resolver.js";
import { filterLspEligibleFiles, groupFilesByServerAndWorkspace } from "../src/lsp-utils.js";
import { normalizePath, pathsEqual, uriToNormalizedPath } from "../src/path-utils.js";

const {
  formatDiagnostic,
  formatLimitedDiagnostics,
  formatLimitedLocations,
  formatLimitedSymbols,
  formatRenameReport,
} = __test__;

// ── Package manifest ───────────────────────────────────────────────────

describe("pi-lsp-tools package manifest", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    name: string;
    version: string;
    keywords?: string[];
    pi?: { extensions?: string[] };
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };

  it("declares the pi-package keyword", () => {
    expect(packageJson.keywords).toContain("pi-package");
  });

  it("declares the pi manifest with extensions", () => {
    expect(packageJson.pi?.extensions).toEqual(["./src/index.ts"]);
  });

  it("has the correct scoped package name", () => {
    expect(packageJson.name).toBe("@davehardy20/pi-lsp-tools");
  });

  it("declares required peer dependencies", () => {
    expect(packageJson.peerDependencies).toHaveProperty("@earendil-works/pi-coding-agent");
    expect(packageJson.peerDependencies).toHaveProperty("typebox");
  });

  it("does not import from pi-tui (headless-safe)", () => {
    expect(packageJson.peerDependencies).not.toHaveProperty("@earendil-works/pi-tui");
  });

  it("declares runtime dependencies for LSP support", () => {
    expect(packageJson.dependencies).toHaveProperty("vscode-jsonrpc");
    expect(packageJson.dependencies).toHaveProperty("yaml");
  });

  it("has required scripts", () => {
    expect(packageJson.scripts).toHaveProperty("build");
    expect(packageJson.scripts).toHaveProperty("test");
    expect(packageJson.scripts).toHaveProperty("test:watch");
    expect(packageJson.scripts).toHaveProperty("typecheck");
  });

  it("has no imports from ~/.pi shared helpers", () => {
    const srcDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../src");
    const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
    for (const file of files) {
      const content = fs.readFileSync(path.join(srcDir, file), "utf8");
      // Check for relative imports that reach outside the package
      const importLines = content
        .split("\n")
        .filter((l) => l.includes("from") && l.includes("shared"));
      // Only allow comment references, not actual imports
      const codeImports = importLines.filter(
        (l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"),
      );
      expect(codeImports, `${file} should not import from shared/`).toHaveLength(0);
    }
  });
});

// ── Extension registration ─────────────────────────────────────────────

describe("lspToolsExtension registration", () => {
  interface CapturedToolResult {
    content: Array<{ type: string; text: string }>;
    details: { matches?: string[]; added?: string[] };
  }

  interface CapturedTool {
    name: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    execute: (...args: unknown[]) => Promise<CapturedToolResult>;
  }

  function createHarness(initialActive: string[] = []) {
    const commands: Record<string, { handler: (...args: unknown[]) => Promise<void> }> = {};
    const tools = new Map<string, CapturedTool>();
    const handlers: Record<string, (...args: unknown[]) => unknown> = {};
    const active = [...initialActive];
    const activeUpdates: string[][] = [];
    let sentMessage: unknown = null;

    const pi = {
      registerCommand: (
        name: string,
        definition: { handler: (...args: unknown[]) => Promise<void> },
      ) => {
        commands[name] = definition;
      },
      registerTool: (definition: unknown) => {
        const tool = definition as CapturedTool;
        tools.set(tool.name, tool);
        active.push(tool.name);
      },
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        handlers[event] = handler;
      },
      sendMessage: (message: unknown) => {
        sentMessage = message;
      },
      getActiveTools: () => [...active],
      setActiveTools: (names: string[]) => {
        active.splice(0, active.length, ...names);
        activeUpdates.push([...names]);
      },
    };

    return {
      active,
      activeUpdates,
      commands,
      handlers,
      pi,
      sentMessage: () => sentMessage,
      tools,
    };
  }

  it("registers the status command, loader, and six deferred tools", () => {
    const harness = createHarness();

    lspToolsExtension(harness.pi as never);

    expect(harness.commands).toHaveProperty("lsp-status");
    expect(harness.handlers).toHaveProperty("session_start");
    expect(harness.handlers).toHaveProperty("session_shutdown");
    expect([...harness.tools.keys()]).toEqual(
      expect.arrayContaining([
        "lsp_tool_search",
        "lsp_goto_definition",
        "lsp_find_references",
        "lsp_diagnostics",
        "lsp_symbols",
        "lsp_prepare_rename",
        "lsp_rename",
      ]),
    );
    expect(harness.tools).toHaveLength(7);

    const loader = harness.tools.get("lsp_tool_search");
    expect(loader?.promptSnippet).toBeTruthy();
    for (const [name, tool] of harness.tools) {
      if (name === "lsp_tool_search") continue;
      expect(tool.promptSnippet).toBeUndefined();
      expect(tool.promptGuidelines).toBeUndefined();
    }
  });

  it("starts with only the loader active while preserving other tools", () => {
    const harness = createHarness(["read", "custom_tool"]);
    lspToolsExtension(harness.pi as never);

    harness.handlers.session_start();

    expect(harness.active).toEqual(["read", "custom_tool", "lsp_tool_search"]);
  });

  it("activates only the LSP tool matching the requested operation", async () => {
    const harness = createHarness(["read"]);
    lspToolsExtension(harness.pi as never);
    harness.handlers.session_start();

    const loader = harness.tools.get("lsp_tool_search");
    const result = await loader?.execute(
      "call-1",
      { query: "references" },
      undefined,
      undefined,
      undefined,
    );

    expect(result?.details).toEqual({
      matches: ["lsp_find_references"],
      added: ["lsp_find_references"],
    });
    expect(harness.active).toEqual(["read", "lsp_tool_search", "lsp_find_references"]);
  });

  it.each([
    ["definition", ["lsp_goto_definition"]],
    ["definitions", ["lsp_goto_definition"]],
    ["declarations", ["lsp_goto_definition"]],
    ["errors and warnings", ["lsp_diagnostics"]],
    ["document symbols", ["lsp_symbols"]],
    ["symbol", ["lsp_symbols"]],
    ["document symbol", ["lsp_symbols"]],
    ["find symbol", ["lsp_symbols"]],
    ["prepare rename", ["lsp_prepare_rename"]],
    ["prepare a rename", ["lsp_prepare_rename"]],
    ["can this symbol be renamed?", ["lsp_prepare_rename"]],
    ["check if a rename is possible", ["lsp_prepare_rename"]],
    ["check whether the rename is safe", ["lsp_prepare_rename"]],
    ["rename validation", ["lsp_prepare_rename"]],
    ["rename check", ["lsp_prepare_rename"]],
    ["is this rename safe", ["lsp_prepare_rename"]],
    ["prepare rename and rename", ["lsp_prepare_rename", "lsp_rename"]],
  ])("maps %s to only the required operation", async (query, expected) => {
    const harness = createHarness(["read"]);
    lspToolsExtension(harness.pi as never);
    harness.handlers.session_start();

    const result = await harness.tools
      .get("lsp_tool_search")
      ?.execute("call-1", { query }, undefined, undefined, undefined);

    expect(result?.details.matches).toEqual(expected);
    expect(result?.details.added).toEqual(expected);
  });

  it("activates prepare-rename with rename and does not duplicate active tools", async () => {
    const harness = createHarness(["read"]);
    lspToolsExtension(harness.pi as never);
    harness.handlers.session_start();

    const loader = harness.tools.get("lsp_tool_search");
    await loader?.execute("call-1", { query: "rename symbol" }, undefined, undefined, undefined);
    await loader?.execute("call-2", { query: "rename" }, undefined, undefined, undefined);

    expect(harness.active).toEqual(["read", "lsp_tool_search", "lsp_prepare_rename", "lsp_rename"]);
    expect(harness.activeUpdates).toHaveLength(2);
  });

  it("reports an unknown capability without changing active tools", async () => {
    const harness = createHarness(["read"]);
    lspToolsExtension(harness.pi as never);
    harness.handlers.session_start();
    const before = [...harness.active];

    const result = await harness.tools
      .get("lsp_tool_search")
      ?.execute("call-1", { query: "database migrations" }, undefined, undefined, undefined);

    expect(result?.details).toEqual({ matches: [], added: [] });
    expect(harness.active).toEqual(before);
    expect(harness.activeUpdates).toHaveLength(1);
  });

  it("keeps tools eagerly available when active-tool APIs are absent", async () => {
    const harness = createHarness(["read"]);
    const legacyPi = {
      ...harness.pi,
      getActiveTools: undefined,
      setActiveTools: undefined,
    };
    lspToolsExtension(legacyPi as never);

    expect(() => harness.handlers.session_start()).not.toThrow();
    const result = await harness.tools
      .get("lsp_tool_search")
      ?.execute("call-1", { query: "references" }, undefined, undefined, undefined);

    expect(result?.details).toEqual({
      matches: ["lsp_find_references"],
      added: [],
    });
    expect(harness.active).toEqual(
      expect.arrayContaining(["lsp_tool_search", "lsp_find_references"]),
    );
  });

  it("lsp-status command sends package metadata", async () => {
    const harness = createHarness();
    lspToolsExtension(harness.pi as never);

    await harness.commands["lsp-status"].handler(undefined, undefined);

    const message = harness.sentMessage() as {
      content: string;
      display: boolean;
    };
    expect(message.content).toContain("@davehardy20/pi-lsp-tools");
    expect(message.display).toBe(true);
  });
});

// ── Formatter tests ────────────────────────────────────────────────────

describe("formatDiagnostic", () => {
  it("formats a warning diagnostic", () => {
    const diag: LSPDiagnostic = {
      severity: 2,
      message: "Unused variable",
      range: {
        start: { line: 4, character: 7 },
        end: { line: 4, character: 10 },
      },
    };
    const result = formatDiagnostic("/path/to/file.ts", diag);
    expect(result).toBe("/path/to/file.ts:5:8 [warning] Unused variable");
  });

  it("formats an error diagnostic", () => {
    const diag: LSPDiagnostic = {
      severity: 1,
      message: "Type 'string' is not assignable to 'number'",
      range: {
        start: { line: 9, character: 0 },
        end: { line: 9, character: 5 },
      },
    };
    const result = formatDiagnostic("/app/index.ts", diag);
    expect(result).toContain("[error]");
    expect(result).toContain("10:1");
  });

  it("handles missing severity", () => {
    const diag: LSPDiagnostic = {
      message: "Something",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 5 },
      },
    };
    const result = formatDiagnostic("/test.ts", diag);
    expect(result).toContain("[unknown]");
  });

  it("formats hint diagnostic", () => {
    const diag: LSPDiagnostic = {
      severity: 4,
      message: "Optional property",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 5 },
      },
    };
    const result = formatDiagnostic("/test.ts", diag);
    expect(result).toContain("[hint]");
  });
});

// ── Output cap tests ───────────────────────────────────────────────────

describe("LSP output caps", () => {
  it("caps references while preserving file path, line, and character", () => {
    const locations: LSPLocation[] = Array.from({ length: 3 }, (_, i) => ({
      uri: `file:///project/src/file${i}.ts`,
      range: {
        start: { line: i + 10, character: i + 2 },
        end: { line: i + 10, character: i + 5 },
      },
    }));

    const result = formatLimitedLocations(locations, 2, 0);

    expect(result.locations).toHaveLength(2);
    expect(result.total).toBe(3);
    expect(result.capped).toBe(true);
    expect(result.text).toContain("/project/src/file0.ts:11:2");
    expect(result.text).toContain("use limit:0 for all");
  });

  it("caps diagnostics while preserving path, line, column, severity, and raw recovery", () => {
    const diagnostics: LSPDiagnostic[] = Array.from({ length: 3 }, (_, i) => ({
      severity: 1,
      message: `Problem ${i}`,
      range: {
        start: { line: i, character: 1 },
        end: { line: i, character: 2 },
      },
    }));

    const result = formatLimitedDiagnostics("/project/src/app.ts", diagnostics, 1, 0);

    expect(result.diagnostics).toHaveLength(1);
    expect(result.total).toBe(3);
    expect(result.capped).toBe(true);
    expect(result.text).toContain("/project/src/app.ts:1:2 [error] Problem 0");
    expect(result.text).toContain("use maxDiagnostics:0 for all");
  });

  it("caps symbols using flattened symbol count while preserving names and lines", () => {
    const symbols: LSPDocumentSymbol[] = [
      {
        name: "TopLevel",
        kind: 12,
        range: { start: { line: 4, character: 0 }, end: { line: 10, character: 1 } },
        selectionRange: { start: { line: 4, character: 0 }, end: { line: 4, character: 8 } },
        children: [
          {
            name: "childSymbol",
            kind: 6,
            range: { start: { line: 6, character: 2 }, end: { line: 7, character: 3 } },
            selectionRange: { start: { line: 6, character: 2 }, end: { line: 6, character: 13 } },
          },
        ],
      },
    ];

    const result = formatLimitedSymbols(symbols, 1, 0);

    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0]).toMatchObject({
      name: "TopLevel",
      kind: 12,
      line: 5,
      childCount: 1,
    });
    expect(result.symbols[0]).not.toHaveProperty("children");
    expect(JSON.stringify(result.symbols)).not.toContain("childSymbol");
    expect(result.total).toBe(2);
    expect(result.capped).toBe(true);
    expect(result.text).toContain("TopLevel (kind:12) - line 5");
    expect(result.text).toContain("use maxSymbols:0 for all");
  });

  it("keeps raw symbol subtrees only when both symbol and char caps are disabled", () => {
    const symbols: LSPDocumentSymbol[] = [
      {
        name: "TopLevel",
        kind: 12,
        range: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } },
        selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
        children: [
          {
            name: "childSymbol",
            kind: 6,
            range: { start: { line: 1, character: 2 }, end: { line: 2, character: 3 } },
            selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 13 } },
          },
        ],
      },
    ];

    const result = formatLimitedSymbols(symbols, 0, 0);

    expect(result.symbols[0]).toHaveProperty("children");
    expect(JSON.stringify(result.symbols)).toContain("childSymbol");
  });

  it("bounds symbol details when text is capped by characters", () => {
    const symbols: LSPDocumentSymbol[] = Array.from({ length: 30 }, (_, i) => ({
      name: `Symbol${i}`,
      kind: 12,
      range: { start: { line: i, character: 0 }, end: { line: i, character: 1 } },
      selectionRange: { start: { line: i, character: 0 }, end: { line: i, character: 1 } },
      children: [
        {
          name: `nestedChild${i}`,
          kind: 6,
          range: { start: { line: i, character: 2 }, end: { line: i, character: 3 } },
          selectionRange: { start: { line: i, character: 2 }, end: { line: i, character: 3 } },
        },
      ],
    }));

    const result = formatLimitedSymbols(symbols, 0, 180);

    expect(result.cappedByChars).toBe(true);
    expect(JSON.stringify(result.symbols).length).toBeLessThanOrEqual(180);
    expect(result.symbols.every((symbol) => !("children" in symbol))).toBe(true);
  });

  it("bounds symbol details even when text is under maxChars", () => {
    const symbols: LSPDocumentSymbol[] = Array.from({ length: 3 }, (_, i) => ({
      name: `S${i}`,
      kind: 12,
      range: { start: { line: i, character: 0 }, end: { line: i, character: 1 } },
      selectionRange: { start: { line: i, character: 0 }, end: { line: i, character: 1 } },
    }));

    const result = formatLimitedSymbols(symbols, 0, 120);

    expect(result.cappedByChars).toBe(false);
    expect(result.text.length).toBeLessThanOrEqual(120);
    expect(JSON.stringify(result.symbols).length).toBeLessThanOrEqual(120);
    expect(result.symbols.length).toBeLessThan(result.total);
    expect(result.symbols.every((symbol) => !("children" in symbol))).toBe(true);
  });

  it("caps long text output with explicit maxChars recovery", () => {
    const diagnostics: LSPDiagnostic[] = [
      {
        severity: 2,
        message: "x".repeat(200),
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
      },
    ];

    const result = formatLimitedDiagnostics("/project/src/app.ts", diagnostics, 0, 120);

    expect(result.cappedByChars).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(120);
    expect(result.text).toContain("Use maxChars:0");
  });

  it("never exceeds very small maxChars when truncation marker is longer than the cap", () => {
    const diagnostics: LSPDiagnostic[] = [
      {
        severity: 2,
        message: "x".repeat(200),
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
      },
    ];

    const result = formatLimitedDiagnostics("/project/src/app.ts", diagnostics, 0, 5);

    expect(result.cappedByChars).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(5);
  });

  it("returns compact bounded diagnostic details when output is capped by characters", () => {
    const longMessage = "diagnostic-detail-".repeat(100);
    const diagnostics: LSPDiagnostic[] = [
      {
        severity: 1,
        message: longMessage,
        range: {
          start: { line: 4, character: 2 },
          end: { line: 4, character: 3 },
        },
      },
    ];

    const result = formatLimitedDiagnostics("/project/src/app.ts", diagnostics, 0, 120);

    expect(result.cappedByChars).toBe(true);
    expect(JSON.stringify(result.diagnostics)).not.toContain(longMessage);
    expect(JSON.stringify(result.diagnostics).length).toBeLessThanOrEqual(120);
  });

  it("does not return raw large diagnostic details when output is capped by count", () => {
    const longMessage = "count-capped-diagnostic-detail-".repeat(100);
    const diagnostics: LSPDiagnostic[] = Array.from({ length: 2 }, (_, i) => ({
      severity: 1,
      message: i === 0 ? longMessage : "short",
      range: {
        start: { line: i, character: 2 },
        end: { line: i, character: 3 },
      },
    }));

    const result = formatLimitedDiagnostics("/project/src/app.ts", diagnostics, 1, 0);

    expect(result.capped).toBe(true);
    expect(JSON.stringify(result.diagnostics)).not.toContain(longMessage);
    expect(JSON.stringify(result.diagnostics)).toContain("count-capped-diagnostic-detail");
  });

  it("returns raw diagnostic details only when diagnostic and character caps are disabled", () => {
    const longMessage = "raw-diagnostic-detail-".repeat(100);
    const diagnostics: LSPDiagnostic[] = [
      {
        severity: 1,
        message: longMessage,
        range: {
          start: { line: 4, character: 2 },
          end: { line: 4, character: 3 },
        },
      },
    ];

    const result = formatLimitedDiagnostics("/project/src/app.ts", diagnostics, 0, 0);

    expect(result.diagnostics).toEqual(diagnostics);
    expect(JSON.stringify(result.diagnostics)).toContain(longMessage);
  });

  it("summarizes large rename edits without returning raw workspace edit content", () => {
    const files = Array.from({ length: 75 }, (_, i) => `/project/src/file-${i}.ts`);
    const edit: LSPWorkspaceEdit = {
      changes: Object.fromEntries(
        files.map((file, i) => [
          `file://${file}`,
          [
            {
              range: {
                start: { line: i, character: 0 },
                end: { line: i, character: 7 },
              },
              newText: `RenamedSymbol${i}`,
            },
          ],
        ]),
      ),
    };
    const report = files
      .map((file) => `  ✓ ${file} (1 edit(s)) ${"verbose-result-detail ".repeat(20)}`)
      .join("\n");

    const result = formatRenameReport(report, files, edit, 10, 1200);
    const fullResult = formatRenameReport(report, files, edit, 0, 0);

    expect(result.editsSummary).toMatchObject({
      totalChangedFiles: 75,
      totalTextEdits: 75,
      usesDocumentChanges: false,
    });
    expect(result.totalModifiedFiles).toBe(75);
    expect(result.displayModifiedFiles.length).toBeLessThan(75);
    expect(result.capped).toBe(true);
    expect(result.text).toContain("Applied rename edits: 75 edit(s) across 75 file(s)");
    expect(result.text).toContain("Modified files (75, showing 10)");
    expect(JSON.stringify(result)).not.toContain("RenamedSymbol74");
    expect(JSON.stringify(result)).not.toContain('"changes"');
    expect(fullResult.text).toContain("file-74.ts");
    expect(fullResult.text).toContain("verbose-result-detail");
    expect(fullResult.displayModifiedFiles).toHaveLength(75);
    expect(fullResult.capped).toBe(false);
  });
});

// ── Path utils tests ───────────────────────────────────────────────────

describe("path-utils", () => {
  it("normalizes paths consistently", () => {
    expect(normalizePath("/foo/bar/baz.ts")).toBe("/foo/bar/baz.ts");
    expect(normalizePath("/foo/../bar/baz.ts")).toBe("/bar/baz.ts");
  });

  it("converts file URIs to paths", () => {
    expect(uriToNormalizedPath("file:///Users/test/file.ts")).toBe("/Users/test/file.ts");
  });

  it("compares paths for equality", () => {
    expect(pathsEqual("/foo/bar", "/foo/bar")).toBe(true);
    expect(pathsEqual("/foo/bar", "/foo/baz")).toBe(false);
  });

  it("strips trailing slashes", () => {
    expect(normalizePath("/foo/bar/")).toBe("/foo/bar");
    expect(normalizePath("/")).toBe("/");
  });

  it("collapses multiple slashes", () => {
    expect(normalizePath("/foo//bar")).toBe("/foo/bar");
  });
});

// ── LSP server resolver tests ──────────────────────────────────────────

describe("lsp-server-resolver", () => {
  afterEach(() => {
    resetCache();
  });

  it("finds typescript server for .ts files", () => {
    const server = findServerForFile("/project/src/index.ts");
    expect(server?.id).toBe("typescript");
  });

  it("finds python server for .py files", () => {
    const server = findServerForFile("/project/main.py");
    expect(server?.id).toBe("python");
  });

  it("finds rust server for .rs files", () => {
    const server = findServerForFile("/project/src/main.rs");
    expect(server?.id).toBe("rust");
  });

  it("finds go server for .go files", () => {
    const server = findServerForFile("/project/main.go");
    expect(server?.id).toBe("go");
  });

  it("finds bash server for .sh files", () => {
    const server = findServerForFile("/project/script.sh");
    expect(server?.id).toBe("bash");
  });

  it("finds yaml server for .yaml files", () => {
    const server = findServerForFile("/project/config.yaml");
    expect(server?.id).toBe("yaml");
  });

  it("finds json server for .json files", () => {
    const server = findServerForFile("/project/package.json");
    expect(server?.id).toBe("json");
  });

  it("returns undefined for unsupported extensions", () => {
    const server = findServerForFile("/project/data.csv");
    expect(server).toBeUndefined();
  });

  it("finds server by extension string", () => {
    const server = findServerForExtension(".tsx");
    expect(server?.id).toBe("typescript");
  });

  it("all builtin servers have required fields", () => {
    const servers = getMergedServers();
    for (const server of servers) {
      expect(server.id).toBeTruthy();
      expect(server.command).toBeInstanceOf(Array);
      expect(server.command.length).toBeGreaterThan(0);
      expect(server.extensions).toBeInstanceOf(Array);
      expect(server.extensions.length).toBeGreaterThan(0);
    }
  });

  it("auto-install defaults to enabled", () => {
    expect(getAutoInstallEnabled()).toBe(true);
  });
});

// ── LSP utils tests ────────────────────────────────────────────────────

describe("lsp-utils", () => {
  it("filters eligible files by extension", () => {
    const files = [
      "/project/src/index.ts",
      "/project/src/style.css",
      "/project/src/util.ts",
      "/project/README.md",
    ];
    const result = filterLspEligibleFiles(files, [".ts"]);
    expect(result).toEqual(["/project/src/index.ts", "/project/src/util.ts"]);
  });

  it("returns all files when no extensions specified", () => {
    const files = ["/a.ts", "/b.css", "/c.py"];
    const result = filterLspEligibleFiles(files);
    expect(result).toEqual(files);
  });

  it("groups files by server and workspace", () => {
    const files = ["/project/src/a.ts", "/project/src/b.ts", "/project/other/c.ts"];
    const groups = groupFilesByServerAndWorkspace(files);
    // All .ts files should map to the same server
    expect(groups.size).toBeGreaterThanOrEqual(1);
    for (const [, groupFiles] of groups) {
      for (const f of groupFiles) {
        expect(f).toMatch(/\.ts$/);
      }
    }
  });

  it("groups files with mixed extensions by server", () => {
    const files = ["/project/a.ts", "/project/b.py", "/project/c.rs"];
    const groups = groupFilesByServerAndWorkspace(files);
    const serverIds = Array.from(groups.keys()).map((k) => k.split(":")[0]);
    expect(serverIds).toContain("typescript");
    expect(serverIds).toContain("python");
    expect(serverIds).toContain("rust");
  });
});

// ── Auto-installer tests ───────────────────────────────────────────────

describe("lsp-auto-installer", () => {
  it("provides install instructions for known servers", () => {
    expect(getInstallInstructions("typescript-language-server")).toContain("npm install -g");
    expect(getInstallInstructions("pyright-langserver")).toContain("pyright");
    expect(getInstallInstructions("rust-analyzer")).toContain("rustup");
    expect(getInstallInstructions("gopls")).toContain("go install");
    expect(getInstallInstructions("bash-language-server")).toContain("npm install -g");
    expect(getInstallInstructions("yaml-language-server")).toContain("npm install -g");
    expect(getInstallInstructions("vscode-json-language-server")).toContain("npm install -g");
  });

  it("provides fallback instructions for unknown servers", () => {
    const instructions = getInstallInstructions("my-custom-server");
    expect(instructions).toContain("my-custom-server");
    expect(instructions).toContain("PATH");
  });
});

// ── Package-local boundary verification ────────────────────────────────

describe("package-local boundary", () => {
  it("all source files exist and are non-empty", () => {
    const srcDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../src");
    const expectedFiles = [
      "index.ts",
      "lsp-client.ts",
      "lsp-service.ts",
      "lsp-server-resolver.ts",
      "lsp-auto-installer.ts",
      "lsp-utils.ts",
      "path-utils.ts",
    ];
    for (const file of expectedFiles) {
      const filePath = path.join(srcDir, file);
      expect(fs.existsSync(filePath), `${file} should exist`).toBe(true);
      const stat = fs.statSync(filePath);
      expect(stat.size, `${file} should be non-empty`).toBeGreaterThan(0);
    }
  });

  it("extension entrypoint exists at the declared path", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { pi?: { extensions?: string[] } };
    const extensions = packageJson.pi?.extensions ?? [];
    for (const ext of extensions) {
      const extPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", ext);
      expect(fs.existsSync(extPath), `extension ${ext} should exist`).toBe(true);
    }
  });
});
