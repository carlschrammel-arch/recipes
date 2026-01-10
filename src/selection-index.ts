/**
 * Selection Index Generator
 * Generates machine-friendly catalog.selection.jsonl for deterministic recipe selection
 */

import { writeFile } from 'fs/promises';
import { join } from 'path';
import type { NormalizedRecipe, PrimaryProtein } from './types.js';

// ============================================================================
// Enums for Selection Fields
// ============================================================================

export type FreezerFriendly = 'yes' | 'no' | 'unknown';
export type ReheatQuality = 'excellent' | 'good' | 'fair' | 'unknown';
export type NutritionProfile = 'lean' | 'balanced' | 'comfort' | 'unknown';
export type FatRisk = 'low' | 'medium' | 'high' | 'unknown';
export type OmegaOrMufa = 'yes' | 'no' | 'unknown';
export type SpiceLevelEnum = 'none' | 'mild' | 'medium' | 'hot' | 'unknown';

// ============================================================================
// Selection Record Type
// ============================================================================

export interface SelectionRecord {
  // Identity fields
  id: string;
  title: string;
  paprika_title_exact: string;
  source_name: string | null;
  source_url: string | null;
  source_normalized: string;
  
  // Core selection fields
  primary_protein: PrimaryProtein;
  is_hellofresh: boolean;
  is_vegetarian: boolean;
  is_vegan: boolean;
  cost_tier: string;
  
  // Time fields (nullable)
  prep_time_minutes: number | null;
  cook_time_minutes: number | null;
  total_time_minutes: number | null;  // null if unknown, not 999
  
  // Scores (0-1 scale, from heuristics)
  kid_friendly_score: number;
  kid_friendly_bucket: 'High' | 'Med' | 'Low';
  weeknight_score: number;
  weeknight_bucket: 'High' | 'Med' | 'Low';
  
  // Spice
  spice_level: number;
  spice_level_label: SpiceLevelEnum;
  
  // Tags
  tags: string[];
  
  // Computed tag booleans with explicit enums
  is_pasta: boolean;
  is_comfort_food: boolean;
  freezer_friendly: FreezerFriendly;
  reheat_quality: ReheatQuality;
  nutrition_profile: NutritionProfile;
  saturated_fat_risk: FatRisk;
  omega3_or_mufa: OmegaOrMufa;
  
  // Inference tracking (for transparency)
  pasta_inferred_reason: string | null;
  freezer_inferred_reason: string | null;
  kid_friendly_inferred: boolean;
  is_freezer_candidate_heuristic: boolean;
  
  // Macros (nullable)
  macros_incomplete: boolean;
  kcal_est: number | null;
  macro_pct_protein: number | null;
  macro_pct_carbs: number | null;
  macro_pct_fat: number | null;
  macro_target_ok: boolean | null;
  
  // Detailed nutrition when available
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  saturated_fat_g: number | null;
  fiber_g: number | null;
  sodium_mg: number | null;
  
  // Warnings for data quality
  warnings: string[];
}

export interface SelectionIndexStats {
  total_recipes: number;
  by_protein: Record<string, number>;
  hellofresh_count: number;
  macros_incomplete_count: number;
  pasta_count: number;
  comfort_food_count: number;
  freezer_friendly_count: number;
  freezer_unknown_count: number;
  vegetarian_count: number;
  vegan_count: number;
  time_missing_count: number;
  protein_unknown_count: number;
  nutrition_present_count: number;
}

// ============================================================================
// Source Normalization
// ============================================================================

const SOURCE_NORMALIZATIONS: Record<string, string> = {
  'hellofresh': 'HelloFresh',
  'hellofresh.com': 'HelloFresh',
  'hellofresh.ca': 'HelloFresh',
  'hellofresh.co.uk': 'HelloFresh',
  'hello fresh': 'HelloFresh',
  'budgetbytes': 'Budget Bytes',
  'budgetbytes.com': 'Budget Bytes',
  'allrecipes': 'AllRecipes',
  'allrecipes.com': 'AllRecipes',
  'seriouseats': 'Serious Eats',
  'seriouseats.com': 'Serious Eats',
  'bonappetit': 'Bon Appétit',
  'bonappetit.com': 'Bon Appétit',
  'foodnetwork': 'Food Network',
  'foodnetwork.com': 'Food Network',
  'cooking.nytimes': 'NYT Cooking',
  'cooking.nytimes.com': 'NYT Cooking',
  'nytimes.com': 'NYT Cooking',
  'epicurious': 'Epicurious',
  'epicurious.com': 'Epicurious',
  'food52': 'Food52',
  'food52.com': 'Food52',
  'tasty': 'Tasty',
  'tasty.co': 'Tasty',
  'delish': 'Delish',
  'delish.com': 'Delish',
  'blueapron': 'Blue Apron',
  'blueapron.com': 'Blue Apron',
  'homechef': 'Home Chef',
  'homechef.com': 'Home Chef',
  'purplecarrot': 'Purple Carrot',
  'purplecarrot.com': 'Purple Carrot',
};

