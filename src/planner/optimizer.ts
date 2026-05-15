/**
 * Weekly Meal Planner — Beam Search Optimizer
 *
 * Selects the best combination of recipes across all required slots using
 * beam search. All selection is deterministic and local — the LLM is never
 * the source of truth for recipe choices.
 *
 * Algorithm:
 *   1. Score all candidates per slot.
 *   2. Grow partial plans slot-by-slot; keep the top BEAM_WIDTH beams at each step.
 *   3. Ingredient-overlap and cuisine-variety bonuses are applied incrementally.
 *   4. Required singletons (HelloFresh, pasta) are enforced as post-hoc swaps.
 *   5. Compute full plan-level score + shopping overlap for the winner.
 */

import type {
  WeeklyPlanRequest,
  WeeklyPlanResult,
  PlannerRecipe,
  PartialPlan,
  CandidateScore,
  ShoppingOverlap,
  SharedIngredient,
  IngredientWasteClass,
  PlanAlternative,
  PlanAlternativeEntry,
} from './types.js';
import type { NormalizedRecipe } from '../types.js';
import type { SelectionRecord } from '../selection-index.js';
import { getCandidatesForPlan, hasSourceSignal, hasTagOrTitleTerm } from './candidate-filter.js';
import { scoreRecipeForRequest, getCanonicalIngredientKeys } from './scoring.js';
import { validatePlanResult } from './validation.js';

// ============================================================================
// Constants
// ============================================================================

const BEAM_WIDTH = 100;
const OVERLAP_BONUS_PER_KEY = 0.15;  // Per shared ingredient key added to plan
const VARIETY_BONUS_PER_CUISINE = 0.10; // Per novel cuisine added to plan
const MAX_OVERLAP_BONUS = 2.0;
const MAX_VARIETY_BONUS = 1.0;

// ============================================================================
// Recipe format helpers
// ============================================================================

/** Detect creamy pasta format (heavy cream/cream cheese + pasta). */
function isCreamyPasta(recipe: PlannerRecipe): boolean {
  if (!recipe.sel.is_pasta) return false;
  const ingText = recipe.norm.ingredients.map((i) => i.original.toLowerCase()).join(' ');
  return /heavy cream|cream cheese|cream sauce|alfredo|bechamel|b[eé]chamel|white sauce/.test(ingText);
}

// ============================================================================
// Helpers
// ============================================================================

function clonePartialPlan(plan: PartialPlan): PartialPlan {
  return {
    assignments: new Map(plan.assignments),
    score: plan.score,
    usedIds: new Set(plan.usedIds),
    ingredientKeys: new Map(
      [...plan.ingredientKeys.entries()].map(([k, v]) => [k, [...v]])
    ),
    cuisines: new Set(plan.cuisines),
  };
}

function addRecipeToPartialPlan(
  plan: PartialPlan,
  slot: string,
  recipe: PlannerRecipe,
  candidateScore: CandidateScore
): { newPlan: PartialPlan; overlapBonus: number; varietyBonus: number } {
  const newPlan = clonePartialPlan(plan);
  newPlan.assignments.set(slot, recipe);
  newPlan.usedIds.add(recipe.norm.id);

  // Compute ingredient overlap bonus
  let overlapBonus = 0;
  const ingKeys = getCanonicalIngredientKeys(recipe.norm);

  for (const key of ingKeys) {
    if (newPlan.ingredientKeys.has(key)) {
      // Key already present: bonus for sharing
      const existing = newPlan.ingredientKeys.get(key)!;
      existing.push(recipe.norm.id);
      overlapBonus += OVERLAP_BONUS_PER_KEY;
    } else {
      newPlan.ingredientKeys.set(key, [recipe.norm.id]);
    }
  }
  overlapBonus = Math.min(overlapBonus, MAX_OVERLAP_BONUS);

  // Compute cuisine variety bonus
  let varietyBonus = 0;
  const cuisine = recipe.norm.cuisine;
  if (cuisine && !newPlan.cuisines.has(cuisine)) {
    newPlan.cuisines.add(cuisine);
    varietyBonus = VARIETY_BONUS_PER_CUISINE;
  }

  newPlan.score = plan.score + candidateScore.score + overlapBonus + varietyBonus;

  return { newPlan, overlapBonus, varietyBonus };
}

