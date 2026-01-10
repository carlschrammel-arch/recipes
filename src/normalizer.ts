/**
 * Normalizer - Converts raw recipes to normalized schema
 */

import { createHash } from 'crypto';
import type { 
  RawRecipe, 
  NormalizedRecipe, 
  ParsedIngredient,
  MealType,
  PrimaryProtein,
  CostTier,
  Equipment,
  Nutrition,
} from './types.js';
import { parseIngredient } from './ingredient-parser.js';

/**
 * Normalize a raw recipe to the standard schema
 */
export function normalizeRecipe(raw: RawRecipe): NormalizedRecipe {
  const warnings = [...raw.parse_warnings];

  // Parse ingredients
  const ingredients = raw.ingredients.map(parseIngredient);

  // Parse times
  const prepTime = parseTimeToMinutes(raw.prep_time);
  const cookTime = parseTimeToMinutes(raw.cook_time);
  const totalTime = parseTimeToMinutes(raw.total_time) || 
    (prepTime !== null && cookTime !== null ? prepTime + cookTime : null);

  // Parse servings
  const yieldServings = parseServings(raw.servings);

  // Generate stable ID
  const id = generateRecipeId(raw.title, raw.source, raw.ingredients);

  // Combine tags from categories and explicit tags
  const tags = [...new Set([
    ...(raw.categories || []).map(c => c.toLowerCase().trim()),
    ...(raw.tags || []).map(t => t.toLowerCase().trim()),
  ])].filter(Boolean);

  // Derive metadata using heuristics
  const ingredientText = raw.ingredients.join(' ').toLowerCase();
  const instructionText = raw.instructions.join(' ').toLowerCase();
  const fullText = `${raw.title} ${ingredientText} ${instructionText}`.toLowerCase();

  const mealType = deriveMealType(raw.title, tags, fullText);
  const primaryProtein = derivePrimaryProtein(ingredients, ingredientText);
  const equipment = deriveEquipment(instructionText);
  const spiceLevel = deriveSpiceLevel(ingredientText, instructionText);
  const kidFriendlyScore = deriveKidFriendlyScore(raw.title, ingredients, spiceLevel, tags);
  const weeknightScore = deriveWeeknightScore(totalTime, ingredients.length, equipment, instructionText);
  const costTier = deriveCostTier(ingredients, primaryProtein);
  const cuisine = deriveCuisine(raw.title, tags, ingredientText);
  const nutrition = parseNutrition(raw.nutrition);

  return {
    id,
    title: cleanTitle(raw.title),
    source_name: extractSourceName(raw.source, raw.source_url),
    source_url: raw.source_url || null,
    yield_servings: yieldServings,
    prep_time_minutes: prepTime,
    cook_time_minutes: cookTime,
    total_time_minutes: totalTime,
    ingredients,
    instructions: raw.instructions.filter(Boolean),
    tags,
    notes: raw.notes || null,
    nutrition,
    cuisine,
    meal_type: mealType,
    kid_friendly_score: kidFriendlyScore,
    weeknight_score: weeknightScore,
    spice_level: spiceLevel,
    equipment,
    primary_protein: primaryProtein,
    cost_tier: costTier,
    duplicate_group_id: null,
    parse_warnings: warnings,
    source_file: raw.source_file,
    imported_at: new Date().toISOString(),
  };
}

/**
 * Generate a stable recipe ID
 */
function generateRecipeId(title: string, source: string | undefined, ingredients: string[]): string {
  const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]/g, '');
  const normalizedSource = (source || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const ingredientHash = ingredients.slice(0, 5).join('').toLowerCase().replace(/[^a-z0-9]/g, '');
  
  const combined = `${normalizedTitle}|${normalizedSource}|${ingredientHash}`;
  const hash = createHash('sha256').update(combined).digest('hex');
  
  return hash.slice(0, 12);
}

/**
 * Parse time string to minutes
 */
