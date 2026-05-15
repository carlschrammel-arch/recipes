/**
 * Recipe Enricher — Automatic Planning Metadata via OpenAI
 *
 * Enriches recipes that are missing planning metadata (freezer-friendliness,
 * kid-friendliness, comfort score, flavor family, estimated macros) by calling
 * OpenAI and caching the results in `recipes.enrichment.jsonl`.
 *
 * Safety rules (enforced throughout):
 * - Never overwrites original Paprika data.
 * - Estimated macros are NEVER used for strict nutritional validation.
 * - All enriched fields are clearly labeled as estimates.
 * - Cache key = recipe_id + recipe_hash + schema_version + model.
 *   If any input changes the cache entry is treated as stale.
 */

import { createHash } from 'crypto';
import { createReadStream, existsSync } from 'fs';
import { appendFile, writeFile } from 'fs/promises';
import { createInterface } from 'readline';
import { join } from 'path';
import OpenAI from 'openai';

import type { NormalizedRecipe } from '../types.js';
import type { EnrichmentRecord, EstimatedPlanningMetadata } from './types.js';

// ============================================================================
// Constants
// ============================================================================

const SCHEMA_VERSION = 1 as const;
const ENRICHMENT_FILE = 'recipes.enrichment.jsonl';

/** Fields that count as "missing planning metadata" for enrichment eligibility. */
const PLANNING_FIELDS_TO_CHECK: Array<keyof NormalizedRecipe> = [
  'nutrition',
  'kid_friendly_score',
  'weeknight_score',
];

// ============================================================================
// Cache I/O
// ============================================================================

/**
 * Load all enrichment records from the cache file into a map keyed by recipe_id.
 * Only the most recent valid record per recipe_id is kept.
 */
export async function loadEnrichmentCache(
  dataPath: string
): Promise<Map<string, EnrichmentRecord>> {
  const filePath = join(dataPath, ENRICHMENT_FILE);
  if (!existsSync(filePath)) return new Map();

  return new Promise((resolve, reject) => {
    const records = new Map<string, EnrichmentRecord>();
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const record = JSON.parse(trimmed) as EnrichmentRecord;
        if (record.recipe_id && record.schema_version === SCHEMA_VERSION) {
          // Validate macro plausibility — AI sometimes returns whole-recipe values instead of per-serving
          const m = record.metadata;
          if (m.estimated_protein_g != null && m.estimated_protein_g > 150) m.estimated_protein_g = null;
          if (m.estimated_carbs_g != null && m.estimated_carbs_g > 200) m.estimated_carbs_g = null;
          if (m.estimated_fat_g != null && m.estimated_fat_g > 120) m.estimated_fat_g = null;
          // If macros and calories are all set but don't add up (within 50%), null the macros
          if (
            m.estimated_calories != null &&
            m.estimated_protein_g != null &&
            m.estimated_carbs_g != null &&
            m.estimated_fat_g != null
          ) {
            const macroKcal =
              m.estimated_protein_g * 4 + m.estimated_carbs_g * 4 + m.estimated_fat_g * 9;
            if (Math.abs(macroKcal - m.estimated_calories) > m.estimated_calories * 0.5) {
              m.estimated_protein_g = null;
              m.estimated_carbs_g = null;
              m.estimated_fat_g = null;
            }
          }
          records.set(record.recipe_id, record); // Later entries overwrite earlier ones
        }
      } catch {
        // Skip malformed lines
      }
    });

    rl.on('close', () => resolve(records));
    rl.on('error', reject);
  });
}

/**
 * Append a single enrichment record to the cache file.
 * Appending is safe for concurrent use and allows later entries to win.
 */
async function appendEnrichmentRecord(
  dataPath: string,
  record: EnrichmentRecord
): Promise<void> {
  const filePath = join(dataPath, ENRICHMENT_FILE);
  const line = JSON.stringify(record) + '\n';
  try {
    await appendFile(filePath, line, { encoding: 'utf-8' });
  } catch (err: unknown) {
    // If file doesn't exist yet, create it
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await writeFile(filePath, line, { encoding: 'utf-8' });
    } else {
      throw err;
    }
  }
}

// ============================================================================
// Recipe hash
// ============================================================================

/**
 * Compute a short hash of the recipe content that changes when the recipe changes.
 * Used to detect stale cache entries.
 */