// ============================================================================
// Singleton enforcement (HelloFresh, pasta)
// ============================================================================

/**
 * If requiredSourceSignals or requiredTagsOrTitleTerms are set and not satisfied
 * by the current best plan, attempt a post-hoc swap:
 *   - For each slot, check if there's a qualifying candidate not already used.
 *   - Swap out the lowest-scoring recipe in the plan for the qualifying one.
 */
function enforceRequiredSingletons(
  plan: PartialPlan,
  candidatesBySlot: Map<string, Array<{ recipe: PlannerRecipe; score: CandidateScore }>>,
  request: WeeklyPlanRequest
): { plan: PartialPlan; warnings: string[] } {
  const warnings: string[] = [];

  const selectedRecipes = [...plan.assignments.values()];

  // ---- HelloFresh requirement ----
  if (request.requiredSourceSignals?.includes('hellofresh')) {
    const hasHF = selectedRecipes.some((r) => r.sel.is_hellofresh);
    if (!hasHF) {
      // Find any slot that has a HF candidate not already used
      let swapped = false;
      for (const [slot, candidates] of candidatesBySlot) {
        const hfCandidate = candidates.find(
          (c) => c.recipe.sel.is_hellofresh && !plan.usedIds.has(c.recipe.norm.id)
        );
        if (hfCandidate) {
          // Find the lowest-scoring recipe currently in this slot or the overall lowest
          const currentInSlot = plan.assignments.get(slot);
          const overallLowest = [...plan.assignments.entries()]
            .map(([s, r]) => ({ slot: s, recipe: r }))
            .sort((a, b) => {
              const sa = candidatesBySlot.get(a.slot)?.find((c) => c.recipe.norm.id === a.recipe.norm.id)?.score.score ?? 0;
              const sb = candidatesBySlot.get(b.slot)?.find((c) => c.recipe.norm.id === b.recipe.norm.id)?.score.score ?? 0;
              return sa - sb;
            })[0];

          const targetSlot = overallLowest?.slot ?? slot;
          const removedId = plan.assignments.get(targetSlot)?.norm.id;

          plan = clonePartialPlan(plan);
          plan.assignments.set(targetSlot, hfCandidate.recipe);
          if (removedId) plan.usedIds.delete(removedId);
          plan.usedIds.add(hfCandidate.recipe.norm.id);
          swapped = true;
          break;
        }
      }
      if (!swapped) {
        warnings.push(
          'HelloFresh requirement: no HelloFresh recipes found in any candidate pool. ' +
          'Check that your catalog contains HelloFresh recipes (run "recipe-context build" to refresh).'
        );
      }
    }
  }

  // ---- Pasta requirement ----
  if (request.requiredTagsOrTitleTerms?.includes('pasta')) {
    const hasPasta = [...plan.assignments.values()].some((r) => r.sel.is_pasta);
    if (!hasPasta) {
      let swapped = false;
      for (const [slot, candidates] of candidatesBySlot) {
        const pastaCandidate = candidates.find(
          (c) => c.recipe.sel.is_pasta && !plan.usedIds.has(c.recipe.norm.id)
        );
        if (pastaCandidate) {
          const overallLowest = [...plan.assignments.entries()]
            .map(([s, r]) => ({ slot: s, recipe: r }))
            .sort((a, b) => {
              const sa = candidatesBySlot.get(a.slot)?.find((c) => c.recipe.norm.id === a.recipe.norm.id)?.score.score ?? 0;
              const sb = candidatesBySlot.get(b.slot)?.find((c) => c.recipe.norm.id === b.recipe.norm.id)?.score.score ?? 0;
              return sa - sb;
            })[0];

          const targetSlot = overallLowest?.slot ?? slot;
          const removedId = plan.assignments.get(targetSlot)?.norm.id;

          plan = clonePartialPlan(plan);
          plan.assignments.set(targetSlot, pastaCandidate.recipe);
          if (removedId) plan.usedIds.delete(removedId);
          plan.usedIds.add(pastaCandidate.recipe.norm.id);
          swapped = true;
          break;
        }
      }
      if (!swapped) {
        warnings.push(
          'Pasta requirement: no pasta recipes found in the candidate pools. ' +
          'The plan was built without a pasta dish.'
        );
      }
    }
  }

  return { plan, warnings };
}