/**
 * Normalize source name for consistency
 */
export function normalizeSourceName(sourceName: string | null, sourceUrl: string | null): string {
  if (!sourceName && !sourceUrl) return 'Unknown';
  
  // Try to extract from URL first (more reliable)
  if (sourceUrl) {
    try {
      const url = new URL(sourceUrl);
      const host = url.hostname.replace(/^www\./, '').toLowerCase();
      
      // Check normalization map
      for (const [key, normalized] of Object.entries(SOURCE_NORMALIZATIONS)) {
        if (host.includes(key.replace('.com', '').replace('.', ''))) {
          return normalized;
        }
      }
      
      // Return cleaned hostname if no match
      return host;
    } catch {
      // Invalid URL, fall through
    }
  }
  
  // Try source name
  if (sourceName) {
    const lower = sourceName.toLowerCase().trim();
    
    // Check normalization map
    for (const [key, normalized] of Object.entries(SOURCE_NORMALIZATIONS)) {
      if (lower.includes(key.replace('.com', '').replace('.', ''))) {
        return normalized;
      }
    }
    
    return sourceName.trim();
  }
  
  return 'Unknown';
}

/**
 * Check if recipe is from HelloFresh (derived from normalized source)
 */
export function isHelloFresh(recipe: NormalizedRecipe): boolean {
  const normalizedSource = normalizeSourceName(recipe.source_name, recipe.source_url);
  if (normalizedSource === 'HelloFresh') return true;
  
  // Also check tags
  const tags = recipe.tags.map(t => t.toLowerCase());
  return tags.some(t => t === 'hellofresh' || t === 'hello fresh');
}

// ============================================================================
// Tag Heuristics
// ============================================================================

const PASTA_KEYWORDS = [
  'pasta', 'spaghetti', 'rigatoni', 'penne', 'ziti', 'fettuccine', 
  'linguine', 'noodles', 'orzo', 'lasagna', 'macaroni', 'ravioli', 
  'tortellini', 'gnocchi', 'bucatini', 'cavatappi', 'farfalle', 
  'fusilli', 'rotini', 'tagliatelle', 'pappardelle', 'orecchiette',
  'mostaccioli', 'carbonara', 'alfredo', 'bolognese', 'ramen', 'udon',
  'lo mein', 'chow mein', 'pad thai', 'pho'
];

const COMFORT_FOOD_TITLE_KEYWORDS = [
  'stroganoff', 'mac', 'lasagna', 'ziti', 'casserole', 'creamy',
  'alfredo', 'pot pie', 'chili', 'chowder', 'meatloaf', 'fried',
  'grilled cheese', 'burger', 'pizza', 'meatball', 'shepherd',
  'potpie', 'biscuits', 'gravy', 'mashed', 'loaded'
];

const COMFORT_FOOD_INGREDIENT_CUES = [
  'heavy cream', 'cream cheese', 'cheese sauce', 'velveeta',
  'sour cream', 'butter', 'bacon'
];

const FREEZER_FRIENDLY_KEYWORDS = [
  'soup', 'stew', 'chili', 'casserole', 'bake', 'curry', 'braise',
  'meatball', 'meatloaf', 'lasagna', 'sauce', 'bolognese', 'ragù',
  'ragu', 'pot pie', 'potpie', 'burrito', 'enchilada', 'beans'
];

const FREEZER_UNFRIENDLY_KEYWORDS = [
  'salad', 'lettuce', 'slaw', 'ceviche', 'tartare', 'poke',
  'sashimi', 'fresh', 'raw', 'crisp', 'crunchy'
];

/**
 * Check if recipe is a pasta dish and return reason
 */
