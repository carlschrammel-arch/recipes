/**
 * Plan History — tracks recipes that have already been suggested
 * so the planner can exclude them from future plans.
 *
 * Storage: plan-history.json in the data directory (same folder as catalog files).
 * Format:  Human-editable JSON array — delete any entry to make that recipe
 *          eligible again on the next `plan` run.
 *
 * Matching strategy (most-stable first):
 *   1. Exact recipe ID  — fast and definitive
 *   2. Normalized title — fallback when IDs changed after catalog rebuild
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import type { SelectionRecord } from '../selection-index.js';

export interface HistoryEntry {
  id: string;
  title: string;
  /** ISO 8601 timestamp of when this recipe was suggested. */
  suggestedAt: string;
}

export type HistoryMatchType = 'id' | 'normalized_title' | 'none';

export interface HistoryMatchResult {
  matched: boolean;
  matchType: HistoryMatchType;
  entry?: HistoryEntry;
}

export interface HistoryExclusionResult {
  available: SelectionRecord[];
  excluded: Array<{ record: SelectionRecord; matchType: Exclude<HistoryMatchType, 'none'>; entry: HistoryEntry }>;
  historyPath: string;
  historyCount: number;
  excludedCount: number;
}

// ============================================================================
// Title normalization
// ============================================================================

export function normalizeRecipeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9']+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ============================================================================
// File helpers
// ============================================================================

const HISTORY_FILE = 'plan-history.json';

export function historyFilePath(dataPath: string): string {
  return join(dataPath, HISTORY_FILE);
}

/**
 * Load all history entries from disk.
 * Supports both array format `[{...}]` and object wrapper `{entries:[{...}]}`.
 * Returns an empty array if the file does not exist or cannot be parsed.
 */
export async function loadHistory(dataPath: string): Promise<HistoryEntry[]> {
  const path = historyFilePath(dataPath);
  if (!existsSync(path)) return [];
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as HistoryEntry[];
    if (parsed && Array.isArray(parsed.entries)) return parsed.entries as HistoryEntry[];
    return [];
  } catch {
    return [];
  }
}

/**
 * Persist history entries to disk (pretty-printed for easy editing).
 */
export async function saveHistory(dataPath: string, entries: HistoryEntry[]): Promise<void> {
  await writeFile(historyFilePath(dataPath), JSON.stringify(entries, null, 2) + '\n', 'utf-8');
}

/**
 * Append newly-suggested recipes to history.
 * Already-present IDs are skipped so there are no duplicates.
 */
export async function appendToHistory(
  dataPath: string,
  recipes: Array<{ id: string; title: string }>
): Promise<void> {
  const existing = await loadHistory(dataPath);
  const existingIds = new Set(existing.map((e) => e.id));
  const now = new Date().toISOString();

  const toAdd: HistoryEntry[] = recipes
    .filter((r) => !existingIds.has(r.id))
    .map((r) => ({ id: r.id, title: r.title, suggestedAt: now }));

  if (toAdd.length === 0) return;
  await saveHistory(dataPath, [...existing, ...toAdd]);
}

// ============================================================================
// Matching
// ============================================================================

/**
 * Check whether a SelectionRecord matches any history entry.
 * Tries exact ID first, then falls back to normalized title.
 */
export function matchAgainstHistory(
  sel: SelectionRecord,
  byId: Map<string, HistoryEntry>,
  byNormalizedTitle: Map<string, HistoryEntry>
): HistoryMatchResult {
  // 1. Exact ID
  const byIdEntry = byId.get(sel.id);
  if (byIdEntry) return { matched: true, matchType: 'id', entry: byIdEntry };

  // 2. Normalized title
  const normTitle = normalizeRecipeTitle(sel.title ?? '');
  if (normTitle.length > 0) {
    const byTitleEntry = byNormalizedTitle.get(normTitle);
    if (byTitleEntry) return { matched: true, matchType: 'normalized_title', entry: byTitleEntry };
  }

  return { matched: false, matchType: 'none' };
}

// ============================================================================
// High-level exclusion (used before optimizer)
// ============================================================================

/**
 * Filter a SelectionRecord array by removing any recipe that matches history.
 * Returns both the available (non-history) records and an exclusion report.
 */
export async function applyHistoryExclusion(
  dataPath: string,
  records: SelectionRecord[]
): Promise<HistoryExclusionResult> {
  const histPath = historyFilePath(dataPath);
  const entries = await loadHistory(dataPath);

  // Build lookup maps
  const byId = new Map<string, HistoryEntry>(entries.map((e) => [e.id, e]));
  const byNormalizedTitle = new Map<string, HistoryEntry>(
    entries.map((e) => [normalizeRecipeTitle(e.title), e])
  );

  const available: SelectionRecord[] = [];
  const excluded: HistoryExclusionResult['excluded'] = [];

  for (const sel of records) {
    const match = matchAgainstHistory(sel, byId, byNormalizedTitle);
    if (match.matched && match.entry && match.matchType !== 'none') {
      excluded.push({ record: sel, matchType: match.matchType, entry: match.entry });
    } else {
      available.push(sel);
    }
  }

  return {
    available,
    excluded,
    historyPath: histPath,
    historyCount: entries.length,
    excludedCount: excluded.length,
  };
}

/**
 * @deprecated Use applyHistoryExclusion() instead.
 * Returns the set of recipe IDs that have been previously suggested.
 */
export async function getExcludedIds(dataPath: string): Promise<Set<string>> {
  const entries = await loadHistory(dataPath);
  return new Set(entries.map((e) => e.id));
}
