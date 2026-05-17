/**
 * Shared path utilities for robust path parsing and comparison.
 *
 * Package-local copy for pi-lsp-tools.
 * Original: ~/.pi/agent/extensions/shared/path-utils.ts
 *
 * Goals:
 * - Consistent normalization across slash commands and tools.
 * - Safe resolution that rejects empty/whitespace-only inputs.
 * - Platform-agnostic comparison (backslash → slash, collapse duplicates,
 *   resolve . and .., strip trailing slashes).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const MULTIPLE_SLASHES = /\/+/g;

/**
 * Strip matching outer quotes from a string.
 * Handles "..." and '...' wrappers.
 */
function stripQuotes(value: string): string {
  if (
    value.length >= 2 &&
    value[0] === value[value.length - 1] &&
    (value[0] === '"' || value[0] === "'")
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Normalize a file path for use as a Map key or in comparisons.
 *
 * - Runs `path.normalize()` to resolve `.` and `..` segments.
 * - Converts backslashes to forward slashes.
 * - Collapses multiple consecutive slashes.
 * - Strips trailing slashes (except for root `/`).
 */
export function normalizePath(filePath: string): string {
  // Convert backslashes first so path.normalize can resolve . and ..
  // on any platform.
  let normalized = filePath.replace(/\\/g, "/");
  normalized = path.normalize(normalized);
  // On Windows path.normalize converts forward slashes back to backslashes,
  // so run a second pass to guarantee consistent forward-slash output.
  normalized = normalized.replace(/\\/g, "/");
  normalized = normalized.replace(MULTIPLE_SLASHES, "/");
  normalized = path.normalize(normalized);
  normalized = normalized.replace(MULTIPLE_SLASHES, "/");
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * Compare two paths for equality after normalization.
 *
 * On case-insensitive file systems (Windows, macOS) this performs a
 * case-insensitive comparison. On Linux it is case-sensitive.
 */
export function pathsEqual(a: string, b: string): boolean {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  const caseInsensitive =
    process.platform === "win32" || process.platform === "darwin";
  return caseInsensitive ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/**
 * Expand `~` and `~user` prefixes using the OS home directory.
 */
export function expandTilde(filePath: string): string {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

/**
 * Resolve a raw slash-command argument into an absolute, normalized path.
 *
 * - Trims whitespace and rejects empty inputs (returns `null`).
 * - Strips matching outer quotes.
 * - Expands `~` prefixes.
 * - Resolves relative paths against `cwd`.
 * - Normalizes the result.
 *
 * Use this in `registerCommand` handlers when parsing file-path arguments.
 */
export function resolveCommandPath(input: string, cwd: string): string | null {
  let trimmed = input.trim();
  if (!trimmed) return null;

  trimmed = stripQuotes(trimmed).trim();
  if (!trimmed) return null;

  const expanded = expandTilde(trimmed);
  const absolute = path.isAbsolute(expanded)
    ? expanded
    : path.resolve(cwd, expanded);

  return normalizePath(absolute);
}

/**
 * Convert a `file://` URI to a normalized path.
 *
 * Uses Node's `fileURLToPath` so Windows drive-letter URIs are handled
 * correctly (e.g. `file:///C:/foo` → `C:/foo` after normalization).
 */
export function uriToNormalizedPath(uri: string): string {
  try {
    let filePath = fileURLToPath(uri);
    // On POSIX, fileURLToPath leaves a leading slash on Windows drive-letter
    // URIs (e.g. file:///C:/foo → /C:/foo). Strip it so the path is usable.
    if (/^\/[A-Za-z]:(?:\/|$)/.test(filePath)) {
      filePath = filePath.slice(1);
    }
    return normalizePath(filePath);
  } catch {
    // Not a valid file URI — fall back to normalizing the raw string
    return normalizePath(uri);
  }
}

/**
 * Deduplicate and sort a list of paths after normalization.
 *
 * Useful when collecting affected files from multiple sources to ensure
 * consistent output ordering and eliminate duplicates.
 */
export function normalizeAndSortPaths(filePaths: string[]): string[] {
  return Array.from(new Set(filePaths.map(normalizePath))).sort();
}

/**
 * Options for {@link resolvePath}.
 */
export interface ResolvePathOptions {
  /**
   * When `true` (default), follow symlinks via `fs.realpathSync.native`.
   * When `false`, skip symlink resolution and return the logical path.
   *
   * Set to `false` when you need the path the caller *intended* rather than
   * its physical target (e.g. git secret scanning that should stay within
   * the repo root).
   */
  followSymlinks?: boolean;
}

/**
 * Resolve a path for security comparisons.
 *
 * - Expands `~` to the user's home directory.
 * - Resolves relative paths against `cwd`.
 * - When `followSymlinks` is `true` (default), follows symlinks via
 *   `fs.realpathSync.native`.
 * - Falls back to the unresolved path if `realpath` fails (e.g. path does
 *   not exist yet).
 */
export function resolvePath(
  p: string,
  cwd: string,
  options?: ResolvePathOptions,
): string {
  const followSymlinks = options?.followSymlinks ?? true;
  if (p.startsWith("~")) {
    p = path.join(os.homedir(), p.slice(1));
  }
  const resolved = path.resolve(cwd, p);
  if (!followSymlinks) {
    return resolved;
  }
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Test whether `targetPath` matches a damage-prevention pattern.
 *
 * Supports:
 * - Exact path match
 * - Directory prefix match (`/foo/bar` matches `/foo/bar/baz`)
 * - Relative path match against `cwd`
 * - Glob-style wildcards (`*` = any sequence, `?` = single char)
 *
 * The pattern itself is resolved the same way as `targetPath` (tilde,
 * absolute, symlink-followed by default) before comparison.
 */
export function isPathMatch(
  targetPath: string,
  pattern: string,
  cwd: string,
  options?: ResolvePathOptions,
): boolean {
  const followSymlinks = options?.followSymlinks ?? true;
  let resolvedPattern = pattern.startsWith("~")
    ? path.join(os.homedir(), pattern.slice(1))
    : pattern;

  if (!path.isAbsolute(resolvedPattern)) {
    resolvedPattern = path.resolve(cwd, resolvedPattern);
  }

  if (followSymlinks) {
    try {
      resolvedPattern = fs.realpathSync.native(resolvedPattern);
    } catch {
      // path may not exist; keep resolved value for glob/regex matching
    }
  }

  const isDirPattern = resolvedPattern.endsWith(path.sep);
  const normPattern = isDirPattern
    ? resolvedPattern.slice(0, -1)
    : resolvedPattern;
  const normTarget = targetPath.endsWith(path.sep)
    ? targetPath.slice(0, -1)
    : targetPath;

  if (normTarget === normPattern) return true;
  if (normTarget.startsWith(normPattern + path.sep)) return true;

  const relativePath = path.relative(cwd, targetPath);
  const normRelative = relativePath.endsWith(path.sep)
    ? relativePath.slice(0, -1)
    : relativePath;
  if (normRelative === normPattern) return true;
  if (normRelative.startsWith(normPattern + path.sep)) return true;

  const regexPattern = normPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");

  const sep = path.sep === "\\" ? "\\\\" : "/";
  const regex = new RegExp(
    `^${regexPattern}$|^${regexPattern}${sep}|${sep}${regexPattern}$|${sep}${regexPattern}${sep}`,
  );

  return regex.test(normTarget) || regex.test(normRelative);
}
