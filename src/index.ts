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

// ── Output caps and formatters ─────────────────────────────────────────

const DEFAULT_REFERENCE_LIMIT = 50;
const DEFAULT_DIAGNOSTIC_LIMIT = 100;
const DEFAULT_SYMBOL_LIMIT = 200;
const DEFAULT_RENAME_REPORT_FILE_LIMIT = 50;
const DEFAULT_MAX_CHARS = 6000;

function normalizeLimit(value: number | undefined, fallback: number): number {
	return value === undefined ? fallback : Math.max(0, Math.floor(value));
}

function normalizeMaxChars(value: number | undefined): number {
	return value === undefined
		? DEFAULT_MAX_CHARS
		: Math.max(0, Math.floor(value));
}

function capText(
	text: string,
	maxChars: number,
	recoveryHint: string,
): {
	text: string;
	cappedByChars: boolean;
} {
	if (maxChars === 0 || text.length <= maxChars) {
		return { text, cappedByChars: false };
	}

	const marker = `\n\n... output truncated to ${maxChars} chars. ${recoveryHint}`;
	const suffix = marker.length > maxChars ? marker.slice(0, maxChars) : marker;
	const keep = Math.max(0, maxChars - suffix.length);
	return {
		text: `${text.slice(0, keep).trimEnd()}${suffix}`,
		cappedByChars: true,
	};
}

export function formatLocation(loc: LSPLocation): string {
	const filePath = uriToNormalizedPath(loc.uri);
	const line = loc.range.start.line + 1;
	const char = loc.range.start.character;
	return `${filePath}:${line}:${char}`;
}

interface SymbolSummary {
	name: string;
	kind: number;
	line: number;
	character: number;
	depth: number;
	childCount: number;
}

function summarizeSymbol(
	symbol: LSPDocumentSymbol,
	depth: number,
): SymbolSummary {
	return {
		name: symbol.name,
		kind: symbol.kind,
		line: (symbol.range?.start?.line ?? 0) + 1,
		character: symbol.range?.start?.character ?? 0,
		depth,
		childCount: symbol.children?.length ?? 0,
	};
}

function flattenSymbols(
	symbols: LSPDocumentSymbol[],
	indent = 0,
): Array<{ symbol: LSPDocumentSymbol; summary: SymbolSummary; line: string }> {
	const rows: Array<{
		symbol: LSPDocumentSymbol;
		summary: SymbolSummary;
		line: string;
	}> = [];
	for (const symbol of symbols) {
		const prefix = "  ".repeat(indent);
		const line = (symbol.range?.start?.line ?? 0) + 1;
		rows.push({
			symbol,
			summary: summarizeSymbol(symbol, indent),
			line: `${prefix}${symbol.name} (kind:${symbol.kind}) - line ${line}`,
		});
		if (symbol.children) {
			rows.push(...flattenSymbols(symbol.children, indent + 1));
		}
	}
	return rows;
}

function capItemsByJsonChars<T>(items: T[], maxChars: number): T[] {
	if (maxChars === 0) return items;
	const capped: T[] = [];
	for (const item of items) {
		const next = [...capped, item];
		if (JSON.stringify(next).length > maxChars) break;
		capped.push(item);
	}
	return capped;
}

