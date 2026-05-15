/**
 * Weekly Meal Planner — Recipe Scoring
 *
 * Scores an individual PlannerRecipe against a WeeklyPlanRequest.
 * All scoring is deterministic and local — no external API calls.
 *
 * Missing nutrition data is flagged and excluded from score computation;
 * no values are invented or assumed.
 */

import type { WeeklyPlanRequest, PlannerRecipe, CandidateScore } from './types.js';
import type { NormalizedRecipe } from '../types.js';

// ============================================================================
// Constants
// ============================================================================

/** Ingredients that signal trans-fat risk (partially hydrogenated oils). */
const TRANS_FAT_SIGNALS = [
  'shortening',
  'margarine',
  'partially hydrogenated',
  'hydrogenated vegetable',
  'hydrogenated soybean',
];

/** Canonical ingredient keys that indicate low perishability (pantry staples). */
const CANONICAL_PANTRY = new Set([
  'olive oil', 'vegetable oil', 'canola oil', 'salt', 'black pepper',
  'garlic', 'onion', 'butter', 'sugar', 'flour', 'soy sauce',
  'chicken broth', 'beef broth', 'vegetable broth', 'tomato sauce',
  'canned tomatoes', 'black beans', 'chickpeas', 'rice', 'pasta',
  'vinegar', 'honey', 'mustard', 'cumin', 'paprika', 'oregano',
  'bay leaves', 'thyme', 'rosemary', 'chili flakes', 'tomato paste',
  'coconut milk', 'lentils', 'dried pasta', 'bread crumbs', 'panko',
]);

/** Regex-based canonical normalizations for ingredient overlap calculation. */
const INGREDIENT_NORMALIZATIONS: [RegExp, string][] = [
  [/\bboneless\s+(?:and\s+)?skinless\s+chicken\s+breast/i, 'chicken breast'],
  [/\bchicken\s+breast/i, 'chicken breast'],
  [/\bchicken\s+thigh/i, 'chicken thigh'],
  [/\bground\s+beef/i, 'ground beef'],
  [/\bground\s+turkey/i, 'ground turkey'],
  [/\bpork\s+(?:tender)?loin/i, 'pork tenderloin'],
  [/\bsirloin\s+steak/i, 'sirloin steak'],
  [/\byellow\s+onion/i, 'onion'],
  [/\bwhite\s+onion/i, 'onion'],
  [/\bred\s+onion/i, 'red onion'],
  [/\bgreen\s+onion/i, 'scallions'],
  [/\bscallion/i, 'scallions'],
  [/\bgarlic\s+clove/i, 'garlic'],
  [/\bminced\s+garlic/i, 'garlic'],
  [/\bextra\s+virgin\s+olive\s+oil/i, 'olive oil'],
  [/\bblack\s+bean/i, 'black beans'],
  [/\bchickpea/i, 'chickpeas'],
  [/\bbaby\s+spinach/i, 'spinach'],
  [/\bunsalted\s+butter/i, 'butter'],
  [/\bsalted\s+butter/i, 'butter'],
  [/\bkosher\s+salt/i, 'salt'],
  [/\bsea\s+salt/i, 'salt'],
  [/\bfreshly\s+ground\s+(?:black\s+)?pepper/i, 'black pepper'],
  [/\bgrated\s+parmesan/i, 'parmesan cheese'],
  [/\bparmesan\s+cheese/i, 'parmesan cheese'],
  [/\bshredded\s+mozzarella/i, 'mozzarella'],
  [/\bheavy\s+(?:whipping\s+)?cream/i, 'heavy cream'],
  [/\bcanola\s+oil/i, 'vegetable oil'],
  [/\bdiced\s+tomatoes?\b/i, 'canned tomatoes'],
  [/\bcrushed\s+tomatoes?\b/i, 'canned tomatoes'],
  [/\bcanned\s+tomatoes?\b/i, 'canned tomatoes'],
  [/\bchicken\s+(?:stock|broth)/i, 'chicken broth'],
  [/\bbeef\s+(?:stock|broth)/i, 'beef broth'],
  [/\bvegetable\s+(?:stock|broth)/i, 'vegetable broth'],
  [/\bsoy\s+sauce/i, 'soy sauce'],
  [/\bfish\s+sauce/i, 'fish sauce'],
  [/\blime\s+juice/i, 'lime'],
  [/\blemon\s+juice/i, 'lemon'],
  [/\bbell\s+pepper/i, 'bell pepper'],
  [/\bjalape[nñ]o/i, 'jalapeño'],
  [/\bserrano\s+pepper/i, 'jalapeño'],
  [/\bshredded\s+cheese/i, 'cheese'],
  [/\bfresh\s+cilantro/i, 'cilantro'],
  [/\bfresh\s+parsley/i, 'parsley'],
  [/\bfresh\s+basil/i, 'basil'],
  [/\blong-grain\s+white\s+rice/i, 'white rice'],
  [/\bbrown\s+rice/i, 'brown rice'],
  [/\bbasmati\s+rice/i, 'white rice'],
];

