import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import lspToolsExtension, { __test__ } from "../src/index.js";
const { formatDiagnostic } = __test__;
import type { LSPDiagnostic } from "../src/lsp-client.js";
import { normalizePath, uriToNormalizedPath, pathsEqual } from "../src/path-utils.js";
import { filterLspEligibleFiles } from "../src/lsp-utils.js";
import {
  findServerForFile,
  findServerForExtension,
  resetCache,
} from "../src/lsp-server-resolver.js";

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
    expect(packageJson.peerDependencies).toHaveProperty(
      "@earendil-works/pi-coding-agent",
    );
    expect(packageJson.peerDependencies).toHaveProperty("typebox");
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
});

// ── Extension registration ─────────────────────────────────────────────

describe("lspToolsExtension registration", () => {
  it("registers the lsp-status command", () => {
    const registered = {
      commands: [] as string[],
      tools: [] as string[],
      events: [] as string[],
    };

    const mockPi = {
      registerCommand: (name: string, _def: unknown) =>
        registered.commands.push(name),
      registerTool: (def: { name: string }) =>
        registered.tools.push(def.name),
      on: (event: string, _handler: unknown) => registered.events.push(event),
      sendMessage: () => undefined,
    };

    lspToolsExtension(mockPi as never);

    expect(registered.commands).toContain("lsp-status");
    expect(registered.events).toContain("session_shutdown");
  });

  it("registers all six LSP tools", () => {
    const tools: string[] = [];

    const mockPi = {
      registerCommand: () => undefined,
      registerTool: (def: { name: string }) => tools.push(def.name),
      on: () => undefined,
      sendMessage: () => undefined,
    };

    lspToolsExtension(mockPi as never);

    expect(tools).toContain("lsp_goto_definition");
    expect(tools).toContain("lsp_find_references");
    expect(tools).toContain("lsp_diagnostics");
    expect(tools).toContain("lsp_symbols");
    expect(tools).toContain("lsp_prepare_rename");
    expect(tools).toContain("lsp_rename");
    expect(tools).toHaveLength(6);
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
});

// ── Path utils tests ───────────────────────────────────────────────────

describe("path-utils", () => {
  it("normalizes paths consistently", () => {
    expect(normalizePath("/foo/bar/baz.ts")).toBe("/foo/bar/baz.ts");
    expect(normalizePath("/foo/../bar/baz.ts")).toBe("/bar/baz.ts");
  });

  it("converts file URIs to paths", () => {
    expect(uriToNormalizedPath("file:///Users/test/file.ts")).toBe(
      "/Users/test/file.ts",
    );
  });

  it("compares paths for equality", () => {
    expect(pathsEqual("/foo/bar", "/foo/bar")).toBe(true);
    expect(pathsEqual("/foo/bar", "/foo/baz")).toBe(false);
  });
});

// ── LSP server resolver tests ──────────────────────────────────────────

describe("lsp-server-resolver", () => {
  afterEach(() => {
    resetCache();
  });

  it("finds typescript server for .ts files", () => {
    const server = findServerForFile("/project/src/index.ts");
    expect(server).toBeDefined();
    expect(server!.id).toBe("typescript");
  });

  it("finds python server for .py files", () => {
    const server = findServerForFile("/project/main.py");
    expect(server).toBeDefined();
    expect(server!.id).toBe("python");
  });

  it("finds rust server for .rs files", () => {
    const server = findServerForFile("/project/src/main.rs");
    expect(server).toBeDefined();
    expect(server!.id).toBe("rust");
  });

  it("finds go server for .go files", () => {
    const server = findServerForFile("/project/main.go");
    expect(server).toBeDefined();
    expect(server!.id).toBe("go");
  });

  it("returns undefined for unsupported extensions", () => {
    const server = findServerForFile("/project/data.csv");
    expect(server).toBeUndefined();
  });

  it("finds server by extension string", () => {
    const server = findServerForExtension(".tsx");
    expect(server).toBeDefined();
    expect(server!.id).toBe("typescript");
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
});