export function formatLimitedSymbols(
	symbols: LSPDocumentSymbol[],
	limit = DEFAULT_SYMBOL_LIMIT,
	maxChars = DEFAULT_MAX_CHARS,
): {
	text: string;
	symbols: Array<LSPDocumentSymbol | SymbolSummary>;
	total: number;
	capped: boolean;
	cappedByChars: boolean;
} {
	const normalizedLimit = normalizeLimit(limit, DEFAULT_SYMBOL_LIMIT);
	const normalizedMaxChars = normalizeMaxChars(maxChars);
	const rawDetails = normalizedLimit === 0 && normalizedMaxChars === 0;
	const flat = flattenSymbols(symbols);
	const cappedByCount = normalizedLimit > 0 && flat.length > normalizedLimit;
	const displayRows =
		normalizedLimit > 0 ? flat.slice(0, normalizedLimit) : flat;
	const lines = displayRows.map((row) => row.line);
	if (cappedByCount) {
		lines.push(
			`\n... and ${flat.length - normalizedLimit} more symbol(s) (use maxSymbols:0 for all)`,
		);
	}
	const capped = capText(
		lines.join("\n"),
		normalizedMaxChars,
		"Use maxChars:0 or a higher maxChars for raw symbol output.",
	);
	const detailBudget =
		normalizedMaxChars > 0 ? normalizedMaxChars : DEFAULT_MAX_CHARS;
	const compactDetails = displayRows.map((row) => row.summary);
	const detailSymbols = rawDetails
		? displayRows.map((row) => row.symbol)
		: capItemsByJsonChars(compactDetails, detailBudget);
	const cappedByDetails =
		!rawDetails && detailSymbols.length < compactDetails.length;
	return {
		text: capped.text,
		symbols: detailSymbols,
		total: flat.length,
		capped: cappedByCount || capped.cappedByChars || cappedByDetails,
		cappedByChars: capped.cappedByChars,
	};
}

function diagnosticSeverityName(severity: number | undefined): string {
	return severity !== undefined
		? (["error", "warning", "info", "hint"][severity - 1] ?? "unknown")
		: "unknown";
}

function truncateDiagnosticMessage(message: string): string {
	const maxMessageChars = 200;
	if (message.length <= maxMessageChars) return message;
	return `${message.slice(0, maxMessageChars - 1)}…`;
}

function formatDiagnostic(filePath: string, diag: LSPDiagnostic): string {
	const sev = diagnosticSeverityName(diag.severity);
	const line = diag.range.start.line + 1;
	const col = diag.range.start.character + 1;
	return `${filePath}:${line}:${col} [${sev}] ${diag.message}`;
}

interface DiagnosticSummary {
	filePath: string;
	line: number;
	column: number;
	severity: string;
	message: string;
	code?: string | number;
	source?: string;
}

function summarizeDiagnostic(
	filePath: string,
	diag: LSPDiagnostic,
): DiagnosticSummary {
	return {
		filePath,
		line: diag.range.start.line + 1,
		column: diag.range.start.character + 1,
		severity: diagnosticSeverityName(diag.severity),
		message: truncateDiagnosticMessage(diag.message),
		...(diag.code !== undefined ? { code: diag.code } : {}),
		...(diag.source !== undefined ? { source: diag.source } : {}),
	};
}

interface LocationSummary {
	filePath: string;
	line: number;
	character: number;
}

function summarizeLocation(loc: LSPLocation): LocationSummary {
	return {
		filePath: uriToNormalizedPath(loc.uri),
		line: loc.range.start.line + 1,
		character: loc.range.start.character,
	};
}

export function formatLimitedLocations(
	locations: LSPLocation[],
	limit = DEFAULT_REFERENCE_LIMIT,
	maxChars = DEFAULT_MAX_CHARS,
): {
	text: string;
	locations: Array<LSPLocation | LocationSummary>;
	total: number;
	capped: boolean;
	cappedByChars: boolean;
} {
	const normalizedLimit = normalizeLimit(limit, DEFAULT_REFERENCE_LIMIT);
	const normalizedMaxChars = normalizeMaxChars(maxChars);
	const rawDetails = normalizedLimit === 0 && normalizedMaxChars === 0;
	const cappedByCount =
		normalizedLimit > 0 && locations.length > normalizedLimit;
	const display =
		normalizedLimit > 0 ? locations.slice(0, normalizedLimit) : locations;
	const lines = display.map(formatLocation);
	if (cappedByCount) {
		lines.push(
			`\n... and ${locations.length - normalizedLimit} more reference(s) (use limit:0 for all)`,
		);
	}
	const cappedText = capText(
		lines.join("\n"),
		normalizedMaxChars,
		"Use maxChars:0 or a higher maxChars for raw reference output.",
	);
	const detailBudget =
		normalizedMaxChars > 0 ? normalizedMaxChars : DEFAULT_MAX_CHARS;
	const compactDetails = display.map(summarizeLocation);
	const detailLocations = rawDetails
		? display
		: capItemsByJsonChars(compactDetails, detailBudget);
	const cappedByDetails =
		!rawDetails && detailLocations.length < compactDetails.length;
	return {
		text: cappedText.text,
		locations: detailLocations,
		total: locations.length,
		capped: cappedByCount || cappedText.cappedByChars || cappedByDetails,
		cappedByChars: cappedText.cappedByChars,
	};
}

