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
  PreferredIngredientCoverage,
  RequestFitSummary,
  SuggestedSwap,
} from './types.js';
import type { NormalizedRecipe } from '../types.js';
import type { SelectionRecord } from '../selection-index.js';
import { getCandidatesForPlan, hasSourceSignal, hasTagOrTitleTerm } from './candidate-filter.js';
import { scoreRecipeForRequest, getCanonicalIngredientKeys, computeCheeseScore } from './scoring.js';
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
// Singleton enforcement (HelloFresh, pasta, kid-friendly)
// ============================================================================

const KID_FRIENDLY_THRESHOLD = 0.6;

/**
 * Find the best slot to swap a singleton candidate into.
 *
 * Searches each plan slot's OWN candidate pool to ensure the replacement is
 * slot-compatible (e.g., a chicken recipe never ends up in the vegetarian slot).
 * Among all slots that have a valid replacement, prefer the one with the
 * lowest-scoring current recipe so we lose the least by swapping.
 */
function findBestSingletonSwap(
  plan: PartialPlan,
  candidatesBySlot: Map<string, Array<{ recipe: PlannerRecipe; score: CandidateScore }>>,
  predicate: (c: { recipe: PlannerRecipe; score: CandidateScore }) => boolean,
  skipCurrentPredicate?: (current: PlannerRecipe) => boolean
): { slot: string; candidate: { recipe: PlannerRecipe; score: CandidateScore }; currentScore: number } | null {
  const options: Array<{
    slot: string;
    candidate: { recipe: PlannerRecipe; score: CandidateScore };
    currentScore: number;
  }> = [];

  for (const [slot, candidates] of candidatesBySlot) {
    const current = plan.assignments.get(slot);
    if (!current) continue; // Only look at slots that are actually assigned in the plan
    if (skipCurrentPredicate && skipCurrentPredicate(current)) continue; // e.g., skip already-kid-friendly slots
    const replacement = candidates.find((c) => !plan.usedIds.has(c.recipe.norm.id) && predicate(c));
    if (!replacement) continue;
    const currentScore =
      candidates.find((c) => c.recipe.norm.id === current.norm.id)?.score.score ?? 0;
    options.push({ slot, candidate: replacement, currentScore });
  }

  if (options.length === 0) return null;
  // Prefer to swap out the lowest-scoring current recipe
  return options.sort((a, b) => a.currentScore - b.currentScore)[0];
}

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

  // ---- Pasta requirement ----
  if (request.requiredTagsOrTitleTerms?.includes('pasta')) {
    const hasPasta = [...plan.assignments.values()].some((r) => r.sel.is_pasta);
    if (!hasPasta) {
      const swap = findBestSingletonSwap(
        plan, candidatesBySlot,
        (c) => c.recipe.sel.is_pasta
      );
      if (swap) {
        const { slot, candidate } = swap;
        const removedId = plan.assignments.get(slot)?.norm.id;
        plan = clonePartialPlan(plan);
        plan.assignments.set(slot, candidate.recipe);
        if (removedId) plan.usedIds.delete(removedId);
        plan.usedIds.add(candidate.recipe.norm.id);
      } else {
        warnings.push(
          'Pasta requirement: no pasta recipes found in the candidate pools. ' +
          'The plan was built without a pasta dish.'
        );
      }
    }
  }

  // ---- Cuisine requirements (e.g. "cuisine:mexican") ----
  const cuisineRequirements = (request.requiredTagsOrTitleTerms ?? [])
    .filter((t) => t.startsWith('cuisine:'))
    .map((t) => t.slice('cuisine:'.length));

  for (const cuisine of cuisineRequirements) {
    const hasCuisine = [...plan.assignments.values()].some((r) => {
      return (
        r.norm.cuisine?.toLowerCase().includes(cuisine) ||
        r.norm.title.toLowerCase().includes(cuisine) ||
        r.sel.tags.some((tag) => tag.toLowerCase().includes(cuisine))
      );
    });

    if (!hasCuisine) {
      const swap = findBestSingletonSwap(
        plan, candidatesBySlot,
        (c) =>
          (c.recipe.norm.cuisine?.toLowerCase().includes(cuisine) ||
            c.recipe.norm.title.toLowerCase().includes(cuisine) ||
            c.recipe.sel.tags.some((tag) => tag.toLowerCase().includes(cuisine))) ?? false
      );
      if (swap) {
        const { slot, candidate } = swap;
        const removedId = plan.assignments.get(slot)?.norm.id;
        plan = clonePartialPlan(plan);
        plan.assignments.set(slot, candidate.recipe);
        if (removedId) plan.usedIds.delete(removedId);
        plan.usedIds.add(candidate.recipe.norm.id);
      } else {
        warnings.push(
          `Cuisine requirement "${cuisine}": no ${cuisine} recipes found in any candidate pool. ` +
          'The plan was built without this cuisine.'
        );
      }
    }
  }

  // ---- Kid-friendly minimum ----
  // Post-hoc: if beam search didn't naturally select enough kid-friendly recipes,
  // swap in kid-friendly candidates (within their own slot pools, preserving compatibility).
  if (request.minKidFriendlyMeals && request.minKidFriendlyMeals > 0) {
    let kidCount = [...plan.assignments.values()].filter(
      (r) => r.sel.kid_friendly_score >= KID_FRIENDLY_THRESHOLD
    ).length;


    while (kidCount < request.minKidFriendlyMeals) {
      const swap = findBestSingletonSwap(
        plan,
        candidatesBySlot,
        (c) => c.recipe.sel.kid_friendly_score >= KID_FRIENDLY_THRESHOLD,
        // Skip slots whose current recipe is already kid-friendly
        (current) => current.sel.kid_friendly_score >= KID_FRIENDLY_THRESHOLD
      );

      if (!swap) break; // No more kid-friendly candidates available
      const { slot, candidate } = swap;
      const removedId = plan.assignments.get(slot)?.norm.id;
      plan = clonePartialPlan(plan);
      plan.assignments.set(slot, candidate.recipe);
      if (removedId) plan.usedIds.delete(removedId);
      plan.usedIds.add(candidate.recipe.norm.id);
      kidCount++;
    }

    if (kidCount < request.minKidFriendlyMeals) {
      warnings.push(
        `Kid-friendly minimum: could only find ${kidCount} of ${request.minKidFriendlyMeals} ` +
        `kid-friendly recipes (score ≥ ${KID_FRIENDLY_THRESHOLD}) in the candidate pools.`
      );
    }
  }

  // ---- HelloFresh requirement (runs LAST so it isn't undone by other enforcement) ----
  if (request.requiredSourceSignals?.includes('hellofresh')) {
    const hasHF = [...plan.assignments.values()].some((r) => r.sel.is_hellofresh);
    if (!hasHF) {
      // Prefer swapping a non-kid-friendly slot so we don't undo kid-friendly enforcement
      const kidFriendlyMealsNeeded = request.minKidFriendlyMeals ?? 0;
      const currentKidCount = [...plan.assignments.values()].filter(
        (r) => r.sel.kid_friendly_score >= KID_FRIENDLY_THRESHOLD
      ).length;
      const skipKidFriendlySlots = currentKidCount <= kidFriendlyMealsNeeded;

      const swap = findBestSingletonSwap(
        plan, candidatesBySlot,
        (c) => c.recipe.sel.is_hellofresh,
        // If we've exactly met kid-friendly requirement, avoid displacing kid-friendly recipes
        skipKidFriendlySlots
          ? (current) => current.sel.kid_friendly_score >= KID_FRIENDLY_THRESHOLD
          : undefined
      );
      if (swap) {
        const { slot, candidate } = swap;
        const removedId = plan.assignments.get(slot)?.norm.id;
        plan = clonePartialPlan(plan);
        plan.assignments.set(slot, candidate.recipe);
        if (removedId) plan.usedIds.delete(removedId);
        plan.usedIds.add(candidate.recipe.norm.id);
      } else {
        warnings.push(
          'HelloFresh requirement: no HelloFresh recipes found in any candidate pool. ' +
          'Check that your catalog contains HelloFresh recipes (run "recipe-context build" to refresh).'
        );
      }
    }
  }

  // ---- Pasta concentration limiter (cap at max 2 pasta dishes) ----
  {
    const MAX_PASTA = 2;
    const pastaEntries = [...plan.assignments.entries()].filter(([, r]) => r.sel.is_pasta);
    if (pastaEntries.length > MAX_PASTA) {
      const pastaRequired = request.requiredTagsOrTitleTerms?.includes('pasta') ?? false;
      const requiredSrcSignals = request.requiredSourceSignals ?? [];

      // Sort pasta dishes by score ascending (swap lowest-scoring ones first)
      const sortedPasta = pastaEntries
        .map(([slot, recipe]) => {
          const slotScore =
            candidatesBySlot
              .get(slot)
              ?.find((c) => c.recipe.norm.id === recipe.norm.id)?.score.score ?? 0;
          return { slot, recipe, slotScore };
        })
        .sort((a, b) => a.slotScore - b.slotScore);

      let pastaCount = pastaEntries.length;
      for (const { slot, recipe } of sortedPasta) {
        if (pastaCount <= MAX_PASTA) break;

        // Never remove our only HelloFresh dish if HF is required
        if (recipe.sel.is_hellofresh && requiredSrcSignals.includes('hellofresh')) {
          const otherHF = [...plan.assignments.values()].filter(
            (r) => r.sel.is_hellofresh && r.norm.id !== recipe.norm.id
          );
          if (otherHF.length === 0) continue;
        }

        // Never remove the last pasta if pasta is required
        if (pastaRequired && pastaCount <= 1) continue;

        const candidates = candidatesBySlot.get(slot) ?? [];
        const alt = candidates.find(
          (c) => !c.recipe.sel.is_pasta && !plan.usedIds.has(c.recipe.norm.id)
        );
        if (alt) {
          const removedId = plan.assignments.get(slot)?.norm.id;
          plan = clonePartialPlan(plan);
          plan.assignments.set(slot, alt.recipe);
          if (removedId) plan.usedIds.delete(removedId);
          plan.usedIds.add(alt.recipe.norm.id);
          pastaCount--;
        }
      }
    }
  }

  return { plan, warnings };
}

