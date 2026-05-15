/**
 * Weekly Meal Planner — Query Parser
 *
 * Converts a natural-language planning query into a structured WeeklyPlanRequest.
 *
 * Architecture:
 *   1. Primary path: send query to OpenAI → receive JSON → validate with Zod → return.
 *   2. Fallback (--no-ai-parser or API error): regex-based offline parser.
 *
 * The AI is ONLY used to parse intent into structured constraints.
 * It NEVER selects recipes, invents IDs, or fabricates nutrition data.
 */

import { z } from 'zod';
import OpenAI from 'openai';
import type { WeeklyPlanRequest, ProteinSlot } from './types.js';

// ============================================================================
// Zod Schema — validates the AI response before use
// ============================================================================

const MacroRangeSchema = z.object({
  minPct: z.number().min(0).max(100).nullable().optional(),
  maxPct: z.number().min(0).max(100).nullable().optional(),
});

const WeeklyPlanRequestSchema = z.object({
  mealCount: z.number().int().min(1).max(14),
  requiredProteinSlots: z.array(
    z.enum(['chicken', 'pork', 'beef', 'vegetarian', 'vegan', 'seafood', 'turkey', 'other'])
  ),
  flexMealCount: z.number().int().min(0).nullable().optional(),
  minKidFriendlyMeals: z.number().int().min(0).nullable().optional(),
  macroTargets: z
    .object({
      fatPct: MacroRangeSchema.nullable().optional(),
      carbsPct: MacroRangeSchema.nullable().optional(),
      proteinPct: MacroRangeSchema.nullable().optional(),
    })
    .nullable()
    .optional(),
  goals: z.object({
    weightLoss: z.boolean().optional(),
    highProtein: z.boolean().optional(),
    lowFat: z.boolean().optional(),
    quickEasy: z.boolean().optional(),
    lowMediumCost: z.boolean().optional(),
    freezerFriendly: z.boolean().optional(),
    lowWaste: z.boolean().optional(),
    lowTransFat: z.boolean().optional(),
    limitedSaturatedFat: z.boolean().optional(),
    healthyFats: z.boolean().optional(),
    varietyOfFlavors: z.boolean().optional(),
  }),
  preferredIngredients: z.array(z.string()),
  requiredSourceSignals: z.array(z.string()).nullable().optional(),
  requiredTagsOrTitleTerms: z.array(z.string()).nullable().optional(),
  allowComfortFood: z.boolean().optional(),
  maxResults: z.number().int().min(1).nullable().optional(),
});

// ============================================================================
// AI Parser
// ============================================================================