// ============================================================================
// Ingredient waste classification
// ============================================================================

/**
 * Pure pantry staples — long shelf life, always stocked, not meaningful grocery items.
 * These will go to pantryOverlaps and are not shown in the main shared list.
 */
const PANTRY_INGREDIENT_KEYS = new Set([
  'olive oil', 'vegetable oil', 'canola oil', 'cooking oil', 'salt', 'black pepper',
  'pepper', 'white pepper', 'water', 'sugar', 'flour', 'bread crumbs', 'panko',
  'vinegar', 'mustard', 'cumin', 'paprika', 'oregano', 'bay leaves',
  'thyme', 'rosemary', 'chili flakes', 'dried pasta', 'rice', 'white rice',
  'brown rice', 'corn starch', 'baking powder', 'baking soda',
  // Common kitchen staples that virtually everyone stocks — not meaningful grocery items
  'garlic', 'onion', 'butter', 'soy sauce', 'hot sauce', 'tomato paste',
  'honey', 'chicken broth', 'beef broth', 'vegetable broth',
]);

/**
 * Fridge items that are worth buying once for multiple recipes but low individual waste.
 * Shown in main list at reduced weight — they're useful to call out but not critical.
 */
const FRIDGE_STAPLE_KEYS = new Set([
  'red onion', 'eggs', 'fish sauce', 'coconut milk',
  'canned tomatoes', 'black beans', 'chickpeas', 'lentils', 'salsa', 'cheese',
  'parmesan cheese', 'mozzarella',
]);

/**
 * Perishable items — short shelf life, high waste risk if only used in one recipe.
 * Most meaningful for shopping overlap.
 */
const PERISHABLE_INGREDIENT_KEYS = new Set([
  'cilantro', 'parsley', 'basil', 'scallions', 'spinach', 'baby spinach',
  'kale', 'arugula', 'heavy cream', 'sour cream', 'cream cheese', 'buttermilk',
  'avocado', 'lemon', 'lime', 'mushrooms', 'bell pepper', 'jalapeño',
  'grape tomatoes', 'cherry tomatoes', 'lettuce', 'cabbage', 'bok choy',
  'broccoli', 'zucchini', 'asparagus', 'eggplant', 'fresh ginger',
  'mozzarella', 'ricotta', 'feta', 'brie',
]);

function classifyIngredient(key: string): { wasteClass: IngredientWasteClass; scoreWeight: number } {
  if (PANTRY_INGREDIENT_KEYS.has(key)) return { wasteClass: 'pantry', scoreWeight: 0 };
  if (FRIDGE_STAPLE_KEYS.has(key)) return { wasteClass: 'fridge_staple', scoreWeight: 0.3 };
  if (PERISHABLE_INGREDIENT_KEYS.has(key)) return { wasteClass: 'perishable', scoreWeight: 1.0 };
  return { wasteClass: 'specialty', scoreWeight: 0.7 };
}

// ============================================================================
// Shopping overlap analysis
// ============================================================================

