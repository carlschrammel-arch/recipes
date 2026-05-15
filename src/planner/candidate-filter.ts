/**
 * Weekly Meal Planner — Candidate Filter
 *
 * Given the full recipe catalog and a WeeklyPlanRequest, returns a map of
 * { slot → PlannerRecipe[] } containing only recipes that could legitimately
 * fill each protein slot.
 *
 * Rules:
 * - Only real recipes from the catalog (no hallucinated entries).
 * - Non-canonical duplicates are excluded (SelectionRecord already deduplicates).
 * - Slot assignment is based on SelectionRecord fields computed during build.
 * - Vegan/vegetarian verification uses ingredient-level checks as safety net.
 */

import type { WeeklyPlanRequest, ProteinSlot, PlannerRecipe } from './types.js';
import type { SelectionRecord } from '../selection-index.js';
import type { NormalizedRecipe } from '../types.js';

// ============================================================================
// Meat / animal-product term lists
// ============================================================================

const MEAT_TERMS = new Set([
  'chicken', 'beef', 'pork', 'turkey', 'lamb', 'veal', 'bison', 'venison',
  'duck', 'goose', 'rabbit', 'salmon', 'tuna', 'shrimp', 'crab', 'lobster',
  'clam', 'mussel', 'oyster', 'scallop', 'anchovy', 'sardine', 'bacon',
  'ham', 'sausage', 'salami', 'pepperoni', 'prosciutto', 'pancetta',
  'ground meat', 'steak', 'ribs', 'chorizo', 'bratwurst', 'hot dog',
  'fish', 'seafood', 'cod', 'tilapia', 'halibut', 'mahi', 'trout',
  'herring', 'mackerel', 'catfish', 'snapper', 'bass', 'perch',
]);

const DAIRY_EGG_HONEY_TERMS = new Set([
  'egg', 'eggs', 'cheese', 'milk', 'cream', 'butter', 'yogurt', 'ghee',
  'honey', 'beeswax', 'whey', 'casein', 'lactose', 'buttermilk',
  'sour cream', 'cream cheese', 'half-and-half', 'gelatin',
]);

// ============================================================================
// Slot-matching logic
// ============================================================================

/**
 * Returns true if the recipe's SelectionRecord matches the given protein slot.
 * Does NOT perform ingredient-level cross-checks here (caller filters further).
 */
function matchesSlotBySelectionRecord(sel: SelectionRecord, slot: ProteinSlot): boolean {
  switch (slot) {
    case 'chicken':
      return sel.primary_protein === 'chicken';

    case 'beef':
      return sel.primary_protein === 'beef';

    case 'pork':
      return sel.primary_protein === 'pork';

    case 'turkey':
      return sel.primary_protein === 'turkey';

    case 'seafood':
      return sel.primary_protein === 'fish' || sel.primary_protein === 'seafood';

    case 'vegetarian':
      return sel.is_vegetarian && !sel.is_vegan;

    case 'vegan':
      return sel.is_vegan;

    case 'other':
      // Everything not covered by the more specific slots
      return !['chicken', 'beef', 'pork', 'turkey', 'fish', 'seafood'].includes(
        sel.primary_protein
      );
  }
}

/**
 * Confirms vegetarian/vegan slots by scanning ingredient text.
 * Returns true if the recipe is safe to include in the slot.
 */
function passesIngredientSafetyCheck(
  norm: NormalizedRecipe,
  slot: ProteinSlot
): boolean {
  if (slot !== 'vegetarian' && slot !== 'vegan') return true;

  const ingText = norm.ingredients
    .map((i) => i.ingredient.toLowerCase() + ' ' + i.original.toLowerCase())
    .join(' ');

  // Both vegetarian and vegan must not contain meat
  for (const term of MEAT_TERMS) {
    if (ingText.includes(term)) return false;
  }

  // Vegan additionally must not contain dairy/eggs/honey
  if (slot === 'vegan') {
    for (const term of DAIRY_EGG_HONEY_TERMS) {
      if (ingText.includes(term)) return false;
    }
  }

  return true;
}

