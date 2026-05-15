/**
 * Plan History — tracks recipes that have already been suggested
 * so the planner can exclude them from future plans.
 *
 * Storage: plan-history.json in the data directory (same folder as catalog files).
 * Format:  Human-editable JSON array — delete any entry to make that recipe
 *          eligible again on the next `plan` run.
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import type { NormalizedRecipe } from '../types.js';

export interface HistoryEntry {
  id: string;
  title: string;
  /** ISO 8601 timestamp of when this recipe was suggested. */
  suggestedAt: string;
}

const HISTORY_FILE = 'plan-history.json';

function historyFilePath(dataPath: string): string {
  return join(dataPath, HISTORY_FILE);
}

/**
 * Load all history entries from disk.
 * Returns an empty array if the file does not exist or cannot be parsed.
 */
export async function loadHistory(dataPath: string): Promise<HistoryEntry[]> {
  const path = historyFilePath(dataPath);
  if (!existsSync(path)) return [];
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as HistoryEntry[];
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
  recipes: Pick<NormalizedRecipe, 'id' | 'title'>[]
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

/**
 * Return the set of recipe IDs that have been previously suggested.
 * Used to filter candidates before the optimizer runs.
 */
export async function getExcludedIds(dataPath: string): Promise<Set<string>> {
  const entries = await loadHistory(dataPath);
  return new Set(entries.map((e) => e.id));
}