function parseTimeToMinutes(timeStr: string | undefined): number | null {
  if (!timeStr) return null;

  const lower = timeStr.toLowerCase().trim();
  
  // Handle ISO 8601 duration format (PT1H30M)
  const isoMatch = lower.match(/pt(?:(\d+)h)?(?:(\d+)m)?/);
  if (isoMatch) {
    const hours = parseInt(isoMatch[1] || '0', 10);
    const minutes = parseInt(isoMatch[2] || '0', 10);
    return hours * 60 + minutes;
  }

  let totalMinutes = 0;

  // Extract hours
  const hourMatch = lower.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h\b)/);
  if (hourMatch) {
    totalMinutes += parseFloat(hourMatch[1]) * 60;
  }

  // Extract minutes
  const minMatch = lower.match(/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m\b)/);
  if (minMatch) {
    totalMinutes += parseFloat(minMatch[1]);
  }

  // If just a number, assume minutes
  if (totalMinutes === 0) {
    const numMatch = lower.match(/^(\d+)$/);
    if (numMatch) {
      totalMinutes = parseInt(numMatch[1], 10);
    }
  }

  return totalMinutes > 0 ? Math.round(totalMinutes) : null;
}

/**
 * Parse servings string to number
 */
function parseServings(servingsStr: string | undefined): number | null {
  if (!servingsStr) return null;

  const lower = servingsStr.toLowerCase();
  
  // Match "4 servings", "serves 4", "4-6", etc.
  const match = lower.match(/(\d+)(?:\s*[-–—to]+\s*(\d+))?/);
  if (match) {
    if (match[2]) {
      // Range - take average
      return Math.round((parseInt(match[1], 10) + parseInt(match[2], 10)) / 2);
    }
    return parseInt(match[1], 10);
  }

  return null;
}

/**
 * Clean and normalize recipe title
 */
