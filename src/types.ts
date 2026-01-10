/**
 * Recipe Context Builder - Type Definitions
 * Normalized schema for Paprika recipe exports
 */

// ============================================================================
// Core Recipe Schema
// ============================================================================

export interface ParsedIngredient {
  original: string;
  quantity: number | null;
  unit: string | null;
  ingredient: string;
  notes: string | null;
}

export interface Nutrition {
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  sodium_mg: number | null;
}

export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'dessert' | 'other';
export type PrimaryProtein = 'chicken' | 'beef' | 'pork' | 'fish' | 'seafood' | 'turkey' | 'lamb' | 'tofu' | 'legumes' | 'eggs' | 'vegetarian' | 'other';
export type CostTier = 'low' | 'medium' | 'high';
export type Equipment = 'oven' | 'stovetop' | 'sheet_pan' | 'instant_pot' | 'slow_cooker' | 'air_fryer' | 'grill' | 'blender' | 'food_processor' | 'dutch_oven' | 'microwave' | 'stand_mixer';

export interface NormalizedRecipe {
  id: string;
  title: string;
  source_name: string | null;
  source_url: string | null;
  yield_servings: number | null;
  prep_time_minutes: number | null;
  cook_time_minutes: number | null;
  total_time_minutes: number | null;
  ingredients: ParsedIngredient[];
  instructions: string[];
  tags: string[];
  notes: string | null;
  nutrition: Nutrition | null;
  cuisine: string | null;
  meal_type: MealType;
  kid_friendly_score: number;
  weeknight_score: number;
  spice_level: number;
  equipment: Equipment[];
  primary_protein: PrimaryProtein;
  cost_tier: CostTier;
  duplicate_group_id: string | null;
  parse_warnings: string[];
  
  // Metadata
  raw_text?: string;
  source_file: string;
  imported_at: string;
}

// ============================================================================
// Raw Parsed Recipe (before normalization)
// ============================================================================

export interface RawRecipe {
  title: string;
  source?: string;
  source_url?: string;
  servings?: string;
  prep_time?: string;
  cook_time?: string;
  total_time?: string;
  ingredients: string[];
  instructions: string[];
  categories?: string[];
  tags?: string[];
  notes?: string;
  nutrition?: string;
  image_url?: string;
  rating?: number;
  difficulty?: string;
  
  // Parser metadata
  source_file: string;
  source_format: 'html' | 'txt' | 'mcb' | 'json' | 'unknown';
  raw_text?: string;
  parse_warnings: string[];
}

// ============================================================================
// User Configuration
// ============================================================================

export interface DietaryPreferences {
  high_protein?: boolean;
  low_fat?: boolean;
  low_carb?: boolean;
  vegetarian?: boolean;
  vegan?: boolean;
  gluten_free?: boolean;
  dairy_free?: boolean;
  keto?: boolean;
  paleo?: boolean;
}

export interface UserConfig {
  dietary_preferences?: DietaryPreferences;
  household_notes?: {
    kid_friendly?: boolean;
    spice_tolerance?: 'mild' | 'medium' | 'hot' | 'very_hot';
    num_servings?: number;
  };
  excluded_ingredients?: string[];
  serving_size_default?: number;
  hellofresh_format?: boolean;
  
  // Context generation settings
  max_recipes_in_context?: number;
  max_chars?: number;
}

// ============================================================================
// Index & Output Structures
// ============================================================================

export interface RecipeIndexEntry {
  id: string;
  title: string;
  meal_type: MealType;
  primary_protein: PrimaryProtein;
  total_time_minutes: number | null;
  tags: string[];
  weeknight_score: number;
  kid_friendly_score: number;
  duplicate_group_id: string | null;
}

export interface RecipeIndex {
  version: string;
  generated_at: string;
  total_recipes: number;
  unique_recipes: number;
  duplicate_groups: number;
  recipes: RecipeIndexEntry[];
  tag_counts: Record<string, number>;
  protein_counts: Record<PrimaryProtein, number>;
  meal_type_counts: Record<MealType, number>;
}

export interface ImportReport {
  generated_at: string;
  input_path: string;
  output_path: string;
  files_scanned: number;
  files_parsed: number;
  files_failed: number;
  recipes_imported: number;
  recipes_unique: number;
  duplicate_groups: DuplicateGroup[];
  parse_errors: ParseError[];
  warnings: string[];
  stats: {
    by_format: Record<string, number>;
    by_meal_type: Record<MealType, number>;
    by_protein: Record<PrimaryProtein, number>;
    avg_weeknight_score: number;
    avg_kid_friendly_score: number;
    recipes_with_ingredients?: number;
    recipes_with_instructions?: number;
  };
}

export interface DuplicateGroup {
  group_id: string;
  canonical_id: string;
  recipes: Array<{
    id: string;
    title: string;
    source_file: string;
    similarity_score: number;
  }>;
}

export interface ParseError {
  file: string;
  error: string;
  stack?: string;
}

// ============================================================================
// Parser Interface
// ============================================================================

export interface Parser {
  name: string;
  extensions: string[];
  canParse(filePath: string, content?: Buffer): boolean;
  parse(filePath: string, content: Buffer): Promise<RawRecipe[]>;
}

// ============================================================================
// Build Options
// ============================================================================

export interface BuildOptions {
  inputPath: string;
  outputPath: string;
  configPath?: string;
  maxChars?: number;
  maxRecipesInContext?: number;
  format?: 'markdown' | 'jsonl' | 'both';
  verbose?: boolean;
}

export interface SearchOptions {
  query?: string;
  tags?: string[];
  mealType?: MealType;
  protein?: PrimaryProtein;
  maxTime?: number;
  minWeeknightScore?: number;
  minKidFriendlyScore?: number;
  limit?: number;
}