// ============================================================================
// Ingredient canonical key extraction (used by optimizer for overlap scoring)
// ============================================================================

/**
 * Normalize an ingredient name to a canonical grocery key for shopping overlap.
 */
export function canonicalIngredientKey(ingredientName: string): string {
  // Strip leading non-alphanumeric chars (e.g. ". white rice" from "oz." unit abbreviation)
  const lower = ingredientName.toLowerCase().trim().replace(/^[^a-z0-9]+/, '');

  for (const [pattern, canonical] of INGREDIENT_NORMALIZATIONS) {
    if (pattern.test(lower)) return canonical;
  }

  // Strip common prep/modifier words and extra whitespace
  return lower
    .replace(
      /\b(fresh|frozen|canned|dried|organic|large|small|medium|thick|thin|roughly|finely|coarsely|freshly|chopped|minced|sliced|diced|grated|shredded|cooked|raw|peeled|trimmed|washed|rinsed|drained|halved|quartered|julienned|cubed|whole|ground)\b/g,
      ''
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract all canonical ingredient keys from a NormalizedRecipe.
 * Filters out very short or pantry-irrelevant strings.
 */
export function getCanonicalIngredientKeys(norm: NormalizedRecipe): string[] {
  return norm.ingredients
    .map((i) => canonicalIngredientKey(i.ingredient))
    .filter((k) => k.length > 2);
}

// ============================================================================
// Trans-fat risk inference
// ============================================================================

function detectTransFatRisk(norm: NormalizedRecipe): 'low' | 'high' | 'unknown' {
  const ingText = norm.ingredients.map((i) => i.original.toLowerCase()).join(' ');
  if (TRANS_FAT_SIGNALS.some((s) => ingText.includes(s))) return 'high';
  // Whole-ingredient recipes typically have negligible trans fat
  // but we only claim 'low' when no suspicious terms are present
  return 'low';
}

// ============================================================================
// Scoring weights (tuneable constants)
// ============================================================================

const W = {
  /**
   * Base macro-fit weights per macro dimension.
   * These are multiplied by macroImportance (1x or 2x) based on active goals.
   */
  macroFit: { protein: 1.2, carbs: 0.8, fat: 1.2 },
  weightLoss: { calRange: 0.5, protPct: 0.3, fatPct: 0.2 },
  highProtein: 1.5,
  lowFat: 1.5,
  kidFriendly: { required: 1.0, bonus: 0.3 },
  quickEasy: 1.0,
  cost: { low: 1.0, medium: 0.7, high: 0.2 },
  freezer: { yes: 1.0, unknown: 0.3, no: 0.0 },
  saturatedFat: { low: 0.5, medium: 0.25, high: 0.0, unknown: 0.15 },
  healthyFats: 0.5,
  transFat: { low: 0.5, high: 0.0 },
  preferredIngredient: 0.25, // per match
  maxPreferredScore: 1.5,
  helloFreshBonus: 0.5,
  pastaBonus: 0.3,
  comfortFoodBonus: 0.3,
  cuisineBonus: 0.1,
};

// ============================================================================
// Macro fit gradient scoring
// ============================================================================

/**
 * Score how well an actual macro percentage fits a target range.
 * Returns a value in [-1.0, 1.0]:
 *   - In range: 1.0
 *   - 1-5% outside: 0.5 (close)
 *   - 6-10% outside: 0.0 (moderate miss)
 *   - >10% outside: negative penalty (bad miss, up to -0.75)
 */
function macroFitGradient(
  actual: number,
  min: number | undefined,
  max: number | undefined
): number {
  const belowMin = min !== undefined && actual < min ? min - actual : 0;
  const aboveMax = max !== undefined && actual > max ? actual - max : 0;
  const miss = Math.max(belowMin, aboveMax);

  if (miss === 0) return 1.0;
  if (miss <= 5) return 0.5;
  if (miss <= 10) return 0.0;
  // Penalty for extreme miss: ramps from 0 at 10% miss to -0.75 at 25% miss
  return -Math.min((miss - 10) / 20, 1.0) * 0.75;
}

// ============================================================================
// Main scoring function
// ============================================================================

/**
 * Score a single candidate recipe against the planning request.
 * Returns a CandidateScore with full breakdown.
 */
export function scoreRecipeForRequest(
  recipe: PlannerRecipe,
  request: WeeklyPlanRequest
): CandidateScore {
  const { sel, norm } = recipe;
  const breakdown: Record<string, number> = {};
  const missingNutritionSet = new Set<string>(); // deduplicated
  const matchedPreferredIngredients: string[] = [];
  let score = 0;

  // ---------- Macro targets ----------
  if (request.macroTargets) {
    // Double the macro importance when the user also set related goals
    const hasMacroGoals = request.goals.weightLoss || request.goals.highProtein || request.goals.lowFat;
    const macroImportance = hasMacroGoals ? 2.0 : 1.0;

    let macroScore = 0;
    let macroDataExpected = 0;
    let macroDataAvailable = 0;

    if (request.macroTargets.proteinPct) {
      macroDataExpected++;
      if (sel.macro_pct_protein !== null) {
        macroDataAvailable++;
        const { minPct, maxPct } = request.macroTargets.proteinPct;
        macroScore += macroFitGradient(sel.macro_pct_protein, minPct, maxPct) * W.macroFit.protein * macroImportance;
      } else {
        missingNutritionSet.add('protein_pct');
      }
    }

    if (request.macroTargets.carbsPct) {
      macroDataExpected++;
      if (sel.macro_pct_carbs !== null) {
        macroDataAvailable++;
        const { minPct, maxPct } = request.macroTargets.carbsPct;
        macroScore += macroFitGradient(sel.macro_pct_carbs, minPct, maxPct) * W.macroFit.carbs * macroImportance;
      } else {
        missingNutritionSet.add('carbs_pct');
      }
    }

    if (request.macroTargets.fatPct) {
      macroDataExpected++;
      if (sel.macro_pct_fat !== null) {
        macroDataAvailable++;
        const { minPct, maxPct } = request.macroTargets.fatPct;
        macroScore += macroFitGradient(sel.macro_pct_fat, minPct, maxPct) * W.macroFit.fat * macroImportance;
      } else {
        missingNutritionSet.add('fat_pct');
      }
    }

    // Uncertainty penalty: missing macro data when targets were requested
    if (macroDataExpected > 0 && macroDataAvailable < macroDataExpected) {
      const missingFraction = (macroDataExpected - macroDataAvailable) / macroDataExpected;
      // Penalty scales with importance; unknown is worse than known-bad when macros matter
      macroScore -= missingFraction * 0.4 * macroImportance;
    }

    breakdown.macroFit = macroScore;
    score += macroScore;
  }

  // ---------- Weight loss ----------
  if (request.goals.weightLoss) {
    let wlScore = 0;

    if (sel.calories !== null) {
      if (sel.calories >= 350 && sel.calories <= 650) {
        wlScore += W.weightLoss.calRange;
      } else if (sel.calories < 350) {
        wlScore += W.weightLoss.calRange * 0.6; // Very low-cal: ok but not ideal
      } else if (sel.calories <= 800) {
        wlScore += W.weightLoss.calRange * 0.3;
      }
    } else {
      missingNutritionSet.add('calories');
    }

    if (sel.macro_pct_protein !== null && sel.macro_pct_protein >= 25) {
      wlScore += W.weightLoss.protPct;
    }
    if (sel.macro_pct_fat !== null && sel.macro_pct_fat <= 35) {
      wlScore += W.weightLoss.fatPct;
    }

    breakdown.weightLoss = wlScore;
    score += wlScore;
  }

  // ---------- High protein ----------
  if (request.goals.highProtein) {
    if (sel.macro_pct_protein !== null) {
      // Scale: 35% protein → score 1.0
      const hpScore = Math.min(sel.macro_pct_protein / 35, 1.0) * W.highProtein;
      breakdown.highProtein = hpScore;
      score += hpScore;
    } else {
      missingNutritionSet.add('protein_pct');
    }
  }

  // ---------- Low fat ----------
  if (request.goals.lowFat) {
    if (sel.macro_pct_fat !== null) {
      // Scale: 15% fat → 1.0, 45% fat → 0.0
      const lfScore = Math.max(0, 1.0 - (sel.macro_pct_fat - 15) / 30) * W.lowFat;
      breakdown.lowFat = lfScore;
      score += lfScore;
    } else {
      missingNutritionSet.add('fat_pct');
    }
  }

  // ---------- Kid-friendly ----------
  {
    const kidWeight =
      request.minKidFriendlyMeals && request.minKidFriendlyMeals > 0
        ? W.kidFriendly.required
        : W.kidFriendly.bonus;
    const kidScore = sel.kid_friendly_score * kidWeight;
    breakdown.kidFriendly = kidScore;
    score += kidScore;
  }

  // ---------- Quick / easy ----------
  if (request.goals.quickEasy) {
    const qeScore = sel.weeknight_score * W.quickEasy;
    breakdown.quickEasy = qeScore;
    score += qeScore;
  }

  // ---------- Cost ----------
  if (request.goals.lowMediumCost) {
    const costScore =
      norm.cost_tier === 'low'
        ? W.cost.low
        : norm.cost_tier === 'medium'
          ? W.cost.medium
          : W.cost.high;
    breakdown.cost = costScore;
    score += costScore;
  }

  // ---------- Freezer friendly ----------
  if (request.goals.freezerFriendly) {
    const fScore = W.freezer[sel.freezer_friendly] ?? W.freezer.unknown;
    breakdown.freezer = fScore;
    score += fScore;
  }

  // ---------- Saturated fat ----------
  if (request.goals.limitedSaturatedFat) {
    const sfScore = W.saturatedFat[sel.saturated_fat_risk] ?? W.saturatedFat.unknown;
    breakdown.saturatedFat = sfScore;
    score += sfScore;
  }

  // ---------- Healthy fats (omega-3 / MUFA) ----------
  if (request.goals.healthyFats) {
    const hfScore = sel.omega3_or_mufa === 'yes' ? W.healthyFats : 0;
    breakdown.healthyFats = hfScore;
    score += hfScore;
  }

  // ---------- Trans fat ----------
  if (request.goals.lowTransFat) {
    const tfRisk = detectTransFatRisk(norm);
    const tfScore = tfRisk === 'low' ? W.transFat.low : W.transFat.high;
    breakdown.transFat = tfScore;
    score += tfScore;
  }

  // ---------- Preferred ingredients ----------
  if (request.preferredIngredients.length > 0) {
    const ingText = norm.ingredients
      .map((i) => i.ingredient.toLowerCase() + ' ' + i.original.toLowerCase())
      .join(' ');

    for (const pref of request.preferredIngredients) {
      if (ingText.includes(pref.toLowerCase())) {
        matchedPreferredIngredients.push(pref);
      }
    }

    const prefScore = Math.min(
      matchedPreferredIngredients.length * W.preferredIngredient,
      W.maxPreferredScore
    );
    breakdown.preferredIngredients = prefScore;
    score += prefScore;
  }

  // ---------- HelloFresh bonus ----------
  if (sel.is_hellofresh) {
    breakdown.helloFresh = W.helloFreshBonus;
    score += W.helloFreshBonus;
  }

  // ---------- Pasta bonus ----------
  if (sel.is_pasta) {
    breakdown.pasta = W.pastaBonus;
    score += W.pastaBonus;
  }

  // ---------- Comfort food ----------
  if (request.allowComfortFood && sel.is_comfort_food) {
    breakdown.comfortFood = W.comfortFoodBonus;
    score += W.comfortFoodBonus;
  }

  // ---------- Has cuisine label (variety signal) ----------
  if (norm.cuisine) {
    breakdown.hasCuisine = W.cuisineBonus;
    score += W.cuisineBonus;
  }

  return {
    recipeId: norm.id,
    hardConstraintPass: true,
    disqualifyingReasons: [],
    score,
    scoreBreakdown: breakdown,
    matchedPreferredIngredients,
    missingNutritionFields: [...missingNutritionSet],
  };
}