// ============================================================================
// Main filter function
// ============================================================================

export interface FilterResult {
  /** Slot → candidate PlannerRecipes (passing hard constraints). */
  candidatesBySlot: Map<string, PlannerRecipe[]>;
  /** Diagnostic counts per slot. */
  counts: Record<string, number>;
  /** Slots with zero candidates (plan will warn for these). */
  emptySlots: string[];
}

/**
 * Build candidate pools for all slots in the request.
 *
 * @param selectionRecords   All SelectionRecords from catalog.selection.jsonl (already deduplicated).
 * @param normalizedById     Map from ID → NormalizedRecipe (from recipes.normalized.jsonl).
 * @param request            The parsed planning request.
 * @param maxPerSlot         Hard cap on candidates per slot (controls beam search cost).
 */
export function getCandidatesForPlan(
  selectionRecords: SelectionRecord[],
  normalizedById: Map<string, NormalizedRecipe>,
  request: WeeklyPlanRequest,
  maxPerSlot = 75
): FilterResult {
  // Determine which unique slots we need candidates for
  const uniqueSlots = [...new Set(request.requiredProteinSlots)];
  // If flex meals are requested, we also need a 'flex' pool
  const needsFlexPool = (request.flexMealCount ?? 0) > 0;

  const candidatesBySlot = new Map<string, PlannerRecipe[]>();
  const counts: Record<string, number> = {};
  const emptySlots: string[] = [];

  for (const slot of uniqueSlots) {
    const candidates: PlannerRecipe[] = [];

    for (const sel of selectionRecords) {
      // Must have a corresponding normalized record (safety: exclude orphan IDs)
      const norm = normalizedById.get(sel.id);
      if (!norm) continue;

      // Check slot match
      if (!matchesSlotBySelectionRecord(sel, slot)) continue;

      // Ingredient-level safety for vegetarian/vegan
      if (!passesIngredientSafetyCheck(norm, slot)) continue;

      candidates.push({ sel, norm });
    }

    // Truncate (caller will score and pick top-N anyway, but keep a hard cap)
    const truncated = candidates.slice(0, maxPerSlot);

    candidatesBySlot.set(slot, truncated);
    counts[slot] = truncated.length;

    if (truncated.length === 0) emptySlots.push(slot);
  }

  // ---- Build flex pool (all recipes, ordered by a simple heuristic) ----
  if (needsFlexPool) {
    const flexCandidates: PlannerRecipe[] = [];
    for (const sel of selectionRecords) {
      const norm = normalizedById.get(sel.id);
      if (!norm) continue;
      flexCandidates.push({ sel, norm });
    }
    const truncatedFlex = flexCandidates.slice(0, maxPerSlot);
    candidatesBySlot.set('flex', truncatedFlex);
    counts['flex'] = truncatedFlex.length;
  }

  return { candidatesBySlot, counts, emptySlots };
}

/**
 * Check whether at least one recipe in a set satisfies a source signal.
 * Source signals are lowercase substrings matched against source_normalized.
 */
export function hasSourceSignal(
  recipes: PlannerRecipe[],
  signal: string
): boolean {
  const sig = signal.toLowerCase();
  return recipes.some(
    (r) =>
      r.sel.source_normalized.toLowerCase().includes(sig) ||
      (r.sel.is_hellofresh && sig === 'hellofresh')
  );
}

/**
 * Check whether at least one recipe in a set matches a tag/title term.
 */
export function hasTagOrTitleTerm(
  recipes: PlannerRecipe[],
  term: string
): boolean {
  const t = term.toLowerCase();
  return recipes.some(
    (r) =>
      r.norm.title.toLowerCase().includes(t) ||
      r.sel.tags.some((tag) => tag.toLowerCase().includes(t)) ||
      (t === 'pasta' && r.sel.is_pasta)
  );
}