function computeShoppingOverlap(
  selectedRecipes: NormalizedRecipe[]
): ShoppingOverlap {
  // Build key → recipeIds map across all selected recipes
  const keyToIds = new Map<string, string[]>();
  for (const norm of selectedRecipes) {
    for (const key of getCanonicalIngredientKeys(norm)) {
      if (!keyToIds.has(key)) keyToIds.set(key, []);
      keyToIds.get(key)!.push(norm.id);
    }
  }

  // Separate shared ingredients by waste class
  const sharedIngredients: SharedIngredient[] = [];
  const pantryOverlaps: Array<{ ingredient: string; recipeIds: string[] }> = [];

  for (const [ingredient, recipeIds] of keyToIds) {
    if (recipeIds.length < 2) continue; // Not shared

    const { wasteClass, scoreWeight } = classifyIngredient(ingredient);
    if (wasteClass === 'pantry') {
      pantryOverlaps.push({ ingredient, recipeIds });
    } else {
      sharedIngredients.push({ ingredient, recipeIds, wasteClass, scoreWeight });
    }
  }

  // Sort by waste relevance: perishable > specialty > fridge_staple, then by count
  const wasteOrder: Record<IngredientWasteClass, number> = {
    perishable: 0,
    specialty: 1,
    fridge_staple: 2,
    pantry: 3,
  };
  sharedIngredients.sort((a, b) => {
    const wDiff = wasteOrder[a.wasteClass] - wasteOrder[b.wasteClass];
    if (wDiff !== 0) return wDiff;
    return b.recipeIds.length - a.recipeIds.length;
  });

  // Waste risk: count perishables NOT shared (high individual waste)
  const perishableNotShared = [...keyToIds.entries()].filter(
    ([key, ids]) => PERISHABLE_INGREDIENT_KEYS.has(key) && ids.length === 1
  ).length;

  let estimatedWasteRisk: ShoppingOverlap['estimatedWasteRisk'];
  if (perishableNotShared <= 2) estimatedWasteRisk = 'low';
  else if (perishableNotShared <= 5) estimatedWasteRisk = 'medium';
  else estimatedWasteRisk = 'high';

  const notes: string[] = [];
  const meaningfulShared = sharedIngredients.filter(
    (s) => s.wasteClass === 'perishable' || s.wasteClass === 'specialty'
  ).length;
  if (meaningfulShared > 0) {
    notes.push(
      `${meaningfulShared} meaningful shared ingredient${meaningfulShared > 1 ? 's' : ''} across recipes — fewer wasted groceries.`
    );
  } else if (sharedIngredients.length > 0) {
    notes.push(
      `${sharedIngredients.length} ingredient${sharedIngredients.length > 1 ? 's' : ''} shared across recipes.`
    );
  }
  if (estimatedWasteRisk === 'high') {
    notes.push('Several perishables are only used in one recipe — consider buying smaller quantities.');
  }
  if (pantryOverlaps.length > 0) {
    notes.push(`${pantryOverlaps.length} pantry staple${pantryOverlaps.length > 1 ? 's' : ''} also overlap (salt, pepper, oils — not counted in waste score).`);
  }

  return { sharedIngredients, pantryOverlaps, estimatedWasteRisk, notes };
}

// ============================================================================
// Plan-level score computation
// ============================================================================