export function isPastaRecipe(recipe: NormalizedRecipe): { result: boolean; reason: string | null } {
  const title = recipe.title.toLowerCase();
  const ingredients = recipe.ingredients.map(i => i.ingredient.toLowerCase()).join(' ');
  const tags = recipe.tags.map(t => t.toLowerCase());
  
  // Check tags first
  if (tags.includes('pasta')) {
    return { result: true, reason: 'tag_pasta' };
  }
  
  // Check title for pasta keywords
  for (const kw of PASTA_KEYWORDS) {
    if (title.includes(kw)) {
      return { result: true, reason: `title_contains_${kw.replace(/\s+/g, '_')}` };
    }
  }
  
  // Check ingredients for pasta keywords
  for (const kw of PASTA_KEYWORDS) {
    if (ingredients.includes(kw)) {
      return { result: true, reason: `ingredient_contains_${kw.replace(/\s+/g, '_')}` };
    }
  }
  
  // Check tags for pasta keywords
  for (const kw of PASTA_KEYWORDS) {
    if (tags.includes(kw)) {
      return { result: true, reason: `tag_${kw}` };
    }
  }
  
  return { result: false, reason: null };
}

/**
 * Check if recipe is comfort food
 */
export function isComfortFood(recipe: NormalizedRecipe): boolean {
  const title = recipe.title.toLowerCase();
  const ingredients = recipe.ingredients.map(i => i.ingredient.toLowerCase()).join(' ');
  const tags = recipe.tags.map(t => t.toLowerCase());
  
  // Check title keywords
  if (COMFORT_FOOD_TITLE_KEYWORDS.some(kw => title.includes(kw))) {
    return true;
  }
  
  // Check tags
  if (tags.some(t => t === 'comfort food' || t === 'comfort')) {
    return true;
  }
  
  // Check ingredient cues (need multiple or significant)
  const comfortIngredientCount = COMFORT_FOOD_INGREDIENT_CUES.filter(cue => 
    ingredients.includes(cue)
  ).length;
  
  return comfortIngredientCount >= 2;
}

/**
 * Guess if recipe is freezer-friendly
 * Returns: FreezerFriendly enum and inference reason
 */
export function isFreezerFriendlyGuess(recipe: NormalizedRecipe): { 
  result: FreezerFriendly; 
  reason: string | null;
} {
  const title = recipe.title.toLowerCase();
  const tags = recipe.tags.map(t => t.toLowerCase());
  const notes = (recipe.notes || '').toLowerCase();
  const instructions = recipe.instructions.join(' ').toLowerCase();
  
  // Check for explicit freezer mentions in notes/instructions
  if (notes.includes('freeze') || notes.includes('freezer') || notes.includes('frozen')) {
    return { result: 'yes', reason: 'notes_mention_freezer' };
  }
  if (instructions.includes('freeze for') || instructions.includes('can be frozen') || instructions.includes('freezes well')) {
    return { result: 'yes', reason: 'instructions_mention_freezer' };
  }
  
  // Check for explicit freezer tag
  if (tags.includes('freezer') || tags.includes('freezer-friendly') || tags.includes('freezer friendly')) {
    return { result: 'yes', reason: 'tag_freezer' };
  }
  
  // Check unfriendly indicators (they indicate "no")
  for (const kw of FREEZER_UNFRIENDLY_KEYWORDS) {
    if (title.includes(kw)) {
      return { result: 'no', reason: `title_contains_${kw.replace(/\s+/g, '_')}` };
    }
    if (tags.includes(kw)) {
      return { result: 'no', reason: `tag_${kw.replace(/\s+/g, '_')}` };
    }
  }
  
  // Check friendly indicators (heuristic - candidate but not confirmed)
  for (const kw of FREEZER_FRIENDLY_KEYWORDS) {
    if (title.includes(kw) || tags.includes(kw)) {
      return { result: 'unknown', reason: `heuristic_${kw.replace(/\s+/g, '_')}` };
    }
  }
  
  // Check for meal prep tag - suggests good for freezing
  if (tags.includes('meal prep')) {
    return { result: 'unknown', reason: 'heuristic_meal_prep' };
  }
  
  // Unknown - no signal
  return { result: 'unknown', reason: null };
}

/**
 * Check if recipe is a freezer candidate based on heuristics
 * (recipe type suggests it COULD freeze well, but not confirmed)
 */
