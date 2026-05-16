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
import type { SelectionRecord } from '../selection-index.js';

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

// ============================================================================
// Dinner-plan appropriateness signals
// ============================================================================

/**
 * Title terms that strongly suggest a breakfast recipe.
 * Checked against lowercased recipe title.
 */
const BREAKFAST_TITLE_TERMS = [
  'french toast', 'pancake', 'waffle', 'oatmeal', 'granola',
  'overnight oats', 'breakfast burrito', 'breakfast bowl', 'shakshuka',
  'egg casserole', 'egg bake', 'frittata', 'quiche', 'breakfast sandwich',
  'morning glory', 'coffee cake', 'smoothie bowl',
  // Additional breakfast / morning terms
  'muffin', 'scone', 'biscuit', 'hash brown', 'crepe', 'crumpet',
  'bagel', 'egg bite', 'avocado toast', 'breakfast wrap', 'morning',
  'acai bowl',
];

/**
 * Title terms that strongly suggest a dessert or sweet snack.
 */
const DESSERT_TITLE_TERMS = [
  'cake', ' pie', 'pie ', 'cobbler', 'tart', 'brownie', 'cookie', 'cookies',
  'pudding', 'cheesecake', 'cupcake', 'ice cream', 'sorbet', 'fudge',
  'chocolate mousse', 'tiramisu', 'panna cotta', 'creme brulee',
  'bread pudding', 'churros',
  // Additional dessert / sweet-snack terms
  'donut', 'doughnut', 'macaron', 'macaroon', 'trifle', 'gelatin',
  'popsicle', 'banana bread', 'sweet bread', 'candy', 'truffles',
  'lemon bars', 'rice crispy', 'krispie treat',
];

/**
 * Ingredient terms that identify high-quality vegetarian protein sources.
 */
const LEGUME_TERMS = [
  'lentil', 'black bean', 'chickpea', 'garbanzo', 'kidney bean',
  'pinto bean', 'edamame', 'tofu', 'tempeh', 'soy ', 'navy bean',
  'cannellini', 'white bean', 'fava bean', 'mung bean', 'split pea',
  'peanut', 'peanut butter',
];

const HIGH_PROTEIN_GRAIN_TERMS = ['quinoa', 'seitan', 'nutritional yeast'];

/**
 * Title terms that identify snack/appetizer recipes not suitable as dinner entrees.
 * Supplementary to the meal_type='snack' check.
 */
const SNACK_TITLE_TERMS = [
  'snack', 'appetizer', 'dip', 'chips', 'popcorn', 'nachos',
  'bruschetta', 'crostini', 'bite', 'bites', 'slider', 'skewer',
];

/**
 * Title/ingredient signals that strongly indicate a meal-prep-friendly dish.
 * These recipes hold well, freeze well, and improve overnight.
 */
const MEAL_PREP_TITLE_SIGNALS = [
  'chili', 'stew', 'curry', 'soup', 'casserole', 'meatball', 'meatballs',
  'braised', 'slow cooker', 'crockpot', 'sheet pan', 'rice bowl', 'grain bowl',
  'burrito bowl', 'meal prep', 'batch', 'make ahead', 'make-ahead',
];

/**
 * Ingredients that make a recipe meal-prep friendly (cook in bulk, hold well).
 */
const MEAL_PREP_INGREDIENT_SIGNALS = [
  'lentil', 'black bean', 'chickpea', 'kidney bean', 'white bean',
  'brown rice', 'quinoa', 'farro', 'barley',
];

// ============================================================================
// Cheese detection signals
// ============================================================================

/**
 * Cheese ingredient terms that constitute a meaningfully cheesy recipe.
 * Each hit adds substantially to the cheese score.
 */
const STRONG_CHEESE_TERMS = [
  'cheddar', 'mozzarella', 'feta', 'goat cheese', 'cream cheese',
  'ricotta', 'swiss cheese', 'monterey jack', 'pepper jack', 'provolone',
  'queso', 'cotija', 'blue cheese', 'gruyere', 'gruyère', 'fontina',
  'cheese sauce', 'mac and cheese', 'four cheese', 'quattro formaggi',
  'brie', 'camembert', 'manchego', 'gorgonzola', 'havarti',
  'muenster', 'colby jack', 'american cheese', 'velveeta',
  'shredded cheese', 'string cheese', 'cheese blend', 'mixed cheese',
];