export function formatLimitedDiagnostics(
	filePath: string,
	diagnostics: LSPDiagnostic[],
	limit = DEFAULT_DIAGNOSTIC_LIMIT,
	maxChars = DEFAULT_MAX_CHARS,
): {
	text: string;
	diagnostics: Array<LSPDiagnostic | DiagnosticSummary>;
	total: number;
	capped: boolean;
	cappedByChars: boolean;
} {
	const normalizedLimit = normalizeLimit(limit, DEFAULT_DIAGNOSTIC_LIMIT);
	const normalizedMaxChars = normalizeMaxChars(maxChars);
	const rawDetails = normalizedLimit === 0 && normalizedMaxChars === 0;
	const cappedByCount =
		normalizedLimit > 0 && diagnostics.length > normalizedLimit;
	const display =
		normalizedLimit > 0 ? diagnostics.slice(0, normalizedLimit) : diagnostics;
	const lines = display.map((d) => formatDiagnostic(filePath, d));
	if (cappedByCount) {
		lines.push(
			`\n... and ${diagnostics.length - normalizedLimit} more diagnostic(s) (use maxDiagnostics:0 for all)`,
		);
	}
	const cappedText = capText(
		lines.join("\n"),
		normalizedMaxChars,
		"Use maxChars:0 or a higher maxChars for raw diagnostic output.",
	);
	const detailBudget =
		normalizedMaxChars > 0 ? normalizedMaxChars : DEFAULT_MAX_CHARS;
	const compactDetails = display.map((diag) =>
		summarizeDiagnostic(filePath, diag),
	);
	const detailDiagnostics = rawDetails
		? display
		: capItemsByJsonChars(compactDetails, detailBudget);
	const cappedByDetails =
		!rawDetails && detailDiagnostics.length < compactDetails.length;
	return {
		text: cappedText.text,
		diagnostics: detailDiagnostics,
		total: diagnostics.length,
		capped: cappedByCount || cappedText.cappedByChars || cappedByDetails,
		cappedByChars: cappedText.cappedByChars,
	};
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

export interface WorkspaceEditSummary {
	totalChangedFiles: number;
	totalTextEdits: number;
	totalDocumentChanges: number;
	totalResourceOperations: number;
	usesDocumentChanges: boolean;
}

function summarizeWorkspaceEdit(edit: LSPWorkspaceEdit): WorkspaceEditSummary {
	let totalChangedFiles = 0;
	let totalTextEdits = 0;
	let totalResourceOperations = 0;
	const documentChanges = Array.isArray(edit.documentChanges)
		? (edit.documentChanges as DocumentChange[])
		: [];

	if (documentChanges.length > 0) {
		for (const change of documentChanges) {
			if (isTextDocumentEdit(change)) {
				totalChangedFiles += 1;
				totalTextEdits += change.edits.length;
			} else {
				totalResourceOperations += 1;
			}
		}
		return {
			totalChangedFiles,
			totalTextEdits,
			totalDocumentChanges: documentChanges.length,
			totalResourceOperations,
			usesDocumentChanges: true,
		};
	}

	if (edit.changes) {
		for (const edits of Object.values(edit.changes)) {
			totalChangedFiles += 1;
			totalTextEdits += edits.length;
		}
	}

	return {
		totalChangedFiles,
		totalTextEdits,
		totalDocumentChanges: 0,
		totalResourceOperations,
		usesDocumentChanges: false,
	};
}

export function formatRenameReport(
	report: string,
	modifiedFiles: string[],
	edit: LSPWorkspaceEdit,
	maxReportFiles = DEFAULT_RENAME_REPORT_FILE_LIMIT,
	maxChars = DEFAULT_MAX_CHARS,
): {
	text: string;
	displayModifiedFiles: string[];
	editsSummary: WorkspaceEditSummary;
	totalModifiedFiles: number;
	capped: boolean;
	cappedByChars: boolean;
} {
	const summary = summarizeWorkspaceEdit(edit);
	const normalizedLimit = normalizeLimit(
		maxReportFiles,
		DEFAULT_RENAME_REPORT_FILE_LIMIT,
	);
	const normalizedMaxChars = normalizeMaxChars(maxChars);
	const reportLines = report ? report.split("\n") : [];
	const cappedByCount =
		normalizedLimit > 0 && reportLines.length > normalizedLimit;
	const displayLines =
		normalizedLimit > 0 ? reportLines.slice(0, normalizedLimit) : reportLines;
	const displayModifiedFiles =
		normalizedLimit > 0
			? modifiedFiles.slice(0, normalizedLimit)
			: modifiedFiles;
	const lines = [
		`Applied rename edits: ${summary.totalTextEdits} edit(s) across ${summary.totalChangedFiles} file(s).`,
		"",
		`Modified files (${modifiedFiles.length}${cappedByCount ? `, showing ${displayModifiedFiles.length}` : ""}):`,
		...displayModifiedFiles.map((file) => `  ${file}`),
	];
	if (cappedByCount) {
		lines.push("  ... additional modified files omitted from display");
	}
	lines.push("", "Rename result report:", ...displayLines);
	if (cappedByCount) {
		lines.push(
			`\n... and ${reportLines.length - normalizedLimit} more rename result line(s).`,
		);
	}

	const cappedText = capText(
		lines.join("\n"),
		normalizedMaxChars,
		"Rename details are summarized by default; inspect details.modifiedFiles for the full changed-file list.",
	);
	const detailBudget =
		normalizedMaxChars > 0 ? normalizedMaxChars : DEFAULT_MAX_CHARS;
	const cappedDisplayModifiedFiles = capItemsByJsonChars(
		displayModifiedFiles,
		detailBudget,
	);
	const cappedByDetails =
		cappedDisplayModifiedFiles.length < displayModifiedFiles.length;

	return {
		text: cappedText.text,
		displayModifiedFiles: cappedDisplayModifiedFiles,
		editsSummary: summary,
		totalModifiedFiles: modifiedFiles.length,
		capped: cappedByCount || cappedText.cappedByChars || cappedByDetails,
		cappedByChars: cappedText.cappedByChars,
	};
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

const LSP_TOOL_SEARCH = "lsp_tool_search";
const LSP_TOOL_NAMES = [
	"lsp_goto_definition",
	"lsp_find_references",
	"lsp_diagnostics",
	"lsp_symbols",
	"lsp_prepare_rename",
	"lsp_rename",
] as const;

type LspToolName = (typeof LSP_TOOL_NAMES)[number];
const LSP_TOOL_NAME_SET = new Set<string>(LSP_TOOL_NAMES);

function normalizeToolSearchQuery(query: string): string {
	return query
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function findLspTools(query: string): LspToolName[] {
	const normalized = normalizeToolSearchQuery(query);
	if (!normalized) return [];

	const exactTool = LSP_TOOL_NAMES.find(
		(name) => normalizeToolSearchQuery(name) === normalized,
	);
	if (exactTool) {
		return exactTool === "lsp_rename"
			? ["lsp_prepare_rename", "lsp_rename"]
			: [exactTool];
	}

	const matches: LspToolName[] = [];
	const add = (...names: LspToolName[]) => {
		for (const name of names) {
			if (!matches.includes(name)) matches.push(name);
		}
	};

	if (
		/\b(definition|definitions|defined|declaration|declarations|goto|go to|jump to)\b/.test(
			normalized,
		)
	) {
		add("lsp_goto_definition");
	}
	if (
		/\b(reference|references|usage|usages|caller|callers)\b/.test(normalized)
	) {
		add("lsp_find_references");
	}
	if (
		/\b(diagnostic|diagnostics|error|errors|warning|warnings|problem|problems)\b/.test(
			normalized,
		)
	) {
		add("lsp_diagnostics");
	}
	if (
		/\b(symbols|outline|structure)\b/.test(normalized) ||
		(/\bsymbol\b/.test(normalized) &&
			!/\b(rename|renamed|renaming)\b/.test(normalized))
	) {
		add("lsp_symbols");
	}
	const renameValidationPatterns = [
		/\b(?:prepare|validate|check|can|whether)\b(?:\s+\w+){0,6}?\s+(?:rename|renamed|renaming)\b/g,
	];
	let renameRemainder = normalized;
	let hasRenameValidationIntent = false;
	for (const pattern of renameValidationPatterns) {
		const next = renameRemainder.replace(pattern, "");
		hasRenameValidationIntent ||= next !== renameRemainder;
		renameRemainder = next;
	}
	if (hasRenameValidationIntent) {
		add("lsp_prepare_rename");
	}
	if (/\b(rename|renamed|renaming)\b/.test(renameRemainder)) {
		add("lsp_prepare_rename", "lsp_rename");
	}

	return matches;
}

interface DeferredToolActivationApi {
	getActiveTools?: () => string[];
	setActiveTools?: (toolNames: string[]) => void;
}

type ActiveDeferredToolApi = Required<DeferredToolActivationApi>;

function supportsDeferredToolActivation(
	api: DeferredToolActivationApi,
): api is ActiveDeferredToolApi {
	return (
		typeof api.getActiveTools === "function" &&
		typeof api.setActiveTools === "function"
	);
}

// ── Extension ──────────────────────────────────────────────────────────

export default function lspToolsExtension(pi: ExtensionAPI) {
	const deferredTools = pi as DeferredToolActivationApi;
	// Cleanup on shutdown
	// stopAllLspClients is narrow: only LSP client processes and the LSP
	// client cache. It never throws (suppresses stream-destroyed errors),
	// so downstream session_start handlers (e.g. orchestrator recovery)
	// always get a chance to run after /reload.
	pi.on("session_shutdown", async (_event, ctx) => {
		await stopAllLspClients(ctx);
	});

	pi.on("session_start", () => {
		if (!supportsDeferredToolActivation(deferredTools)) return;

		const active = deferredTools.getActiveTools();
		const next = active.filter((name) => !LSP_TOOL_NAME_SET.has(name));
		if (!next.includes(LSP_TOOL_SEARCH)) next.push(LSP_TOOL_SEARCH);
		if (
			next.length !== active.length ||
			next.some((name, index) => name !== active[index])
		) {
			deferredTools.setActiveTools(next);
		}
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

	pi.registerTool({
		name: LSP_TOOL_SEARCH,
		label: "LSP Tool Search",
		description:
			"Activate LSP tools for definitions, references, diagnostics, symbols, or safe rename.",
		promptSnippet:
			"Use lsp_tool_search to activate the required LSP operation.",
		parameters: Type.Object({
			query: Type.String({
				description: "Capability to activate, such as references or rename",
				maxLength: 200,
			}),
		}),
		async execute(_toolCallId, params) {
			const matches = findLspTools(params.query);
			if (matches.length === 0) {
				return {
					content: [{ type: "text", text: "No matching LSP tools found." }],
					details: { matches: [], added: [] },
				};
			}

			if (!supportsDeferredToolActivation(deferredTools)) {
				return {
					content: [
						{
							type: "text",
							text: `Matching LSP tools are already available: ${matches.join(", ")}`,
						},
					],
					details: { matches, added: [] },
				};
			}

			const active = deferredTools.getActiveTools();
			const activeNames = new Set(active);
			const added = matches.filter((name) => !activeNames.has(name));
			if (added.length > 0) {
				deferredTools.setActiveTools([...active, ...added]);
			}

			return {
				content: [
					{
						type: "text",
						text:
							added.length > 0
								? `Activated LSP tools: ${added.join(", ")}`
								: `Matching LSP tools already active: ${matches.join(", ")}`,
					},
				],
				details: { matches, added },
			};
		},
	});

	// Register tools
	pi.registerTool({
		name: "lsp_goto_definition",
		label: "LSP Go to Definition",
		description: "Jump to where a symbol is defined using LSP.",
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
		parameters: Type.Object({
			...makeFilePathParams().properties,
			limit: Type.Optional(
				Type.Number({
					description: "Maximum references to return (0 = unlimited)",
					default: DEFAULT_REFERENCE_LIMIT,
				}),
			),
			maxChars: Type.Optional(
				Type.Number({
					description: "Maximum characters in the text output (0 = unlimited)",
					default: DEFAULT_MAX_CHARS,
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
			const formatted = formatLimitedLocations(
				locations,
				params.limit,
				params.maxChars,
			);
			return {
				content: [{ type: "text", text: formatted.text }],
				details: {
					locations: formatted.locations,
					total: formatted.total,
					capped: formatted.capped,
					cappedByChars: formatted.cappedByChars,
				},
			};
		},
	});

	pi.registerTool({
		name: "lsp_diagnostics",
		label: "LSP Diagnostics",
		description: "Get errors and warnings for a file using LSP diagnostics.",
		parameters: Type.Object({
			filePath: Type.String({ description: "Path to the file to check" }),
			maxDiagnostics: Type.Optional(
				Type.Number({
					description: "Maximum diagnostics to return (0 = unlimited)",
					default: DEFAULT_DIAGNOSTIC_LIMIT,
				}),
			),
			maxChars: Type.Optional(
				Type.Number({
					description: "Maximum characters in the text output (0 = unlimited)",
					default: DEFAULT_MAX_CHARS,
				}),
			),
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
			const formatted = formatLimitedDiagnostics(
				filePath,
				diagnostics,
				params.maxDiagnostics,
				params.maxChars,
			);
			return {
				content: [{ type: "text", text: formatted.text }],
				details: {
					diagnostics: formatted.diagnostics,
					total: formatted.total,
					capped: formatted.capped,
					cappedByChars: formatted.cappedByChars,
				},
			};
		},
	});

	pi.registerTool({
		name: "lsp_symbols",
		label: "LSP Document Symbols",
		description: "List all symbols (functions, classes, variables) in a file.",
		parameters: Type.Object({
			filePath: Type.String({ description: "Path to the file to analyze" }),
			maxSymbols: Type.Optional(
				Type.Number({
					description: "Maximum flattened symbols to return (0 = unlimited)",
					default: DEFAULT_SYMBOL_LIMIT,
				}),
			),
			maxChars: Type.Optional(
				Type.Number({
					description: "Maximum characters in the text output (0 = unlimited)",
					default: DEFAULT_MAX_CHARS,
				}),
			),
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
			const formatted = formatLimitedSymbols(
				symbols,
				params.maxSymbols,
				params.maxChars,
			);
			return {
				content: [{ type: "text", text: formatted.text }],
				details: {
					symbols: formatted.symbols,
					total: formatted.total,
					capped: formatted.capped,
					cappedByChars: formatted.cappedByChars,
				},
			};
		},
	});

	pi.registerTool({
		name: "lsp_prepare_rename",
		label: "LSP Prepare Rename",
		description:
			"Check if a symbol can be renamed at a position. Use BEFORE lsp_rename.",
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
		parameters: Type.Object({
			...makeFilePathParams().properties,
			newName: Type.String({ description: "New symbol name" }),
			maxReportFiles: Type.Optional(
				Type.Number({
					description:
						"Maximum rename result report lines/files to display (0 = unlimited)",
					default: DEFAULT_RENAME_REPORT_FILE_LIMIT,
				}),
			),
			maxChars: Type.Optional(
				Type.Number({
					description:
						"Maximum characters in the rename text output (0 = unlimited)",
					default: DEFAULT_MAX_CHARS,
				}),
			),
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
			const formatted = formatRenameReport(
				report,
				modifiedFiles,
				edit,
				params.maxReportFiles,
				params.maxChars,
			);
			return {
				content: [{ type: "text", text: formatted.text }],
				details: {
					modifiedFiles,
					displayModifiedFiles: formatted.displayModifiedFiles,
					totalModifiedFiles: formatted.totalModifiedFiles,
					editSummary: formatted.editsSummary,
					capped: formatted.capped,
					cappedByChars: formatted.cappedByChars,
				},
			};
		},
	});
}

export const __test__ = {
	formatDiagnostic,
	formatLimitedDiagnostics,
	formatLimitedLocations,
	formatLimitedSymbols,
	formatRenameReport,
};
