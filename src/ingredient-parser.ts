/**
 * Ingredient Parser - Parses ingredient strings into structured data
 */

import type { ParsedIngredient } from './types.js';

// Unit patterns for matching
const UNIT_PATTERNS: Array<{ pattern: RegExp; normalized: string }> = [
  { pattern: /\b(cups?)\b/i, normalized: 'cup' },
  { pattern: /\b(c\.?)\b/i, normalized: 'cup' },
  { pattern: /\b(tablespoons?|tbsps?|tbl?s?p?)\b/i, normalized: 'tbsp' },
  { pattern: /\b(teaspoons?|tsps?|tsp?)\b/i, normalized: 'tsp' },
  { pattern: /\b(ounces?|oz\.?)\b/i, normalized: 'oz' },
  { pattern: /\b(pounds?|lbs?\.?)\b/i, normalized: 'lb' },
  { pattern: /\b(grams?|g\.?)\b/i, normalized: 'g' },
  { pattern: /\b(kilograms?|kg\.?)\b/i, normalized: 'kg' },
  { pattern: /\b(milliliters?|mls?\.?)\b/i, normalized: 'ml' },
  { pattern: /\b(liters?|l\.?)\b/i, normalized: 'l' },
  { pattern: /\b(pints?|pt\.?)\b/i, normalized: 'pint' },
  { pattern: /\b(quarts?|qt\.?)\b/i, normalized: 'quart' },
  { pattern: /\b(gallons?|gal\.?)\b/i, normalized: 'gallon' },
  { pattern: /\b(pinch(es)?)\b/i, normalized: 'pinch' },
  { pattern: /\b(dash(es)?)\b/i, normalized: 'dash' },
  { pattern: /\b(cloves?)\b/i, normalized: 'clove' },
  { pattern: /\b(heads?)\b/i, normalized: 'head' },
  { pattern: /\b(bunche?s?)\b/i, normalized: 'bunch' },
  { pattern: /\b(cans?)\b/i, normalized: 'can' },
  { pattern: /\b(packages?|pkgs?\.?)\b/i, normalized: 'package' },
  { pattern: /\b(slices?)\b/i, normalized: 'slice' },
  { pattern: /\b(pieces?|pcs?\.?)\b/i, normalized: 'piece' },
  { pattern: /\b(stalks?)\b/i, normalized: 'stalk' },
  { pattern: /\b(sprigs?)\b/i, normalized: 'sprig' },
  { pattern: /\b(unit)\b/i, normalized: 'unit' },  // HelloFresh uses "1 unit Tomato"
  { pattern: /\b(large|lg\.?)\b/i, normalized: 'large' },
  { pattern: /\b(medium|med\.?)\b/i, normalized: 'medium' },
  { pattern: /\b(small|sm\.?)\b/i, normalized: 'small' },
];

// Fraction map
const FRACTION_MAP: Record<string, number> = {
  '½': 0.5,
  '⅓': 0.333,
  '⅔': 0.667,
  '¼': 0.25,
  '¾': 0.75,
  '⅕': 0.2,
  '⅖': 0.4,
  '⅗': 0.6,
  '⅘': 0.8,
  '⅙': 0.167,
  '⅚': 0.833,
  '⅛': 0.125,
  '⅜': 0.375,
  '⅝': 0.625,
  '⅞': 0.875,
};

/**
 * Parse a single ingredient line
 */
export function parseIngredient(line: string): ParsedIngredient {
  const original = line.trim();
  let remaining = original;
  let quantity: number | null = null;
  let unit: string | null = null;
  let notes: string | null = null;

  // Extract notes in parentheses
  const notesMatch = remaining.match(/\(([^)]+)\)/);
  if (notesMatch) {
    notes = notesMatch[1].trim();
    remaining = remaining.replace(notesMatch[0], '').trim();
  }

  // Extract notes after comma (e.g., "1 cup flour, sifted")
  const commaIdx = remaining.indexOf(',');
  if (commaIdx > 0) {
    const afterComma = remaining.slice(commaIdx + 1).trim();
    if (afterComma && !afterComma.match(/^\d/)) {
      notes = notes ? `${notes}; ${afterComma}` : afterComma;
      remaining = remaining.slice(0, commaIdx).trim();
    }
  }

  // Parse quantity at start
  const quantityResult = parseQuantity(remaining);
  if (quantityResult) {
    quantity = quantityResult.value;
    remaining = remaining.slice(quantityResult.consumed).trim();
  }

  // Parse unit
  for (const { pattern, normalized } of UNIT_PATTERNS) {
    const match = remaining.match(pattern);
    if (match && remaining.toLowerCase().startsWith(match[0].toLowerCase())) {
      unit = normalized;
      remaining = remaining.slice(match[0].length).trim();
      // Remove "of" after unit (e.g., "cup of flour")
      remaining = remaining.replace(/^of\s+/i, '');
      break;
    }
  }

  // Clean up ingredient name
  const ingredient = cleanIngredientName(remaining);

  return {
    original,
    quantity,
    unit,
    ingredient,
    notes,
  };
}

/**
 * Parse quantity from start of string
 */
