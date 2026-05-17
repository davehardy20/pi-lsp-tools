import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import lspToolsExtension, { __test__ } from "../src/index.js";
const { formatDiagnostic } = __test__;
import type { LSPDiagnostic } from "../src/lsp-client.js";
import {
  normalizePath,
  uriToNormalizedPath,
  pathsEqual,
} from "../src/path-utils.js";
import { filterLspEligibleFiles, groupFilesByServerAndWorkspace } from "../src/lsp-utils.js";
import {
  findServerForFile,
  findServerForExtension,
  getMergedServers,
  getAutoInstallEnabled,
  resetCache,
} from "../src/lsp-server-resolver.js";
import { getInstallInstructions } from "../src/lsp-auto-installer.js";

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

  it("does not import from pi-tui (headless-safe)", () => {
    expect(packageJson.peerDependencies).not.toHaveProperty(
      "@earendil-works/pi-tui",
    );
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
    const srcDir = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../src",
    );
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
      expect(
        codeImports,
        `${file} should not import from shared/`,
      ).toHaveLength(0);
    }
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
      on: (event: string, _handler: unknown) =>
        registered.events.push(event),
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

  it("lsp-status command sends package metadata", () => {
    let sentMessage: unknown = null;
    const mockPi = {
      registerCommand: () => undefined,
      registerTool: () => undefined,
      on: () => undefined,
      sendMessage: (msg: unknown) => {
        sentMessage = msg;
      },
    };

    lspToolsExtension(mockPi as never);

    // Find the lsp-status command handler and invoke it
    const commands: Record<string, { handler: (...args: unknown[]) => Promise<void> }> = {};
    const capturingPi = {
      registerCommand: (name: string, def: { handler: (...args: unknown[]) => Promise<void> }) => {
        commands[name] = def;
      },
      registerTool: () => undefined,
      on: () => undefined,
      sendMessage: (msg: unknown) => {
        sentMessage = msg;
      },
    };

    lspToolsExtension(capturingPi as never);

    // Invoke the lsp-status handler
    const statusCmd = commands["lsp-status"];
    expect(statusCmd).toBeDefined();

    sentMessage = null;
    // Handler is async; call it and check the side effect
    const voidResult = statusCmd.handler(undefined, undefined);
    // It may return a Promise; let it settle synchronously for this test
    expect(voidResult).toBeInstanceOf(Promise);
    return voidResult.then(() => {
      expect(sentMessage).not.toBeNull();
      const msg = sentMessage as { content: string; display: boolean };
      expect(msg.content).toContain("@davehardy20/pi-lsp-tools");
      expect(msg.display).toBe(true);
    });
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

  it("finds bash server for .sh files", () => {
    const server = findServerForFile("/project/script.sh");
    expect(server).toBeDefined();
    expect(server!.id).toBe("bash");
  });

  it("finds yaml server for .yaml files", () => {
    const server = findServerForFile("/project/config.yaml");
    expect(server).toBeDefined();
    expect(server!.id).toBe("yaml");
  });

  it("finds json server for .json files", () => {
    const server = findServerForFile("/project/package.json");
    expect(server).toBeDefined();
    expect(server!.id).toBe("json");
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
    const files = [
      "/project/src/a.ts",
      "/project/src/b.ts",
      "/project/other/c.ts",
    ];
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
    expect(getInstallInstructions("typescript-language-server")).toContain(
      "npm install -g",
    );
    expect(getInstallInstructions("pyright-langserver")).toContain("pyright");
    expect(getInstallInstructions("rust-analyzer")).toContain("rustup");
    expect(getInstallInstructions("gopls")).toContain("go install");
    expect(getInstallInstructions("bash-language-server")).toContain(
      "npm install -g",
    );
    expect(getInstallInstructions("yaml-language-server")).toContain(
      "npm install -g",
    );
    expect(getInstallInstructions("vscode-json-language-server")).toContain(
      "npm install -g",
    );
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
    const srcDir = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../src",
    );
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
      const extPath = path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        "..",
        ext,
      );
      expect(fs.existsSync(extPath), `extension ${ext} should exist`).toBe(
        true,
      );
    }
  });
});