export function isFreezerCandidateHeuristic(recipe: NormalizedRecipe): boolean {
  const title = recipe.title.toLowerCase();
  const tags = recipe.tags.map(t => t.toLowerCase());
  
  return FREEZER_FRIENDLY_KEYWORDS.some(kw => 
    title.includes(kw) || tags.includes(kw)
  ) || tags.includes('meal prep');
}

/**
 * Check if recipe is vegetarian
 */
export function isVegetarian(recipe: NormalizedRecipe): boolean {
  const nonVegProteins: PrimaryProtein[] = ['chicken', 'beef', 'pork', 'fish', 'seafood', 'turkey', 'lamb'];
  
  if (nonVegProteins.includes(recipe.primary_protein)) {
    return false;
  }
  
  if (recipe.primary_protein === 'vegetarian' || recipe.primary_protein === 'tofu' || 
      recipe.primary_protein === 'legumes' || recipe.primary_protein === 'eggs') {
    return true;
  }
  
  // Check tags
  const tags = recipe.tags.map(t => t.toLowerCase());
  return tags.includes('vegetarian') || tags.includes('veggie');
}

/**
 * Check if recipe is vegan
 */
export function isVegan(recipe: NormalizedRecipe): boolean {
  const tags = recipe.tags.map(t => t.toLowerCase());
  
  if (tags.includes('vegan')) {
    return true;
  }
  
  // Check ingredients for non-vegan items
  const ingredients = recipe.ingredients.map(i => i.ingredient.toLowerCase()).join(' ');
  const nonVeganItems = ['egg', 'cheese', 'milk', 'cream', 'butter', 'yogurt', 'honey'];
  
  if (recipe.primary_protein === 'eggs') {
    return false;
  }
  
  // Only return true if explicitly tagged, too hard to infer
  return false;
}

// ============================================================================
// Macro Calculations
// ============================================================================

export interface MacroResult {
  macros_incomplete: boolean;
  kcal_est: number | null;
  macro_pct_protein: number | null;
  macro_pct_carbs: number | null;
  macro_pct_fat: number | null;
  macro_target_ok: boolean | null;
}

/**
 * Calculate macro percentages and target compliance
 * Target ranges: fat 15-25%, carbs 45-65%, protein 25-35%
 */
export function calculateMacros(recipe: NormalizedRecipe): MacroResult {
  const nutrition = recipe.nutrition;
  
  if (!nutrition || 
      nutrition.protein_g === null || 
      nutrition.carbs_g === null || 
      nutrition.fat_g === null) {
    return {
      macros_incomplete: true,
      kcal_est: nutrition?.calories ?? null,
      macro_pct_protein: null,
      macro_pct_carbs: null,
      macro_pct_fat: null,
      macro_target_ok: null,
    };
  }
  
  const protein = nutrition.protein_g;
  const carbs = nutrition.carbs_g;
  const fat = nutrition.fat_g;
  
  // Calculate estimated calories: protein*4 + carbs*4 + fat*9
  const kcal_est = Math.round(protein * 4 + carbs * 4 + fat * 9);
  
  // Calculate percentages
  const totalCals = kcal_est > 0 ? kcal_est : 1; // Avoid division by zero
  const pct_protein = Math.round((protein * 4 / totalCals) * 1000) / 10;
  const pct_carbs = Math.round((carbs * 4 / totalCals) * 1000) / 10;
  const pct_fat = Math.round((fat * 9 / totalCals) * 1000) / 10;
  
  // Check if within target ranges
  const macro_target_ok = 
    pct_fat >= 15 && pct_fat <= 25 &&
    pct_carbs >= 45 && pct_carbs <= 65 &&
    pct_protein >= 25 && pct_protein <= 35;
  
  return {
    macros_incomplete: false,
    kcal_est,
    macro_pct_protein: pct_protein,
    macro_pct_carbs: pct_carbs,
    macro_pct_fat: pct_fat,
    macro_target_ok,
  };
}

// ============================================================================
// New Classification Functions
// ============================================================================

/**
 * Get spice level label from numeric spice level
 */
export function getSpiceLevelLabel(spiceLevel: number): SpiceLevelEnum {
  if (spiceLevel < 0) return 'unknown';
  if (spiceLevel === 0) return 'none';
  if (spiceLevel <= 2) return 'mild';
  if (spiceLevel <= 4) return 'medium';
  return 'hot';
}

