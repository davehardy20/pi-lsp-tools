/**
 * LSP utility helpers for filtering and grouping files.
 *
 * Package-local copy for pi-lsp-tools.
 * Original: ~/.pi/agent/extensions/shared/lsp-utils.ts
 */

import { extname } from "node:path";
import { findServerForFile, findWorkspaceRoot } from "./lsp-server-resolver.js";

/**
 * Filter file paths by extension. If no extensions are provided,
 * all files are returned unchanged. Comparison is case-insensitive.
 */
export function filterLspEligibleFiles(
  filePaths: string[],
  extensions?: string[],
): string[] {
  if (!extensions || extensions.length === 0) {
    return filePaths;
  }
  const extSet = new Set(extensions.map((e) => e.toLowerCase()));
  return filePaths.filter((fp) => extSet.has(extname(fp).toLowerCase()));
}

/**
 * Group file paths by the LSP server that handles them and the
 * workspace root each file belongs to.
 *
 * Returns a Map where keys are `"serverId:root"` and values are
 * arrays of file paths.
 */
export function groupFilesByServerAndWorkspace(
  filePaths: string[],
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const fp of filePaths) {
    const server = findServerForFile(fp);
    if (!server) continue;
    const root = findWorkspaceRoot(fp);
    const key = `${server.id}:${root}`;
    const group = groups.get(key) ?? [];
    group.push(fp);
    groups.set(key, group);
  }
  return groups;
}
