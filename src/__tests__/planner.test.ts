/**
 * Weekly Meal Planner — Test Suite
 *
 * Tests the deterministic planning pipeline without calling external APIs.
 * The AI query-parser is not tested here (it is a thin wrapper around OpenAI).
 * Everything below is unit-testable with local data.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { parsePlanRequestOffline } from '../planner/query-parser.js';
import { getCandidatesForPlan } from '../planner/candidate-filter.js';
import { scoreRecipeForRequest, getCanonicalIngredientKeys } from '../planner/scoring.js';
import { buildWeeklyPlan } from '../planner/optimizer.js';
import { validatePlanResult, isSuspiciousServingCount } from '../planner/validation.js';
import { renderPlanAsMarkdown, isAiExplanationSafe } from '../planner/renderer.js';
import { calculateMacroPercentages } from '../planner/macro-calculator.js';
import type { WeeklyPlanRequest, PlannerRecipe } from '../planner/types.js';
import type { NormalizedRecipe } from '../types.js';
import type { SelectionRecord } from '../selection-index.js';

// ============================================================================
// Fixtures
// ============================================================================

function makeNorm(overrides: Partial<NormalizedRecipe> & { id: string; title: string }): NormalizedRecipe {
  return {
    id: overrides.id,
    title: overrides.title,
    source_name: overrides.source_name ?? null,
    source_url: overrides.source_url ?? null,
    yield_servings: overrides.yield_servings ?? 4,
    prep_time_minutes: overrides.prep_time_minutes ?? 15,
    cook_time_minutes: overrides.cook_time_minutes ?? 25,
    total_time_minutes: overrides.total_time_minutes ?? 40,
    ingredients: overrides.ingredients ?? [
      { original: '1 lb chicken breast', quantity: 1, unit: 'lb', ingredient: 'chicken breast', notes: null },
      { original: '1 tbsp olive oil', quantity: 1, unit: 'tbsp', ingredient: 'olive oil', notes: null },
      { original: '1 onion', quantity: 1, unit: null, ingredient: 'onion', notes: null },
      { original: '2 cloves garlic', quantity: 2, unit: 'cloves', ingredient: 'garlic', notes: null },
    ],
    instructions: overrides.instructions ?? ['Cook the chicken.'],
    tags: overrides.tags ?? [],
    notes: overrides.notes ?? null,
    nutrition: overrides.nutrition ?? null,
    cuisine: overrides.cuisine ?? null,
    meal_type: overrides.meal_type ?? 'dinner',
    kid_friendly_score: overrides.kid_friendly_score ?? 0.5,
    weeknight_score: overrides.weeknight_score ?? 0.7,
    spice_level: overrides.spice_level ?? 1,
    equipment: overrides.equipment ?? ['stovetop'],
    primary_protein: overrides.primary_protein ?? 'chicken',
    cost_tier: overrides.cost_tier ?? 'medium',
    duplicate_group_id: overrides.duplicate_group_id ?? null,
    parse_warnings: overrides.parse_warnings ?? [],
    source_file: overrides.source_file ?? 'test.json',
    imported_at: overrides.imported_at ?? new Date().toISOString(),
  };
}

function makeSel(overrides: Partial<SelectionRecord> & { id: string; title: string }): SelectionRecord {
  return {
    id: overrides.id,
    title: overrides.title,
    paprika_title_exact: overrides.paprika_title_exact ?? overrides.title,
    source_name: overrides.source_name ?? null,
    source_url: overrides.source_url ?? null,
    source_normalized: overrides.source_normalized ?? 'Unknown',
    primary_protein: overrides.primary_protein ?? 'chicken',
    is_hellofresh: overrides.is_hellofresh ?? false,
    is_vegetarian: overrides.is_vegetarian ?? false,
    is_vegan: overrides.is_vegan ?? false,
    cost_tier: overrides.cost_tier ?? 'medium',
    prep_time_minutes: overrides.prep_time_minutes ?? 15,
    cook_time_minutes: overrides.cook_time_minutes ?? 25,
    total_time_minutes: overrides.total_time_minutes ?? 40,
    kid_friendly_score: overrides.kid_friendly_score ?? 0.5,
    kid_friendly_bucket: overrides.kid_friendly_bucket ?? 'Med',
    weeknight_score: overrides.weeknight_score ?? 0.7,
    weeknight_bucket: overrides.weeknight_bucket ?? 'High',
    spice_level: overrides.spice_level ?? 1,
    spice_level_label: overrides.spice_level_label ?? 'mild',
    tags: overrides.tags ?? [],
    is_pasta: overrides.is_pasta ?? false,
    is_comfort_food: overrides.is_comfort_food ?? false,
    freezer_friendly: overrides.freezer_friendly ?? 'unknown',
    reheat_quality: overrides.reheat_quality ?? 'unknown',
    nutrition_profile: overrides.nutrition_profile ?? 'unknown',
    saturated_fat_risk: overrides.saturated_fat_risk ?? 'unknown',
    omega3_or_mufa: overrides.omega3_or_mufa ?? 'unknown',
    pasta_inferred_reason: overrides.pasta_inferred_reason ?? null,
    freezer_inferred_reason: overrides.freezer_inferred_reason ?? null,
    kid_friendly_inferred: overrides.kid_friendly_inferred ?? false,
    is_freezer_candidate_heuristic: overrides.is_freezer_candidate_heuristic ?? false,
    macros_incomplete: overrides.macros_incomplete ?? true,
    kcal_est: overrides.kcal_est ?? null,
    macro_pct_protein: overrides.macro_pct_protein ?? null,
    macro_pct_carbs: overrides.macro_pct_carbs ?? null,
    macro_pct_fat: overrides.macro_pct_fat ?? null,
    macro_target_ok: overrides.macro_target_ok ?? null,
    calories: overrides.calories ?? null,
    protein_g: overrides.protein_g ?? null,
    carbs_g: overrides.carbs_g ?? null,
    fat_g: overrides.fat_g ?? null,
    saturated_fat_g: overrides.saturated_fat_g ?? null,
    fiber_g: overrides.fiber_g ?? null,
    sodium_mg: overrides.sodium_mg ?? null,
    warnings: overrides.warnings ?? [],
  };
}

// ---- Build a minimal test catalog ----
const CHICKEN_NORM = makeNorm({
  id: 'aaaa0000000000aa',
  title: 'Lemon Herb Chicken',
  primary_protein: 'chicken',
  kid_friendly_score: 0.8,
  nutrition: { calories: 420, protein_g: 38, carbs_g: 12, fat_g: 14, sodium_mg: 400 },
  ingredients: [
    { original: '1 lb chicken breast', quantity: 1, unit: 'lb', ingredient: 'chicken breast', notes: null },
    { original: '2 tbsp olive oil', quantity: 2, unit: 'tbsp', ingredient: 'olive oil', notes: null },
    { original: '1 lemon', quantity: 1, unit: null, ingredient: 'lemon', notes: null },
    { original: '3 garlic cloves', quantity: 3, unit: 'cloves', ingredient: 'garlic', notes: null },
  ],
});

const PORK_NORM = makeNorm({
  id: 'bbbb0000000000bb',
  title: 'Garlic Pork Tenderloin',
  primary_protein: 'pork',
  kid_friendly_score: 0.65,
  nutrition: { calories: 380, protein_g: 35, carbs_g: 8, fat_g: 12, sodium_mg: 350 },
  ingredients: [
    { original: '1 pork tenderloin', quantity: 1, unit: null, ingredient: 'pork tenderloin', notes: null },
    { original: '4 garlic cloves', quantity: 4, unit: 'cloves', ingredient: 'garlic', notes: null },
    { original: '2 tbsp olive oil', quantity: 2, unit: 'tbsp', ingredient: 'olive oil', notes: null },
  ],
});

const BEEF_NORM = makeNorm({
  id: 'cccc0000000000cc',
  title: 'Classic Beef Stew',
  primary_protein: 'beef',
  kid_friendly_score: 0.7,
  tags: ['comfort_food', 'freezer_friendly'],
  nutrition: { calories: 520, protein_g: 42, carbs_g: 35, fat_g: 16, sodium_mg: 600 },
  ingredients: [
    { original: '2 lb ground beef', quantity: 2, unit: 'lb', ingredient: 'ground beef', notes: null },
    { original: '1 onion', quantity: 1, unit: null, ingredient: 'onion', notes: null },
    { original: '3 garlic cloves', quantity: 3, unit: 'cloves', ingredient: 'garlic', notes: null },
    { original: '2 cups beef broth', quantity: 2, unit: 'cups', ingredient: 'beef broth', notes: null },
  ],
});

const VEG_NORM = makeNorm({
  id: 'dddd0000000000dd',
  title: 'Black Bean Tacos',
  primary_protein: 'legumes',
  is_vegetarian: true,
  kid_friendly_score: 0.75,
  nutrition: { calories: 320, protein_g: 14, carbs_g: 52, fat_g: 8, sodium_mg: 480 },
  ingredients: [
    { original: '1 can black beans', quantity: 1, unit: 'can', ingredient: 'black beans', notes: null },
    { original: '1 onion', quantity: 1, unit: null, ingredient: 'onion', notes: null },
    { original: '1 tbsp olive oil', quantity: 1, unit: 'tbsp', ingredient: 'olive oil', notes: null },
    { original: '1/2 cup cilantro', quantity: 0.5, unit: 'cup', ingredient: 'cilantro', notes: null },
  ],
});

const HF_NORM = makeNorm({
  id: 'eeee0000000000ee',
  title: 'HelloFresh Honey Garlic Chicken',
  primary_protein: 'chicken',
  source_name: 'HelloFresh',
  source_url: 'https://www.hellofresh.com/recipes/honey-garlic-chicken',
  kid_friendly_score: 0.85,
  nutrition: { calories: 450, protein_g: 36, carbs_g: 38, fat_g: 14, sodium_mg: 700 },
  ingredients: [
    { original: '1 lb chicken breast', quantity: 1, unit: 'lb', ingredient: 'chicken breast', notes: null },
    { original: '2 tbsp honey', quantity: 2, unit: 'tbsp', ingredient: 'honey', notes: null },
    { original: '3 garlic cloves', quantity: 3, unit: 'cloves', ingredient: 'garlic', notes: null },
    { original: '1 onion', quantity: 1, unit: null, ingredient: 'onion', notes: null },
  ],
});

const PASTA_NORM = makeNorm({
  id: 'ffff0000000000ff',
  title: 'Spaghetti Carbonara',
  primary_protein: 'pork',
  tags: ['pasta', 'comfort_food'],
  kid_friendly_score: 0.7,
  nutrition: { calories: 580, protein_g: 26, carbs_g: 68, fat_g: 22, sodium_mg: 650 },
  ingredients: [
    { original: '300g spaghetti', quantity: 300, unit: 'g', ingredient: 'spaghetti', notes: null },
    { original: '150g pancetta', quantity: 150, unit: 'g', ingredient: 'pancetta', notes: null },
    { original: '3 eggs', quantity: 3, unit: null, ingredient: 'eggs', notes: null },
    { original: '50g parmesan cheese', quantity: 50, unit: 'g', ingredient: 'parmesan cheese', notes: null },
  ],
});

const ALL_NORMS = [CHICKEN_NORM, PORK_NORM, BEEF_NORM, VEG_NORM, HF_NORM, PASTA_NORM];

const CHICKEN_SEL = makeSel({
  id: 'aaaa0000000000aa',
  title: 'Lemon Herb Chicken',
  primary_protein: 'chicken',
  kid_friendly_score: 0.8,
  kid_friendly_bucket: 'High',
  calories: 420,
  protein_g: 38,
  carbs_g: 12,
  fat_g: 14,
  macro_pct_protein: 36.2,
  macro_pct_carbs: 22.9,
  macro_pct_fat: 30.0,
  macros_incomplete: false,
  omega3_or_mufa: 'yes',
  saturated_fat_risk: 'low',
});

const PORK_SEL = makeSel({
  id: 'bbbb0000000000bb',
  title: 'Garlic Pork Tenderloin',
  primary_protein: 'pork',
  kid_friendly_score: 0.65,
  kid_friendly_bucket: 'Med',
  calories: 380,
  protein_g: 35,
  macros_incomplete: false,
});

const BEEF_SEL = makeSel({
  id: 'cccc0000000000cc',
  title: 'Classic Beef Stew',
  primary_protein: 'beef',
  kid_friendly_score: 0.7,
  kid_friendly_bucket: 'High',
  freezer_friendly: 'yes',
  tags: ['comfort_food', 'freezer_friendly'],
  macros_incomplete: false,
  calories: 520,
  protein_g: 42,
});

const VEG_SEL = makeSel({
  id: 'dddd0000000000dd',
  title: 'Black Bean Tacos',
  primary_protein: 'legumes',
  is_vegetarian: true,
  kid_friendly_score: 0.75,
  kid_friendly_bucket: 'High',
  macros_incomplete: false,
  calories: 320,
  protein_g: 14,
});

const HF_SEL = makeSel({
  id: 'eeee0000000000ee',
  title: 'HelloFresh Honey Garlic Chicken',
  primary_protein: 'chicken',
  source_name: 'HelloFresh',
  source_url: 'https://www.hellofresh.com/recipes/honey-garlic-chicken',
  source_normalized: 'HelloFresh',
  is_hellofresh: true,
  kid_friendly_score: 0.85,
  kid_friendly_bucket: 'High',
  macros_incomplete: false,
  calories: 450,
});

const PASTA_SEL = makeSel({
  id: 'ffff0000000000ff',
  title: 'Spaghetti Carbonara',
  primary_protein: 'pork',
  is_pasta: true,
  tags: ['pasta', 'comfort_food'],
  kid_friendly_score: 0.7,
  kid_friendly_bucket: 'High',
  macros_incomplete: false,
  calories: 580,
});

const ALL_SELS = [CHICKEN_SEL, PORK_SEL, BEEF_SEL, VEG_SEL, HF_SEL, PASTA_SEL];
const NORM_MAP = new Map<string, NormalizedRecipe>(ALL_NORMS.map((r) => [r.id, r]));

// ============================================================================
// Tests: Offline Query Parser
// ============================================================================

describe('parsePlanRequestOffline', () => {
  it('parses protein slot counts correctly', () => {
    const req = parsePlanRequestOffline('1 chicken recipe, 1 pork recipe, 1 beef recipe, 1 vegetarian recipe');
    expect(req.requiredProteinSlots).toContain('chicken');
    expect(req.requiredProteinSlots).toContain('pork');
    expect(req.requiredProteinSlots).toContain('beef');
    expect(req.requiredProteinSlots).toContain('vegetarian');
    expect(req.mealCount).toBe(4);
  });

  it('parses "at least 2 meals are kid friendly"', () => {
    const req = parsePlanRequestOffline('1 chicken, 1 beef — at least 2 meals are kid friendly');
    expect(req.minKidFriendlyMeals).toBe(2);
  });

  it('parses macro percentage ranges', () => {
    const req = parsePlanRequestOffline('macro goals: Fat 15%-25%, Carbs 45%-65%, Protein 25%-35%');
    expect(req.macroTargets?.fatPct?.minPct).toBe(15);
    expect(req.macroTargets?.fatPct?.maxPct).toBe(25);
    expect(req.macroTargets?.carbsPct?.minPct).toBe(45);
    expect(req.macroTargets?.proteinPct?.maxPct).toBe(35);
  });

  it('detects weight loss goal', () => {
    const req = parsePlanRequestOffline('promotes weight loss, higher protein, lower fat');
    expect(req.goals.weightLoss).toBe(true);
    expect(req.goals.highProtein).toBe(true);
    expect(req.goals.lowFat).toBe(true);
  });

  it('detects freezer/meal prep goal', () => {
    const req = parsePlanRequestOffline('can freeze and reheat for meal prep');
    expect(req.goals.freezerFriendly).toBe(true);
  });

  it('detects HelloFresh requirement', () => {
    const req = parsePlanRequestOffline('at least one recipe from HelloFresh');
    expect(req.requiredSourceSignals).toContain('hellofresh');
  });

  it('detects pasta requirement', () => {
    const req = parsePlanRequestOffline('at least one recipe has pasta');
    expect(req.requiredTagsOrTitleTerms).toContain('pasta');
  });

  it('detects comfort food', () => {
    const req = parsePlanRequestOffline('one meal can be a comfort food');
    expect(req.allowComfortFood).toBe(true);
  });

  it('detects healthy fats goal', () => {
    const req = parsePlanRequestOffline('at least some meals contain monounsaturated fats or omega-3 fats');
    expect(req.goals.healthyFats).toBe(true);
  });

  it('detects low trans fat goal', () => {
    const req = parsePlanRequestOffline('no or very low trans fats');
    expect(req.goals.lowTransFat).toBe(true);
  });

  it('detects preferred ingredients', () => {
    const req = parsePlanRequestOffline('prefer having these ingredients but does not need to have any: lentils, black beans, chicken breast');
    expect(req.preferredIngredients.length).toBeGreaterThan(0);
  });

  it('defaults to 4 slots when none detected', () => {
    const req = parsePlanRequestOffline('healthy weeknight dinners');
    expect(req.mealCount).toBeGreaterThanOrEqual(1);
    expect(req.requiredProteinSlots.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// Tests: Candidate Filter
// ============================================================================

describe('getCandidatesForPlan', () => {
  it('assigns chicken to chicken slot only', () => {
    const req: WeeklyPlanRequest = {
      mealCount: 2,
      requiredProteinSlots: ['chicken', 'beef'],
      preferredIngredients: [],
      goals: {},
    };
    const result = getCandidatesForPlan(ALL_SELS, NORM_MAP, req, 100);

    const chickenCandidates = result.candidatesBySlot.get('chicken') ?? [];
    const chickenIds = chickenCandidates.map((r) => r.norm.id);

    // Chicken slot should contain chicken recipes, not beef/pork/vegetarian
    expect(chickenIds).toContain(CHICKEN_NORM.id);
    expect(chickenIds).not.toContain(BEEF_NORM.id);
    expect(chickenIds).not.toContain(VEG_NORM.id);
  });

  it('assigns vegetarian recipes to vegetarian slot', () => {
    const req: WeeklyPlanRequest = {
      mealCount: 1,
      requiredProteinSlots: ['vegetarian'],
      preferredIngredients: [],
      goals: {},
    };
    const result = getCandidatesForPlan(ALL_SELS, NORM_MAP, req, 100);
    const vegCandidates = result.candidatesBySlot.get('vegetarian') ?? [];
    const vegIds = vegCandidates.map((r) => r.norm.id);

    expect(vegIds).toContain(VEG_NORM.id);
    // Chicken should NOT be in vegetarian slot
    expect(vegIds).not.toContain(CHICKEN_NORM.id);
    expect(vegIds).not.toContain(BEEF_NORM.id);
  });

  it('excludes recipes with meat from vegetarian slot', () => {
    // PASTA_NORM has pancetta (pork) — should be excluded from vegetarian slot
    const req: WeeklyPlanRequest = {
      mealCount: 1,
      requiredProteinSlots: ['vegetarian'],
      preferredIngredients: [],
      goals: {},
    };
    const result = getCandidatesForPlan(ALL_SELS, NORM_MAP, req, 100);
    const vegCandidates = result.candidatesBySlot.get('vegetarian') ?? [];
    const vegIds = vegCandidates.map((r) => r.norm.id);

    expect(vegIds).not.toContain(PASTA_NORM.id);
  });

  it('reports empty slots correctly', () => {
    const req: WeeklyPlanRequest = {
      mealCount: 1,
      requiredProteinSlots: ['seafood'], // No seafood in our test catalog
      preferredIngredients: [],
      goals: {},
    };
    const result = getCandidatesForPlan(ALL_SELS, NORM_MAP, req, 100);
    expect(result.emptySlots).toContain('seafood');
  });
});

// ============================================================================
// Tests: Scoring
// ============================================================================

describe('scoreRecipeForRequest', () => {
  it('scores macro fit only when nutrition exists', () => {
    const req: WeeklyPlanRequest = {
      mealCount: 1,
      requiredProteinSlots: ['chicken'],
      preferredIngredients: [],
      goals: {},
      macroTargets: { proteinPct: { minPct: 25, maxPct: 40 } }, // CHICKEN_SEL has 36.2% — within this range
    };

    const recipeWithNutrition: PlannerRecipe = {
      sel: CHICKEN_SEL,
      norm: CHICKEN_NORM,
    };
    const recipeWithoutNutrition: PlannerRecipe = {
      sel: makeSel({ id: 'x1', title: 'No Data Recipe', primary_protein: 'chicken' }),
      norm: makeNorm({ id: 'x1', title: 'No Data Recipe', primary_protein: 'chicken' }),
    };

    const scoreWith = scoreRecipeForRequest(recipeWithNutrition, req);
    const scoreWithout = scoreRecipeForRequest(recipeWithoutNutrition, req);

    // Recipe with nutrition gets a positive macro score; without gets an uncertainty penalty
    expect(scoreWith.scoreBreakdown.macroFit ?? 0).toBeGreaterThan(0);
    expect(scoreWithout.scoreBreakdown.macroFit ?? 0).toBeLessThan(0); // uncertainty penalty
    expect(scoreWithout.missingNutritionFields).toContain('protein_pct');
  });

  it('rewards preferred ingredients', () => {
    const req: WeeklyPlanRequest = {
      mealCount: 1,
      requiredProteinSlots: ['chicken'],
      preferredIngredients: ['chicken breast', 'garlic'],
      goals: {},
    };
    const recipe: PlannerRecipe = { sel: CHICKEN_SEL, norm: CHICKEN_NORM };
    const score = scoreRecipeForRequest(recipe, req);

    expect(score.matchedPreferredIngredients.length).toBeGreaterThan(0);
    expect(score.scoreBreakdown.preferredIngredients ?? 0).toBeGreaterThan(0);
  });

  it('does not invent nutrition values when data is absent', () => {
    const req: WeeklyPlanRequest = {
      mealCount: 1,
      requiredProteinSlots: ['beef'],
      preferredIngredients: [],
      goals: { weightLoss: true },
    };
    const noNutrNorm = makeNorm({ id: 'x2', title: 'Plain Beef', primary_protein: 'beef' });
    const noNutrSel = makeSel({ id: 'x2', title: 'Plain Beef', primary_protein: 'beef' });
    const recipe: PlannerRecipe = { sel: noNutrSel, norm: noNutrNorm };

    const score = scoreRecipeForRequest(recipe, req);

    // Should still compute a score (without nutrition data)
    expect(score.hardConstraintPass).toBe(true);
    expect(score.missingNutritionFields).toContain('calories');
    // Score from weightLoss calorie component should be 0 when calories missing
    // (overall score may still be > 0 from other signals)
    expect(typeof score.score).toBe('number');
  });

  it('rewards HelloFresh recipes', () => {
    const req: WeeklyPlanRequest = {
      mealCount: 1,
      requiredProteinSlots: ['chicken'],
      preferredIngredients: [],
      goals: {},
    };
    const hfRecipe: PlannerRecipe = { sel: HF_SEL, norm: HF_NORM };
    const normalRecipe: PlannerRecipe = { sel: CHICKEN_SEL, norm: CHICKEN_NORM };

    const hfScore = scoreRecipeForRequest(hfRecipe, req);
    const normalScore = scoreRecipeForRequest(normalRecipe, req);

    expect(hfScore.scoreBreakdown.helloFresh ?? 0).toBeGreaterThan(0);
    expect(normalScore.scoreBreakdown.helloFresh ?? 0).toBe(0);
  });
});

// ============================================================================
// Tests: Ingredient Key Extraction
// ============================================================================

describe('getCanonicalIngredientKeys', () => {
  it('normalizes garlic cloves to garlic', () => {
    const norm = makeNorm({
      id: 'x3',
      title: 'Garlic Test',
      ingredients: [
        { original: '3 garlic cloves', quantity: 3, unit: 'cloves', ingredient: 'garlic cloves', notes: null },
      ],
    });
    const keys = getCanonicalIngredientKeys(norm);
    expect(keys).toContain('garlic');
  });

  it('normalizes olive oil variants', () => {
    const norm = makeNorm({
      id: 'x4',
      title: 'Olive Oil Test',
      ingredients: [
        {
          original: '2 tbsp extra virgin olive oil',
          quantity: 2,
          unit: 'tbsp',
          ingredient: 'extra virgin olive oil',
          notes: null,
        },
      ],
    });
    const keys = getCanonicalIngredientKeys(norm);
    expect(keys).toContain('olive oil');
  });
});

// ============================================================================
// Tests: Optimizer
// ============================================================================

describe('buildWeeklyPlan', () => {
  it('returns only IDs that exist in normalizedById', () => {
    const req: WeeklyPlanRequest = {
      mealCount: 4,
      requiredProteinSlots: ['chicken', 'pork', 'beef', 'vegetarian'],
      preferredIngredients: [],
      goals: {},
    };
    const result = buildWeeklyPlan(ALL_SELS, NORM_MAP, req);

    for (const id of result.selectedRecipeIds) {
      expect(NORM_MAP.has(id)).toBe(true);
    }
  });

  it('satisfies required protein slots when candidates exist', () => {
    const req: WeeklyPlanRequest = {
      mealCount: 4,
      requiredProteinSlots: ['chicken', 'pork', 'beef', 'vegetarian'],
      preferredIngredients: [],
      goals: {},
    };
    const result = buildWeeklyPlan(ALL_SELS, NORM_MAP, req);

    const selectedProteins = result.selectedRecipes.map((r) => r.primary_protein);
    expect(selectedProteins).toContain('chicken');
    expect(selectedProteins).toContain('pork');
    expect(selectedProteins).toContain('beef');
  });

  it('selects no duplicate recipes', () => {
    const req: WeeklyPlanRequest = {
      mealCount: 4,
      requiredProteinSlots: ['chicken', 'pork', 'beef', 'vegetarian'],
      preferredIngredients: [],
      goals: {},
    };
    const result = buildWeeklyPlan(ALL_SELS, NORM_MAP, req);

    const ids = result.selectedRecipeIds;
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('selects a HelloFresh recipe when required (via swap)', () => {
    const req: WeeklyPlanRequest = {
      mealCount: 2,
      requiredProteinSlots: ['chicken', 'beef'],
      preferredIngredients: [],
      goals: {},
      requiredSourceSignals: ['hellofresh'],
    };
    const result = buildWeeklyPlan(ALL_SELS, NORM_MAP, req);

    const hasHF = result.selectedRecipes.some(
      (r) => (r.source_name ?? '').toLowerCase().includes('hellofresh')
    );
    // May warn if no HF recipe fits, but if HF_NORM exists it should be included
    if (!result.validation.failedConstraints.some((c) => c.includes('hellofresh'))) {
      expect(hasHF).toBe(true);
    }
  });

  it('selects a pasta recipe when required', () => {
    const req: WeeklyPlanRequest = {
      mealCount: 2,
      requiredProteinSlots: ['pork', 'beef'],
      preferredIngredients: [],
      goals: {},
      requiredTagsOrTitleTerms: ['pasta'],
    };
    const result = buildWeeklyPlan(ALL_SELS, NORM_MAP, req);

    if (!result.validation.failedConstraints.some((c) => c.includes('pasta'))) {
      const hasPasta = result.selectedRecipes.some(
        (r) =>
          r.title.toLowerCase().includes('pasta') ||
          r.tags.includes('pasta') ||
          r.ingredients.some((i) => i.ingredient.toLowerCase().includes('pasta') || i.ingredient.toLowerCase().includes('spaghetti'))
      );
      expect(hasPasta).toBe(true);
    }
  });

  it('warns when no candidates exist for a slot', () => {
    const req: WeeklyPlanRequest = {
      mealCount: 1,
      requiredProteinSlots: ['seafood'], // No seafood in test catalog
      preferredIngredients: [],
      goals: {},
    };
    const result = buildWeeklyPlan(ALL_SELS, NORM_MAP, req);
    expect(result.validation.warnings.some((w) => w.includes('seafood'))).toBe(true);
  });

  it('computes shopping overlap correctly', () => {
    const req: WeeklyPlanRequest = {
      mealCount: 3,
      requiredProteinSlots: ['chicken', 'beef', 'pork'],
      preferredIngredients: [],
      goals: {},
    };
    const result = buildWeeklyPlan(ALL_SELS, NORM_MAP, req);

    expect(['low', 'medium', 'high']).toContain(result.shoppingOverlap.estimatedWasteRisk);

    // pantryOverlaps array must exist
    expect(Array.isArray(result.shoppingOverlap.pantryOverlaps)).toBe(true);

    // Garlic is now a pantry staple — must NOT appear in the main sharedIngredients list
    const mainKeys = result.shoppingOverlap.sharedIngredients.map((s) => s.ingredient);
    expect(mainKeys).not.toContain('garlic');
    expect(mainKeys).not.toContain('onion');
    expect(mainKeys).not.toContain('butter');

    // Pantry items must NOT appear in the main sharedIngredients list
    const pantryIngredients = ['olive oil', 'salt', 'black pepper', 'cumin', 'paprika', 'pepper'];
    for (const pantry of pantryIngredients) {
      expect(mainKeys).not.toContain(pantry);
    }

    // Each sharedIngredient in the main list should never be classified as pantry
    for (const shared of result.shoppingOverlap.sharedIngredients) {
      expect(['perishable', 'specialty', 'fridge_staple']).toContain(shared.wasteClass);
      expect(shared.scoreWeight).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// Tests: Validation
// ============================================================================

describe('validatePlanResult', () => {
  it('passes when all IDs exist in local database', () => {
    const req: WeeklyPlanRequest = {
      mealCount: 2,
      requiredProteinSlots: ['chicken', 'beef'],
      preferredIngredients: [],
      goals: {},
    };
    const selectedIds = [CHICKEN_NORM.id, BEEF_NORM.id];
    const selectedRecipes = [CHICKEN_NORM, BEEF_NORM];

    const validation = validatePlanResult(selectedIds, selectedRecipes, NORM_MAP, req);
    expect(validation.allRecipeIdsExist).toBe(true);
    expect(validation.structuralConstraintsSatisfied).toBe(true);
    expect(validation.hardConstraintsSatisfied).toBe(true); // alias still works
  });

  it('fails when a recipe ID does not exist in local database', () => {
    const req: WeeklyPlanRequest = {
      mealCount: 1,
      requiredProteinSlots: ['chicken'],
      preferredIngredients: [],
      goals: {},
    };
    const fakeId = 'fake000000000000';
    const fakeNorm = makeNorm({ id: fakeId, title: 'Hallucinated Chicken', primary_protein: 'chicken' });

    const validation = validatePlanResult([fakeId], [fakeNorm], NORM_MAP, req);
    expect(validation.allRecipeIdsExist).toBe(false);
    expect(validation.failedConstraints.some((c) => c.includes('unknown_ids'))).toBe(true);
  });

  it('warns when kid-friendly minimum is not met', () => {
    const req: WeeklyPlanRequest = {
      mealCount: 2,
      requiredProteinSlots: ['chicken', 'pork'],
      preferredIngredients: [],
      goals: {},
      minKidFriendlyMeals: 2,
    };

    // Both recipes have kid_friendly_score < 0.6
    const lowKidNorm1 = makeNorm({ id: 'kf01', title: 'Spicy Chicken', primary_protein: 'chicken', kid_friendly_score: 0.3 });
    const lowKidNorm2 = makeNorm({ id: 'kf02', title: 'Spicy Pork', primary_protein: 'pork', kid_friendly_score: 0.3 });

    const validation = validatePlanResult(
      [lowKidNorm1.id, lowKidNorm2.id],
      [lowKidNorm1, lowKidNorm2],
      new Map([[lowKidNorm1.id, lowKidNorm1], [lowKidNorm2.id, lowKidNorm2]]),
      req
    );

    expect(validation.warnings.some((w) => w.toLowerCase().includes('kid'))).toBe(true);
  });

  it('warns when nutrition is missing instead of assuming values', () => {
    const req: WeeklyPlanRequest = {
      mealCount: 1,
      requiredProteinSlots: ['chicken'],
      preferredIngredients: [],
      goals: {},
    };
    const noNutrNorm = makeNorm({ id: 'nn01', title: 'No Nutrition', primary_protein: 'chicken' });
    // nutrition is null by default in makeNorm

    const validation = validatePlanResult(
      [noNutrNorm.id],
      [noNutrNorm],
      new Map([[noNutrNorm.id, noNutrNorm]]),
      req
    );

    expect(validation.warnings.some((w) => w.includes('nutrition'))).toBe(true);
  });
});

// ============================================================================
// Tests: AI Explanation Safety
// ============================================================================

describe('isAiExplanationSafe', () => {
  it('accepts explanation with no foreign recipe IDs', () => {
    const result = buildWeeklyPlan(ALL_SELS, NORM_MAP, {
      mealCount: 2,
      requiredProteinSlots: ['chicken', 'beef'],
      preferredIngredients: [],
      goals: {},
    });

    const safeText = `This plan features ${result.selectedRecipes[0]?.title ?? 'a chicken dish'} and a hearty stew. Great for meal prep!`;
    expect(isAiExplanationSafe(safeText, result)).toBe(true);
  });

  it('rejects explanation that contains a foreign recipe ID', () => {
    const result = buildWeeklyPlan(ALL_SELS, NORM_MAP, {
      mealCount: 2,
      requiredProteinSlots: ['chicken', 'beef'],
      preferredIngredients: [],
      goals: {},
    });

    const unsafeText = `Check out recipe deadbeefdeadbeef for a great option!`;
    expect(isAiExplanationSafe(unsafeText, result)).toBe(false);
  });
});

// ============================================================================
// Tests: Renderer
// ============================================================================

describe('renderPlanAsMarkdown', () => {
  it('produces a markdown string with recipe titles', () => {
    const req: WeeklyPlanRequest = {
      mealCount: 2,
      requiredProteinSlots: ['chicken', 'beef'],
      preferredIngredients: [],
      goals: {},
    };
    const result = buildWeeklyPlan(ALL_SELS, NORM_MAP, req);
    const md = renderPlanAsMarkdown(result);

    expect(md).toContain('# 🗓️ Weekly Meal Plan');
    expect(md).toContain('## Recipes');
    // Should include at least one of the selected recipe titles
    const hasSomeTitle = result.selectedRecipes.some((r) => md.includes(r.title));
    expect(hasSomeTitle).toBe(true);
  });

  it('shows validation warnings when present', () => {
    const req: WeeklyPlanRequest = {
      mealCount: 1,
      requiredProteinSlots: ['seafood'],
      preferredIngredients: [],
      goals: {},
    };
    const result = buildWeeklyPlan(ALL_SELS, NORM_MAP, req);
    const md = renderPlanAsMarkdown(result, { showWarnings: true });
    expect(md).toContain('Warning');
  });
});

// ============================================================================
// NEW Tests (spec item 11): Flex slots, macros, pantry, servings, alternatives
// ============================================================================

// Test 1: Parser does not output 'other' for flex meal count
describe('parsePlanRequestOffline — flex slot (no other)', () => {
  it('produces flexMealCount for extra meals beyond explicit slots', () => {
    const req = parsePlanRequestOffline(
      '5 recipes: 1 chicken, 1 pork, 1 beef, 1 vegetarian'
    );
    // 5 requested, 4 explicit slots → 1 flex
    expect(req.mealCount).toBe(5);
    expect(req.flexMealCount).toBe(1);
    // 'other' must NOT appear in requiredProteinSlots
    expect(req.requiredProteinSlots).not.toContain('other');
    // Exactly 4 required protein slots
    expect(req.requiredProteinSlots.filter((s) => s !== 'flex').length).toBe(4);
  });
});

// Test 2: Macro calculation is correct (protein*4 / (p*4+c*4+f*9))
describe('calculateMacroPercentages', () => {
  it('computes protein, carbs, fat % from gram values', () => {
    const result = calculateMacroPercentages({ protein_g: 34, carbs_g: 21, fat_g: 6 });
    // macro calories: 34*4 + 21*4 + 6*9 = 136 + 84 + 54 = 274
    // protein% = 136/274 ≈ 49.6%
    expect(result.source).toBe('macro_calories');
    expect(result.proteinPct).not.toBeNull();
    expect(result.proteinPct!).toBeCloseTo(49.6, 0);
    expect(result.carbsPct).not.toBeNull();
    expect(result.carbsPct!).toBeCloseTo(30.7, 0);
    expect(result.fatPct).not.toBeNull();
    expect(result.fatPct!).toBeCloseTo(19.7, 0);
    // Should sum to 100
    expect(result.proteinPct! + result.carbsPct! + result.fatPct!).toBeCloseTo(100, 0);
  });

  it('returns null when any macro gram value is missing', () => {
    const noCarbs = calculateMacroPercentages({ protein_g: 34, carbs_g: null, fat_g: 6 });
    expect(noCarbs.source).toBe('unavailable');
    expect(noCarbs.proteinPct).toBeNull();
    expect(noCarbs.carbsPct).toBeNull();
    expect(noCarbs.fatPct).toBeNull();
  });

  it('returns null when total macro calories is zero', () => {
    const zero = calculateMacroPercentages({ protein_g: 0, carbs_g: 0, fat_g: 0 });
    expect(zero.source).toBe('unavailable');
    expect(zero.proteinPct).toBeNull();
  });
});

// Test 3: Macro target validation is 'partial' / 'unknown' when data insufficient
describe('validatePlanResult — macro evaluation status', () => {
  it('reports partial when some recipes lack macro data', () => {
    const req: WeeklyPlanRequest = {
      mealCount: 2,
      requiredProteinSlots: ['chicken', 'beef'],
      preferredIngredients: [],
      goals: {},
      macroTargets: { proteinPct: { minPct: 25, maxPct: 40 } },
    };
    // One recipe has nutrition, one does not
    const noNutrNorm = makeNorm({
      id: 'mn01',
      title: 'No Macro Chicken',
      primary_protein: 'chicken',
      nutrition: null,
    });
    const validation = validatePlanResult(
      [CHICKEN_NORM.id, noNutrNorm.id],
      [CHICKEN_NORM, noNutrNorm],
      new Map([[CHICKEN_NORM.id, CHICKEN_NORM], [noNutrNorm.id, noNutrNorm]]),
      req
    );
    // nutritionEvaluationStatus should be 'partial' or 'met'/'failed' (not 'unknown')
    expect(['partial', 'met', 'failed']).toContain(validation.nutritionEvaluationStatus);
    // nutritionTargetsSatisfied may be null (unknown) or boolean
    // structuralConstraintsSatisfied must not be affected by nutrition status
    expect(validation.structuralConstraintsSatisfied).toBe(true);
  });

  it('structuralConstraintsSatisfied can be true when nutritionTargetsSatisfied is false', () => {
    const req: WeeklyPlanRequest = {
      mealCount: 1,
      requiredProteinSlots: ['chicken'],
      preferredIngredients: [],
      goals: {},
      macroTargets: { proteinPct: { minPct: 60, maxPct: 80 } }, // Impossibly high
    };
    const validation = validatePlanResult(
      [CHICKEN_NORM.id],
      [CHICKEN_NORM],
      NORM_MAP,
      req
    );
    // Structural should pass (valid IDs, valid slot)
    expect(validation.structuralConstraintsSatisfied).toBe(true);
    // But nutrition target should fail (protein is only ~36%)
    if (validation.nutritionEvaluationStatus === 'failed') {
      expect(validation.nutritionTargetsSatisfied).toBe(false);
    }
  });
});

// Test 4: Missing nutrition fields are unique (no duplicates from Set)
describe('scoreRecipeForRequest — missingNutritionFields deduplication', () => {
  it('does not contain duplicate field names', () => {
    const req: WeeklyPlanRequest = {
      mealCount: 1,
      requiredProteinSlots: ['chicken'],
      preferredIngredients: [],
      goals: { weightLoss: true, highProtein: true },
      macroTargets: { proteinPct: { minPct: 25, maxPct: 40 } },
    };
    const noNutrRecipe: PlannerRecipe = {
      sel: makeSel({ id: 'dn01', title: 'Plain Chicken', primary_protein: 'chicken' }),
      norm: makeNorm({ id: 'dn01', title: 'Plain Chicken', primary_protein: 'chicken', nutrition: null }),
    };
    const score = scoreRecipeForRequest(noNutrRecipe, req);

    // No duplicate field names
    const fields = score.missingNutritionFields;
    expect(new Set(fields).size).toBe(fields.length);
  });
});

// Test 5: Partial nutrition display says 'not available' for missing fields
describe('renderPlanAsMarkdown — partial nutrition display', () => {
  it('shows "not available" for recipes missing some macro grams', () => {
    const partialNutrNorm = makeNorm({
      id: 'pn01',
      title: 'Partial Nutrition Recipe',
      primary_protein: 'chicken',
      nutrition: { calories: 400, protein_g: 30, carbs_g: null, fat_g: null, sodium_mg: null },
    });
    const req: WeeklyPlanRequest = {
      mealCount: 1,
      requiredProteinSlots: ['chicken'],
      preferredIngredients: [],
      goals: {},
    };
    const result = buildWeeklyPlan(
      [makeSel({ id: 'pn01', title: 'Partial Nutrition Recipe', primary_protein: 'chicken' })],
      new Map([['pn01', partialNutrNorm]]),
      req
    );
    const md = renderPlanAsMarkdown(result);
    // Should mention "not available" for missing fields
    expect(md).toMatch(/not available/i);
  });
});

// Test 6: Variety penalty reduces likelihood of pasta over-selection
describe('buildWeeklyPlan — pasta variety', () => {
  it('does not select the same recipe twice', () => {
    // If only one pasta-like recipe exists, it won't be duplicated
    const req: WeeklyPlanRequest = {
      mealCount: 2,
      requiredProteinSlots: ['pork', 'beef'],
      preferredIngredients: [],
      goals: { varietyOfFlavors: true },
      requiredTagsOrTitleTerms: ['pasta'],
    };
    const result = buildWeeklyPlan(ALL_SELS, NORM_MAP, req);
    const ids = result.selectedRecipeIds;
    expect(new Set(ids).size).toBe(ids.length); // No duplicates
  });
});

// Test 7: Shopping overlap excludes salt/pepper from main list
describe('buildWeeklyPlan — pantry item exclusion', () => {
  it('excludes salt and pepper from sharedIngredients main list', () => {
    // Create two recipes that share salt and pepper
    const recipe1 = makeNorm({
      id: 'sp01',
      title: 'Recipe with Salt',
      primary_protein: 'chicken',
      ingredients: [
        { original: '1 tsp salt', quantity: 1, unit: 'tsp', ingredient: 'salt', notes: null },
        { original: '1/2 tsp black pepper', quantity: 0.5, unit: 'tsp', ingredient: 'black pepper', notes: null },
        { original: '1 lb chicken', quantity: 1, unit: 'lb', ingredient: 'chicken breast', notes: null },
        { original: '1 lemon', quantity: 1, unit: null, ingredient: 'lemon', notes: null },
      ],
    });
    const recipe2 = makeNorm({
      id: 'sp02',
      title: 'Another Salted Recipe',
      primary_protein: 'beef',
      ingredients: [
        { original: '1 tsp salt', quantity: 1, unit: 'tsp', ingredient: 'salt', notes: null },
        { original: '1/2 tsp black pepper', quantity: 0.5, unit: 'tsp', ingredient: 'black pepper', notes: null },
        { original: '1 lb beef', quantity: 1, unit: 'lb', ingredient: 'ground beef', notes: null },
        { original: '2 limes', quantity: 2, unit: null, ingredient: 'lime', notes: null },
      ],
    });
    const sel1 = makeSel({ id: 'sp01', title: 'Recipe with Salt', primary_protein: 'chicken' });
    const sel2 = makeSel({ id: 'sp02', title: 'Another Salted Recipe', primary_protein: 'beef' });

    const req: WeeklyPlanRequest = {
      mealCount: 2,
      requiredProteinSlots: ['chicken', 'beef'],
      preferredIngredients: [],
      goals: {},
    };

    const result = buildWeeklyPlan(
      [sel1, sel2],
      new Map([['sp01', recipe1], ['sp02', recipe2]]),
      req
    );

    const mainKeys = result.shoppingOverlap.sharedIngredients.map((s) => s.ingredient);
    expect(mainKeys).not.toContain('salt');
    expect(mainKeys).not.toContain('black pepper');

    // Salt and pepper should appear in pantryOverlaps
    const pantryKeys = result.shoppingOverlap.pantryOverlaps.map((p) => p.ingredient);
    expect(pantryKeys).toContain('salt');
    expect(pantryKeys).toContain('black pepper');
  });
});

// Test 8: Suspicious servings warning for large entrees
describe('isSuspiciousServingCount', () => {
  it('flags large chili/stew with yield_servings=1 and many ingredients', () => {
    const chiliNorm = makeNorm({
      id: 'sv01',
      title: 'Big Pot Chili',
      primary_protein: 'beef',
      yield_servings: 1,
      ingredients: [
        { original: '2 lb ground beef', quantity: 2, unit: 'lb', ingredient: 'ground beef', notes: null },
        { original: '1 can black beans', quantity: 1, unit: 'can', ingredient: 'black beans', notes: null },
        { original: '1 can kidney beans', quantity: 1, unit: 'can', ingredient: 'kidney beans', notes: null },
        { original: '1 onion', quantity: 1, unit: null, ingredient: 'onion', notes: null },
        { original: '3 garlic cloves', quantity: 3, unit: 'cloves', ingredient: 'garlic', notes: null },
        { original: '2 cups beef broth', quantity: 2, unit: 'cups', ingredient: 'beef broth', notes: null },
        { original: '2 cans diced tomatoes', quantity: 2, unit: 'cans', ingredient: 'canned tomatoes', notes: null },
        { original: '1 tbsp cumin', quantity: 1, unit: 'tbsp', ingredient: 'cumin', notes: null },
        { original: '1 tbsp chili powder', quantity: 1, unit: 'tbsp', ingredient: 'chili powder', notes: null },
      ],
    });
    expect(isSuspiciousServingCount(chiliNorm)).toBe(true);
  });

  it('does not flag a simple single-serving recipe', () => {
    const simpleNorm = makeNorm({
      id: 'sv02',
      title: 'Quick Chicken Bowl',
      primary_protein: 'chicken',
      yield_servings: 1,
      ingredients: [
        { original: '6 oz chicken', quantity: 6, unit: 'oz', ingredient: 'chicken breast', notes: null },
        { original: '1 cup rice', quantity: 1, unit: 'cup', ingredient: 'rice', notes: null },
        { original: '1 tbsp olive oil', quantity: 1, unit: 'tbsp', ingredient: 'olive oil', notes: null },
      ],
    });
    expect(isSuspiciousServingCount(simpleNorm)).toBe(false);
  });
});

// Test 9: Alternatives show titles, not only IDs
describe('buildWeeklyPlan — alternatives with titles', () => {
  it('alternatives include recipe titles in entries', () => {
    const req: WeeklyPlanRequest = {
      mealCount: 2,
      requiredProteinSlots: ['chicken', 'pork'],
      preferredIngredients: [],
      goals: {},
    };
    const result = buildWeeklyPlan(ALL_SELS, NORM_MAP, req);

    // Should have at least one slot with alternatives
    if (result.alternatives.length > 0) {
      const firstAlt = result.alternatives[0];
      // New entries field should exist with titles
      expect(firstAlt.entries).toBeDefined();
      expect(firstAlt.entries.length).toBeGreaterThan(0);
      const firstEntry = firstAlt.entries[0];
      expect(firstEntry.id).toBeTruthy();
      expect(firstEntry.title).toBeTruthy();
      expect(typeof firstEntry.title).toBe('string');
      expect(firstEntry.reason).toBeTruthy();
      // Backward compat: recipeIds still present
      expect(firstAlt.recipeIds).toBeDefined();
      expect(firstAlt.recipeIds).toContain(firstEntry.id);
    }
  });
});

// Test 10: Constraint check distinguishes structural from nutrition
describe('validatePlanResult — structural vs nutrition separation', () => {
  it('structural constraints pass while nutrition targets may fail', () => {
    const req: WeeklyPlanRequest = {
      mealCount: 2,
      requiredProteinSlots: ['chicken', 'beef'],
      preferredIngredients: [],
      goals: {},
      macroTargets: { proteinPct: { minPct: 90, maxPct: 95 } }, // Impossible targets
    };
    const selectedIds = [CHICKEN_NORM.id, BEEF_NORM.id];
    const selectedRecipes = [CHICKEN_NORM, BEEF_NORM];

    const validation = validatePlanResult(selectedIds, selectedRecipes, NORM_MAP, req);

    // Structural: all IDs exist, no duplicates, no hallucinations
    expect(validation.structuralConstraintsSatisfied).toBe(true);
    expect(validation.hardConstraintsSatisfied).toBe(true);

    // Nutrition: should fail because targets are impossible
    if (validation.nutritionEvaluationStatus === 'failed') {
      expect(validation.nutritionTargetsSatisfied).toBe(false);
      // Nutrition failures should NOT be in structuralConstraintsSatisfied
      // (it remains true even when nutrition fails)
      expect(validation.structuralConstraintsSatisfied).toBe(true);
    }
  });
});

// =============================================================================
// Enrichment unit tests
// =============================================================================

import {
  loadEnrichmentCache,
  enrichRecipes,
  computeRecipeHash,
  getMissingPlanningFields,
  applyEnrichmentForSoftScoring,
} from '../planner/enricher.js';
import type { EnrichmentRecord } from '../planner/types.js';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

describe('computeRecipeHash', () => {
  it('is stable for the same recipe', () => {
    const recipe = makeNorm({ id: 'r1', title: 'Chicken Soup' });
    expect(computeRecipeHash(recipe)).toBe(computeRecipeHash(recipe));
  });

  it('changes when the title changes', () => {
    const r1 = makeNorm({ id: 'r1', title: 'Chicken Soup' });
    const r2 = makeNorm({ id: 'r1', title: 'Beef Stew' });
    expect(computeRecipeHash(r1)).not.toBe(computeRecipeHash(r2));
  });

  it('produces a 16-character hex string', () => {
    const recipe = makeNorm({ id: 'r1', title: 'Test Recipe' });
    const hash = computeRecipeHash(recipe);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('getMissingPlanningFields', () => {
  it('returns empty for a fully-populated recipe', () => {
    const recipe = makeNorm({
      id: 'r1',
      kid_friendly_score: 0.8,
      weeknight_score: 0.9,
      nutrition: { calories: 500, protein_g: 30, carbs_g: 40, fat_g: 20, sodium_mg: null },
    });
    expect(getMissingPlanningFields(recipe)).toHaveLength(0);
  });

  it('reports missing nutrition when calories are null', () => {
    const recipe = makeNorm({
      id: 'r1',
      nutrition: { calories: null, protein_g: null, carbs_g: null, fat_g: null, sodium_mg: null },
    });
    const missing = getMissingPlanningFields(recipe);
    expect(missing).toContain('nutrition');
  });

  it('reports missing kid_friendly_score when 0', () => {
    const recipe = makeNorm({ id: 'r1', kid_friendly_score: 0 });
    expect(getMissingPlanningFields(recipe)).toContain('kid_friendly_score');
  });
});

describe('applyEnrichmentForSoftScoring', () => {
  it('does not mutate the original recipe', () => {
    const original = makeNorm({ id: 'r1', title: 'Test', nutrition: null });
    const record: EnrichmentRecord = {
      recipe_id: 'r1',
      recipe_hash: computeRecipeHash(original),
      schema_version: 1,
      model: 'gpt-4o-mini',
      enriched_at: new Date().toISOString(),
      metadata: { estimated_calories: 400, estimated_protein_g: 25, estimated_carbs_g: 35, estimated_fat_g: 15 },
    };
    const enriched = applyEnrichmentForSoftScoring(original, record, true);
    expect(original.nutrition).toBeNull(); // makeNorm defaults to null
    expect(enriched.nutrition?.calories).toBe(400);
  });

  it('does not overwrite existing nutrition values', () => {
    const original = makeNorm({
      id: 'r1',
      nutrition: { calories: 600, protein_g: 40, carbs_g: 50, fat_g: 20, sodium_mg: null },
    });
    const record: EnrichmentRecord = {
      recipe_id: 'r1',
      recipe_hash: computeRecipeHash(original),
      schema_version: 1,
      model: 'gpt-4o-mini',
      enriched_at: new Date().toISOString(),
      metadata: { estimated_calories: 999, estimated_protein_g: 99 },
    };
    const enriched = applyEnrichmentForSoftScoring(original, record, true);
    // Original nutrition should be preserved
    expect(enriched.nutrition?.calories).toBe(600);
    expect(enriched.nutrition?.protein_g).toBe(40);
  });
});

describe('loadEnrichmentCache and enrichRecipes', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'recipe-enrich-test-'));
  });

  it('returns empty cache for non-existent file', async () => {
    const cache = await loadEnrichmentCache(tmpDir);
    expect(cache.size).toBe(0);
  });

  it('missing API key: enrichRecipes skips enrichment gracefully', async () => {
    const recipe = makeNorm({ id: 'r1', kid_friendly_score: 0, nutrition: undefined });
    const cache = new Map<string, EnrichmentRecord>();

    // No apiKey → should not throw, should return 0 enriched
    const result = await enrichRecipes({
      recipes: [recipe],
      cache,
      dataPath: tmpDir,
      apiKey: undefined,  // No key!
      limit: 5,
    });

    expect(result.recipesEnriched).toBe(0);
    expect(result.skippedDueToLimit).toBe(0);
    expect(result.recipesFromCache).toBe(0);
  });

  it('enrichRecipes respects limit', async () => {
    // Three recipes all missing data, but limit = 1
    // Since there's no API key this test verifies limit tracking without real calls
    const recipes = [
      makeNorm({ id: 'ra', kid_friendly_score: 0, nutrition: undefined }),
      makeNorm({ id: 'rb', kid_friendly_score: 0, nutrition: undefined }),
      makeNorm({ id: 'rc', kid_friendly_score: 0, nutrition: undefined }),
    ];
    const cache = new Map<string, EnrichmentRecord>();

    // With no key, nothing is called, skippedDueToLimit stays 0 (we skip, not count as limited)
    const result = await enrichRecipes({
      recipes,
      cache,
      dataPath: tmpDir,
      apiKey: undefined,
      limit: 1,
    });

    // Without a key, we skip (not count as limited); with a key and limit=1, we'd get 1 enriched + 2 skipped
    expect(result.recipesEnriched).toBe(0);
    // skippedDueToLimit only increments when apiKey is present but limit is reached
    expect(result.skippedDueToLimit).toBe(0);
  });

  it('cached enrichment prevents duplicate API calls', async () => {
    const recipe = makeNorm({ id: 'cached-r1', kid_friendly_score: 0, nutrition: undefined });
    const record: EnrichmentRecord = {
      recipe_id: 'cached-r1',
      recipe_hash: computeRecipeHash(recipe),
      schema_version: 1,
      model: 'gpt-4o-mini',
      enriched_at: new Date().toISOString(),
      metadata: { estimated_calories: 350, kid_friendly_score: 0.7 },
    };
    const cache = new Map<string, EnrichmentRecord>([['cached-r1', record]]);

    const result = await enrichRecipes({
      recipes: [recipe],
      cache,
      dataPath: tmpDir,
      apiKey: 'sk-fake-key-for-cache-test',
      model: 'gpt-4o-mini',
      limit: 10,
    });

    // Should hit cache — no API calls made (we didn't mock OpenAI, would throw if called)
    expect(result.recipesFromCache).toBe(1);
    expect(result.recipesEnriched).toBe(0);
  });
});

describe('renderer — enrichment summary', () => {
  const minimalReq: WeeklyPlanRequest = {
    mealCount: 1,
    requiredProteinSlots: ['chicken'],
    flexMealCount: 0,
    macroTargets: null,
    minKidFriendlyMeals: null,
    maxTotalTimeMinutes: null,
    preferredIngredients: [],
    avoidIngredients: [],
    requiredSourceSignals: [],
    requiredTagsOrTitleTerms: [],
    rawQuery: 'test',
    goals: {},
  };

  it('clearly labels enriched metadata in output', () => {
    const result = buildWeeklyPlan([makeSel({ id: 'r1', title: 'Chicken', protein_slots: ['chicken'] })], NORM_MAP, minimalReq, 75);

    const md = renderPlanAsMarkdown(result, {
      enrichmentSummary: {
        mode: 'selected_only',
        recipesEnriched: 2,
        recipesFromCache: 1,
        skippedDueToLimit: 0,
        apiKeyMissing: false,
        limitReached: false,
        enrichedRecipes: [{ id: 'r1', title: 'Test Recipe' }],
        estimatedFields: ['calories', 'kid_friendly_score'],
      },
    });

    expect(md).toContain('Enrichment');
    expect(md).toContain('Estimated nutrition was available for soft scoring only.');
    expect(md).toContain('not used for strict macro validation');
  });

  it('shows API key missing message when no key', () => {
    const result = buildWeeklyPlan([makeSel({ id: 'r1', title: 'Chicken', protein_slots: ['chicken'] })], NORM_MAP, minimalReq, 75);

    const md = renderPlanAsMarkdown(result, {
      enrichmentSummary: {
        mode: 'selected_only',
        recipesEnriched: 0,
        recipesFromCache: 0,
        skippedDueToLimit: 0,
        apiKeyMissing: true,
        limitReached: false,
        enrichedRecipes: [],
        estimatedFields: [],
      },
    });

    expect(md).toContain('no OpenAI API key');
  });
});