function computePlanLevelScore(
  plan: PartialPlan,
  candidatesBySlot: Map<string, Array<{ recipe: PlannerRecipe; score: CandidateScore }>>,
  request: WeeklyPlanRequest
): { planScore: number; breakdown: Record<string, number> } {
  const breakdown: Record<string, number> = {};
  let planScore = 0;

  const selectedRecipes = [...plan.assignments.values()];

  // Base: sum of per-recipe scores
  let baseScore = 0;
  for (const [slot, recipe] of plan.assignments) {
    const cs = candidatesBySlot.get(slot)?.find((c) => c.recipe.norm.id === recipe.norm.id);
    baseScore += cs?.score.score ?? 0;
  }
  breakdown.recipeScores = baseScore;
  planScore += baseScore;

  // Ingredient overlap
  const overlapCount = [...plan.ingredientKeys.values()].filter((ids) => ids.length >= 2).length;
  const overlapScore = Math.min(overlapCount * OVERLAP_BONUS_PER_KEY, MAX_OVERLAP_BONUS);
  breakdown.ingredientOverlap = overlapScore;
  planScore += overlapScore;

  // Cuisine variety
  const varietyScore = Math.min(plan.cuisines.size * VARIETY_BONUS_PER_CUISINE, MAX_VARIETY_BONUS);
  breakdown.cuisineVariety = varietyScore;
  planScore += varietyScore;

  // Kid-friendly count satisfaction
  if (request.minKidFriendlyMeals) {
    const kidFriendlyCount = selectedRecipes.filter(
      (r) => r.sel.kid_friendly_score >= 0.6
    ).length;
    const satisfied = kidFriendlyCount >= request.minKidFriendlyMeals;
    breakdown.kidFriendlySatisfied = satisfied ? 1.0 : 0.0;
    planScore += breakdown.kidFriendlySatisfied;
  }

  // HelloFresh satisfied
  if (request.requiredSourceSignals?.includes('hellofresh')) {
    const hf = selectedRecipes.some((r) => r.sel.is_hellofresh);
    breakdown.helloFreshSatisfied = hf ? 1.0 : 0.0;
    planScore += breakdown.helloFreshSatisfied;
  }

  // Pasta satisfied
  if (request.requiredTagsOrTitleTerms?.includes('pasta')) {
    const pasta = selectedRecipes.some((r) => r.sel.is_pasta);
    breakdown.pastaSatisfied = pasta ? 0.5 : 0.0;
    planScore += breakdown.pastaSatisfied;
  }

  // Macro average compliance (only for recipes with nutrition data)
  if (request.macroTargets) {
    const withMacros = selectedRecipes.filter(
      (r) => r.sel.macro_pct_protein !== null && r.sel.macro_pct_fat !== null && r.sel.macro_pct_carbs !== null
    );
    if (withMacros.length > 0) {
      const avgProt = withMacros.reduce((a, r) => a + (r.sel.macro_pct_protein ?? 0), 0) / withMacros.length;
      const avgFat = withMacros.reduce((a, r) => a + (r.sel.macro_pct_fat ?? 0), 0) / withMacros.length;

      let macroAvgScore = 0;
      const tp = request.macroTargets.proteinPct;
      if (tp) {
        const ok = (!tp.minPct || avgProt >= tp.minPct) && (!tp.maxPct || avgProt <= tp.maxPct);
        macroAvgScore += ok ? 0.5 : 0;
      }
      const tf = request.macroTargets.fatPct;
      if (tf) {
        const ok = (!tf.minPct || avgFat >= tf.minPct) && (!tf.maxPct || avgFat <= tf.maxPct);
        macroAvgScore += ok ? 0.5 : 0;
      }
      breakdown.macroAvgCompliance = macroAvgScore;
      planScore += macroAvgScore;
    }
  }

  // Variety penalty: discourage repetition of the same recipe type
  if (request.goals.varietyOfFlavors) {
    let varietyPenalty = 0;

    const pastaCount = selectedRecipes.filter((r) => r.sel.is_pasta).length;
    const creamyPastaCount = selectedRecipes.filter(isCreamyPasta).length;

    // Pasta repetition: one pasta is fine (even required), but more is penalized
    if (pastaCount > 1) {
      varietyPenalty += (pastaCount - 1) * 1.0; // was 0.5 — stronger now
    }

    // Extra penalty for repeated creamy pasta specifically
    if (creamyPastaCount > 1) {
      varietyPenalty += (creamyPastaCount - 1) * 0.8;
    }

    // Creamy pasta is particularly incompatible with weight-loss / low-fat goals
    if ((request.goals.weightLoss || request.goals.lowFat) && creamyPastaCount > 0) {
      varietyPenalty += creamyPastaCount * 0.5;
    }

    // Cuisine repetition: penalize >2 recipes from the same cuisine
    const cuisineCounts: Record<string, number> = {};
    for (const r of selectedRecipes) {
      const c = r.norm.cuisine ?? 'unknown';
      cuisineCounts[c] = (cuisineCounts[c] ?? 0) + 1;
    }
    for (const count of Object.values(cuisineCounts)) {
      if (count > 2) varietyPenalty += (count - 2) * 0.4;
    }

    breakdown.varietyPenalty = -varietyPenalty;
    planScore -= varietyPenalty;
  }

  return { planScore, breakdown };
}

// ============================================================================
// Alternatives
// ============================================================================

