/**
 * Weekly Meal Planner — Main Entry Point
 *
 * Orchestrates the full planning pipeline:
 *   1. Load SelectionRecords + NormalizedRecipes from disk.
 *   2. Parse query → WeeklyPlanRequest (AI or offline).
 *   3. Build plan (deterministic beam search optimizer).
 *   4. Render markdown output.
 *   5. Optionally call AI for a natural-language explanation and validate it.
 *
 * Re-exports all public planner types and functions.
 */

import { createReadStream, existsSync } from 'fs';
import { createInterface } from 'readline';
import { join } from 'path';
import OpenAI from 'openai';

import { parsePlanRequestWithAI, parsePlanRequestOffline } from './query-parser.js';
import { buildWeeklyPlan } from './optimizer.js';
import { renderPlanAsMarkdown, isAiExplanationSafe } from './renderer.js';
import { scoreRecipeForRequest } from './scoring.js';
import { getExcludedIds, appendToHistory } from './history.js';
import {
  loadEnrichmentCache,
  enrichRecipes,
  applyEnrichmentForSoftScoring,
  getMissingPlanningFields,
} from './enricher.js';
import type { WeeklyPlanRequest, WeeklyPlanResult, CandidateScore, EnrichmentSummary, EnrichmentRecord } from './types.js';
import type { NormalizedRecipe } from '../types.js';
import type { SelectionRecord } from '../selection-index.js';

// Re-export types for consumers
export type { WeeklyPlanRequest, WeeklyPlanResult, CandidateScore } from './types.js';
export type { ProteinSlot, MacroRange, SharedIngredient, IngredientWasteClass, PlanAlternativeEntry, EnrichmentRecord, EnrichmentSummary, EstimatedPlanningMetadata } from './types.js';
export { parsePlanRequestOffline, parsePlanRequestWithAI } from './query-parser.js';
export { buildWeeklyPlan } from './optimizer.js';
export { renderPlanAsMarkdown } from './renderer.js';
export { validatePlanResult, isSuspiciousServingCount } from './validation.js';
export { scoreRecipeForRequest, getCanonicalIngredientKeys } from './scoring.js';
export { calculateMacroPercentages, getMissingMacroFields, formatMacroPct } from './macro-calculator.js';
export { loadHistory, saveHistory } from './history.js';
export type { HistoryEntry } from './history.js';
export { loadEnrichmentCache, enrichRecipes, computeRecipeHash, getMissingPlanningFields, applyEnrichmentForSoftScoring } from './enricher.js';

// ============================================================================
// Data loading
// ============================================================================

async function readJsonLines<T>(filePath: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const results: T[] = [];
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        results.push(JSON.parse(trimmed) as T);
      } catch {
        // Skip malformed lines
      }
    });

    rl.on('close', () => resolve(results));
    rl.on('error', reject);
  });
}

export interface PlannerDataFiles {
  selectionRecords: SelectionRecord[];
  normalizedById: Map<string, NormalizedRecipe>;
}

/**
 * Load the planner's required data files from the build output directory.
 */
export async function loadPlannerData(dataPath: string): Promise<PlannerDataFiles> {
  const selectionPath = join(dataPath, 'catalog.selection.jsonl');
  const normalizedPath = join(dataPath, 'recipes.normalized.jsonl');

  if (!existsSync(selectionPath)) {
    throw new Error(
      `catalog.selection.jsonl not found at ${dataPath}. Run "recipe-context build" first.`
    );
  }
  if (!existsSync(normalizedPath)) {
    throw new Error(
      `recipes.normalized.jsonl not found at ${dataPath}. Run "recipe-context build" first.`
    );
  }

  const [selectionRecords, normalizedList] = await Promise.all([
    readJsonLines<SelectionRecord>(selectionPath),
    readJsonLines<NormalizedRecipe>(normalizedPath),
  ]);

  const normalizedById = new Map<string, NormalizedRecipe>(
    normalizedList.map((r) => [r.id, r])
  );

  return { selectionRecords, normalizedById };
}

// ============================================================================
// Optional AI explanation
// ============================================================================

