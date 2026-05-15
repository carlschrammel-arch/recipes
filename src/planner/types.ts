/**
 * Weekly Meal Planner — Type Definitions
 *
 * The planning layer converts natural-language intent into a structured
 * WeeklyPlanRequest, then uses a deterministic TypeScript optimizer to
 * select real recipes. The LLM never invents recipe choices.
 */

import type { NormalizedRecipe } from '../types.js';
import type { SelectionRecord } from '../selection-index.js';

// ============================================================================
// Request Types
// ============================================================================

/** Protein category used to bucket recipe slots in the weekly plan. */
export type ProteinSlot =
  | 'chicken'
  | 'pork'
  | 'beef'
  | 'vegetarian'
  | 'vegan'
  | 'seafood'
  | 'turkey'
  | 'other';

/**
 * Waste classification for a shared grocery ingredient.
 * - pantry: long shelf-life basics (salt, pepper, oil, flour). Not shown in main overlap.
 * - fridge_staple: common refrigerated items (garlic, onion, butter, eggs). Low waste risk.
 * - perishable: short shelf-life items (fresh herbs, leafy greens, tomatoes, cream). High waste risk.
 * - specialty: specific purchase needed (parmesan, tortillas, canned beans). Medium waste risk.
 */
export type IngredientWasteClass = 'pantry' | 'fridge_staple' | 'perishable' | 'specialty';

/** An inclusive percentage range (0–100). Undefined end = unbounded. */
export interface MacroRange {
  minPct?: number;
  maxPct?: number;
}

/**
 * Structured constraints extracted from a natural-language planning query.
 * Created by the AI query-parser; validated by Zod before use.
 */
export interface WeeklyPlanRequest {
  /** Total number of meals/recipes to select. */
  mealCount: number;

  /**
   * One entry per explicitly requested protein category.
   * Length ≤ mealCount. Extra meals are tracked in flexMealCount.
   */
  requiredProteinSlots: ProteinSlot[];

  /**
   * Number of meals that can be any protein type (mealCount − requiredProteinSlots.length).
   * Flex meals are filled from the best remaining candidates across all categories.
   * Do NOT use the 'other' slot for this; use flexMealCount instead.
   */
  flexMealCount?: number;

  /** Minimum number of selected recipes that must be kid-friendly (score ≥ 0.6). */
  minKidFriendlyMeals?: number;

  /** Optional macro percentage targets (all nullable endpoints = no constraint). */
  macroTargets?: {
    fatPct?: MacroRange;
    carbsPct?: MacroRange;
    proteinPct?: MacroRange;
  };

  /** Boolean diet/lifestyle goals. Each activates corresponding scoring bonuses. */
  goals: {
    weightLoss?: boolean;
    highProtein?: boolean;
    lowFat?: boolean;
    quickEasy?: boolean;
    lowMediumCost?: boolean;
    freezerFriendly?: boolean;
    lowWaste?: boolean;
    lowTransFat?: boolean;
    limitedSaturatedFat?: boolean;
    healthyFats?: boolean;
    varietyOfFlavors?: boolean;
  };

  /** Ingredient names the user would like to see in the plan (soft preference). */
  preferredIngredients: string[];

  /**
   * At least one recipe must come from a matching source.
   * Values are lowercase substrings matched against SelectionRecord.source_normalized.
   * E.g. ["hellofresh"].
   */
  requiredSourceSignals?: string[];

  /**
   * At least one recipe must match these tags or title terms.
   * E.g. ["pasta"].
   */
  requiredTagsOrTitleTerms?: string[];

  /** Whether a comfort-food recipe is acceptable (if false, deprioritize). */
  allowComfortFood?: boolean;

  /** Override for max alternatives to show per slot (default 3). */
  maxResults?: number;
}

// ============================================================================
// Scoring Types
// ============================================================================

/** Score and breakdown for a single candidate recipe against a request. */
export interface CandidateScore {
  recipeId: string;
  /** False if any hard disqualifying constraint was triggered. */
  hardConstraintPass: boolean;
  /** Reasons why this candidate was disqualified (only when hardConstraintPass=false). */
  disqualifyingReasons: string[];
  /** Composite score (higher = better fit). */
  score: number;
  /** Named sub-scores for transparency. */
  scoreBreakdown: Record<string, number>;
  /** Preferred ingredients found in this recipe's ingredients. */
  matchedPreferredIngredients: string[];
  /** Nutrition fields that were absent (score computed without them). */
  missingNutritionFields: string[];
}

// ============================================================================
// Plan Result Types
// ============================================================================

/** A shared grocery ingredient with its waste classification. */
export interface SharedIngredient {
  ingredient: string;
  recipeIds: string[];
  wasteClass: IngredientWasteClass;
  /** Weight used for waste-risk scoring (0=ignore, 1.0=full weight). */
  scoreWeight: number;
}

export interface ShoppingOverlap {
  /**
   * Meaningful shared ingredients (fridge_staple, perishable, specialty).
   * Sorted by waste relevance: perishable first, then specialty, then fridge_staple.
   */
  sharedIngredients: SharedIngredient[];
  /**
   * Pantry staples that overlap (salt, pepper, oil, etc.).
   * Shown separately in verbose mode; not counted in waste-risk score.
   */
  pantryOverlaps: Array<{ ingredient: string; recipeIds: string[] }>;
  /** Estimated shopping waste risk based on perishable overlap count. */
  estimatedWasteRisk: 'low' | 'medium' | 'high';
  notes: string[];
}