function buildAlternativeReason(
  candidate: { recipe: PlannerRecipe; score: CandidateScore }
): string {
  const { sel } = candidate.recipe;
  const bd = candidate.score.scoreBreakdown;
  const reasons: string[] = [];

  if (sel.is_hellofresh) reasons.push('HelloFresh');
  if (sel.is_pasta) reasons.push('pasta dish');
  if ((bd.highProtein ?? 0) > 0.7) reasons.push('high protein');
  if ((bd.quickEasy ?? 0) > 0.7) reasons.push('quick & easy');
  if ((bd.kidFriendly ?? 0) > 0.6) reasons.push('kid-friendly');
  if (sel.freezer_friendly === 'yes') reasons.push('freezer-friendly');
  if ((bd.cost ?? 0) > 0.7) reasons.push('budget-friendly');
  if ((bd.preferredIngredients ?? 0) > 0) reasons.push('uses preferred ingredients');

  return reasons.length > 0 ? reasons.join(', ') : 'solid overall fit';
}

function computeAlternatives(
  plan: PartialPlan,
  candidatesBySlot: Map<string, Array<{ recipe: PlannerRecipe; score: CandidateScore }>>,
  maxAlt: number
): PlanAlternative[] {
  const alternatives: PlanAlternative[] = [];
  const selectedIds = new Set([...plan.assignments.values()].map((r) => r.norm.id));

  for (const [slot, candidates] of candidatesBySlot) {
    if (slot === 'flex') continue; // Skip flex pool — too many candidates to list alternatives

    const topCandidates = candidates
      .filter((c) => !selectedIds.has(c.recipe.norm.id))
      .slice(0, maxAlt);

    if (topCandidates.length > 0) {
      const entries: PlanAlternativeEntry[] = topCandidates.map((c) => ({
        id: c.recipe.norm.id,
        title: c.recipe.norm.title,
        reason: buildAlternativeReason(c),
      }));

      alternatives.push({
        slot,
        entries,
        recipeIds: entries.map((e) => e.id), // backward compat
        reason: `Next-best options for the ${slot} slot`,
      });
    }
  }

  return alternatives;
}

// ============================================================================
// Selected-despite-warnings diagnostics
// ============================================================================

/**
 * Identify selected recipes that are a notably poor fit for the requested goals.
 * Used for transparency — tells users why a weak recipe was still picked.
 */
function computeSelectedDespiteWarnings(
  plan: PartialPlan,
  candidatesBySlot: Map<string, Array<{ recipe: PlannerRecipe; score: CandidateScore }>>,
  request: WeeklyPlanRequest,
  selectedRecipes: NormalizedRecipe[]
): Array<{ recipeId: string; title: string; reasons: string[] }> {
  const result: Array<{ recipeId: string; title: string; reasons: string[] }> = [];

  const recipeMap = new Map<string, PlannerRecipe>();
  for (const [, recipe] of plan.assignments) {
    recipeMap.set(recipe.norm.id, recipe);
  }

  for (const norm of selectedRecipes) {
    const plannerRecipe = recipeMap.get(norm.id);
    if (!plannerRecipe) continue;
    const { sel } = plannerRecipe;
    const reasons: string[] = [];

    // Macro fit warnings when targets were requested
    if (request.macroTargets) {
      const { fatPct, proteinPct, carbsPct } = request.macroTargets;

      if (fatPct?.maxPct !== undefined && sel.macro_pct_fat !== null) {
        const miss = sel.macro_pct_fat - fatPct.maxPct;
        if (miss > 10) {
          reasons.push(
            `fat ${sel.macro_pct_fat.toFixed(1)}% is far above requested max ${fatPct.maxPct}%`
          );
        }
      }
      if (fatPct?.minPct !== undefined && sel.macro_pct_fat !== null) {
        const miss = fatPct.minPct - sel.macro_pct_fat;
        if (miss > 5) {
          reasons.push(
            `fat ${sel.macro_pct_fat.toFixed(1)}% is below requested min ${fatPct.minPct}%`
          );
        }
      }
      if (proteinPct?.minPct !== undefined && sel.macro_pct_protein !== null) {
        const miss = proteinPct.minPct - sel.macro_pct_protein;
        if (miss > 8) {
          reasons.push(
            `protein ${sel.macro_pct_protein.toFixed(1)}% is below requested min ${proteinPct.minPct}%`
          );
        }
      }
      if (carbsPct?.minPct !== undefined && sel.macro_pct_carbs !== null) {
        const miss = carbsPct.minPct - sel.macro_pct_carbs;
        if (miss > 10) {
          reasons.push(
            `carbs ${sel.macro_pct_carbs.toFixed(1)}% is below requested min ${carbsPct.minPct}%`
          );
        }
      }
    }

    // Creamy pasta under weight-loss goals
    if (
      (request.goals.weightLoss || request.goals.lowFat) &&
      isCreamyPasta(plannerRecipe)
    ) {
      reasons.push('creamy pasta is a poor fit for weight-loss / low-fat goals');
    }

    if (reasons.length > 0) {
      result.push({ recipeId: norm.id, title: norm.title, reasons });
    }
  }

  return result;
}