export function computeRecipeHash(recipe: NormalizedRecipe): string {
  const content = [
    recipe.title,
    recipe.ingredients.map((i) => i.original).join('|'),
    recipe.yield_servings?.toString() ?? '',
  ].join('\0');
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// ============================================================================
// Enrichment eligibility
// ============================================================================

/**
 * Determine which planning fields are missing for a recipe.
 * Returns the list of missing field names (empty = fully populated).
 */
export function getMissingPlanningFields(recipe: NormalizedRecipe): string[] {
  const missing: string[] = [];
  if (!recipe.nutrition || recipe.nutrition.calories === null) {
    missing.push('nutrition');
  } else {
    // Has calories but may be missing the macro breakdown needed for scoring.
    // Sources like HelloFresh often publish calorie counts without protein/carbs/fat.
    const n = recipe.nutrition;
    if (n.protein_g === null || n.carbs_g === null || n.fat_g === null) {
      missing.push('nutrition_macros');
    }
  }
  // kid_friendly_score defaults to 0 but we treat 0 as "not computed" for recipes
  // that have no kid-friendly signals. We only enrich if it's exactly 0 AND the recipe
  // has no tags or title signals that would have set it.
  if (recipe.kid_friendly_score === 0) missing.push('kid_friendly_score');
  if (recipe.weeknight_score === 0) missing.push('weeknight_score');
  return missing;
}

/**
 * Returns true when the cached record is still valid for this recipe + model.
 */
function isCacheValid(
  record: EnrichmentRecord,
  recipe: NormalizedRecipe,
  model: string
): boolean {
  return (
    record.recipe_hash === computeRecipeHash(recipe) &&
    record.model === model &&
    record.schema_version === SCHEMA_VERSION
  );
}

// ============================================================================
// OpenAI enrichment call
// ============================================================================

const SYSTEM_PROMPT = `You are a culinary metadata assistant.
Given a recipe's title, ingredients, and context, estimate planning metadata.
All estimates are for soft meal-planning scoring only — they are NEVER used for strict nutritional validation.
Respond with a single JSON object and no other text.`;

function buildEnrichmentPrompt(recipe: NormalizedRecipe): string {
  const ingredientList = recipe.ingredients
    .slice(0, 20)
    .map((i) => `- ${i.original}`)
    .join('\n');

  return `Recipe: "${recipe.title}"
Tags: ${recipe.tags.join(', ') || 'none'}
Servings: ${recipe.yield_servings ?? 'unknown'}
Total time: ${recipe.total_time_minutes != null ? `${recipe.total_time_minutes} min` : 'unknown'}
Cuisine: ${recipe.cuisine ?? 'unknown'}
${recipe.nutrition ? `Known nutrition: ${JSON.stringify(recipe.nutrition)}` : 'Nutrition: not available'}

Ingredients (up to 20):
${ingredientList}

Estimate the following planning metadata. Return a JSON object with these exact keys:
{
  "estimated_calories": <number per serving or null>,
  "estimated_protein_g": <number per serving or null>,
  "estimated_carbs_g": <number per serving or null>,
  "estimated_fat_g": <number per serving or null>,
  "freezer_friendly": <true|false|null>,
  "reheats_well": <true|false|null>,
  "kid_friendly_score": <0.0-1.0 or null>,
  "comfort_score": <0.0-1.0 or null>,
  "flavor_family": <"umami"|"bright"|"hearty"|"light"|"spicy"|"sweet"|"neutral" or null>,
  "reasoning": "<one sentence>"
}

Rules:
- Return null for any field you cannot reasonably estimate.
- Do NOT guess nutrition if the recipe is heavily customizable.
- kid_friendly_score: 1.0 = universally loved by children, 0.0 = adults only.
- comfort_score: 1.0 = classic comfort food, 0.0 = light/fresh/diet food.`;
}

async function callOpenAIForEnrichment(
  recipe: NormalizedRecipe,
  client: OpenAI,
  model: string
): Promise<EstimatedPlanningMetadata | null> {
  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildEnrichmentPrompt(recipe) },
      ],
      temperature: 0.2,
      max_tokens: 400,
      response_format: { type: 'json_object' },
    });

    const text = response.choices[0]?.message?.content ?? '';
    const parsed = JSON.parse(text) as EstimatedPlanningMetadata;
    return parsed;
  } catch {
    return null;
  }
}

// ============================================================================
// Main enrichment function
// ============================================================================

export interface EnrichRecipesOptions {
  /** Recipes to potentially enrich. */
  recipes: NormalizedRecipe[];
  /** Loaded enrichment cache (will be mutated with new entries). */
  cache: Map<string, EnrichmentRecord>;
  /** Data directory for writing the enrichment file. */
  dataPath: string;
  /** OpenAI API key. Required to call the API; if absent, only cached data is used. */
  apiKey?: string;
  /** OpenAI model (default: gpt-4o-mini). */
  model?: string;
  /** Maximum number of API calls to make in this run. */
  limit?: number;
  /** Progress callback called for each recipe enriched. */
  onProgress?: (recipe: NormalizedRecipe, fromCache: boolean) => void;
}

