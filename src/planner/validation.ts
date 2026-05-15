/**
 * Weekly Meal Planner — Plan Validation
 *
 * Validates the final WeeklyPlanResult to ensure:
 *   - All selected IDs exist in the normalized recipe database.
 *   - No hallucinated recipes (titles match local data).
 *   - Structural constraints are satisfied (protein slots, kid-friendly, HF, pasta).
 *   - Nutrition targets are evaluated separately from structural constraints.
 *   - Nutrition claims are only made when data actually exists.
 *   - Suspicious serving counts trigger warnings (not failures).
 *
 * Called by the optimizer after selection and before rendering.
 * A failed validation still returns a result — it just populates
 * failedConstraints and sets the boolean flags accordingly.
 */

import type { WeeklyPlanRequest, PlanValidation } from './types.js';
import type { NormalizedRecipe } from '../types.js';

// ============================================================================
// Meat terms used to verify vegetarian constraint
// ============================================================================

const MEAT_TERMS = [
  'chicken', 'beef', 'pork', 'turkey', 'lamb', 'veal', 'bison', 'venison',
  'duck', 'goose', 'bacon', 'ham', 'sausage', 'salami', 'pepperoni',
  'prosciutto', 'pancetta', 'chorizo', 'bratwurst', 'hot dog', 'ground meat',
  'fish', 'seafood', 'shrimp', 'crab', 'lobster', 'clam', 'mussel', 'oyster',
  'scallop', 'anchovy', 'sardine', 'salmon', 'tuna', 'cod', 'tilapia',
  'halibut', 'mahi', 'trout', 'herring', 'mackerel', 'catfish',
];

// Keywords suggesting a multi-serving bulk entree
const BULK_ENTREE_TITLE_TERMS = /\b(chili|stew|casserole|slow\s*cooker|crockpot|soup|roast|braise|bake|lasagna)\b/i;
const BULK_INGREDIENT_PATTERNS = /\b[1-9]\d*\s*(?:lb|lbs|pound|pounds)\b|\b[2-9]\s*cups?\s+(?:rice|beans|pasta|broth|stock|lentils)\b|\b[2-9]\s*cans?\b/i;

/**
 * Detect recipes where a yield_servings of 1 is almost certainly a parse error.
 * Large, multi-ingredient entrees rarely serve just one person.
 */
export function isSuspiciousServingCount(recipe: NormalizedRecipe): boolean {
  if (recipe.yield_servings !== 1) return false;
  if (recipe.ingredients.length < 8) return false;

  const title = recipe.title.toLowerCase();
  const ingText = recipe.ingredients.map((i) => i.original.toLowerCase()).join(' ');

  const looksLikeBulkDish = BULK_ENTREE_TITLE_TERMS.test(title) || BULK_ENTREE_TITLE_TERMS.test(ingText);
  const hasBulkIngredients = BULK_INGREDIENT_PATTERNS.test(ingText);

  return looksLikeBulkDish || hasBulkIngredients;
}

// ============================================================================
// Macro target evaluation
// ============================================================================

interface MacroEvaluation {
  status: 'met' | 'failed' | 'partial' | 'unknown';
  satisfied: boolean | null;
  failedTargets: string[];
}