export interface PlanValidation {
  allRecipeIdsExist: boolean;
  noHallucinatedRecipes: boolean;
  /**
   * True when all structural constraints pass: IDs exist, no duplicates,
   * required protein slots filled, kid-friendly minimum met, HF/pasta requirements met.
   */
  structuralConstraintsSatisfied: boolean;
  /**
   * @deprecated Use structuralConstraintsSatisfied.
   * Kept for backward compatibility; equals structuralConstraintsSatisfied.
   */
  hardConstraintsSatisfied: boolean;
  /**
   * True when all requested macro targets were met on average.
   * null when there was insufficient nutrition data to evaluate.
   */
  nutritionTargetsSatisfied: boolean | null;
  /**
   * 'met'     — all macro targets evaluated and within range.
   * 'failed'  — at least one target was outside range.
   * 'partial' — some recipes lacked complete macro data; partial evaluation only.
   * 'unknown' — no macro targets were requested, or no recipes had any nutrition data.
   */
  nutritionEvaluationStatus: 'met' | 'failed' | 'partial' | 'unknown';
  warnings: string[];
  failedConstraints: string[];
}

/** A single alternative candidate for a slot. */
export interface PlanAlternativeEntry {
  id: string;
  title: string;
  /** Short phrase describing why this is a good alternative. */
  reason: string;
}

export interface PlanAlternative {
  slot: string;
  /** Detailed alternative entries with titles and reasons. */
  entries: PlanAlternativeEntry[];
  /**
   * @deprecated Use entries. Kept for backward compatibility.
   * Contains the same IDs as entries[*].id.
   */
  recipeIds: string[];
  reason: string;
}

/** Final output of the deterministic weekly plan optimizer. */
export interface WeeklyPlanResult {
  request: WeeklyPlanRequest;
  /** Ordered IDs of selected recipes (one per effective slot). */
  selectedRecipeIds: string[];
  /** Full NormalizedRecipe objects, in the same order. */
  selectedRecipes: NormalizedRecipe[];
  planScore: number;
  planScoreBreakdown: Record<string, number>;
  shoppingOverlap: ShoppingOverlap;
  validation: PlanValidation;
  alternatives: PlanAlternative[];
  /** Present when auto-enrichment ran during planning. */
  enrichmentSummary?: EnrichmentSummary;
  /**
   * Recipes that were selected despite being a weak fit for some requested goals.
   * Populated when a recipe has notably poor macro fit, is creamy pasta under
   * weight-loss goals, or has other significant mismatches.
   */
  selectedDespiteWarnings?: Array<{
    recipeId: string;
    title: string;
    reasons: string[];
  }>;
}

// ============================================================================
// Enrichment Types
// ============================================================================

/**
 * Estimated planning metadata produced by OpenAI for recipes that lack it.
 * All fields are estimates — never used for strict nutritional validation.
 */
export interface EstimatedPlanningMetadata {
  /** Estimated calories per serving (informational only, not for strict validation). */
  estimated_calories?: number | null;
  /** Estimated protein grams per serving (informational only). */
  estimated_protein_g?: number | null;
  /** Estimated carbs grams per serving (informational only). */
  estimated_carbs_g?: number | null;
  /** Estimated fat grams per serving (informational only). */
  estimated_fat_g?: number | null;
  /** Whether this recipe is likely freezer-safe. */
  freezer_friendly?: boolean | null;
  /** Whether this recipe reheats well. */
  reheats_well?: boolean | null;
  /** 0–1 score for kid-friendliness. */
  kid_friendly_score?: number | null;
  /** Comfort food rating (0–1). */
  comfort_score?: number | null;
  /** Primary flavor family (e.g. "umami", "bright", "hearty"). */
  flavor_family?: string | null;
  /** AI's brief reasoning (for transparency). */
  reasoning?: string | null;
}

/**
 * A single cached enrichment record.
 * Keyed by recipe ID + content hash + schema version + model.
 * Never overwrites original Paprika data.
 */
export interface EnrichmentRecord {
  /** Recipe ID from the normalized catalog. */
  recipe_id: string;
  /** SHA-256 of recipe title + ingredient list (detects staleness). */
  recipe_hash: string;
  /** Schema version for forward-compatibility. */
  schema_version: 1;
  /** Model that produced this enrichment (e.g. "gpt-4o-mini"). */
  model: string;
  /** ISO timestamp. */
  enriched_at: string;
  /** The estimated metadata. */
  metadata: EstimatedPlanningMetadata;
}

/** Summary of what happened during auto-enrichment in a planning run. */
export interface EnrichmentSummary {
  mode: 'off' | 'selected_only' | 'candidates';
  recipesEnriched: number;
  recipesFromCache: number;
  skippedDueToLimit: number;
  apiKeyMissing: boolean;
  limitReached: boolean;
  /** IDs + titles of newly enriched recipes. */
  enrichedRecipes: Array<{ id: string; title: string }>;
  /** Fields that were estimated and used for soft scoring. */
  estimatedFields: string[];
}


// ============================================================================
// Internal Optimizer Types
// ============================================================================

/** A recipe enriched with its pre-computed SelectionRecord for fast scoring. */
export interface PlannerRecipe {
  sel: SelectionRecord;
  norm: NormalizedRecipe;
}

/** A partial plan being grown during beam search. */
export interface PartialPlan {
  /** slot label → chosen PlannerRecipe */
  assignments: Map<string, PlannerRecipe>;
  /** Running composite score (individual + plan-level bonuses applied so far). */
  score: number;
  /** IDs already used (prevents duplicate selection). */
  usedIds: Set<string>;
  /** Canonical ingredient key → list of recipeIds that contain it. */
  ingredientKeys: Map<string, string[]>;
  /** Cuisine strings already in the plan (for variety scoring). */
  cuisines: Set<string>;
}