function cleanTitle(title: string): string {
  return title
    .replace(/^recipe[:\s]*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract source name from source string or URL
 */
function extractSourceName(source: string | undefined, sourceUrl: string | undefined): string | null {
  if (source && source.trim()) {
    return source.trim();
  }

  if (sourceUrl) {
    try {
      const url = new URL(sourceUrl);
      return url.hostname.replace(/^www\./, '');
    } catch {
      // Not a valid URL
    }
  }

  return null;
}

/**
 * Derive meal type from recipe data
 */
function deriveMealType(title: string, tags: string[], fullText: string): MealType {
  const lower = (title + ' ' + tags.join(' ')).toLowerCase();

  // Breakfast indicators
  if (/\b(breakfast|brunch|pancakes?|waffles?|omelette|omelet|scramble|eggs?|bacon|cereal|muffins?|french toast|oatmeal|granola|morning)\b/.test(lower)) {
    return 'breakfast';
  }

  // Dessert indicators
  if (/\b(desserts?|cakes?|cookies?|brownies?|pies?|tarts?|puddings?|ice cream|sorbet|chocolate|sweet|candy|cupcakes?|cheesecakes?)\b/.test(lower)) {
    return 'dessert';
  }

  // Snack indicators
  if (/\b(snack|appetizer|dip|chips|crackers|nuts|popcorn|finger food|bite|nibble)\b/.test(lower)) {
    return 'snack';
  }

  // Lunch indicators (sandwiches, salads, light meals)
  if (/\b(lunch|sandwich|wrap|salad|soup|panini|bagel|sub|burger)\b/.test(lower) && 
      !/\b(dinner|supper|main)\b/.test(lower)) {
    return 'lunch';
  }

  // Default to dinner for most recipes
  return 'dinner';
}

/**
 * Derive primary protein from ingredients
 */
function derivePrimaryProtein(ingredients: ParsedIngredient[], ingredientText: string): PrimaryProtein {
  const proteinPatterns: Array<{ pattern: RegExp; protein: PrimaryProtein }> = [
    { pattern: /\b(chicken|poultry)\b/i, protein: 'chicken' },
    { pattern: /\b(beef|steak|ground beef|brisket|sirloin|ribeye)\b/i, protein: 'beef' },
    { pattern: /\b(pork|ham|bacon|sausage|pancetta|prosciutto)\b/i, protein: 'pork' },
    { pattern: /\b(salmon|tuna|cod|tilapia|halibut|trout|bass|mahi|fish)\b/i, protein: 'fish' },
    { pattern: /\b(shrimp|crab|lobster|scallop|clam|mussel|oyster|seafood|prawn)\b/i, protein: 'seafood' },
    { pattern: /\b(turkey)\b/i, protein: 'turkey' },
    { pattern: /\b(lamb)\b/i, protein: 'lamb' },
    { pattern: /\b(tofu|tempeh|seitan)\b/i, protein: 'tofu' },
    { pattern: /\b(lentil|chickpea|bean|legume|black bean|kidney bean|cannellini)\b/i, protein: 'legumes' },
    { pattern: /\b(eggs?)\b/i, protein: 'eggs' },
  ];

  // Check each ingredient
  for (const ing of ingredients) {
    const text = ing.ingredient.toLowerCase();
    for (const { pattern, protein } of proteinPatterns) {
      if (pattern.test(text)) {
        return protein;
      }
    }
  }

  // Check full ingredient text
  for (const { pattern, protein } of proteinPatterns) {
    if (pattern.test(ingredientText)) {
      return protein;
    }
  }

  // Check for vegetarian indicators
  if (/\b(vegetarian|veggie|meatless|plant.?based)\b/i.test(ingredientText)) {
    return 'vegetarian';
  }

  return 'other';
}

/**
 * Derive equipment needed from instructions
 */
function deriveEquipment(instructionText: string): Equipment[] {
  const equipment: Set<Equipment> = new Set();

  const patterns: Array<{ pattern: RegExp; equipment: Equipment }> = [
    { pattern: /\b(oven|bake|roast)\b/i, equipment: 'oven' },
    { pattern: /\b(stovetop|stove|saut[ée]|pan.?fry|simmer|boil)\b/i, equipment: 'stovetop' },
    { pattern: /\b(sheet pan|baking sheet|sheet tray)\b/i, equipment: 'sheet_pan' },
    { pattern: /\b(instant pot|pressure cook(er)?)\b/i, equipment: 'instant_pot' },
    { pattern: /\b(slow cook(er)?|crock.?pot)\b/i, equipment: 'slow_cooker' },
    { pattern: /\b(air fry(er)?)\b/i, equipment: 'air_fryer' },
    { pattern: /\b(grill(ed)?|barbecue|bbq)\b/i, equipment: 'grill' },
    { pattern: /\b(blend(er)?|puree|smooth)\b/i, equipment: 'blender' },
    { pattern: /\b(food processor|pulse|chop.*processor)\b/i, equipment: 'food_processor' },
    { pattern: /\b(dutch oven)\b/i, equipment: 'dutch_oven' },
    { pattern: /\b(microwave)\b/i, equipment: 'microwave' },
    { pattern: /\b(stand mixer|kitchen.?aid)\b/i, equipment: 'stand_mixer' },
  ];

  for (const { pattern, equipment: eq } of patterns) {
    if (pattern.test(instructionText)) {
      equipment.add(eq);
    }
  }

  return Array.from(equipment);
}

/**
 * Derive spice level (0-3)
 */
function deriveSpiceLevel(ingredientText: string, instructionText: string): number {
  const fullText = `${ingredientText} ${instructionText}`.toLowerCase();

  // Very hot (3)
  if (/\b(ghost peppers?|carolina reapers?|habaneros?|scotch bonnets?|thai chili|bird.?s? eye)\b/.test(fullText)) {
    return 3;
  }

  // Hot (2) - use more flexible matching for accented characters
  if (/(jalape[ñn]os?|serranos?|cayenne|hot sauce|sriracha|chili flakes|red pepper flakes|spicy)\b/.test(fullText)) {
    return 2;
  }

  // Medium (1)
  if (/\b(poblanos?|anaheim|chipotles?|paprika|mild chili|green chiles?)\b/.test(fullText)) {
    return 1;
  }

  // Mild (0)
  return 0;
}

/**
 * Derive kid-friendly score (0-1)
 */
function deriveKidFriendlyScore(
  title: string, 
  ingredients: ParsedIngredient[], 
  spiceLevel: number, 
  tags: string[]
): number {
  let score = 0.5; // Start neutral

  const titleLower = title.toLowerCase();
  const ingredientText = ingredients.map(i => i.ingredient).join(' ').toLowerCase();

  // Positive indicators
  const kidFriendlyFoods = [
    'pasta', 'mac', 'cheese', 'pizza', 'chicken nugget', 'grilled cheese', 
    'pancake', 'waffle', 'taco', 'burrito', 'quesadilla', 'meatball',
    'spaghetti', 'burger', 'hot dog', 'french fries', 'fries',
    'chicken tender', 'chicken finger', 'corn dog', 'nachos',
  ];

  for (const food of kidFriendlyFoods) {
    if (titleLower.includes(food) || ingredientText.includes(food)) {
      score += 0.15;
    }
  }

  // Kid-friendly tags
  if (tags.some(t => /(kid|child|family|easy|simple|quick|comfort)/.test(t))) {
    score += 0.2;
  }

  // Negative indicators (spicy)
  score -= spiceLevel * 0.15;

  // Penalty for "exotic" or complex ingredients
  const complexIngredients = [
    'anchov', 'olive', 'blue cheese', 'gorgonzola', 'goat cheese',
    'brussels sprout', 'asparagus', 'kale', 'arugula', 'liver',
    'oyster', 'mussel', 'capers', 'artichoke',
  ];

  for (const complex of complexIngredients) {
    if (ingredientText.includes(complex)) {
      score -= 0.1;
    }
  }

  return Math.max(0, Math.min(1, score));
}

/**
 * Derive weeknight score (0-1)
 */
function deriveWeeknightScore(
  totalTime: number | null, 
  ingredientCount: number, 
  equipment: Equipment[],
  instructionText: string
): number {
  let score = 0.5;

  // Time factor
  if (totalTime !== null) {
    if (totalTime <= 20) score += 0.3;
    else if (totalTime <= 30) score += 0.2;
    else if (totalTime <= 45) score += 0.1;
    else if (totalTime > 60) score -= 0.2;
    else if (totalTime > 90) score -= 0.3;
  }

  // Ingredient count
  if (ingredientCount <= 5) score += 0.2;
  else if (ingredientCount <= 8) score += 0.1;
  else if (ingredientCount > 15) score -= 0.1;
  else if (ingredientCount > 20) score -= 0.2;

  // Simple equipment bonus
  const simpleEquipment: Equipment[] = ['stovetop', 'sheet_pan', 'microwave'];
  const complexEquipment: Equipment[] = ['slow_cooker', 'instant_pot', 'food_processor', 'stand_mixer'];

  if (equipment.every(e => simpleEquipment.includes(e))) {
    score += 0.1;
  }

  // Quick cooking methods
  if (/\b(one.?pot|one.?pan|sheet.?pan|dump|no.?cook|5.?minute|10.?minute|15.?minute)\b/i.test(instructionText)) {
    score += 0.15;
  }

  return Math.max(0, Math.min(1, score));
}

/**
 * Derive cost tier
 */
function deriveCostTier(ingredients: ParsedIngredient[], primaryProtein: PrimaryProtein): CostTier {
  const ingredientText = ingredients.map(i => i.ingredient).join(' ').toLowerCase();

  // Expensive proteins
  const expensiveProteins: PrimaryProtein[] = ['fish', 'seafood', 'lamb'];
  if (expensiveProteins.includes(primaryProtein)) {
    return 'high';
  }

  // Expensive ingredients
  const expensiveIngredients = [
    'lobster', 'crab', 'scallop', 'filet mignon', 'ribeye', 'tenderloin',
    'truffle', 'saffron', 'vanilla bean', 'pine nut', 'macadamia',
    'wagyu', 'kobe', 'foie gras', 'caviar',
  ];

  for (const expensive of expensiveIngredients) {
    if (ingredientText.includes(expensive)) {
      return 'high';
    }
  }

  // Budget ingredients
  const budgetProteins: PrimaryProtein[] = ['eggs', 'legumes', 'tofu', 'chicken'];
  const budgetIngredients = [
    'rice', 'bean', 'lentil', 'pasta', 'potato', 'egg', 'chicken thigh',
    'ground turkey', 'ground beef', 'canned',
  ];

  let budgetScore = 0;
  if (budgetProteins.includes(primaryProtein)) {
    budgetScore++;
  }

  for (const budget of budgetIngredients) {
    if (ingredientText.includes(budget)) {
      budgetScore++;
    }
  }

  if (budgetScore >= 3) {
    return 'low';
  }

  return 'medium';
}

/**
 * Derive cuisine from recipe data
 */
function deriveCuisine(title: string, tags: string[], ingredientText: string): string | null {
  const fullText = `${title} ${tags.join(' ')} ${ingredientText}`.toLowerCase();

  const cuisinePatterns: Array<{ pattern: RegExp; cuisine: string }> = [
    { pattern: /\b(italian|pasta|risotto|lasagna|pizza|pesto|marinara)\b/, cuisine: 'Italian' },
    { pattern: /\b(mexican|taco|burrito|enchilada|fajita|salsa|guacamole|tex.?mex)\b/, cuisine: 'Mexican' },
    { pattern: /\b(chinese|stir.?fry|wok|kung pao|fried rice|lo mein|szechuan)\b/, cuisine: 'Chinese' },
    { pattern: /\b(japanese|sushi|ramen|teriyaki|miso|tempura|udon)\b/, cuisine: 'Japanese' },
    { pattern: /\b(thai|pad thai|curry|coconut milk|fish sauce|lemongrass)\b/, cuisine: 'Thai' },
    { pattern: /\b(indian|curry|tandoori|tikka|masala|naan|biryani)\b/, cuisine: 'Indian' },
    { pattern: /\b(greek|mediterranean|tzatziki|feta|hummus|falafel)\b/, cuisine: 'Mediterranean' },
    { pattern: /\b(french|ratatouille|beurre|au gratin|croissant|crepe)\b/, cuisine: 'French' },
    { pattern: /\b(korean|kimchi|bulgogi|bibimbap|gochujang)\b/, cuisine: 'Korean' },
    { pattern: /\b(american|bbq|barbecue|burger|hot dog|mac.?cheese)\b/, cuisine: 'American' },
    { pattern: /\b(southern|cajun|creole|gumbo|jambalaya)\b/, cuisine: 'Southern' },
  ];

  for (const { pattern, cuisine } of cuisinePatterns) {
    if (pattern.test(fullText)) {
      return cuisine;
    }
  }

  return null;
}

/**
 * Parse nutrition information
 */
function parseNutrition(nutritionStr: string | undefined): Nutrition | null {
  if (!nutritionStr) return null;

  const lower = nutritionStr.toLowerCase();
  
  const extractNumber = (pattern: RegExp): number | null => {
    const match = lower.match(pattern);
    return match ? parseFloat(match[1]) : null;
  };

  const calories = extractNumber(/(\d+(?:\.\d+)?)\s*(?:cal(?:orie)?s?|kcal)/);
  const protein = extractNumber(/(\d+(?:\.\d+)?)\s*g?\s*protein/);
  const carbs = extractNumber(/(\d+(?:\.\d+)?)\s*g?\s*(?:carb(?:ohydrate)?s?|carb)/);
  const fat = extractNumber(/(\d+(?:\.\d+)?)\s*g?\s*(?:fat|total fat)/);
  const sodium = extractNumber(/(\d+(?:\.\d+)?)\s*(?:mg)?\s*sodium/);

  if (calories === null && protein === null && carbs === null && fat === null) {
    return null;
  }

  return {
    calories,
    protein_g: protein,
    carbs_g: carbs,
    fat_g: fat,
    sodium_mg: sodium,
  };
}