/**
 * Title terms that strongly indicate a cheesy recipe.
 * These appear in the dish name and are strong signals.
 */
const CHEESE_TITLE_SIGNALS = [
  'cheesy', 'mac and cheese', 'alfredo', 'carbonara',
  'four cheese', 'cheese sauce', 'enchilada', 'lasagna',
  'gratin', 'au gratin', 'parmesan', 'parmigiana', 'parmigiano',
];

/**
 * Garnish-level cheese terms — parmesan/romano/pecorino often appear in tiny
 * quantities (1 tbsp, ¾ oz) as a finishing sprinkle rather than a main component.
 * These add only a weak signal to the cheese score.
 */
const GARNISH_CHEESE_TERMS = [
  'parmesan', 'romano', 'pecorino', 'asiago', 'parmigiano',
];

// ============================================================================
// Cheese scoring (exported for use in optimizer and renderer)
// ============================================================================

/**
 * Compute a cheese-presence score in [0, 1] for a recipe.
 * - 0.0 : no cheese detected
 * - 0.1–0.2 : parmesan/romano as a garnish only
 * - 0.35–0.5 : one meaningful cheese ingredient
 * - 0.6–1.0 : multiple cheeses or cheese as a headline ingredient
 *
 * "Creamy" alone is NOT cheesy; pesto alone is NOT cheesy.
 */
export function computeCheeseScore(norm: NormalizedRecipe): number {
  const titleLower = norm.title.toLowerCase();
  const ingText = norm.ingredients
    .map((i) => i.ingredient.toLowerCase() + ' ' + i.original.toLowerCase())
    .join(' ');

  let score = 0;

  // Title signals add a substantial bonus (recipes named "Cheesy X" are cheesy by design)
  if (CHEESE_TITLE_SIGNALS.some((t) => titleLower.includes(t))) {
    score += 0.45;
  }

  // Count distinct strong cheese hits
  const strongHits = STRONG_CHEESE_TERMS.filter((t) => ingText.includes(t));
  score += Math.min(strongHits.length * 0.35, 0.65);

  // Garnish cheese — only add weak signal if no strong cheese already counted
  if (strongHits.length === 0) {
    const garnishHits = GARNISH_CHEESE_TERMS.filter((t) => ingText.includes(t));
    score += Math.min(garnishHits.length * 0.15, 0.2);
  }

  return Math.min(score, 1.0);
}

/**
 * Human-readable label for a cheese score with the primary matched term.
 */
export function describeCheeseScore(score: number, norm: NormalizedRecipe): string {
  const ingText = norm.ingredients
    .map((i) => i.ingredient.toLowerCase() + ' ' + i.original.toLowerCase())
    .join(' ');

  const matchedStrong = STRONG_CHEESE_TERMS.find((t) => ingText.includes(t));
  const matchedGarnish = GARNISH_CHEESE_TERMS.find((t) => ingText.includes(t));
  const primary = matchedStrong ?? matchedGarnish;

  if (score >= 0.7) {
    return `Strong — ${primary ?? 'cheese'} is a core ingredient`;
  }
  if (score >= 0.4) {
    return `Medium — ${primary ?? 'cheese'} present`;
  }
  if (score > 0) {
    return `Weak — ${primary ?? 'cheese'} appears as a garnish`;
  }
  return 'None — no cheese detected';
}

/**
 * Signals for comfort-heavy / creamy pasta format.
 * Used in scoring to detect when comfort mode is relevant.
 */
const COMFORT_HEAVY_INGREDIENT_SIGNALS = [
  'heavy cream', 'cream cheese', 'cream sauce', 'alfredo', 'béchamel',
  'bechamel', 'white sauce', 'four cheese', 'carbonara',
];