/**
 * Determine nutrition profile based on macro composition
 */
export function getNutritionProfile(macros: MacroResult): NutritionProfile {
  if (macros.macros_incomplete) return 'unknown';
  
  const pctProtein = macros.macro_pct_protein ?? 0;
  const pctFat = macros.macro_pct_fat ?? 0;
  
  // Lean: high protein (>30%), low fat (<20%)
  if (pctProtein > 30 && pctFat < 20) return 'lean';
  
  // Comfort: higher fat (>30%)
  if (pctFat > 30) return 'comfort';
  
  // Balanced: everything else
  return 'balanced';
}

/**
 * Estimate saturated fat risk from total fat
 * (rough estimate since most recipes don't have sat fat data)
 */
export function getSaturatedFatRisk(recipe: NormalizedRecipe): FatRisk {
  const nutrition = recipe.nutrition;
  if (!nutrition || nutrition.fat_g === null) return 'unknown';
  
  // Check ingredients for high-sat-fat indicators
  const ingredients = recipe.ingredients.map(i => i.ingredient.toLowerCase()).join(' ');
  const highSatFatKeywords = ['bacon', 'butter', 'cream', 'cheese', 'coconut', 'lard'];
  const lowSatFatKeywords = ['olive oil', 'avocado', 'salmon', 'nuts', 'seeds'];
  
  const hasHighSatFat = highSatFatKeywords.some(kw => ingredients.includes(kw));
  const hasLowSatFat = lowSatFatKeywords.some(kw => ingredients.includes(kw));
  
  const fatPer = nutrition.fat_g;
  
  if (hasHighSatFat && fatPer > 15) return 'high';
  if (hasLowSatFat || fatPer < 10) return 'low';
  if (fatPer > 20) return 'medium';
  
  return 'low';
}

/**
 * Check if recipe likely has omega-3 or MUFA (healthy fats)
 */
export function getOmegaOrMufa(recipe: NormalizedRecipe): OmegaOrMufa {
  const ingredients = recipe.ingredients.map(i => i.ingredient.toLowerCase()).join(' ');
  
  const omega3Keywords = ['salmon', 'mackerel', 'sardine', 'tuna', 'trout', 'herring', 
                          'flaxseed', 'chia', 'walnut', 'hemp'];
  const mufaKeywords = ['olive oil', 'avocado', 'almond', 'peanut', 'cashew'];
  
  const hasOmega3 = omega3Keywords.some(kw => ingredients.includes(kw));
  const hasMufa = mufaKeywords.some(kw => ingredients.includes(kw));
  
  if (hasOmega3 || hasMufa) return 'yes';
  
  // Check protein type
  if (recipe.primary_protein === 'fish' || recipe.primary_protein === 'seafood') {
    return 'yes';
  }
  
  return 'unknown';
}

/**
 * Estimate reheat quality based on recipe type
 */
export function getReheatQuality(recipe: NormalizedRecipe): ReheatQuality {
  const title = recipe.title.toLowerCase();
  const tags = recipe.tags.map(t => t.toLowerCase());
  
  // Excellent reheaters
  const excellentKeywords = ['soup', 'stew', 'curry', 'chili', 'braise', 'sauce', 
                             'bolognese', 'ragù', 'ragu', 'dal', 'beans'];
  if (excellentKeywords.some(kw => title.includes(kw) || tags.includes(kw))) {
    return 'excellent';
  }
  
  // Good reheaters
  const goodKeywords = ['casserole', 'bake', 'lasagna', 'pasta', 'rice', 'grain',
                        'meatball', 'meatloaf', 'pot pie', 'potpie'];
  if (goodKeywords.some(kw => title.includes(kw) || tags.includes(kw))) {
    return 'good';
  }
  
  // Fair reheaters (often become less good)
  const fairKeywords = ['fried', 'crispy', 'grilled', 'steak', 'burger'];
  if (fairKeywords.some(kw => title.includes(kw))) {
    return 'fair';
  }
  
  // Poor/don't reheat
  const poorKeywords = ['salad', 'sashimi', 'ceviche', 'tartare'];
  if (poorKeywords.some(kw => title.includes(kw) || tags.includes(kw))) {
    return 'fair';  // Using fair since we don't have 'poor'
  }
  
  return 'unknown';
}

// ============================================================================
// Bucket Functions
// ============================================================================