/**
 * Prevent any single recipe source from dominating the plan.
 * If a source accounts for more than half the selected recipes (and it wasn't
 * explicitly required), swap the lowest-scoring excess recipes with the best
 * available alternatives from different sources.
 */
function enforceSourceDiversity(
  plan: PartialPlan,
  candidatesBySlot: Map<string, Array<{ recipe: PlannerRecipe; score: CandidateScore }>>,
  request: WeeklyPlanRequest
): PartialPlan {
  const totalSlots = plan.assignments.size;
  if (totalSlots <= 2) return plan; // No point diversifying tiny plans

  // Max allowed from any one source: floor(total/2), minimum 2
  const maxFromOneSource = Math.max(2, Math.floor(totalSlots / 2));

  // Detect required sources (shouldn't be diversity-penalised)
  const requiredSources = new Set<string>(
    (request.requiredSourceSignals ?? []).map((s) => s.toLowerCase())
  );

  // Count how many times each source_normalized appears in current plan
  for (let pass = 0; pass < totalSlots; pass++) {
    const sourceCounts = new Map<string, string[]>(); // source → array of slot keys
    for (const [slot, recipe] of plan.assignments) {
      // Use a per-recipe fallback for null sources so they don't all group together
      const src = recipe.norm.source_name ?? recipe.sel.source_normalized ?? `_unknown_${recipe.norm.id}`;
      if (!sourceCounts.has(src)) sourceCounts.set(src, []);
      sourceCounts.get(src)!.push(slot);
    }

    let swapped = false;
    for (const [src, slots] of sourceCounts) {
      const srcLower = src.toLowerCase();
      if (slots.length <= maxFromOneSource) continue;
      // Use partial match so "hellofresh.co.uk" is recognized when "hellofresh" is required
      if ([...requiredSources].some((req) => srcLower.includes(req))) continue;

      // Find the slot with the worst-scoring recipe from this over-represented source
      const slotsByScore = slots
        .map((slot) => {
          const recipe = plan.assignments.get(slot)!;
          const slotScore = candidatesBySlot
            .get(slot)
            ?.find((c) => c.recipe.norm.id === recipe.norm.id)?.score.score ?? 0;
          return { slot, recipe, slotScore };
        })
        .sort((a, b) => a.slotScore - b.slotScore); // worst first

      // Current kid-friendly count (needed to avoid violating minKidFriendlyMeals)
      const kidFriendlyMin = request.minKidFriendlyMeals ?? 0;
      const currentKidCount = [...plan.assignments.values()].filter(
        (r) => r.sel.kid_friendly_score >= KID_FRIENDLY_THRESHOLD
      ).length;

      // Try to swap the worst-scoring same-source recipe with the best alternative
      // from a different source
      for (const { slot, recipe: worstRecipe } of slotsByScore) {
        const isKidFriendly = worstRecipe.sel.kid_friendly_score >= KID_FRIENDLY_THRESHOLD;
        const wouldViolateKidMin = isKidFriendly && currentKidCount <= kidFriendlyMin;

        const candidates = candidatesBySlot.get(slot) ?? [];

        // If swapping this recipe would drop below minKidFriendlyMeals, require
        // the replacement to also be kid-friendly
        const alternative = wouldViolateKidMin
          ? candidates.find(
              (c) =>
                !plan.usedIds.has(c.recipe.norm.id) &&
                (c.recipe.norm.source_name ?? c.recipe.sel.source_normalized ?? '') !== src &&
                c.recipe.sel.kid_friendly_score >= KID_FRIENDLY_THRESHOLD
            ) ??
            candidates.find(
              // Fallback: skip this slot entirely (alternative will be undefined if no kf replacement)
              (_c) => false
            )
          : candidates.find(
              (c) =>
                !plan.usedIds.has(c.recipe.norm.id) &&
                (c.recipe.norm.source_name ?? c.recipe.sel.source_normalized ?? '') !== src
            );
        if (alternative) {
          plan = clonePartialPlan(plan);
          plan.usedIds.delete(worstRecipe.norm.id);
          plan.assignments.set(slot, alternative.recipe);
          plan.usedIds.add(alternative.recipe.norm.id);
          swapped = true;
          break;
        }
      }
      if (swapped) break; // Re-evaluate counts from scratch
    }
    if (!swapped) break; // No more swaps needed
  }

  return plan;
}

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

  // Variety penalty: discourage repetition of the same recipe type.
  // Always applied under health/diet goals; additionally applied when varietyOfFlavors is set.
  const hasHealthGoal =
    request.goals.weightLoss ||
    request.goals.highProtein ||
    request.goals.lowFat ||
    request.goals.varietyOfFlavors;

  if (hasHealthGoal) {
    let varietyPenalty = 0;

    const pastaCount = selectedRecipes.filter((r) => r.sel.is_pasta).length;
    const creamyPastaCount = selectedRecipes.filter(isCreamyPasta).length;

    // Pasta repetition: one pasta is fine (even required), but more is penalized.
    // The penalty is stronger under weight-loss / high-protein goals.
    const pastaRepeatPenalty = (request.goals.weightLoss || request.goals.highProtein || request.goals.lowFat)
      ? 1.5
      : 1.0;
    if (pastaCount > 1) {
      varietyPenalty += (pastaCount - 1) * pastaRepeatPenalty;
    }

    // Extra penalty for repeated creamy pasta specifically
    if (creamyPastaCount > 1) {
      varietyPenalty += (creamyPastaCount - 1) * 1.2;
    }

    // Creamy pasta is particularly incompatible with weight-loss / low-fat goals
    if ((request.goals.weightLoss || request.goals.lowFat) && creamyPastaCount > 0) {
      varietyPenalty += creamyPastaCount * 0.8;
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
    // Skip flex slots — too many candidates to list alternatives
    if (slot === 'flex' || slot.startsWith('flex_')) continue;

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
// Flex variety enforcement
// ============================================================================

/**
 * Post-hoc: if a flex slot repeats a protein category already covered by required
 * slots, try to swap it for a candidate with a different protein type.
 * This improves variety without interfering with required slot satisfaction.
 */
function enforceFlexVariety(
  plan: PartialPlan,
  candidatesBySlot: Map<string, Array<{ recipe: PlannerRecipe; score: CandidateScore }>>,
  request?: WeeklyPlanRequest,
): PartialPlan {
  // Proteins covered by required (non-flex) slots
  const requiredProteins = new Set<string>();
  for (const [slot, recipe] of plan.assignments) {
    if (!slot.startsWith('flex')) {
      requiredProteins.add(recipe.sel.primary_protein);
    }
  }
  if (requiredProteins.size === 0) return plan;

  // Collect all flex slot keys in the plan
  const flexSlotKeys = [...plan.assignments.keys()].filter((s) => s.startsWith('flex'));

  // Priority order for flex protein diversity (seafood and plant proteins score highest)
  const DIVERSE_PROTEIN_RANK: Record<string, number> = {
    fish: 10,
    seafood: 10,
    shrimp: 10,
    tofu: 9,
    tempeh: 9,
    seitan: 8,
    lentils: 8,
    beans: 7,
    chickpeas: 7,
    legumes: 7,
    lamb: 5,
    turkey: 5,
    duck: 5,
  };

  for (const flexSlot of flexSlotKeys) {
    const current = plan.assignments.get(flexSlot);
    if (!current) continue;

    // If this flex recipe uses a protein already in required slots, try to diversify
    if (!requiredProteins.has(current.sel.primary_protein)) continue;

    // Look for a scored flex candidate with a different protein, not already used.
    // Prefer candidates with diverse (seafood/plant) proteins using DIVERSE_PROTEIN_RANK.
    const flexCandidates = candidatesBySlot.get(flexSlot) ?? candidatesBySlot.get('flex_0') ?? [];

    // Guard: if swapping the current flex recipe would drop below minKidFriendlyMeals,
    // require the replacement to also be kid-friendly.
    const kidMin = request?.minKidFriendlyMeals ?? 0;
    const currentKidCount = [...plan.assignments.values()].filter(
      (r) => r.sel.kid_friendly_score >= KID_FRIENDLY_THRESHOLD
    ).length;
    const isCurrentKidFriendly = current.sel.kid_friendly_score >= KID_FRIENDLY_THRESHOLD;
    const requireKidFriendlyReplacement = isCurrentKidFriendly && currentKidCount <= kidMin;

    const alternatives = flexCandidates.filter(
      (c) =>
        !plan.usedIds.has(c.recipe.norm.id) &&
        !requiredProteins.has(c.recipe.sel.primary_protein) &&
        (!requireKidFriendlyReplacement || c.recipe.sel.kid_friendly_score >= KID_FRIENDLY_THRESHOLD)
    );

    if (alternatives.length === 0) continue;

    // Prefer diverse proteins; break ties by candidate score descending
    alternatives.sort((a, b) => {
      const rankA = DIVERSE_PROTEIN_RANK[a.recipe.sel.primary_protein ?? ''] ?? 0;
      const rankB = DIVERSE_PROTEIN_RANK[b.recipe.sel.primary_protein ?? ''] ?? 0;
      if (rankB !== rankA) return rankB - rankA;
      return (b.score.score ?? 0) - (a.score.score ?? 0);
    });

    const best = alternatives[0];
    plan = clonePartialPlan(plan);
    plan.usedIds.delete(current.norm.id);
    plan.assignments.set(flexSlot, best.recipe);
    plan.usedIds.add(best.recipe.norm.id);
  }

  return plan;
}

// ============================================================================
// Preferred ingredient coverage
// ============================================================================

function computePreferredIngredientCoverage(
  selectedRecipes: NormalizedRecipe[],
  preferredIngredients: string[]
): PreferredIngredientCoverage {
  if (preferredIngredients.length === 0) {
    return { matched: [], missing: [], coverageScore: 1.0 };
  }

  // Build a single text blob from all selected recipe ingredients
  const allIngText = selectedRecipes
    .flatMap((r) =>
      r.ingredients.map((i) => i.ingredient.toLowerCase() + ' ' + i.original.toLowerCase())
    )
    .join(' ');

  const matched: string[] = [];
  const missing: string[] = [];

  for (const pref of preferredIngredients) {
    if (allIngText.includes(pref.toLowerCase())) {
      matched.push(pref);
    } else {
      missing.push(pref);
    }
  }

  return {
    matched,
    missing,
    coverageScore: matched.length / preferredIngredients.length,
  };
}

// ============================================================================
// Request fit summary
// ============================================================================

function averageNonNull(values: (number | null)[]): number | null {
  const valid = values.filter((v): v is number => v !== null);
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function computeRequestFitSummary(
  request: WeeklyPlanRequest,
  selectedRecipes: NormalizedRecipe[],
  validation: WeeklyPlanResult['validation'],
  coverage: PreferredIngredientCoverage,
  selectedDespiteWarnings: WeeklyPlanResult['selectedDespiteWarnings']
): RequestFitSummary {
  const strongMatches: string[] = [];
  const weakSpots: string[] = [];
  const suggestedImprovements: string[] = [];

  // --- Structural constraints ---
  if (validation.structuralConstraintsSatisfied) {
    if (request.requiredProteinSlots.length > 0) {
      strongMatches.push('All required protein slots filled');
    } else if (request.allMustMatchTerms?.length) {
      const termLabel = request.allMustMatchTerms.join(' + ');
      strongMatches.push(`${selectedRecipes.length} ${termLabel} recipes selected`);
    } else {
      strongMatches.push(`${selectedRecipes.length} flex recipes selected`);
    }
  } else {
    for (const fc of validation.failedConstraints) {
      weakSpots.push(`Constraint failed: ${fc}`);
    }
  }

  // --- Dish-type constraint summary (allMustMatchTerms) ---
  if (request.allMustMatchTerms?.length) {
    const terms = request.allMustMatchTerms;
    const matchCount = selectedRecipes.filter((r) => {
      const title = r.title.toLowerCase();
      const tags = r.tags.map((t) => t.toLowerCase());
      return terms.every((term) =>
        title.includes(term.toLowerCase()) ||
        tags.some((tag) => tag.includes(term.toLowerCase()))
      );
    }).length;
    const total = selectedRecipes.length;
    const termLabel = terms.join(' + ');
    if (matchCount < total) {
      weakSpots.push(
        `Dish-type filter: only ${matchCount} of ${total} recipes matched "${termLabel}". ` +
        `Your catalog may have limited ${termLabel} recipes.`
      );
    }
  }

  // --- Per-recipe preferences (e.g. cheesy) ---
  if (request.perRecipePreferences?.includes('cheesy')) {
    const cheeseScores = selectedRecipes.map((r) => computeCheeseScore(r));
    const strongCount = cheeseScores.filter((s) => s >= 0.4).length;
    const total = selectedRecipes.length;
    if (strongCount >= total) {
      strongMatches.push(`Cheesy preference: all ${total} recipes are meaningfully cheesy`);
    } else if (strongCount >= Math.ceil(total * 0.6)) {
      weakSpots.push(`Cheesy preference: ${strongCount} of ${total} recipes are meaningfully cheesy`);
      suggestedImprovements.push(
        'Look for recipes with feta, cheddar, ricotta, or cheese sauce as a core ingredient'
      );
    } else {
      weakSpots.push(
        `Cheesy preference poorly met: only ${strongCount} of ${total} recipes are meaningfully cheesy`
      );
      suggestedImprovements.push(
        'Look for recipes with feta, cheddar, ricotta, or cheese sauce as a core ingredient'
      );
    }
  }

  // --- Macro targets ---
  if (request.macroTargets) {
    if (validation.nutritionEvaluationStatus === 'met') {
      strongMatches.push('Macro targets met on average');
    } else if (validation.nutritionEvaluationStatus === 'failed') {
      weakSpots.push('Macro targets not fully met');
      suggestedImprovements.push(
        'Add more recipes with complete nutrition data or adjust macro ranges'
      );
    } else if (validation.nutritionEvaluationStatus === 'partial') {
      weakSpots.push('Macro evaluation is partial — some recipes lack complete nutrition data');
    }
  }

  // --- Protein quality (weight loss / high-protein goals) ---
  if (request.goals.weightLoss || request.goals.highProtein) {
    const avgProteinPct = averageNonNull(
      selectedRecipes.map((r) =>
        r.nutrition?.protein_g != null && r.nutrition?.calories != null && r.nutrition.calories > 0
          ? (r.nutrition.protein_g * 4 / r.nutrition.calories) * 100
          : null
      )
    );
    if (avgProteinPct !== null) {
      if (avgProteinPct >= 25) {
        strongMatches.push(`High-protein plan: avg ${avgProteinPct.toFixed(0)}% protein`);
      } else {
        weakSpots.push(
          `Protein content low: avg ${avgProteinPct.toFixed(0)}% (target ≥25%)`
        );
        suggestedImprovements.push(
          'Swap the lowest-protein recipe for a chicken breast, fish, or legume dish'
        );
      }
    }
  }

  // --- Preferred ingredient coverage ---
  if (request.preferredIngredients.length > 0) {
    if (coverage.coverageScore >= 0.75) {
      strongMatches.push(
        `Preferred ingredients: ${Math.round(coverage.coverageScore * 100)}% covered`
      );
    } else {
      const missingPreview = coverage.missing.slice(0, 3).join(', ');
      weakSpots.push(`Preferred ingredients not found: ${missingPreview}`);
      if (coverage.missing.length > 0) {
        suggestedImprovements.push(
          `Look for recipes that include: ${coverage.missing[0]}`
        );
      }
    }
  }

  // --- Kid-friendly minimum ---
  if (request.minKidFriendlyMeals) {
    const kidCount = selectedRecipes.filter((r) => r.kid_friendly_score >= 0.6).length;
    if (kidCount >= request.minKidFriendlyMeals) {
      strongMatches.push(`Kid-friendly: ${kidCount} of ${request.minKidFriendlyMeals} required`);
    } else {
      weakSpots.push(
        `Kid-friendly: only ${kidCount} of ${request.minKidFriendlyMeals} requested`
      );
    }
  }

  // --- Freezer-friendly goal ---
  if (request.goals.freezerFriendly) {
    const freezerCount = selectedRecipes.filter(
      (r) => r.tags?.includes('freezer_friendly') ?? false
    ).length;
    if (freezerCount >= Math.ceil(selectedRecipes.length / 2)) {
      strongMatches.push(`Freezer-friendly: ${freezerCount} of ${selectedRecipes.length} recipes`);
    } else if (freezerCount === 0) {
      weakSpots.push('No recipes confirmed freezer-friendly');
    }
  }

  // --- Weak selections ---
  if (selectedDespiteWarnings && selectedDespiteWarnings.length > 0) {
    for (const w of selectedDespiteWarnings) {
      weakSpots.push(`"${w.title}": ${w.reasons[0]}`);
    }
    if (selectedDespiteWarnings.length === 1) {
      suggestedImprovements.push(
        `Consider swapping "${selectedDespiteWarnings[0].title}" for a better-fitting recipe`
      );
    } else {
      suggestedImprovements.push(
        `${selectedDespiteWarnings.length} recipes have goal-fit issues — see alternatives below`
      );
    }
  }

  // --- Overall label ---
  let overallFitLabel: RequestFitSummary['overallFitLabel'];
  if (weakSpots.length === 0 && validation.structuralConstraintsSatisfied) {
    overallFitLabel = 'excellent';
  } else if (weakSpots.length <= 1) {
    overallFitLabel = 'good';
  } else if (weakSpots.length <= 3) {
    overallFitLabel = 'fair';
  } else {
    overallFitLabel = 'weak';
  }

  return { overallFitLabel, strongMatches, weakSpots, suggestedImprovements };
}

// ============================================================================
// Suggested swaps
// ============================================================================

/**
 * Generate targeted swap suggestions for the weakest-fit recipes in the plan.
 * Uses the alternatives computed per slot as the candidate pool.
 */
function computeSuggestedSwaps(
  plan: PartialPlan,
  candidatesBySlot: Map<string, Array<{ recipe: PlannerRecipe; score: CandidateScore }>>,
  selectedDespiteWarnings: WeeklyPlanResult['selectedDespiteWarnings']
): SuggestedSwap[] {
  if (!selectedDespiteWarnings || selectedDespiteWarnings.length === 0) return [];

  const swaps: SuggestedSwap[] = [];

  for (const warning of selectedDespiteWarnings) {
    // Find which slot this recipe is in
    let slot: string | undefined;
    for (const [s, r] of plan.assignments) {
      if (r.norm.id === warning.recipeId) {
        slot = s;
        break;
      }
    }
    if (!slot) continue;

    // Find the best non-selected alternative from this slot's candidates
    const candidates = candidatesBySlot.get(slot) ?? [];
    const currentCandidateScore = candidates.find(
      (c) => c.recipe.norm.id === warning.recipeId
    )?.score.score ?? 0;

    const selectedIds = new Set([...plan.assignments.values()].map((r) => r.norm.id));
    const alternative = candidates.find(
      (c) => !selectedIds.has(c.recipe.norm.id)
    );

    if (alternative) {
      swaps.push({
        replaceRecipeId: warning.recipeId,
        replaceTitle: warning.title,
        replacementRecipeId: alternative.recipe.norm.id,
        replacementTitle: alternative.recipe.norm.title,
        reasons: warning.reasons,
        scoreDelta: alternative.score.score - currentCandidateScore,
      });
    }
  }

  return swaps;
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

      if (fatPct?.maxPct != null && sel.macro_pct_fat !== null) {
        const miss = sel.macro_pct_fat - fatPct.maxPct;
        if (miss > 10) {
          reasons.push(
            `fat ${sel.macro_pct_fat.toFixed(1)}% is far above requested max ${fatPct.maxPct}%`
          );
        }
      }
      if (fatPct?.minPct != null && sel.macro_pct_fat !== null) {
        const miss = fatPct.minPct - sel.macro_pct_fat;
        if (miss > 5) {
          reasons.push(
            `fat ${sel.macro_pct_fat.toFixed(1)}% is below requested min ${fatPct.minPct}%`
          );
        }
      }
      if (proteinPct?.minPct != null && sel.macro_pct_protein !== null) {
        const miss = proteinPct.minPct - sel.macro_pct_protein;
        if (miss > 8) {
          reasons.push(
            `protein ${sel.macro_pct_protein.toFixed(1)}% is below requested min ${proteinPct.minPct}%`
          );
        }
      }
      if (carbsPct?.minPct != null && sel.macro_pct_carbs !== null) {
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
  // Each flex slot gets a unique key ('flex_0', 'flex_1', ...) so multiple flex
  // meals can coexist in the same assignments Map without overwriting each other.
  const flexSlotKeys = Array.from(
    { length: request.flexMealCount ?? 0 },
    (_, i) => `flex_${i}`
  );
  if (flexSlotKeys.length > 0) {
    const flexCandidates = filterResult.candidatesBySlot.get('flex') ?? [];
    const scoredFlex = flexCandidates
      .map((recipe) => ({
        recipe,
        score: scoreRecipeForRequest(recipe, request),
      }))
      .filter((c) => c.score.hardConstraintPass)
      .sort((a, b) => b.score.score - a.score.score);
    // Point every flex_N key to the same scored pool
    for (const flexKey of flexSlotKeys) {
      scoredBySlot.set(flexKey, scoredFlex);
    }
  }

  // --- 3. Beam search through slots (required first, then flex) ---
  // Build unique keys for protein slots so duplicate types (e.g. ['chicken','chicken','chicken'])
  // don't overwrite each other in the assignments Map. Mirrors how flex slots work.
  const proteinSlotKeys = request.requiredProteinSlots.map((slot, i) => {
    const priorCount = request.requiredProteinSlots.slice(0, i).filter((s) => s === slot).length;
    const totalCount = request.requiredProteinSlots.filter((s) => s === slot).length;
    return totalCount > 1 ? `${slot}_${priorCount}` : slot;
  });
  // Point each unique key to the same scored pool as the base protein type
  for (let i = 0; i < proteinSlotKeys.length; i++) {
    const key = proteinSlotKeys[i];
    const baseSlot = request.requiredProteinSlots[i];
    if (key !== baseSlot) {
      scoredBySlot.set(key, scoredBySlot.get(baseSlot) ?? []);
    }
  }

  const slotOrder = [
    ...proteinSlotKeys,
    ...flexSlotKeys,
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

  // --- 4c. Source diversity: cap over-represented sources ---
  bestPlan = enforceSourceDiversity(bestPlan, scoredBySlot, request);

  // --- 4b. Flex deduplication: if the flex slot has pasta and pasta is already
  //         satisfied by a required slot, try to swap it for a non-pasta alternative
  //         when variety is requested. ---
  if (
    flexSlotKeys.length > 0 &&
    request.goals.varietyOfFlavors &&
    request.requiredTagsOrTitleTerms?.includes('pasta')
  ) {
    const nonFlexAssignedSlots = [...bestPlan.assignments.keys()].filter(
      (s) => !s.startsWith('flex')
    );
    const pastaInRequired = nonFlexAssignedSlots.some(
      (s) => bestPlan.assignments.get(s)?.sel.is_pasta
    );

    if (pastaInRequired) {
      for (const flexKey of flexSlotKeys) {
        const currentFlex = bestPlan.assignments.get(flexKey);
        if (currentFlex?.sel.is_pasta) {
          // Try to find a non-pasta flex candidate not already in plan
          const flexCandidates = scoredBySlot.get(flexKey) ?? [];
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

  // --- 4d. Flex variety: if a flex slot repeats a required-slot protein, swap it ---
  if (flexSlotKeys.length > 0) {
    bestPlan = enforceFlexVariety(bestPlan, scoredBySlot, request);
  }

  // --- 5. Compute full plan-level score ---
  const { planScore, breakdown: planBreakdown } = computePlanLevelScore(
    bestPlan,
    scoredBySlot,
    request
  );

  // --- 6. Assemble output ---
  const selectedRecipes = [...bestPlan.assignments.values()].map((r) => r.norm);
  const selectedRecipeSelTags = [...bestPlan.assignments.values()].map((r) => r.sel.tags);
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

  // --- 9. Preferred ingredient coverage ---
  const preferredIngredientCoverage =
    request.preferredIngredients.length > 0
      ? computePreferredIngredientCoverage(selectedRecipes, request.preferredIngredients)
      : undefined;

  // --- 10. Request fit summary ---
  const requestFitSummary = computeRequestFitSummary(
    request,
    selectedRecipes,
    validation,
    preferredIngredientCoverage ?? { matched: [], missing: [], coverageScore: 1.0 },
    selectedDespiteWarnings.length > 0 ? selectedDespiteWarnings : undefined
  );

  // --- 11. Suggested swaps ---
  const suggestedSwaps = computeSuggestedSwaps(
    bestPlan,
    scoredBySlot,
    selectedDespiteWarnings.length > 0 ? selectedDespiteWarnings : undefined
  );

  return {
    request,
    selectedRecipeIds,
    selectedRecipes,
    selectedRecipeSelTags,
    planScore,
    planScoreBreakdown: planBreakdown,
    shoppingOverlap,
    validation,
    alternatives,
    selectedDespiteWarnings: selectedDespiteWarnings.length > 0 ? selectedDespiteWarnings : undefined,
    preferredIngredientCoverage,
    requestFitSummary,
    suggestedSwaps: suggestedSwaps.length > 0 ? suggestedSwaps : undefined,
  };
}