const COMFORT_HEAVY_TITLE_SIGNALS = [
  'carbonara', 'alfredo', 'mac and cheese', 'macaroni and cheese',
  'chicken parm', 'chicken parmesan', 'lasagna', 'ravioli',
  'stroganoff', 'pot pie',
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
  // Also strip "unit " that leaked through HelloFresh ingredient parsing
  const lower = ingredientName.toLowerCase().trim()
    .replace(/^[^a-z0-9]+/, '')
    .replace(/^unit\s+/, '');

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
// Dinner-appropriateness detection
// ============================================================================

/**
 * Returns a meal-plan-appropriateness penalty for recipes that clearly belong
 * to breakfast, dessert, or snack categories rather than a dinner plan.
 * Returns 0 for normal dinner entrees.
 */
function dinnerInappropriatenessPenalty(norm: NormalizedRecipe): number {
  const titleLower = norm.title.toLowerCase();

  // Check meal_type first (most reliable signal)
  if (norm.meal_type === 'breakfast') return W.dinnerInappropriate.breakfast;
  if (norm.meal_type === 'dessert') return W.dinnerInappropriate.dessert;
  if (norm.meal_type === 'snack') return W.dinnerInappropriate.snack;

  // Fall back to title-term detection
  if (BREAKFAST_TITLE_TERMS.some((t) => titleLower.includes(t))) {
    return W.dinnerInappropriate.breakfast;
  }
  if (DESSERT_TITLE_TERMS.some((t) => titleLower.includes(t))) {
    return W.dinnerInappropriate.dessert;
  }
  if (SNACK_TITLE_TERMS.some((t) => titleLower.includes(t))) {
    return W.dinnerInappropriate.snack;
  }

  return 0;
}

// ============================================================================
// Vegetarian protein quality scoring
// ============================================================================

/**
 * Score a vegetarian/vegan recipe by the quality of its protein source.
 * Returns 0 for non-vegetarian/vegan recipes.
 *
 * - High: legumes (lentils, chickpeas, black beans, tofu, tempeh, etc.) or quinoa/seitan.
 * - Medium: eggs as a primary protein source.
 * - PastaOnly: pasta + cheese with no substantial plant protein — mild penalty.
 */
function scoreVegetarianProteinQuality(
  norm: NormalizedRecipe,
  sel: SelectionRecord
): number {
  if (!sel.is_vegetarian && !sel.is_vegan) return 0;

  const ingText = norm.ingredients
    .map((i) => i.ingredient.toLowerCase() + ' ' + i.original.toLowerCase())
    .join(' ');

  const hasLegumes = LEGUME_TERMS.some((t) => ingText.includes(t));
  const hasHighProteinGrain = HIGH_PROTEIN_GRAIN_TERMS.some((t) => ingText.includes(t));

  if (hasLegumes || hasHighProteinGrain) return W.vegetarianProteinQuality.high;

  // Egg-based: meaningful if eggs appear in the ingredients (not just as garnish)
  const eggCount = norm.ingredients.filter(
    (i) => /\b(egg|eggs)\b/.test(i.ingredient.toLowerCase())
  ).length;
  if (eggCount >= 1 && !sel.is_pasta) return W.vegetarianProteinQuality.medium;

  // Pasta + cheese only (no substantial plant protein) — gentle penalty
  if (sel.is_pasta) return W.vegetarianProteinQuality.pastaOnly;

  return 0;
}

// ============================================================================
// Meal-prep friendliness scoring
// ============================================================================

/**
 * Returns a meal-prep score in [0, 1] based on title and ingredient signals.
 * Dishes that batch well, freeze well, and improve overnight score highest.
 * Returns 0 for recipes that clearly don't hold well (fresh salads, delicate fried items).
 */
function scoreMealPrepFriendliness(norm: NormalizedRecipe, sel: SelectionRecord): number {
  const titleLower = norm.title.toLowerCase();
  const ingText = norm.ingredients.map((i) => i.original.toLowerCase()).join(' ');

  // Penalty signals: delicate / texture-sensitive recipes that don't hold well
  const isDelicate =
    /\b(salad|crispy|fried|tempura|sushi|ceviche|tartare|souffle)\b/.test(titleLower) ||
    sel.freezer_friendly === 'no';

  if (isDelicate) return 0;

  let score = 0;

  // Title signals for batch-cook dishes
  if (MEAL_PREP_TITLE_SIGNALS.some((t) => titleLower.includes(t))) score += 0.6;

  // Ingredient signals for bulk-cook staples
  if (MEAL_PREP_INGREDIENT_SIGNALS.some((t) => ingText.includes(t))) score += 0.3;

  // Confirmed freezer-friendly
  if (sel.freezer_friendly === 'yes') score += 0.3;

  return Math.min(score, 1.0);
}

// ============================================================================
// Comfort-heavy detection
// ============================================================================

/**
 * Returns true if the recipe is comfort-heavy (creamy pasta, cheese-loaded, etc.).
 * Used to apply comfort mode bonuses/penalties appropriately.
 */
function isComfortHeavy(norm: NormalizedRecipe, sel: SelectionRecord): boolean {
  if (!sel.is_comfort_food) return false;

  const titleLower = norm.title.toLowerCase();
  const ingText = norm.ingredients.map((i) => i.original.toLowerCase()).join(' ');

  return (
    COMFORT_HEAVY_TITLE_SIGNALS.some((t) => titleLower.includes(t)) ||
    COMFORT_HEAVY_INGREDIENT_SIGNALS.some((t) => ingText.includes(t))
  );
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
  // calRange removed — calories can always be adjusted by eating a smaller portion;
  // macro ratios and protein density are the meaningful quality signals.
  weightLoss: { proteinDensity: 0.5, protPct: 0.3, fatPct: 0.2 },
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
  pastaBonus: 0.05, // Neutral: being pasta should not be a meaningful advantage
  comfortFoodBonus: 0.05,    // 'allowed' mode: tiny signal only
  comfortFoodPreferred: 0.4, // 'preferred' mode: meaningful bonus
  comfortFoodRequired: 0.8,  // 'required' mode: treat like a slot requirement
  comfortFoodAvoid: -0.3,    // 'avoid' mode: mild penalty for comfort-heavy recipes
  cuisineBonus: 0.1,
  /**
   * Per-recipe preference: cheesy fit score multiplier.
   * Applied when request.perRecipePreferences includes 'cheesy'.
   * High weight so cheesy recipes strongly dominate in an all-cheesy plan.
   */
  cheesyFit: 2.0,
  /**
   * Penalty for recipes that are clearly breakfast, dessert, or snack items
   * in a dinner-plan context. Applied based on meal_type and title signals.
   * Significantly increased to ensure these never appear as top alternatives.
   */
  dinnerInappropriate: { breakfast: -2.5, dessert: -2.5, snack: -1.5 },
  /**
   * Bonus/penalty for vegetarian/vegan recipes based on protein quality.
   * High: legumes, tofu, tempeh, quinoa, seitan.
   * Medium: egg-based (when eggs are a meaningful protein source).
   * PastaOnly: pasta + cheese is the only "protein" — meaningful penalty.
   */
  vegetarianProteinQuality: { high: 0.6, medium: 0.3, pastaOnly: -0.9 },
  /** Small bonus for recipes with complete real macro data in the catalog. */
  nutritionCompleteness: 0.2,
  /** Bonus for meal-prep-friendly recipes when freezer/weight-loss goals are active. */
  mealPrep: 0.4,
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
// Effective macro computation — source-equalizing fallback
// ============================================================================

interface EffectiveMacros {
  macro_pct_protein: number | null;
  macro_pct_carbs: number | null;
  macro_pct_fat: number | null;
  protein_g: number | null;
  calories: number | null;
}

/**
 * Compute effective macro values for scoring by combining the pre-computed
 * catalog SelectionRecord with enrichment-estimated values from norm.nutrition.
 *
 * Priority: sel.* (real source data) > norm.nutrition (enrichment estimates).
 *
 * This allows all recipes — regardless of which source published them — to
 * compete on the same nutritional signals once the enrichment process has
 * estimated their missing macro data. Without this fallback, sources that
 * don't publish macros (e.g. HelloFresh) score 0 on every nutrition signal,
 * making source-specific bonuses the only way to surface them.
 */
function computeEffectiveMacros(sel: SelectionRecord, norm: NormalizedRecipe): EffectiveMacros {
  // If catalog already has full macro percentages, use them as-is (fastest path).
  if (sel.macro_pct_protein !== null && sel.macro_pct_carbs !== null && sel.macro_pct_fat !== null) {
    return {
      macro_pct_protein: sel.macro_pct_protein,
      macro_pct_carbs: sel.macro_pct_carbs,
      macro_pct_fat: sel.macro_pct_fat,
      protein_g: sel.protein_g,
      calories: sel.calories,
    };
  }

  // Try to compute from norm.nutrition (may include enrichment estimates applied
  // at load time via applyEnrichmentForSoftScoring).
  const n = norm.nutrition;
  if (n && n.protein_g != null && n.carbs_g != null && n.fat_g != null) {
    const kcal = n.protein_g * 4 + n.carbs_g * 4 + n.fat_g * 9;
    if (kcal > 0) {
      return {
        macro_pct_protein: sel.macro_pct_protein ?? (n.protein_g * 4 / kcal) * 100,
        macro_pct_carbs:   sel.macro_pct_carbs   ?? (n.carbs_g   * 4 / kcal) * 100,
        macro_pct_fat:     sel.macro_pct_fat     ?? (n.fat_g     * 9 / kcal) * 100,
        protein_g: sel.protein_g ?? n.protein_g,
        calories:  sel.calories  ?? n.calories,
      };
    }
  }

  // Final fallback: whatever sel has (may all be null).
  return {
    macro_pct_protein: sel.macro_pct_protein,
    macro_pct_carbs:   sel.macro_pct_carbs,
    macro_pct_fat:     sel.macro_pct_fat,
    protein_g: sel.protein_g,
    calories:  sel.calories,
  };
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

  // Compute effective macro values: real catalog data where available, enrichment
  // estimates from norm.nutrition otherwise. This ensures all recipe sources compete
  // on equal footing when enrichment has filled in their missing macro data.
  const em = computeEffectiveMacros(sel, norm);

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
      if (em.macro_pct_protein !== null) {
        macroDataAvailable++;
        const { minPct, maxPct } = request.macroTargets.proteinPct;
        macroScore += macroFitGradient(em.macro_pct_protein, minPct, maxPct) * W.macroFit.protein * macroImportance;
      } else {
        missingNutritionSet.add('protein_pct');
      }
    }

    if (request.macroTargets.carbsPct) {
      macroDataExpected++;
      if (em.macro_pct_carbs !== null) {
        macroDataAvailable++;
        const { minPct, maxPct } = request.macroTargets.carbsPct;
        macroScore += macroFitGradient(em.macro_pct_carbs, minPct, maxPct) * W.macroFit.carbs * macroImportance;
      } else {
        missingNutritionSet.add('carbs_pct');
      }
    }

    if (request.macroTargets.fatPct) {
      macroDataExpected++;
      if (em.macro_pct_fat !== null) {
        macroDataAvailable++;
        const { minPct, maxPct } = request.macroTargets.fatPct;
        macroScore += macroFitGradient(em.macro_pct_fat, minPct, maxPct) * W.macroFit.fat * macroImportance;
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
  // We do NOT score on absolute calorie counts — since any recipe can be divided
  // into a smaller portion, calories per listed serving are irrelevant. What matters
  // is macro composition: high protein %, low fat %, and protein-per-calorie density.
  if (request.goals.weightLoss) {
    let wlScore = 0;

    // Protein density: score recipes by how much protein they deliver per calorie.
    // A recipe with 30g protein / 500 kcal = 6g/100kcal is better than 10g / 200kcal = 5g/100kcal.
    // Scale: ≥8g protein per 100 kcal → full score; below 4g → no bonus.
    if (em.protein_g !== null && em.calories !== null && em.calories > 0) {
      const proteinPer100kcal = (em.protein_g / em.calories) * 100;
      const densityScore = Math.min(Math.max((proteinPer100kcal - 4) / 4, 0), 1.0);
      wlScore += densityScore * W.weightLoss.proteinDensity;
    } else if (em.macro_pct_protein !== null) {
      // Fall back to macro % when gram data is absent
      const approxDensityScore = Math.min(Math.max((em.macro_pct_protein - 20) / 15, 0), 1.0);
      wlScore += approxDensityScore * W.weightLoss.proteinDensity * 0.7;
    } else {
      missingNutritionSet.add('protein_density');
    }

    if (em.macro_pct_protein !== null && em.macro_pct_protein >= 25) {
      wlScore += W.weightLoss.protPct;
    }
    if (em.macro_pct_fat !== null && em.macro_pct_fat <= 35) {
      wlScore += W.weightLoss.fatPct;
    }

    breakdown.weightLoss = wlScore;
    score += wlScore;
  }

  // ---------- High protein ----------
  if (request.goals.highProtein) {
    if (em.macro_pct_protein !== null) {
      // Scale: ≥35% protein → 1.0; below 15% → negative penalty (implausible / very low protein)
      const rawHpScore = em.macro_pct_protein / 35;
      const lowProteinPenalty = em.macro_pct_protein < 15 ? (15 - em.macro_pct_protein) / 30 : 0;
      const hpScore = Math.max(-1.0, Math.min(1.0, rawHpScore - lowProteinPenalty)) * W.highProtein;
      breakdown.highProtein = hpScore;
      score += hpScore;
    } else {
      missingNutritionSet.add('protein_pct');
    }
  }

  // ---------- Low fat ----------
  if (request.goals.lowFat) {
    if (em.macro_pct_fat !== null) {
      // Scale: 15% fat → 1.0, 45% fat → 0.0, beyond 45% → negative penalty up to -1.0
      const rawLfScore = 1.0 - (em.macro_pct_fat - 15) / 30;
      const lfScore = Math.max(-1.0, rawLfScore) * W.lowFat;
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

  // ---------- Per-recipe preferences (e.g. cheesy) ----------
  if (request.perRecipePreferences?.includes('cheesy')) {
    const cheeseScore = computeCheeseScore(norm);
    // Score ranges 0–2.0: 0 for no cheese, 2.0 for maximally cheesy recipe
    breakdown.cheesyFit = cheeseScore * W.cheesyFit;
    score += breakdown.cheesyFit;
  }

  // ---------- Pasta bonus ----------
  if (sel.is_pasta) {
    breakdown.pasta = W.pastaBonus;
    score += W.pastaBonus;
  }

  // ---------- Comfort food ----------
  // Apply scoring based on comfortFoodMode (preferred / required / allowed / avoid).
  // Fall back to the legacy allowComfortFood boolean when mode is not set.
  {
    const mode = request.comfortFoodMode;
    const comfortHeavy = isComfortHeavy(norm, sel);
    if (mode === 'preferred' && sel.is_comfort_food) {
      breakdown.comfortFood = W.comfortFoodPreferred;
      score += W.comfortFoodPreferred;
    } else if (mode === 'required' && sel.is_comfort_food) {
      breakdown.comfortFood = W.comfortFoodRequired;
      score += W.comfortFoodRequired;
    } else if (mode === 'avoid' && comfortHeavy) {
      breakdown.comfortFood = W.comfortFoodAvoid;
      score += W.comfortFoodAvoid;
    } else if ((!mode || mode === 'allowed') && request.allowComfortFood && sel.is_comfort_food) {
      // Legacy / 'allowed' mode: tiny signal so comfort food is not totally invisible
      breakdown.comfortFood = W.comfortFoodBonus;
      score += W.comfortFoodBonus;
    }
  }

  // ---------- Has cuisine label (variety signal) ----------
  if (norm.cuisine) {
    breakdown.hasCuisine = W.cuisineBonus;
    score += W.cuisineBonus;
  }

  // ---------- Dinner-plan appropriateness ----------
  // Penalize breakfast / dessert / snack recipes in a dinner-plan context.
  const dinnerPenalty = dinnerInappropriatenessPenalty(norm);
  if (dinnerPenalty !== 0) {
    breakdown.dinnerAppropriateness = dinnerPenalty;
    score += dinnerPenalty;
  }

  // ---------- Vegetarian protein quality ----------
  // Reward legume/tofu-based vegetarian recipes; meaningfully penalize pasta-only veg.
  const vegProteinScore = scoreVegetarianProteinQuality(norm, sel);
  if (vegProteinScore !== 0) {
    breakdown.vegetarianProteinQuality = vegProteinScore;
    score += vegProteinScore;
  }

  // ---------- Meal-prep friendliness ----------
  // Bonus when freezer-friendly or weight-loss goals are active and the recipe
  // batches/holds well. Helps surface stews, chilis, curries, grain bowls over
  // delicate recipes that don't reheat well.
  if (request.goals.freezerFriendly || request.goals.weightLoss || request.goals.highProtein) {
    const mpScore = scoreMealPrepFriendliness(norm, sel);
    if (mpScore > 0) {
      breakdown.mealPrep = mpScore * W.mealPrep;
      score += breakdown.mealPrep;
    }
  }

  // ---------- Nutrition completeness bonus ----------
  // Small bonus when complete real macro data is available from the catalog.
  // This avoids over-relying on enrichment estimates when catalog data exists.
  if (
    sel.macro_pct_protein !== null &&
    sel.macro_pct_carbs !== null &&
    sel.macro_pct_fat !== null
  ) {
    breakdown.nutritionCompleteness = W.nutritionCompleteness;
    score += W.nutritionCompleteness;
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