export function getKidFriendlyBucket(score: number): 'High' | 'Med' | 'Low' {
  if (score >= 0.75) return 'High';
  if (score >= 0.55) return 'Med';
  return 'Low';
}

export function getWeeknightBucket(score: number): 'High' | 'Med' | 'Low' {
  if (score >= 0.75) return 'High';
  if (score >= 0.55) return 'Med';
  return 'Low';
}

// ============================================================================
// Selection Record Builder
// ============================================================================

/**
 * Build a SelectionRecord from a NormalizedRecipe
 */
export function buildSelectionRecord(recipe: NormalizedRecipe): SelectionRecord {
  const normalizedSource = normalizeSourceName(recipe.source_name, recipe.source_url);
  const freezerGuess = isFreezerFriendlyGuess(recipe);
  const pastaResult = isPastaRecipe(recipe);
  const macros = calculateMacros(recipe);
  
  // Compute total_time_minutes - null if unknown (not 999)
  let totalTime = recipe.total_time_minutes;
  if (totalTime === null && recipe.prep_time_minutes !== null && recipe.cook_time_minutes !== null) {
    totalTime = recipe.prep_time_minutes + recipe.cook_time_minutes;
  }
  // Keep as null if unknown - don't use 999
  
  // Build warnings array
  const warnings: string[] = [];
  if (totalTime === null) warnings.push('time_missing');
  if (!recipe.nutrition || recipe.nutrition.protein_g === null) warnings.push('protein_unknown');
  if (!recipe.nutrition) warnings.push('nutrition_missing');
  if (macros.macros_incomplete) warnings.push('macros_incomplete');
  if (recipe.primary_protein === 'other') warnings.push('protein_type_other');
  
  // Build enhanced tags array
  const tags = [...recipe.tags];
  
  const is_pasta = pastaResult.result;
  const is_comfort_food = isComfortFood(recipe);
  const is_vegetarian = isVegetarian(recipe);
  const is_vegan = isVegan(recipe);
  const is_freezer_candidate = isFreezerCandidateHeuristic(recipe);
  
  // Add computed tags
  if (is_pasta && !tags.includes('pasta')) tags.push('pasta');
  if (is_comfort_food && !tags.includes('comfort_food')) tags.push('comfort_food');
  if (freezerGuess.result === 'yes' && !tags.includes('freezer_friendly')) tags.push('freezer_friendly');
  if (freezerGuess.result === 'unknown' && !tags.includes('freezer_unknown')) tags.push('freezer_unknown');
  if (is_vegetarian && !tags.includes('vegetarian')) tags.push('vegetarian');
  if (is_vegan && !tags.includes('vegan')) tags.push('vegan');
  
  // Get nutrition profile and fat analysis
  const nutritionProfile = getNutritionProfile(macros);
  const satFatRisk = getSaturatedFatRisk(recipe);
  const omegaMufa = getOmegaOrMufa(recipe);
  const reheatQuality = getReheatQuality(recipe);
  const spiceLevelLabel = getSpiceLevelLabel(recipe.spice_level);
  
  // Kid friendly inference tracking
  const kidFriendlyInferred = recipe.kid_friendly_score > 0.5;
  
  // Get detailed nutrition
  const nutrition = recipe.nutrition;
  
  return {
    // Identity fields
    id: recipe.id,
    title: recipe.title,
    paprika_title_exact: recipe.title,
    source_name: recipe.source_name,
    source_url: recipe.source_url,
    source_normalized: normalizedSource,
    
    // Core selection fields
    primary_protein: recipe.primary_protein,
    is_hellofresh: isHelloFresh(recipe),
    is_vegetarian,
    is_vegan,
    cost_tier: recipe.cost_tier,
    
    // Time fields (nullable)
    prep_time_minutes: recipe.prep_time_minutes,
    cook_time_minutes: recipe.cook_time_minutes,
    total_time_minutes: totalTime,
    
    // Scores
    kid_friendly_score: recipe.kid_friendly_score,
    kid_friendly_bucket: getKidFriendlyBucket(recipe.kid_friendly_score),
    weeknight_score: recipe.weeknight_score,
    weeknight_bucket: getWeeknightBucket(recipe.weeknight_score),
    
    // Spice
    spice_level: recipe.spice_level,
    spice_level_label: spiceLevelLabel,
    
    // Tags
    tags,
    
    // Computed tag booleans with explicit enums
    is_pasta,
    is_comfort_food,
    freezer_friendly: freezerGuess.result,
    reheat_quality: reheatQuality,
    nutrition_profile: nutritionProfile,
    saturated_fat_risk: satFatRisk,
    omega3_or_mufa: omegaMufa,
    
    // Inference tracking
    pasta_inferred_reason: pastaResult.reason,
    freezer_inferred_reason: freezerGuess.reason,
    kid_friendly_inferred: kidFriendlyInferred,
    is_freezer_candidate_heuristic: is_freezer_candidate,
    
    // Macros
    ...macros,
    
    // Detailed nutrition
    calories: nutrition?.calories ?? null,
    protein_g: nutrition?.protein_g ?? null,
    carbs_g: nutrition?.carbs_g ?? null,
    fat_g: nutrition?.fat_g ?? null,
    saturated_fat_g: null,  // Not in base Nutrition interface
    fiber_g: null,          // Not in base Nutrition interface
    sodium_mg: nutrition?.sodium_mg ?? null,
    
    // Warnings
    warnings,
  };
}