function parseQuantity(text: string): { value: number; consumed: number } | null {
  let value = 0;
  let consumed = 0;
  let remaining = text;

  // First, check if this starts with a standalone fraction (e.g., "1/2 cup")
  // We need to check this BEFORE matching a whole number
  const standaloneFractionMatch = remaining.match(/^(\d+)\/(\d+)\s*/);
  if (standaloneFractionMatch) {
    const num = parseInt(standaloneFractionMatch[1], 10);
    const denom = parseInt(standaloneFractionMatch[2], 10);
    if (denom !== 0) {
      value = num / denom;
      consumed = standaloneFractionMatch[0].length;
      return { value, consumed };
    }
  }

  // Match whole number
  const wholeMatch = remaining.match(/^(\d+)\s*/);
  if (wholeMatch) {
    value = parseInt(wholeMatch[1], 10);
    consumed = wholeMatch[0].length;
    remaining = remaining.slice(consumed);
  }

  // Match fraction after whole number (e.g., "1 1/2" -> 1.5)
  const fractionMatch = remaining.match(/^(\d+)\/(\d+)\s*/);
  if (fractionMatch) {
    const num = parseInt(fractionMatch[1], 10);
    const denom = parseInt(fractionMatch[2], 10);
    if (denom !== 0) {
      value += num / denom;
      consumed += fractionMatch[0].length;
      remaining = remaining.slice(fractionMatch[0].length);
    }
  } else {
    // Check for unicode fractions
    for (const [char, val] of Object.entries(FRACTION_MAP)) {
      if (remaining.startsWith(char)) {
        value += val;
        consumed += char.length;
        break;
      }
    }
  }

  // Match range (e.g., "2-3") - take the average
  const rangeMatch = text.match(/^(\d+(?:\.\d+)?)\s*[-–—to]+\s*(\d+(?:\.\d+)?)\s*/i);
  if (rangeMatch) {
    const low = parseFloat(rangeMatch[1]);
    const high = parseFloat(rangeMatch[2]);
    return { value: (low + high) / 2, consumed: rangeMatch[0].length };
  }

  if (consumed > 0) {
    return { value, consumed };
  }

  return null;
}

/**
 * Clean up ingredient name
 */
function cleanIngredientName(name: string): string {
  return name
    .replace(/^[-–—•*.]+\s*/, '')  // Remove leading bullets and stray punctuation (e.g. period left by "oz.")
    .replace(/^unit\s+/i, '')          // Strip leading "unit" that slipped through parsing (HelloFresh quirk)
    .replace(/\s+/g, ' ')          // Normalize whitespace
    .replace(/^(the|some|a|an)\s+/i, '')  // Remove articles
    .trim();
}

/**
 * Format ingredient for HelloFresh-style output (quantity first)
 */
export function formatIngredientHelloFresh(ingredient: ParsedIngredient): string {
  const parts: string[] = [];

  if (ingredient.quantity !== null) {
    parts.push(formatQuantity(ingredient.quantity));
  }

  if (ingredient.unit) {
    parts.push(ingredient.unit);
  }

  parts.push(ingredient.ingredient);

  if (ingredient.notes) {
    parts.push(`(${ingredient.notes})`);
  }

  return parts.join(' ');
}

/**
 * Format quantity with proper fractions
 */
function formatQuantity(value: number): string {
  const whole = Math.floor(value);
  const frac = value - whole;

  const fractionStrings: Record<number, string> = {
    0.25: '¼',
    0.333: '⅓',
    0.5: '½',
    0.667: '⅔',
    0.75: '¾',
    0.125: '⅛',
    0.375: '⅜',
    0.625: '⅝',
    0.875: '⅞',
  };

  // Find closest fraction
  let fracStr = '';
  let minDiff = 1;
  for (const [key, char] of Object.entries(fractionStrings)) {
    const diff = Math.abs(frac - parseFloat(key));
    if (diff < minDiff && diff < 0.05) {
      minDiff = diff;
      fracStr = char;
    }
  }

  if (whole > 0 && fracStr) {
    return `${whole} ${fracStr}`;
  } else if (whole > 0) {
    return frac > 0.05 ? value.toFixed(1) : whole.toString();
  } else if (fracStr) {
    return fracStr;
  } else {
    return value.toFixed(2).replace(/\.?0+$/, '');
  }
}

/**
 * Extract the main ingredient name (for matching/deduplication)
 */
export function extractMainIngredient(ingredient: ParsedIngredient): string {
  let name = ingredient.ingredient.toLowerCase();
  
  // Remove common modifiers
  const modifiers = [
    'fresh', 'frozen', 'canned', 'dried', 'ground', 'minced', 'diced', 'chopped',
    'sliced', 'shredded', 'grated', 'melted', 'softened', 'room temperature',
    'cold', 'warm', 'hot', 'cooked', 'raw', 'boneless', 'skinless', 'organic',
    'low-fat', 'low-sodium', 'unsalted', 'salted', 'unsweetened', 'sweetened',
    'extra-virgin', 'virgin', 'pure', 'natural', 'plain', 'vanilla',
  ];

  for (const mod of modifiers) {
    name = name.replace(new RegExp(`\\b${mod}\\b`, 'gi'), '');
  }

  return name.replace(/\s+/g, ' ').trim();
}