const SYSTEM_PROMPT = `You are a recipe planning assistant that converts natural language meal planning requests into structured constraints.

Return ONLY a valid JSON object. Do NOT include recipe IDs, recipe titles, nutrition values, or any invented data.
Extract ONLY what the user explicitly asked for.

JSON schema:
{
  "mealCount": number (how many total meals, infer from slot count if not explicit),
  "requiredProteinSlots": array of "chicken"|"pork"|"beef"|"vegetarian"|"vegan"|"seafood"|"turkey"|"other",
  "minKidFriendlyMeals": number|null,
  "macroTargets": {
    "fatPct": { "minPct": number|null, "maxPct": number|null }|null,
    "carbsPct": { "minPct": number|null, "maxPct": number|null }|null,
    "proteinPct": { "minPct": number|null, "maxPct": number|null }|null
  }|null,
  "goals": {
    "weightLoss": boolean,
    "highProtein": boolean,
    "lowFat": boolean,
    "quickEasy": boolean,
    "lowMediumCost": boolean,
    "freezerFriendly": boolean,
    "lowWaste": boolean,
    "lowTransFat": boolean,
    "limitedSaturatedFat": boolean,
    "healthyFats": boolean,
    "varietyOfFlavors": boolean
  },
  "preferredIngredients": string[],
  "requiredSourceSignals": string[]|null  (e.g. ["hellofresh"] if ≥1 HelloFresh recipe required),
  "requiredTagsOrTitleTerms": string[]|null (e.g. ["pasta"] if ≥1 pasta recipe required),
  "allowComfortFood": boolean,
  "maxResults": number|null
}

Flex meal rule:
- If mealCount > requiredProteinSlots.length, do NOT add extra "other" entries.
- Instead, set flexMealCount = mealCount - requiredProteinSlots.length.
- Example: "5 recipes: 1 chicken, 1 pork, 1 beef, 1 vegetarian" → mealCount=5, requiredProteinSlots=["chicken","pork","beef","vegetarian"], flexMealCount=1.
- Only use "other" in requiredProteinSlots if the user EXPLICITLY asked for an "other" or unspecified protein type.

Other rules:
- "at least one HelloFresh" → requiredSourceSignals: ["hellofresh"]
- "at least one pasta" → requiredTagsOrTitleTerms: ["pasta"]
- "comfort food" → allowComfortFood: true
- "freeze and reheat" / "meal prep" → goals.freezerFriendly: true
- "low waste" / "ingredient overlap" → goals.lowWaste: true
- "monounsaturated fats" / "omega-3" → goals.healthyFats: true
- "no trans fats" / "low trans fats" → goals.lowTransFat: true
- "limited saturated fats" → goals.limitedSaturatedFat: true
- "promotes weight loss" → goals.weightLoss: true
- "higher protein" / "high protein" → goals.highProtein: true
- "lower fat" / "low fat" → goals.lowFat: true
- "easy and quick" / "weeknight" → goals.quickEasy: true
- "low to medium priced" / "budget" → goals.lowMediumCost: true
- "variety of flavors" → goals.varietyOfFlavors: true
- For macro ranges like "Fat 15%-25%": fatPct = { minPct: 15, maxPct: 25 }
- For preferred ingredients: extract the listed ingredient names verbatim
- mealCount = requiredProteinSlots.length + (flexMealCount ?? 0)`;

export interface ParseOptions {
  apiKey: string;
  model?: string;
}

/**
 * Parse a planning query using OpenAI.
 * Falls back to the offline parser if the API call fails or returns invalid JSON.
 */
export async function parsePlanRequestWithAI(
  query: string,
  options: ParseOptions
): Promise<{ request: WeeklyPlanRequest; usedFallback: boolean; parseWarnings: string[] }> {
  const warnings: string[] = [];

  try {
    const client = new OpenAI({ apiKey: options.apiKey });

    const response = await client.chat.completions.create({
      model: options.model ?? 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: query },
      ],
      temperature: 0.1,
      max_tokens: 1500,
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) throw new Error('Empty response from AI');

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`AI returned invalid JSON: ${raw.slice(0, 200)}`);
    }

    const result = WeeklyPlanRequestSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      warnings.push(`AI response failed schema validation (${issues}). Using offline parser.`);
      return {
        request: parsePlanRequestOffline(query),
        usedFallback: true,
        parseWarnings: warnings,
      };
    }

    const request = normalizeRequest(result.data as WeeklyPlanRequest);
    return { request, usedFallback: false, parseWarnings: warnings };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`AI parser failed (${msg}). Using offline parser.`);
    return {
      request: parsePlanRequestOffline(query),
      usedFallback: true,
      parseWarnings: warnings,
    };
  }
}

// ============================================================================
// Offline Parser — regex-based, no external dependencies
// ============================================================================

/**
 * Parse a planning query without calling an external API.
 * Handles the most common patterns; less precise than the AI path.
 */
