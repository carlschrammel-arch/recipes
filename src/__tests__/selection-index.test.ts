/**
 * Tests for Selection Index - Tag Heuristics and Macro Calculations
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeSourceName,
  isHelloFresh,
  isPastaRecipe,
  isComfortFood,
  isFreezerFriendlyGuess,
  isFreezerCandidateHeuristic,
  isVegetarian,
  isVegan,
  calculateMacros,
  getKidFriendlyBucket,
  getWeeknightBucket,
  getSpiceLevelLabel,
  getNutritionProfile,
  getReheatQuality,
  buildSelectionRecord,
  validateSelectionRecords,
  generateDataQualityReport,
} from '../selection-index.js';
import type { NormalizedRecipe } from '../types.js';

// Helper to create a minimal recipe for testing
function createRecipe(overrides: Partial<NormalizedRecipe> = {}): NormalizedRecipe {
  return {
    id: 'test123',
    title: 'Test Recipe',
    source_name: null,
    source_url: null,
    yield_servings: 4,
    prep_time_minutes: 15,
    cook_time_minutes: 30,
    total_time_minutes: 45,
    ingredients: [],
    instructions: ['Cook it'],
    tags: [],
    notes: null,
    nutrition: null,
    cuisine: null,
    meal_type: 'dinner',
    kid_friendly_score: 0.5,
    weeknight_score: 0.5,
    spice_level: 0,
    equipment: [],
    primary_protein: 'other',
    cost_tier: 'medium',
    duplicate_group_id: null,
    parse_warnings: [],
    source_file: '/test/recipe.txt',
    imported_at: new Date().toISOString(),
    ...overrides,
  };
}

// ============================================================================
// Source Normalization Tests
// ============================================================================

describe('normalizeSourceName', () => {
  it('should normalize HelloFresh variations', () => {
    expect(normalizeSourceName('hellofresh.com', null)).toBe('HelloFresh');
    expect(normalizeSourceName('HelloFresh', null)).toBe('HelloFresh');
    expect(normalizeSourceName(null, 'https://www.hellofresh.com/recipe/123')).toBe('HelloFresh');
    expect(normalizeSourceName(null, 'https://hellofresh.ca/recipe/123')).toBe('HelloFresh');
  });

  it('should normalize other common sources', () => {
    expect(normalizeSourceName('budgetbytes.com', null)).toBe('Budget Bytes');
    expect(normalizeSourceName(null, 'https://www.allrecipes.com/recipe/123')).toBe('AllRecipes');
    expect(normalizeSourceName('Serious Eats', null)).toBe('Serious Eats');
  });

  it('should return cleaned hostname for unknown sources', () => {
    expect(normalizeSourceName(null, 'https://example.com/recipe')).toBe('example.com');
  });

  it('should return Unknown for null inputs', () => {
    expect(normalizeSourceName(null, null)).toBe('Unknown');
  });
});

// ============================================================================
// HelloFresh Detection Tests
// ============================================================================

describe('isHelloFresh', () => {
  it('should detect HelloFresh from source_name', () => {
    const recipe = createRecipe({ source_name: 'hellofresh.com' });
    expect(isHelloFresh(recipe)).toBe(true);
  });

  it('should detect HelloFresh from source_url', () => {
    const recipe = createRecipe({ source_url: 'https://www.hellofresh.com/recipe/123' });
    expect(isHelloFresh(recipe)).toBe(true);
  });

  it('should detect HelloFresh from tags', () => {
    const recipe = createRecipe({ tags: ['dinner', 'hellofresh'] });
    expect(isHelloFresh(recipe)).toBe(true);
  });

  it('should return false for non-HelloFresh recipes', () => {
    const recipe = createRecipe({ source_name: 'allrecipes.com' });
    expect(isHelloFresh(recipe)).toBe(false);
  });
});

// ============================================================================
// Pasta Detection Tests
// ============================================================================

describe('isPastaRecipe', () => {
  it('should detect pasta from title', () => {
    expect(isPastaRecipe(createRecipe({ title: 'Spaghetti Carbonara' })).result).toBe(true);
    expect(isPastaRecipe(createRecipe({ title: 'Baked Ziti' })).result).toBe(true);
    expect(isPastaRecipe(createRecipe({ title: 'Beef Stroganoff with Noodles' })).result).toBe(true);
  });

  it('should detect pasta from ingredients', () => {
    const recipe = createRecipe({
      title: 'Creamy Chicken Dinner',
      ingredients: [
        { original: '1 lb penne', quantity: 1, unit: 'lb', ingredient: 'penne', notes: null },
      ],
    });
    expect(isPastaRecipe(recipe).result).toBe(true);
  });

  it('should detect pasta from tags', () => {
    const recipe = createRecipe({ tags: ['pasta', 'italian'] });
    expect(isPastaRecipe(recipe).result).toBe(true);
  });

  it('should return false for non-pasta dishes', () => {
    expect(isPastaRecipe(createRecipe({ title: 'Grilled Chicken' })).result).toBe(false);
  });

  it('should detect Asian noodle dishes', () => {
    expect(isPastaRecipe(createRecipe({ title: 'Pad Thai' })).result).toBe(true);
    expect(isPastaRecipe(createRecipe({ title: 'Ramen Bowl' })).result).toBe(true);
    expect(isPastaRecipe(createRecipe({ title: 'Chicken Lo Mein' })).result).toBe(true);
  });

  it('should return inference reason', () => {
    const result = isPastaRecipe(createRecipe({ title: 'Spaghetti Carbonara' }));
    expect(result.reason).toBe('title_contains_spaghetti');
  });
});

// ============================================================================
// Comfort Food Detection Tests
// ============================================================================

describe('isComfortFood', () => {
  it('should detect comfort food from title keywords', () => {
    expect(isComfortFood(createRecipe({ title: 'Mac and Cheese' }))).toBe(true);
    expect(isComfortFood(createRecipe({ title: 'Beef Stroganoff' }))).toBe(true);
    expect(isComfortFood(createRecipe({ title: 'Chicken Pot Pie' }))).toBe(true);
    expect(isComfortFood(createRecipe({ title: 'Classic Chili' }))).toBe(true);
  });

  it('should detect comfort food from tags', () => {
    const recipe = createRecipe({ tags: ['comfort food', 'dinner'] });
    expect(isComfortFood(recipe)).toBe(true);
  });

  it('should detect comfort food from multiple creamy ingredients', () => {
    const recipe = createRecipe({
      title: 'Creamy Chicken',
      ingredients: [
        { original: '1 cup heavy cream', quantity: 1, unit: 'cup', ingredient: 'heavy cream', notes: null },
        { original: '4 oz cream cheese', quantity: 4, unit: 'oz', ingredient: 'cream cheese', notes: null },
      ],
    });
    expect(isComfortFood(recipe)).toBe(true);
  });

  it('should return false for non-comfort food', () => {
    expect(isComfortFood(createRecipe({ title: 'Grilled Salmon with Asparagus' }))).toBe(false);
  });
});

// ============================================================================
// Freezer-Friendly Detection Tests
// ============================================================================

describe('isFreezerFriendlyGuess', () => {
  it('should detect freezer-friendly from title (as candidate)', () => {
    // Heuristic matches return 'unknown' with a reason - they're candidates, not confirmed
    expect(isFreezerFriendlyGuess(createRecipe({ title: 'Beef Stew' })).result).toBe('unknown');
    expect(isFreezerFriendlyGuess(createRecipe({ title: 'Chicken Soup' })).result).toBe('unknown');
    expect(isFreezerFriendlyGuess(createRecipe({ title: 'Vegetable Curry' })).result).toBe('unknown');
  });

  it('should mark salads as not freezer-friendly', () => {
    const result = isFreezerFriendlyGuess(createRecipe({ title: 'Caesar Salad' }));
    expect(result.result).toBe('no');
    expect(result.reason).toBe('title_contains_salad');
  });

  it('should detect from explicit notes', () => {
    const recipe = createRecipe({
      title: 'Meatballs',
      notes: 'Can be frozen for up to 3 months.',
    });
    const result = isFreezerFriendlyGuess(recipe);
    expect(result.result).toBe('yes');
    expect(result.reason).toBe('notes_mention_freezer');
  });

  it('should return unknown for ambiguous recipes', () => {
    const result = isFreezerFriendlyGuess(createRecipe({ title: 'Chicken Dinner' }));
    expect(result.result).toBe('unknown');
    expect(result.reason).toBeNull();
  });

  it('should detect freezer tag', () => {
    const result = isFreezerFriendlyGuess(createRecipe({ tags: ['freezer-friendly'] }));
    expect(result.result).toBe('yes');
    expect(result.reason).toBe('tag_freezer');
  });
});

// ============================================================================
// Vegetarian/Vegan Detection Tests
// ============================================================================

describe('isVegetarian', () => {
  it('should return true for vegetarian proteins', () => {
    expect(isVegetarian(createRecipe({ primary_protein: 'vegetarian' }))).toBe(true);
    expect(isVegetarian(createRecipe({ primary_protein: 'tofu' }))).toBe(true);
    expect(isVegetarian(createRecipe({ primary_protein: 'legumes' }))).toBe(true);
    expect(isVegetarian(createRecipe({ primary_protein: 'eggs' }))).toBe(true);
  });

  it('should return false for meat proteins', () => {
    expect(isVegetarian(createRecipe({ primary_protein: 'chicken' }))).toBe(false);
    expect(isVegetarian(createRecipe({ primary_protein: 'beef' }))).toBe(false);
    expect(isVegetarian(createRecipe({ primary_protein: 'fish' }))).toBe(false);
  });

  it('should detect from tags', () => {
    const recipe = createRecipe({ primary_protein: 'other', tags: ['vegetarian'] });
    expect(isVegetarian(recipe)).toBe(true);
  });
});

describe('isVegan', () => {
  it('should detect vegan from tags', () => {
    const recipe = createRecipe({ tags: ['vegan', 'dinner'] });
    expect(isVegan(recipe)).toBe(true);
  });

  it('should return false for eggs protein', () => {
    expect(isVegan(createRecipe({ primary_protein: 'eggs' }))).toBe(false);
  });

  it('should return false when not explicitly tagged', () => {
    expect(isVegan(createRecipe({ primary_protein: 'vegetarian' }))).toBe(false);
  });
});

// ============================================================================
// Macro Calculation Tests
// ============================================================================

describe('calculateMacros', () => {
  it('should calculate macros when all values present', () => {
    const recipe = createRecipe({
      nutrition: {
        calories: 500,
        protein_g: 30,
        carbs_g: 50,
        fat_g: 15,
        sodium_mg: 800,
      },
    });

    const result = calculateMacros(recipe);
    
    expect(result.macros_incomplete).toBe(false);
    // kcal = 30*4 + 50*4 + 15*9 = 120 + 200 + 135 = 455
    expect(result.kcal_est).toBe(455);
    // protein pct = (30*4) / 455 * 100 = 26.4%
    expect(result.macro_pct_protein).toBeCloseTo(26.4, 0);
    // carbs pct = (50*4) / 455 * 100 = 44.0%
    expect(result.macro_pct_carbs).toBeCloseTo(44.0, 0);
    // fat pct = (15*9) / 455 * 100 = 29.7%
    expect(result.macro_pct_fat).toBeCloseTo(29.7, 0);
  });

  it('should mark incomplete when nutrition missing', () => {
    const recipe = createRecipe({ nutrition: null });
    const result = calculateMacros(recipe);
    
    expect(result.macros_incomplete).toBe(true);
    expect(result.kcal_est).toBe(null);
    expect(result.macro_target_ok).toBe(null);
  });

  it('should mark incomplete when any macro is null', () => {
    const recipe = createRecipe({
      nutrition: {
        calories: 500,
        protein_g: 30,
        carbs_g: null,
        fat_g: 15,
        sodium_mg: 800,
      },
    });
    const result = calculateMacros(recipe);
    
    expect(result.macros_incomplete).toBe(true);
  });

  it('should check macro_target_ok correctly', () => {
    // Target: fat 15-25%, carbs 45-65%, protein 25-35%
    const recipe = createRecipe({
      nutrition: {
        calories: 400,
        protein_g: 30, // 120 cals = 30%
        carbs_g: 50, // 200 cals = 50%
        fat_g: 9,  // 81 cals = ~20%
        sodium_mg: 500,
      },
    });
    // Total: 120 + 200 + 81 = 401 cals
    // protein: 29.9%, carbs: 49.9%, fat: 20.2%
    
    const result = calculateMacros(recipe);
    expect(result.macro_target_ok).toBe(true);
  });

  it('should return macro_target_ok false when out of range', () => {
    const recipe = createRecipe({
      nutrition: {
        calories: 400,
        protein_g: 10, // Low protein
        carbs_g: 80, // High carbs
        fat_g: 5,
        sodium_mg: 500,
      },
    });
    
    const result = calculateMacros(recipe);
    expect(result.macro_target_ok).toBe(false);
  });
});

// ============================================================================
// Bucket Function Tests
// ============================================================================

describe('getKidFriendlyBucket', () => {
  it('should return High for >= 0.75', () => {
    expect(getKidFriendlyBucket(0.75)).toBe('High');
    expect(getKidFriendlyBucket(0.9)).toBe('High');
    expect(getKidFriendlyBucket(1.0)).toBe('High');
  });

  it('should return Med for >= 0.55 and < 0.75', () => {
    expect(getKidFriendlyBucket(0.55)).toBe('Med');
    expect(getKidFriendlyBucket(0.6)).toBe('Med');
    expect(getKidFriendlyBucket(0.74)).toBe('Med');
  });

  it('should return Low for < 0.55', () => {
    expect(getKidFriendlyBucket(0.54)).toBe('Low');
    expect(getKidFriendlyBucket(0.3)).toBe('Low');
    expect(getKidFriendlyBucket(0)).toBe('Low');
  });
});

describe('getWeeknightBucket', () => {
  it('should use same thresholds as kid-friendly', () => {
    expect(getWeeknightBucket(0.75)).toBe('High');
    expect(getWeeknightBucket(0.6)).toBe('Med');
    expect(getWeeknightBucket(0.3)).toBe('Low');
  });
});

// ============================================================================
// Selection Record Builder Tests
// ============================================================================

describe('buildSelectionRecord', () => {
  it('should build complete selection record', () => {
    const recipe = createRecipe({
      id: 'abc123',
      title: 'Spaghetti Carbonara',
      source_name: 'hellofresh.com',
      source_url: 'https://hellofresh.com/recipe/123',
      prep_time_minutes: 10,
      cook_time_minutes: 20,
      total_time_minutes: 30,
      kid_friendly_score: 0.8,
      weeknight_score: 0.9,
      primary_protein: 'pork',
      tags: ['italian', 'pasta'],
    });

    const record = buildSelectionRecord(recipe);

    expect(record.id).toBe('abc123');
    expect(record.title).toBe('Spaghetti Carbonara');
    expect(record.paprika_title_exact).toBe('Spaghetti Carbonara');
    expect(record.source_normalized).toBe('HelloFresh');
    expect(record.is_hellofresh).toBe(true);
    expect(record.is_pasta).toBe(true);
    expect(record.kid_friendly_bucket).toBe('High');
    expect(record.weeknight_bucket).toBe('High');
    expect(record.total_time_minutes).toBe(30);
  });

  it('should compute total_time from prep + cook when missing', () => {
    const recipe = createRecipe({
      prep_time_minutes: 15,
      cook_time_minutes: 25,
      total_time_minutes: null,
    });

    const record = buildSelectionRecord(recipe);
    expect(record.total_time_minutes).toBe(40);
  });

  it('should keep total_time as null when unknown', () => {
    const recipe = createRecipe({
      prep_time_minutes: null,
      cook_time_minutes: null,
      total_time_minutes: null,
    });

    const record = buildSelectionRecord(recipe);
    expect(record.total_time_minutes).toBeNull();
  });

  it('should add computed tags', () => {
    const recipe = createRecipe({
      title: 'Creamy Lasagna',  // Lasagna triggers pasta, creamy triggers comfort_food
      tags: ['dinner'],
    });

    const record = buildSelectionRecord(recipe);
    expect(record.tags).toContain('pasta');
    expect(record.tags).toContain('comfort_food');
  });

  it('should include new fields', () => {
    const recipe = createRecipe({
      title: 'Chicken Curry',
      primary_protein: 'chicken',
      spice_level: 3,
      nutrition: {
        calories: 450,
        protein_g: 35,
        carbs_g: 40,
        fat_g: 15,
        sodium_mg: 600,
      },
    });

    const record = buildSelectionRecord(recipe);
    
    expect(record.spice_level_label).toBe('medium');
    expect(record.freezer_friendly).toBe('unknown');
    expect(record.nutrition_profile).toBeDefined();
    expect(record.warnings).toBeInstanceOf(Array);
    expect(record.calories).toBe(450);
    expect(record.protein_g).toBe(35);
  });

  it('should populate warnings for missing data', () => {
    const recipe = createRecipe({
      total_time_minutes: null,
      prep_time_minutes: null,
      cook_time_minutes: null,
      nutrition: null,
    });

    const record = buildSelectionRecord(recipe);
    
    expect(record.warnings).toContain('time_missing');
    expect(record.warnings).toContain('nutrition_missing');
    expect(record.warnings).toContain('protein_unknown');
  });
});

// ============================================================================
// Validation Tests
// ============================================================================

describe('validateSelectionRecords', () => {
  it('should pass for valid records', () => {
    const records = [
      buildSelectionRecord(createRecipe({ id: '1', title: 'Recipe A' })),
      buildSelectionRecord(createRecipe({ id: '2', title: 'Recipe B' })),
    ];

    const result = validateSelectionRecords(records);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should detect duplicate IDs', () => {
    const records = [
      buildSelectionRecord(createRecipe({ id: 'same', title: 'Recipe A' })),
      buildSelectionRecord(createRecipe({ id: 'same', title: 'Recipe B' })),
    ];

    const result = validateSelectionRecords(records);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual({
      id: 'same',
      field: 'id',
      message: 'Duplicate ID',
    });
  });

  it('should detect empty titles', () => {
    const record = buildSelectionRecord(createRecipe({ id: '1', title: '' }));
    const result = validateSelectionRecords([record]);
    
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === 'title')).toBe(true);
  });

  it('should allow null total_time_minutes', () => {
    const recipe = createRecipe({
      id: '1',
      title: 'Test',
      total_time_minutes: null,
      prep_time_minutes: null,
      cook_time_minutes: null,
    });
    const record = buildSelectionRecord(recipe);
    const result = validateSelectionRecords([record]);
    
    expect(result.valid).toBe(true);
  });
});

// ============================================================================
// New Helper Function Tests
// ============================================================================

describe('getSpiceLevelLabel', () => {
  it('should return correct labels for spice levels', () => {
    expect(getSpiceLevelLabel(-1)).toBe('unknown');
    expect(getSpiceLevelLabel(0)).toBe('none');
    expect(getSpiceLevelLabel(1)).toBe('mild');
    expect(getSpiceLevelLabel(2)).toBe('mild');
    expect(getSpiceLevelLabel(3)).toBe('medium');
    expect(getSpiceLevelLabel(4)).toBe('medium');
    expect(getSpiceLevelLabel(5)).toBe('hot');
  });
});

describe('getNutritionProfile', () => {
  it('should return unknown for incomplete macros', () => {
    const result = getNutritionProfile({
      macros_incomplete: true,
      kcal_est: null,
      macro_pct_protein: null,
      macro_pct_carbs: null,
      macro_pct_fat: null,
      macro_target_ok: null,
    });
    expect(result).toBe('unknown');
  });

  it('should return lean for high protein low fat', () => {
    const result = getNutritionProfile({
      macros_incomplete: false,
      kcal_est: 400,
      macro_pct_protein: 35,
      macro_pct_carbs: 50,
      macro_pct_fat: 15,
      macro_target_ok: true,
    });
    expect(result).toBe('lean');
  });

  it('should return comfort for high fat', () => {
    const result = getNutritionProfile({
      macros_incomplete: false,
      kcal_est: 500,
      macro_pct_protein: 20,
      macro_pct_carbs: 35,
      macro_pct_fat: 45,
      macro_target_ok: false,
    });
    expect(result).toBe('comfort');
  });

  it('should return balanced for middle values', () => {
    const result = getNutritionProfile({
      macros_incomplete: false,
      kcal_est: 450,
      macro_pct_protein: 25,
      macro_pct_carbs: 50,
      macro_pct_fat: 25,
      macro_target_ok: true,
    });
    expect(result).toBe('balanced');
  });
});

describe('getReheatQuality', () => {
  it('should return excellent for soups and stews', () => {
    expect(getReheatQuality(createRecipe({ title: 'Beef Stew' }))).toBe('excellent');
    expect(getReheatQuality(createRecipe({ title: 'Chicken Soup' }))).toBe('excellent');
    expect(getReheatQuality(createRecipe({ title: 'Thai Curry' }))).toBe('excellent');
  });

  it('should return good for casseroles and pasta', () => {
    expect(getReheatQuality(createRecipe({ title: 'Baked Pasta Casserole' }))).toBe('good');
    expect(getReheatQuality(createRecipe({ title: 'Meatball Bake' }))).toBe('good');
  });

  it('should return fair for fried items', () => {
    expect(getReheatQuality(createRecipe({ title: 'Fried Chicken' }))).toBe('fair');
  });

  it('should return unknown for ambiguous recipes', () => {
    expect(getReheatQuality(createRecipe({ title: 'Chicken Dinner' }))).toBe('unknown');
  });
});

describe('isFreezerCandidateHeuristic', () => {
  it('should return true for freezer-type dishes', () => {
    expect(isFreezerCandidateHeuristic(createRecipe({ title: 'Beef Stew' }))).toBe(true);
    expect(isFreezerCandidateHeuristic(createRecipe({ title: 'Chicken Soup' }))).toBe(true);
    expect(isFreezerCandidateHeuristic(createRecipe({ tags: ['meal prep'] }))).toBe(true);
  });

  it('should return false for other dishes', () => {
    expect(isFreezerCandidateHeuristic(createRecipe({ title: 'Grilled Salmon' }))).toBe(false);
  });
});

describe('generateDataQualityReport', () => {
  it('should calculate percentages correctly', () => {
    const records = [
      buildSelectionRecord(createRecipe({
        id: '1',
        total_time_minutes: 30,
        nutrition: { calories: 400, protein_g: 30, carbs_g: 40, fat_g: 15, sodium_mg: 500 },
      })),
      buildSelectionRecord(createRecipe({
        id: '2',
        total_time_minutes: null,
        prep_time_minutes: null,
        cook_time_minutes: null,
        nutrition: null,
      })),
    ];

    const report = generateDataQualityReport(records);

    expect(report.total_recipes).toBe(2);
    expect(report.pct_time_missing).toBe(50);
    expect(report.pct_nutrition_missing).toBe(50);
  });

  it('should aggregate warnings', () => {
    const records = [
      buildSelectionRecord(createRecipe({
        id: '1',
        total_time_minutes: null,
        prep_time_minutes: null,
        cook_time_minutes: null,
        nutrition: null,
      })),
    ];

    const report = generateDataQualityReport(records);

    expect(report.warnings_summary).toHaveProperty('time_missing');
    expect(report.warnings_summary['time_missing']).toBe(1);
  });
});