// ============================================================================
// Main optimizer entry point
// ============================================================================

/**
 * Build the best weekly plan for the given request using beam search.
 *
 * @param selectionRecords   All SelectionRecords from catalog.selection.jsonl.
 * @param normalizedById     Map from ID → NormalizedRecipe.
 * @param request            The parsed WeeklyPlanRequest.
 * @param maxCandidatesPerSlot  Cap on candidates per slot (default 75).
 */
export function buildWeeklyPlan(
  selectionRecords: SelectionRecord[],
  normalizedById: Map<string, NormalizedRecipe>,
  request: WeeklyPlanRequest,
  maxCandidatesPerSlot = 75
): WeeklyPlanResult {
  // --- 1. Get candidates for all unique slots ---
  const filterResult = getCandidatesForPlan(
    selectionRecords,
    normalizedById,
    request,
    maxCandidatesPerSlot
  );

  // --- 2. Score all candidates per slot ---
  const scoredBySlot = new Map<string, Array<{ recipe: PlannerRecipe; score: CandidateScore }>>();

  // Required protein slots
  for (const slot of [...new Set(request.requiredProteinSlots)]) {
    const candidates = filterResult.candidatesBySlot.get(slot) ?? [];
    const scored = candidates
      .map((recipe) => ({
        recipe,
        score: scoreRecipeForRequest(recipe, request),
      }))
      .filter((c) => c.score.hardConstraintPass)
      .sort((a, b) => b.score.score - a.score.score);
    scoredBySlot.set(slot, scored);
  }

  // Flex slot pool (if requested)
  if ((request.flexMealCount ?? 0) > 0) {
    const flexCandidates = filterResult.candidatesBySlot.get('flex') ?? [];
    const scoredFlex = flexCandidates
      .map((recipe) => ({
        recipe,
        score: scoreRecipeForRequest(recipe, request),
      }))
      .filter((c) => c.score.hardConstraintPass)
      .sort((a, b) => b.score.score - a.score.score);
    scoredBySlot.set('flex', scoredFlex);
  }

  // --- 3. Beam search through slots (required first, then flex) ---
  const slotOrder = [
    ...request.requiredProteinSlots,
    ...Array(request.flexMealCount ?? 0).fill('flex'),
  ];

  let beams: PartialPlan[] = [
    {
      assignments: new Map(),
      score: 0,
      usedIds: new Set(),
      ingredientKeys: new Map(),
      cuisines: new Set(),
    },
  ];

  for (const slot of slotOrder) {
    const candidates = scoredBySlot.get(slot) ?? [];
    const nextBeams: PartialPlan[] = [];

    for (const beam of beams) {
      for (const { recipe, score: candidateScore } of candidates) {
        if (beam.usedIds.has(recipe.norm.id)) continue;

        const { newPlan } = addRecipeToPartialPlan(beam, slot, recipe, candidateScore);
        nextBeams.push(newPlan);
      }
    }

    // Keep top BEAM_WIDTH beams; if no candidates, keep existing beams (slot will be missing)
    if (nextBeams.length > 0) {
      beams = nextBeams.sort((a, b) => b.score - a.score).slice(0, BEAM_WIDTH);
    }
    // If nextBeams is empty, slot had no candidates — beams remain but slot is unassigned
  }

  // --- 4. Take best beam and enforce required singletons ---
  let bestPlan = beams[0] ?? {
    assignments: new Map(),
    score: 0,
    usedIds: new Set(),
    ingredientKeys: new Map(),
    cuisines: new Set(),
  };

  const { plan: finalPlan, warnings: singletonWarnings } = enforceRequiredSingletons(
    bestPlan,
    scoredBySlot,
    request
  );
  bestPlan = finalPlan;

  // --- 4b. Flex deduplication: if the flex slot has pasta and pasta is already
  //         satisfied by a required slot, try to swap it for a non-pasta alternative
  //         when variety is requested. ---
  if (
    (request.flexMealCount ?? 0) > 0 &&
    request.goals.varietyOfFlavors &&
    request.requiredTagsOrTitleTerms?.includes('pasta')
  ) {
    const slotKeys = [...bestPlan.assignments.keys()];
    const flexSlotKeys = slotKeys.filter((s) => s === 'flex' || s.startsWith('flex'));
    const nonFlexSlotKeys = slotKeys.filter((s) => s !== 'flex' && !s.startsWith('flex'));
    const pastaInRequired = nonFlexSlotKeys.some((s) => bestPlan.assignments.get(s)?.sel.is_pasta);

    if (pastaInRequired) {
      for (const flexKey of flexSlotKeys) {
        const currentFlex = bestPlan.assignments.get(flexKey);
        if (currentFlex?.sel.is_pasta) {
          // Try to find a non-pasta flex candidate not already in plan
          const flexCandidates = scoredBySlot.get('flex') ?? [];
          const betterFlex = flexCandidates.find(
            (c) => !c.recipe.sel.is_pasta && !bestPlan.usedIds.has(c.recipe.norm.id)
          );
          if (betterFlex) {
            const swapped = clonePartialPlan(bestPlan);
            swapped.usedIds.delete(currentFlex.norm.id);
            swapped.assignments.set(flexKey, betterFlex.recipe);
            swapped.usedIds.add(betterFlex.recipe.norm.id);
            bestPlan = swapped;
          }
        }
      }
    }
  }

  // --- 5. Compute full plan-level score ---
  const { planScore, breakdown: planBreakdown } = computePlanLevelScore(
    bestPlan,
    scoredBySlot,
    request
  );

  // --- 6. Assemble output ---
  const selectedRecipes = [...bestPlan.assignments.values()].map((r) => r.norm);
  const selectedRecipeIds = selectedRecipes.map((r) => r.id);

  // Shopping overlap
  const shoppingOverlap = computeShoppingOverlap(selectedRecipes);

  // Alternatives (next-best per slot)
  const maxAlt = request.maxResults ?? 3;
  const alternatives = computeAlternatives(bestPlan, scoredBySlot, maxAlt);

  // --- 7. Validate ---
  const validation = validatePlanResult(
    selectedRecipeIds,
    selectedRecipes,
    normalizedById,
    request,
    singletonWarnings
  );

  // Add empty-slot warnings
  for (const emptySlot of filterResult.emptySlots) {
    validation.warnings.push(
      `No candidates found for slot '${emptySlot}'. ` +
      'This slot is missing from the plan. Add more recipes in this category and rebuild.'
    );
    validation.structuralConstraintsSatisfied = false;
    validation.hardConstraintsSatisfied = false;
    validation.failedConstraints.push(`empty_slot:${emptySlot}`);
  }

  // --- 8. Diagnose weak selections ---
  const selectedDespiteWarnings = computeSelectedDespiteWarnings(
    bestPlan,
    scoredBySlot,
    request,
    selectedRecipes
  );

  return {
    request,
    selectedRecipeIds,
    selectedRecipes,
    planScore,
    planScoreBreakdown: planBreakdown,
    shoppingOverlap,
    validation,
    alternatives,
    selectedDespiteWarnings: selectedDespiteWarnings.length > 0 ? selectedDespiteWarnings : undefined,
  };
}