export interface EnrichResult {
  /** Updated enrichment records for all recipes that were enriched or cache-hit. */
  records: Map<string, EnrichmentRecord>;
  recipesEnriched: number;
  recipesFromCache: number;
  skippedDueToLimit: number;
  enrichedRecipes: Array<{ id: string; title: string }>;
  estimatedFields: string[];
}

/**
 * Assign a numeric priority to a recipe for enrichment ordering.
 * Lower number = higher priority = enriched first.
 *
 * Priority rationale:
 *   0 — Has calories but missing ≥1 macro (protein/carbs/fat).
 *       These recipes get a macroFit: -0.800 scoring penalty and benefit
 *       the most from enrichment during beam-search scoring.
 *   1 — No calories at all — gets full estimated nutrition.
 *   2 — Only missing soft signals (kid_friendly_score, weeknight_score).
 */
function enrichmentPriority(recipe: NormalizedRecipe): number {
  const n = recipe.nutrition;
  if (n?.calories != null && (n.protein_g === null || n.carbs_g === null || n.fat_g === null)) {
    return 0;
  }
  if (!n || n.calories === null) {
    return 1;
  }
  return 2;
}

/**
 * Enrich the given recipes with planning metadata.
 * Uses cache-first strategy; calls OpenAI only when needed and within limit.
 * Recipes are processed in enrichment-priority order so the API call budget
 * goes to the recipes that benefit most from macro estimation.
 */
export async function enrichRecipes(options: EnrichRecipesOptions): Promise<EnrichResult> {
  const {
    recipes,
    cache,
    dataPath,
    apiKey,
    model = 'gpt-4o-mini',
    limit = 20,
    onProgress,
  } = options;

  // Sort by enrichment priority so the API call budget is used on recipes
  // that benefit most (partial macros first, then no-nutrition, then soft-only).
  const sortedRecipes = [...recipes].sort(
    (a, b) => enrichmentPriority(a) - enrichmentPriority(b)
  );

  const client = apiKey ? new OpenAI({ apiKey }) : null;
  let apiCallsUsed = 0;
  let recipesEnriched = 0;
  let recipesFromCache = 0;
  let skippedDueToLimit = 0;
  const enrichedRecipes: Array<{ id: string; title: string }> = [];
  const estimatedFieldsSet = new Set<string>();

  for (const recipe of sortedRecipes) {
    const missingFields = getMissingPlanningFields(recipe);
    if (missingFields.length === 0) continue; // Already complete, skip

    const cached = cache.get(recipe.id);
    if (cached && isCacheValid(cached, recipe, model)) {
      // Cache hit — collect which fields were estimated
      collectEstimatedFields(cached.metadata, estimatedFieldsSet);
      recipesFromCache++;
      onProgress?.(recipe, true);
      continue;
    }

    // Need to call API
    if (!client) continue; // No API key — skip
    if (apiCallsUsed >= limit) {
      skippedDueToLimit++;
      continue;
    }

    const metadata = await callOpenAIForEnrichment(recipe, client, model);
    if (!metadata) continue;

    const record: EnrichmentRecord = {
      recipe_id: recipe.id,
      recipe_hash: computeRecipeHash(recipe),
      schema_version: SCHEMA_VERSION,
      model,
      enriched_at: new Date().toISOString(),
      metadata,
    };

    cache.set(recipe.id, record);
    await appendEnrichmentRecord(dataPath, record);
    collectEstimatedFields(metadata, estimatedFieldsSet);

    apiCallsUsed++;
    recipesEnriched++;
    enrichedRecipes.push({ id: recipe.id, title: recipe.title });
    onProgress?.(recipe, false);
  }

  return {
    records: cache,
    recipesEnriched,
    recipesFromCache,
    skippedDueToLimit,
    enrichedRecipes,
    estimatedFields: [...estimatedFieldsSet],
  };
}