/**
 * Ask the AI to write a friendly explanation of the selected plan.
 * The explanation is validated — if it introduces fabricated recipe IDs, it is discarded.
 */
async function getAiExplanation(
  result: WeeklyPlanResult,
  options: { apiKey: string; model?: string }
): Promise<string | null> {
  const recipeList = result.selectedRecipes
    .map((r, i) => {
      const slot = result.request.requiredProteinSlots[i] ?? 'other';
      const time = r.total_time_minutes ? `${r.total_time_minutes} min` : 'time unknown';
      const kcal = r.nutrition?.calories ? `${Math.round(r.nutrition.calories)} kcal` : 'nutrition unknown';
      return `${i + 1}. [${slot}] "${r.title}" — ${time}, ${kcal}`;
    })
    .join('\n');

  const prompt =
    `You are explaining a weekly meal plan that was built by a deterministic optimizer from a local recipe catalog.\n\n` +
    `The selected recipes are:\n${recipeList}\n\n` +
    `Write 2-3 short paragraphs explaining why this plan is a good choice based on the user's goals:\n` +
    `${JSON.stringify(result.request.goals, null, 2)}\n\n` +
    `IMPORTANT: Do NOT invent recipe names, IDs, or suggest alternative recipes. ` +
    `Only reference the recipes listed above by their exact titles.`;

  try {
    const client = new OpenAI({ apiKey: options.apiKey });
    const response = await client.chat.completions.create({
      model: options.model ?? 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      max_tokens: 600,
    });

    const text = response.choices[0]?.message?.content ?? '';

    if (!isAiExplanationSafe(text, result)) {
      process.stderr.write(
        '[plan] AI explanation contained unexpected recipe IDs — discarded, using local renderer.\n'
      );
      return null;
    }

    return text;
  } catch {
    return null;
  }
}

// ============================================================================
// Main planRecipes() function — called by CLI
// ============================================================================

export interface PlanOptions {
  /** OpenAI API key (required unless --no-ai-parser). */
  apiKey?: string;
  /** OpenAI model (default: gpt-4o-mini). */
  model?: string;
  /** Path to the build output directory (default: ./dist/recipe-context). */
  dataPath: string;
  /** Show verbose output including score breakdowns. */
  verbose?: boolean;
  /** Output raw JSON result instead of markdown. */
  json?: boolean;
  /** Maximum candidates per slot (default 75). */
  maxCandidatesPerSlot?: number;
  /** Skip AI query parsing; use offline regex parser only. */
  noAiParser?: boolean;
  /** Call AI to explain the final plan (requires API key). */
  explain?: boolean;
  /** If true, previously-suggested recipes are excluded from this plan (default: true). */
  skipHistory?: boolean;
  /**
   * Auto-enrichment mode:
   * - "off": Never enrich during planning.
   * - "selected_only": Enrich selected recipes after initial plan (default).
   * - "candidates": Enrich top candidates before scoring.
   */
  autoEnrich?: 'off' | 'selected_only' | 'candidates';
  /** Maximum enrichment API calls per planning run (default: 20). */
  enrichmentLimit?: number;
  /**
   * Use estimated macros from enrichment for soft scoring.
   * Estimated macros are NEVER used for strict validation regardless of this setting.
   */
  useEstimatedMacrosForSoftScoring?: boolean;
}

export interface PlanOutput {
  result: WeeklyPlanResult;
  markdown: string;
  aiExplanation: string | null;
  /** Parsed request for display in verbose mode. */
  parsedRequest: WeeklyPlanRequest;
  usedFallback: boolean;
  parseWarnings: string[];
  /** Summary of enrichment activity, if any. */
  enrichmentSummary: EnrichmentSummary | null;
}

/**
 * Execute the full planning pipeline for a natural-language query.
 */