/**
 * Build stats summary from selection records
 */
export function buildSelectionStats(records: SelectionRecord[]): SelectionIndexStats {
  const byProtein: Record<string, number> = {};
  let hellofreshCount = 0;
  let macrosIncompleteCount = 0;
  let pastaCount = 0;
  let comfortFoodCount = 0;
  let freezerFriendlyCount = 0;
  let freezerUnknownCount = 0;
  let vegetarianCount = 0;
  let veganCount = 0;
  let timeMissingCount = 0;
  let proteinUnknownCount = 0;
  let nutritionPresentCount = 0;
  
  for (const r of records) {
    byProtein[r.primary_protein] = (byProtein[r.primary_protein] || 0) + 1;
    if (r.is_hellofresh) hellofreshCount++;
    if (r.macros_incomplete) macrosIncompleteCount++;
    if (r.is_pasta) pastaCount++;
    if (r.is_comfort_food) comfortFoodCount++;
    if (r.freezer_friendly === 'yes') freezerFriendlyCount++;
    if (r.freezer_friendly === 'unknown') freezerUnknownCount++;
    if (r.is_vegetarian) vegetarianCount++;
    if (r.is_vegan) veganCount++;
    if (r.total_time_minutes === null) timeMissingCount++;
    if (r.protein_g === null) proteinUnknownCount++;
    if (r.calories !== null || r.protein_g !== null) nutritionPresentCount++;
  }
  
  return {
    total_recipes: records.length,
    by_protein: byProtein,
    hellofresh_count: hellofreshCount,
    macros_incomplete_count: macrosIncompleteCount,
    pasta_count: pastaCount,
    comfort_food_count: comfortFoodCount,
    freezer_friendly_count: freezerFriendlyCount,
    freezer_unknown_count: freezerUnknownCount,
    vegetarian_count: vegetarianCount,
    vegan_count: veganCount,
    time_missing_count: timeMissingCount,
    protein_unknown_count: proteinUnknownCount,
    nutrition_present_count: nutritionPresentCount,
  };
}

// ============================================================================
// Validation
// ============================================================================

export interface ValidationError {
  id: string;
  field: string;
  message: string;
}

const VALID_PROTEINS: PrimaryProtein[] = [
  'chicken', 'beef', 'pork', 'fish', 'seafood', 'turkey', 'lamb', 
  'tofu', 'legumes', 'eggs', 'vegetarian', 'other'
];

/**
 * Validate selection records
 */