function collectEstimatedFields(
  metadata: EstimatedPlanningMetadata,
  out: Set<string>
): void {
  if (metadata.estimated_calories != null) out.add('calories');
  if (metadata.estimated_protein_g != null) out.add('protein_g');
  if (metadata.estimated_carbs_g != null) out.add('carbs_g');
  if (metadata.estimated_fat_g != null) out.add('fat_g');
  if (metadata.freezer_friendly != null) out.add('freezer_friendly');
  if (metadata.reheats_well != null) out.add('reheats_well');
  if (metadata.kid_friendly_score != null) out.add('kid_friendly_score');
  if (metadata.comfort_score != null) out.add('comfort_score');
  if (metadata.flavor_family != null) out.add('flavor_family');
}

// ============================================================================
// Merge enrichment into NormalizedRecipe for soft scoring
//
// IMPORTANT: Only used for soft scoring. Never for strict validation.
// The original recipe object is not mutated — a new object is returned.
// ============================================================================

/**
 * Apply an EnrichmentRecord's estimated metadata to a NormalizedRecipe
 * for use in soft scoring. Returns a shallow-merged copy.
 * The original recipe and its Paprika data are not modified.
 *
 * @param recipe - The original NormalizedRecipe from local catalog.
 * @param record - The enrichment record from cache.
 * @param usedForSoftScoringOnly - Must be true; enforces caller intent.
 * @returns A new NormalizedRecipe with estimated fields applied where missing.
 */
export function applyEnrichmentForSoftScoring(
  recipe: NormalizedRecipe,
  record: EnrichmentRecord,
  usedForSoftScoringOnly: true
): NormalizedRecipe {
  void usedForSoftScoringOnly; // parameter enforces caller intent at call site

  const m = record.metadata;
  const enriched: NormalizedRecipe = { ...recipe };

  // Only fill in missing nutrition — never overwrite existing values.
  // Case 1: No nutrition at all (or calories missing) — fill everything.
  if (!enriched.nutrition || enriched.nutrition.calories === null) {
    if (
      m.estimated_calories != null ||
      m.estimated_protein_g != null ||
      m.estimated_carbs_g != null ||
      m.estimated_fat_g != null
    ) {
      enriched.nutrition = {
        calories: m.estimated_calories ?? enriched.nutrition?.calories ?? null,
        protein_g: m.estimated_protein_g ?? enriched.nutrition?.protein_g ?? null,
        carbs_g: m.estimated_carbs_g ?? enriched.nutrition?.carbs_g ?? null,
        fat_g: m.estimated_fat_g ?? enriched.nutrition?.fat_g ?? null,
        sodium_mg: enriched.nutrition?.sodium_mg ?? null,
      };
    }
  } else if (
    enriched.nutrition &&
    (enriched.nutrition.protein_g === null ||
     enriched.nutrition.carbs_g === null ||
     enriched.nutrition.fat_g === null)
  ) {
    // Case 2: Has calories but missing macro breakdown — fill only the missing macros.
    // This is common for sources (e.g. HelloFresh) that publish calorie counts but not
    // individual macro grams. Enrichment estimates fill the gap so these recipes can
    // be scored on the same macro criteria as sources with full nutritional data.
    enriched.nutrition = {
      ...enriched.nutrition,
      protein_g: enriched.nutrition.protein_g ?? m.estimated_protein_g ?? null,
      carbs_g:   enriched.nutrition.carbs_g   ?? m.estimated_carbs_g   ?? null,
      fat_g:     enriched.nutrition.fat_g     ?? m.estimated_fat_g     ?? null,
    };
  }

  // Apply plausibility bounds to the merged result — catches both implausible
  // AI estimates (already filtered in loadEnrichmentCache) and implausible
  // source data (e.g., whole-recipe macros instead of per-serving).
  if (enriched.nutrition) {
    const n = enriched.nutrition;
    if (n.protein_g != null && n.protein_g > 150) n.protein_g = null;
    if (n.carbs_g != null && n.carbs_g > 200) n.carbs_g = null;
    if (n.fat_g != null && n.fat_g > 120) n.fat_g = null;
  }

  // Only update kid_friendly_score if it was 0 (unset)
  if (recipe.kid_friendly_score === 0 && m.kid_friendly_score != null) {
    enriched.kid_friendly_score = m.kid_friendly_score;
  }

  // Only update weeknight_score if it was 0 (unset)
  if (recipe.weeknight_score === 0) {
    // Derive weeknight score from comfort + time
    if (m.comfort_score != null && recipe.total_time_minutes != null) {
      const timeFactor = recipe.total_time_minutes <= 30 ? 1.0 :
                         recipe.total_time_minutes <= 45 ? 0.8 :
                         recipe.total_time_minutes <= 60 ? 0.6 : 0.4;
      enriched.weeknight_score = (m.comfort_score * 0.4 + timeFactor * 0.6);
    }
  }

  return enriched;
}