export async function planRecipes(query: string, options: PlanOptions): Promise<PlanOutput> {
  const autoEnrich = options.autoEnrich ?? 'selected_only';
  const enrichmentLimit = options.enrichmentLimit ?? 20;
  const useEstimatedMacros = options.useEstimatedMacrosForSoftScoring ?? true;

  // --- Load data ---
  const { selectionRecords: allSelectionRecords, normalizedById } = await loadPlannerData(options.dataPath);

  // --- Filter previously-suggested recipes (unless caller opts out) ---
  const skipHistory = options.skipHistory ?? true;
  let selectionRecords = allSelectionRecords;
  if (skipHistory) {
    const excludedIds = await getExcludedIds(options.dataPath);
    if (excludedIds.size > 0) {
      selectionRecords = allSelectionRecords.filter((r) => !excludedIds.has(r.id));
    }
  }

  // --- Load enrichment cache (always load so we can use cached data even in 'off' mode) ---
  const enrichmentCache = await loadEnrichmentCache(options.dataPath);

  // --- Apply cached enrichment to normalizedById for scoring ---
  //     Cached data is free to use regardless of autoEnrich mode.
  const enrichedNormalizedById = applyEnrichmentCacheToMap(
    normalizedById,
    enrichmentCache,
    useEstimatedMacros
  );

  // --- Parse query ---
  let parsedRequest: WeeklyPlanRequest;
  let usedFallback = false;
  let parseWarnings: string[] = [];

  if (options.noAiParser || !options.apiKey) {
    parsedRequest = parsePlanRequestOffline(query);
    usedFallback = !options.noAiParser;
    if (!options.noAiParser && !options.apiKey) {
      parseWarnings.push('No API key provided — using offline parser. Set OPENAI_API_KEY for better query understanding.');
    }
  } else {
    const parseResult = await parsePlanRequestWithAI(query, {
      apiKey: options.apiKey,
      model: options.model,
    });
    parsedRequest = parseResult.request;
    usedFallback = parseResult.usedFallback;
    parseWarnings = parseResult.parseWarnings;
  }

  // -------------------------------------------------------------------------
  // CANDIDATES mode: enrich top candidates before scoring
  // -------------------------------------------------------------------------
  let candidatesEnrichmentSummary: EnrichmentSummary | null = null;
  if (autoEnrich === 'candidates' && options.apiKey) {
    // Get a rough candidate set (all recipes, optimizer will narrow down)
    // We enrich up to enrichmentLimit recipes that have missing data
    const candidatesNeedingEnrichment = [...enrichedNormalizedById.values()].filter(
      (r) => getMissingPlanningFields(r).length > 0
    );

    if (candidatesNeedingEnrichment.length > 0) {
      const enrichResult = await enrichRecipes({
        recipes: candidatesNeedingEnrichment,
        cache: enrichmentCache,
        dataPath: options.dataPath,
        apiKey: options.apiKey,
        model: options.model,
        limit: enrichmentLimit,
      });

      candidatesEnrichmentSummary = {
        mode: 'candidates',
        recipesEnriched: enrichResult.recipesEnriched,
        recipesFromCache: enrichResult.recipesFromCache,
        skippedDueToLimit: enrichResult.skippedDueToLimit,
        apiKeyMissing: false,
        limitReached: enrichResult.skippedDueToLimit > 0,
        enrichedRecipes: enrichResult.enrichedRecipes,
        estimatedFields: enrichResult.estimatedFields,
      };

      // Re-apply updated cache
      applyEnrichmentCacheToMap(normalizedById, enrichmentCache, useEstimatedMacros, enrichedNormalizedById);
    }
  }

  // --- Build initial plan ---
  const result = buildWeeklyPlan(
    selectionRecords,
    enrichedNormalizedById,
    parsedRequest,
    options.maxCandidatesPerSlot ?? 75
  );

  // -------------------------------------------------------------------------
  // SELECTED_ONLY mode: enrich selected recipes, then re-score
  // -------------------------------------------------------------------------
  let selectedEnrichmentSummary: EnrichmentSummary | null = null;

  if (autoEnrich === 'selected_only') {
    const apiKeyMissing = !options.apiKey;

    if (!apiKeyMissing) {
      const selectedNeedingEnrichment = result.selectedRecipes.filter(
        (r) => getMissingPlanningFields(enrichedNormalizedById.get(r.id) ?? r).length > 0
      );

      if (selectedNeedingEnrichment.length > 0) {
        const enrichResult = await enrichRecipes({
          recipes: selectedNeedingEnrichment,
          cache: enrichmentCache,
          dataPath: options.dataPath,
          apiKey: options.apiKey,
          model: options.model,
          limit: enrichmentLimit,
        });

        selectedEnrichmentSummary = {
          mode: 'selected_only',
          recipesEnriched: enrichResult.recipesEnriched,
          recipesFromCache: enrichResult.recipesFromCache,
          skippedDueToLimit: enrichResult.skippedDueToLimit,
          apiKeyMissing: false,
          limitReached: enrichResult.skippedDueToLimit > 0,
          enrichedRecipes: enrichResult.enrichedRecipes,
          estimatedFields: enrichResult.estimatedFields,
        };

        // Re-apply updated cache to the enriched map
        applyEnrichmentCacheToMap(normalizedById, enrichmentCache, useEstimatedMacros, enrichedNormalizedById);

        // Re-score selected recipes with enriched data — update selectedRecipes in-place
        // (We don't fully re-optimize; we just update the recipe objects used in rendering)
        for (let i = 0; i < result.selectedRecipes.length; i++) {
          const enriched = enrichedNormalizedById.get(result.selectedRecipes[i].id);
          if (enriched) result.selectedRecipes[i] = enriched;
        }
      }
    } else {
      // No API key — report that enrichment was skipped
      const hasAnyCached = result.selectedRecipes.some((r) => enrichmentCache.has(r.id));
      selectedEnrichmentSummary = {
        mode: 'selected_only',
        recipesEnriched: 0,
        recipesFromCache: hasAnyCached ? result.selectedRecipes.filter((r) => enrichmentCache.has(r.id)).length : 0,
        skippedDueToLimit: 0,
        apiKeyMissing: true,
        limitReached: false,
        enrichedRecipes: [],
        estimatedFields: [],
      };
    }
  }

  // Combine enrichment summaries if both ran
  const enrichmentSummary: EnrichmentSummary | null =
    selectedEnrichmentSummary ?? candidatesEnrichmentSummary ?? null;

  // Attach enrichment summary to result
  result.enrichmentSummary = enrichmentSummary ?? undefined;

  // --- Compute per-recipe scores for verbose display ---
  const scoresByRecipeId = new Map<string, CandidateScore>();
  if (options.verbose) {
    for (const recipe of result.selectedRecipes) {
      const sel = selectionRecords.find((s) => s.id === recipe.id);
      if (sel) {
        const cs = scoreRecipeForRequest({ sel, norm: recipe }, parsedRequest);
        scoresByRecipeId.set(recipe.id, cs);
      }
    }
  }

  // --- Render markdown ---
  const markdown = renderPlanAsMarkdown(result, {
    verbose: options.verbose,
    usedFallback,
    parseWarnings,
    scoresByRecipeId,
    enrichmentSummary: enrichmentSummary ?? undefined,
  });

  // --- Optional AI explanation ---
  let aiExplanation: string | null = null;
  if (options.explain && options.apiKey) {
    aiExplanation = await getAiExplanation(result, {
      apiKey: options.apiKey,
      model: options.model,
    });
  }

  // --- Save suggested recipes to history ---
  if (skipHistory) {
    await appendToHistory(options.dataPath, result.selectedRecipes);
  }

  return { result, markdown, aiExplanation, parsedRequest, usedFallback, parseWarnings, enrichmentSummary };
}

// ============================================================================
// Internal: apply enrichment cache to a NormalizedRecipe map
// ============================================================================

function applyEnrichmentCacheToMap(
  originalById: Map<string, NormalizedRecipe>,
  cache: Map<string, EnrichmentRecord>,
  useEstimatedMacros: boolean,
  target: Map<string, NormalizedRecipe> = new Map(originalById)
): Map<string, NormalizedRecipe> {
  if (!useEstimatedMacros) return target;

  for (const [id, record] of cache) {
    const original = originalById.get(id);
    if (!original) continue;
    const enriched = applyEnrichmentForSoftScoring(original, record, true);
    target.set(id, enriched);
  }

  return target;
}