export function parsePlanRequestOffline(query: string): WeeklyPlanRequest {
  const q = query.toLowerCase();

  // --- Protein slots ---
  const slots: ProteinSlot[] = [];
  const proteinPatterns: [RegExp, ProteinSlot][] = [
    [/\b(\d+)\s*chicken\b/gi, 'chicken'],
    [/\b(\d+)\s*pork\b/gi, 'pork'],
    [/\b(\d+)\s*beef\b/gi, 'beef'],
    [/\b(\d+)\s*(?:vegetarian|veggie|veg)\b/gi, 'vegetarian'],
    [/\b(\d+)\s*vegan\b/gi, 'vegan'],
    [/\b(\d+)\s*(?:seafood|fish|shrimp|salmon)\b/gi, 'seafood'],
    [/\b(\d+)\s*turkey\b/gi, 'turkey'],
  ];

  for (const [pattern, slot] of proteinPatterns) {
    let m: RegExpExecArray | null;
    const re = new RegExp(pattern.source, 'gi');
    while ((m = re.exec(q)) !== null) {
      const count = parseInt(m[1] ?? '1', 10);
      for (let i = 0; i < count; i++) slots.push(slot);
    }
  }

  // --- Explicit meal count (e.g. "5 recipes", "5 meals", "choose 5") ---
  let explicitMealCount: number | undefined;
  const mealCountMatch = q.match(/\b(?:choose|pick|select|plan|want|need)?\s*(\d+)\s*(?:recipes?|meals?|dishes?|dinners?)\b/i);
  if (mealCountMatch) {
    explicitMealCount = parseInt(mealCountMatch[1], 10);
  }  if (slots.length === 0) {
    const onePatterns: [RegExp, ProteinSlot][] = [
      [/\bone\s+chicken\b/gi, 'chicken'],
      [/\bone\s+pork\b/gi, 'pork'],
      [/\bone\s+beef\b/gi, 'beef'],
      [/\bone\s+(?:vegetarian|veggie|veg)\b/gi, 'vegetarian'],
      [/\bone\s+vegan\b/gi, 'vegan'],
      [/\bone\s+(?:seafood|fish|shrimp|salmon)\b/gi, 'seafood'],
      [/\bone\s+turkey\b/gi, 'turkey'],
    ];
    for (const [pattern, slot] of onePatterns) {
      if (pattern.test(q)) {
        slots.push(slot);
      }
    }
  }

  // Fall back to default 3-slot plan if no slots detected (no 'other' padding)
  if (slots.length === 0) {
    slots.push('chicken', 'beef', 'vegetarian');
  }

  const mealCount = explicitMealCount ?? slots.length;
  const flexMealCount = mealCount > slots.length ? mealCount - slots.length : 0;

  // --- Kid friendly ---
  let minKidFriendlyMeals: number | undefined;
  const kidMatch = q.match(/at\s+least\s+(\d+)\s+meals?\s+(?:are\s+)?kid\s*[\-\s]?friend/i);
  if (kidMatch) {
    minKidFriendlyMeals = parseInt(kidMatch[1], 10);
  } else if (/kid\s*[\-\s]?friend/i.test(q)) {
    minKidFriendlyMeals = 2;
  }

  // --- Macro targets ---
  function parseMacroRange(re: RegExp): { minPct?: number; maxPct?: number } | undefined {
    const m = q.match(re);
    if (!m) return undefined;
    const nums = [parseInt(m[1], 10), parseInt(m[2], 10)];
    return { minPct: Math.min(...nums), maxPct: Math.max(...nums) };
  }

  const fatRange = parseMacroRange(/fat\s+(\d+)%?\s*[-–]\s*(\d+)%?/i);
  const carbRange = parseMacroRange(/carbs?\s+(\d+)%?\s*[-–]\s*(\d+)%?/i);
  const protRange = parseMacroRange(/protein\s+(\d+)%?\s*[-–]\s*(\d+)%?/i);

  const macroTargets =
    fatRange || carbRange || protRange
      ? { fatPct: fatRange, carbsPct: carbRange, proteinPct: protRange }
      : undefined;

  // --- Goals ---
  const goals: WeeklyPlanRequest['goals'] = {
    weightLoss: /weight\s*loss|promot(?:e|es|ing)\s+weight/i.test(q),
    highProtein: /high(?:er)?\s*protein/i.test(q),
    lowFat: /low(?:er)?\s*fat/i.test(q),
    quickEasy: /\b(?:easy|quick|weeknight|fast)\b/i.test(q),
    lowMediumCost: /\b(?:low|medium)\s+(?:price|priced|cost|budget)\b/i.test(q),
    freezerFriendly: /\b(?:freeze|freezer|reheat|meal\s*prep)\b/i.test(q),
    lowWaste: /\b(?:low\s+waste|no\s+waste|food\s+waste|overlap\s+of\s+ingred)\b/i.test(q),
    lowTransFat: /\b(?:no|low|very\s+low)\s+trans\s+fat/i.test(q),
    limitedSaturatedFat: /limited?\s+saturated\s+fat/i.test(q),
    healthyFats: /\b(?:monounsaturated|mufa|omega[\s-]?3|healthy\s+fat)\b/i.test(q),
    varietyOfFlavors: /\bvariet(?:y|ies)\s+of\s+flavor/i.test(q),
  };

  // --- Preferred ingredients ---
  const preferredIngredients: string[] = [];
  const prefMatch = q.match(/prefer(?:ring|red)?\s+(?:having\s+)?(?:these\s+ingredients?\s*(?:but\s+does?\s+not\s+need\s+to\s+have\s+any)?:?\s*)?([^.;]+)/i);
  if (prefMatch) {
    const rawList = prefMatch[1];
    const items = rawList
      .split(/,|\band\b/i)
      .map((s) => s.trim().replace(/^[-•]\s*/, ''))
      .filter((s) => s.length > 2 && !/^(?:but|does|not|need|to|have|any)$/i.test(s));
    preferredIngredients.push(...items);
  }

  // --- Source signals ---
  const requiredSourceSignals: string[] = [];
  if (/hell(?:o)?\s*fresh/i.test(q)) requiredSourceSignals.push('hellofresh');

  // --- Tag / title terms ---
  const requiredTagsOrTitleTerms: string[] = [];
  if (/\bat\s+least\s+one\s+(?:recipe\s+)?(?:has|with|contains?)\s+pasta\b|\bpasta\s+(?:recipe|dish|meal)\b|\bone\s+(?:meal|recipe)\s+(?:can\s+)?(?:be|is)\s+pasta\b/i.test(q)) {
    requiredTagsOrTitleTerms.push('pasta');
  }

  // --- Comfort food ---
  const allowComfortFood = /comfort\s+food/i.test(q);

  const request: WeeklyPlanRequest = {
    mealCount,
    requiredProteinSlots: slots,
    ...(flexMealCount > 0 ? { flexMealCount } : {}),
    ...(minKidFriendlyMeals !== undefined ? { minKidFriendlyMeals } : {}),
    ...(macroTargets ? { macroTargets } : {}),
    goals,
    preferredIngredients,
    ...(requiredSourceSignals.length > 0 ? { requiredSourceSignals } : {}),
    ...(requiredTagsOrTitleTerms.length > 0 ? { requiredTagsOrTitleTerms } : {}),
    allowComfortFood,
  };

  return normalizeRequest(request);
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Post-process a parsed request to ensure internal consistency.
 * - mealCount must be >= requiredProteinSlots.length
 * - flexMealCount = mealCount - requiredProteinSlots.length (do NOT pad with 'other')
 * - preferredIngredients deduped and trimmed
 */
function normalizeRequest(request: WeeklyPlanRequest): WeeklyPlanRequest {
  const slots = request.requiredProteinSlots ?? [];
  const mealCount = Math.max(request.mealCount ?? slots.length, slots.length, 1);

  // Compute flex meals from the difference instead of padding with 'other'
  const explicitFlex = request.flexMealCount ?? 0;
  const impliedFlex = mealCount - slots.length;
  const flexMealCount = Math.max(explicitFlex, impliedFlex, 0);

  const preferredIngredients = [
    ...new Set(
      (request.preferredIngredients ?? []).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 1)
    ),
  ];

  return {
    ...request,
    mealCount,
    requiredProteinSlots: slots, // never padded with 'other'
    flexMealCount: flexMealCount > 0 ? flexMealCount : undefined,
    preferredIngredients,
    goals: request.goals ?? {},
  };
}