export function validateSelectionRecords(records: SelectionRecord[]): {
  valid: boolean;
  errors: ValidationError[];
} {
  const errors: ValidationError[] = [];
  const seenIds = new Set<string>();
  
  for (const r of records) {
    // Check unique ID
    if (seenIds.has(r.id)) {
      errors.push({ id: r.id, field: 'id', message: 'Duplicate ID' });
    }
    seenIds.add(r.id);
    
    // Check non-empty title
    if (!r.title || r.title.trim() === '') {
      errors.push({ id: r.id, field: 'title', message: 'Empty title' });
    }
    
    // Check total_time_minutes is numeric or null (null is valid for missing)
    if (r.total_time_minutes !== null && 
        (typeof r.total_time_minutes !== 'number' || isNaN(r.total_time_minutes))) {
      errors.push({ id: r.id, field: 'total_time_minutes', message: 'Not a valid number or null' });
    }
    
    // Check primary_protein is valid enum
    if (!VALID_PROTEINS.includes(r.primary_protein)) {
      errors.push({ 
        id: r.id, 
        field: 'primary_protein', 
        message: `Invalid protein: ${r.primary_protein}` 
      });
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
  };
}

// ============================================================================
// File Generation
// ============================================================================

/**
 * Generate catalog.selection.jsonl file
 */
export async function generateSelectionIndex(
  recipes: NormalizedRecipe[],
  outputPath: string
): Promise<{ records: SelectionRecord[]; stats: SelectionIndexStats }> {
  // Sort by ID for deterministic output
  const sortedRecipes = [...recipes].sort((a, b) => a.id.localeCompare(b.id));
  
  // Build selection records
  const records = sortedRecipes.map(buildSelectionRecord);
  
  // Validate
  const validation = validateSelectionRecords(records);
  if (!validation.valid) {
    console.warn(`Selection index validation warnings: ${validation.errors.length} issues`);
    for (const err of validation.errors.slice(0, 10)) {
      console.warn(`  - ${err.id}: ${err.field} - ${err.message}`);
    }
  }
  
  // Build stats
  const stats = buildSelectionStats(records);
  
  // Write JSONL file
  const lines = records.map(r => JSON.stringify(r));
  await writeFile(join(outputPath, 'catalog.selection.jsonl'), lines.join('\n'));
  
  return { records, stats };
}

// ============================================================================
// Validation Report
// ============================================================================

export interface DataQualityReport {
  total_recipes: number;
  pct_time_missing: number;
  pct_nutrition_missing: number;
  pct_protein_unknown: number;
  pct_freezer_unknown: number;
  pct_macros_incomplete: number;
  warnings_summary: Record<string, number>;
}

/**
 * Generate a data quality report from selection records
 */
export function generateDataQualityReport(records: SelectionRecord[]): DataQualityReport {
  const total = records.length;
  if (total === 0) {
    return {
      total_recipes: 0,
      pct_time_missing: 0,
      pct_nutrition_missing: 0,
      pct_protein_unknown: 0,
      pct_freezer_unknown: 0,
      pct_macros_incomplete: 0,
      warnings_summary: {},
    };
  }
  
  let timeMissing = 0;
  let nutritionMissing = 0;
  let proteinUnknown = 0;
  let freezerUnknown = 0;
  let macrosIncomplete = 0;
  const warningsCounts: Record<string, number> = {};
  
  for (const r of records) {
    if (r.total_time_minutes === null) timeMissing++;
    if (r.calories === null && r.protein_g === null) nutritionMissing++;
    if (r.protein_g === null) proteinUnknown++;
    if (r.freezer_friendly === 'unknown') freezerUnknown++;
    if (r.macros_incomplete) macrosIncomplete++;
    
    for (const w of r.warnings) {
      warningsCounts[w] = (warningsCounts[w] || 0) + 1;
    }
  }
  
  const pct = (n: number) => Math.round((n / total) * 1000) / 10;
  
  return {
    total_recipes: total,
    pct_time_missing: pct(timeMissing),
    pct_nutrition_missing: pct(nutritionMissing),
    pct_protein_unknown: pct(proteinUnknown),
    pct_freezer_unknown: pct(freezerUnknown),
    pct_macros_incomplete: pct(macrosIncomplete),
    warnings_summary: warningsCounts,
  };
}

/**
 * Print data quality report to console
 */
export function printDataQualityReport(report: DataQualityReport): void {
  console.log('\n=== Data Quality Report ===');
  console.log(`Total recipes: ${report.total_recipes}`);
  console.log(`Time missing: ${report.pct_time_missing}%`);
  console.log(`Nutrition missing: ${report.pct_nutrition_missing}%`);
  console.log(`Protein unknown: ${report.pct_protein_unknown}%`);
  console.log(`Freezer unknown: ${report.pct_freezer_unknown}%`);
  console.log(`Macros incomplete: ${report.pct_macros_incomplete}%`);
  
  if (Object.keys(report.warnings_summary).length > 0) {
    console.log('\nWarnings breakdown:');
    for (const [warning, count] of Object.entries(report.warnings_summary).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${warning}: ${count} (${Math.round((count / report.total_recipes) * 1000) / 10}%)`);
    }
  }
  console.log('');
}