function evaluateMacroTargets(
  selectedRecipes: NormalizedRecipe[],
  request: WeeklyPlanRequest
): MacroEvaluation {
  if (!request.macroTargets) {
    return { status: 'unknown', satisfied: null, failedTargets: [] };
  }
  const { fatPct, carbsPct, proteinPct } = request.macroTargets;
  if (!fatPct && !carbsPct && !proteinPct) {
    return { status: 'unknown', satisfied: null, failedTargets: [] };
  }

  // Collect recipes that have complete macro data for the requested targets
  const recipesWithFat = selectedRecipes.filter(
    (r) => r.nutrition?.fat_g != null && r.nutrition?.protein_g != null && r.nutrition?.carbs_g != null
  );
  const recipesWithProtein = recipesWithFat; // same requirement
  const recipesWithCarbs = recipesWithFat;

  const totalRecipes = selectedRecipes.length;
  const recipesWithCompleteData = recipesWithFat.length;
  const isPartial = recipesWithCompleteData < totalRecipes && recipesWithCompleteData > 0;
  const hasNone = recipesWithCompleteData === 0;

  if (hasNone) {
    return { status: 'partial', satisfied: null, failedTargets: ['insufficient nutrition data'] };
  }

  // Calculate averages from macro calories (not label calories)
  let totalProtCal = 0, totalCarbCal = 0, totalFatCal = 0;
  for (const r of recipesWithFat) {
    const n = r.nutrition!;
    totalProtCal += (n.protein_g ?? 0) * 4;
    totalCarbCal += (n.carbs_g ?? 0) * 4;
    totalFatCal += (n.fat_g ?? 0) * 9;
  }
  const totalMacroCal = totalProtCal + totalCarbCal + totalFatCal;
  if (totalMacroCal <= 0) {
    return { status: 'unknown', satisfied: null, failedTargets: [] };
  }

  const avgProteinPct = (totalProtCal / totalMacroCal) * 100;
  const avgCarbsPct = (totalCarbCal / totalMacroCal) * 100;
  const avgFatPct = (totalFatCal / totalMacroCal) * 100;

  const failedTargets: string[] = [];

  if (proteinPct) {
    const { minPct, maxPct } = proteinPct;
    const ok = (minPct == null || avgProteinPct >= minPct) && (maxPct == null || avgProteinPct <= maxPct);
    if (!ok) failedTargets.push(`protein avg ${avgProteinPct.toFixed(1)}% outside ${minPct ?? 0}-${maxPct ?? 100}%`);
  }
  if (carbsPct) {
    const { minPct, maxPct } = carbsPct;
    const ok = (minPct == null || avgCarbsPct >= minPct) && (maxPct == null || avgCarbsPct <= maxPct);
    if (!ok) failedTargets.push(`carbs avg ${avgCarbsPct.toFixed(1)}% outside ${minPct ?? 0}-${maxPct ?? 100}%`);
  }
  if (fatPct) {
    const { minPct, maxPct } = fatPct;
    const ok = (minPct == null || avgFatPct >= minPct) && (maxPct == null || avgFatPct <= maxPct);
    if (!ok) failedTargets.push(`fat avg ${avgFatPct.toFixed(1)}% outside ${minPct ?? 0}-${maxPct ?? 100}%`);
  }

  const allMet = failedTargets.length === 0;
  const status: MacroEvaluation['status'] = isPartial
    ? 'partial'
    : allMet
      ? 'met'
      : 'failed';

  return {
    status,
    satisfied: allMet ? true : false,
    failedTargets,
  };
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate a completed plan result.
 * Returns a PlanValidation object with separate structural and nutrition flags.
 *
 * @param selectedRecipeIds  The IDs returned by the optimizer.
 * @param selectedRecipes    The full NormalizedRecipe objects (should match IDs).
 * @param normalizedById     The authoritative local recipe store.
 * @param request            The original planning request.
 * @param extraWarnings      Any warnings accumulated during optimization.
 */
export function validatePlanResult(
  selectedRecipeIds: string[],
  selectedRecipes: NormalizedRecipe[],
  normalizedById: Map<string, NormalizedRecipe>,
  request: WeeklyPlanRequest,
  extraWarnings: string[] = []
): PlanValidation {
  const warnings: string[] = [...extraWarnings];
  const failedConstraints: string[] = [];

  // ---- 1. All IDs must exist in the local database ----
  const missingIds = selectedRecipeIds.filter((id) => !normalizedById.has(id));
  const allRecipeIdsExist = missingIds.length === 0;
  if (!allRecipeIdsExist) {
    failedConstraints.push(`unknown_ids: ${missingIds.join(', ')}`);
    warnings.push(
      `ERROR: ${missingIds.length} selected recipe ID(s) not found in local database: ${missingIds.join(', ')}. ` +
      'These entries have been removed from the plan.'
    );
  }

  // ---- 2. No duplicates ----
  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  for (const id of selectedRecipeIds) {
    if (seen.has(id)) duplicateIds.push(id);
    seen.add(id);
  }
  if (duplicateIds.length > 0) {
    failedConstraints.push(`duplicate_ids: ${duplicateIds.join(', ')}`);
    warnings.push(`Duplicate recipe IDs in plan: ${duplicateIds.join(', ')}`);
  }

  // ---- 3. No hallucinated titles (title must match local database) ----
  let noHallucinatedRecipes = true;
  for (const recipe of selectedRecipes) {
    const local = normalizedById.get(recipe.id);
    if (local && local.title !== recipe.title) {
      noHallucinatedRecipes = false;
      failedConstraints.push(`title_mismatch:${recipe.id}`);
      warnings.push(
        `Recipe ID ${recipe.id}: title mismatch. ` +
        `Local: "${local.title}", plan: "${recipe.title}". Using local title.`
      );
    }
  }

  // ---- 4. Protein slot satisfaction ----
  // We verify this indirectly: candidate-filter already enforces slot matching,
  // but we do a sanity check here for vegetarian/vegan slots.
  for (const recipe of selectedRecipes) {
    const slot = request.requiredProteinSlots.find((s) => {
      if (s === 'vegetarian' || s === 'vegan') {
        const ingText = recipe.ingredients
          .map((i) => i.ingredient.toLowerCase() + ' ' + i.original.toLowerCase())
          .join(' ');
        return !MEAT_TERMS.some((t) => ingText.includes(t));
      }
      return true; // Other slots were enforced by the candidate filter
    });
    if (slot === undefined) {
      warnings.push(
        `Recipe "${recipe.title}" may not satisfy its assigned protein slot. ` +
        'Please review the plan.'
      );
    }
  }

  // ---- 5. Kid-friendly minimum ----
  if (request.minKidFriendlyMeals && request.minKidFriendlyMeals > 0) {
    const kidFriendlyCount = selectedRecipes.filter(
      (r) => r.kid_friendly_score >= 0.6
    ).length;

    if (kidFriendlyCount < request.minKidFriendlyMeals) {
      failedConstraints.push(
        `kid_friendly_min:need_${request.minKidFriendlyMeals}_got_${kidFriendlyCount}`
      );
      warnings.push(
        `Kid-friendly minimum not fully met: required ${request.minKidFriendlyMeals}, ` +
        `found ${kidFriendlyCount} recipe(s) with score ≥ 0.6.`
      );
    }
  }

  // ---- 6. Nutrition data availability (warning, not hard constraint) ----
  const recipesWithoutNutrition = selectedRecipes.filter(
    (r) => !r.nutrition || r.nutrition.calories === null
  );
  if (recipesWithoutNutrition.length > 0) {
    warnings.push(
      `${recipesWithoutNutrition.length} recipe(s) lack nutrition data: ` +
      `${recipesWithoutNutrition.map((r) => `"${r.title}"`).join(', ')}. ` +
      'Macro averages for the plan exclude these recipes.'
    );
  }

  // ---- 7. HelloFresh requirement ----
  if (request.requiredSourceSignals?.includes('hellofresh')) {
    const hasHF = selectedRecipes.some((r) => {
      const sn = (r.source_name ?? '').toLowerCase();
      const su = (r.source_url ?? '').toLowerCase();
      return sn.includes('hellofresh') || su.includes('hellofresh');
    });
    if (!hasHF) {
      failedConstraints.push('hellofresh_required:not_satisfied');
      warnings.push(
        'A HelloFresh recipe was requested but none was available in the candidate pool.'
      );
    }
  }

  // ---- 8. Pasta requirement ----
  if (request.requiredTagsOrTitleTerms?.includes('pasta')) {
    const hasPasta = selectedRecipes.some((r) => {
      const title = r.title.toLowerCase();
      const ingText = r.ingredients.map((i) => i.ingredient.toLowerCase()).join(' ');
      const tags = r.tags.map((t) => t.toLowerCase());
      return (
        title.includes('pasta') ||
        ingText.includes('pasta') ||
        tags.includes('pasta')
      );
    });
    if (!hasPasta) {
      failedConstraints.push('pasta_required:not_satisfied');
      warnings.push(
        'A pasta recipe was requested but none was available in the candidate pool.'
      );
    }
  }

  // ---- 9. Suspicious serving counts (warnings only, not failures) ----
  for (const recipe of selectedRecipes) {
    if (isSuspiciousServingCount(recipe)) {
      warnings.push(
        `⚠️ Servings may have parsed incorrectly for "${recipe.title}" ` +
        `(shows ${recipe.yield_servings} serving — likely a multi-serving dish).`
      );
    }
  }

  // ---- 10. Nutrition target evaluation (separate from structural) ----
  const macroEval = evaluateMacroTargets(selectedRecipes, request);
  const nutritionFailedConstraints: string[] = macroEval.failedTargets.map(
    (t) => `nutrition_target:${t}`
  );

  const structuralConstraintsSatisfied = failedConstraints.length === 0;

  return {
    allRecipeIdsExist,
    noHallucinatedRecipes,
    structuralConstraintsSatisfied,
    hardConstraintsSatisfied: structuralConstraintsSatisfied, // backward compat alias
    nutritionTargetsSatisfied: macroEval.satisfied,
    nutritionEvaluationStatus: macroEval.status,
    macroFailedTargets: macroEval.failedTargets.length > 0 ? macroEval.failedTargets : undefined,
    warnings,
    failedConstraints: [...failedConstraints, ...nutritionFailedConstraints],
  };
}
