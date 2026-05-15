/**
 * Macro Percentage Calculator
 *
 * Computes macronutrient percentages from raw gram values using the correct
 * caloric equivalents: protein 4 kcal/g, carbs 4 kcal/g, fat 9 kcal/g.
 * The denominator is always the sum of macro calories — never the label calorie
 * value — to avoid rounding drift that causes percentages to not sum to 100%.
 */

export interface MacroInput {
  calories?: number | null;
  protein_g?: number | null;
  carbs_g?: number | null;
  fat_g?: number | null;
}

export interface MacroPercentages {
  proteinPct: number | null;
  carbsPct: number | null;
  fatPct: number | null;
  /** Calories derived from macros (protein*4 + carbs*4 + fat*9). */
  macroCalories: number | null;
  /** Whether percentages were computable and from which calorie base. */
  source: 'macro_calories' | 'unavailable';
}

/**
 * Calculate macro percentages from gram values.
 * Returns null values when any macro gram value is missing or totals to zero.
 */
export function calculateMacroPercentages(input: MacroInput): MacroPercentages {
  const { protein_g, carbs_g, fat_g } = input;

  // All three macros must be present to compute percentages
  if (protein_g == null || carbs_g == null || fat_g == null) {
    return {
      proteinPct: null,
      carbsPct: null,
      fatPct: null,
      macroCalories: null,
      source: 'unavailable',
    };
  }

  const protCal = protein_g * 4;
  const carbCal = carbs_g * 4;
  const fatCal = fat_g * 9;
  const macroCalories = protCal + carbCal + fatCal;

  if (macroCalories <= 0) {
    return {
      proteinPct: null,
      carbsPct: null,
      fatPct: null,
      macroCalories: null,
      source: 'unavailable',
    };
  }

  return {
    proteinPct: (protCal / macroCalories) * 100,
    carbsPct: (carbCal / macroCalories) * 100,
    fatPct: (fatCal / macroCalories) * 100,
    macroCalories,
    source: 'macro_calories',
  };
}

/**
 * Identify which macro gram fields are missing from a nutrition record.
 * Returns a deduplicated array of field names.
 */
export function getMissingMacroFields(input: MacroInput): string[] {
  const missing = new Set<string>();
  if (input.protein_g == null) missing.add('protein_g');
  if (input.carbs_g == null) missing.add('carbs_g');
  if (input.fat_g == null) missing.add('fat_g');
  return [...missing];
}

/**
 * Format a macro percentage string for display, rounding to one decimal place.
 * Returns null if the value is null.
 */
export function formatMacroPct(value: number | null): string | null {
  if (value == null) return null;
  return `${value.toFixed(1)}%`;
}
