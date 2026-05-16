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
    // Accept null from AI responses (AI returns null for unmentioned booleans) and coerce to false
    weightLoss: z.boolean().nullable().optional().transform((v) => v ?? false),
    highProtein: z.boolean().nullable().optional().transform((v) => v ?? false),
    lowFat: z.boolean().nullable().optional().transform((v) => v ?? false),
    quickEasy: z.boolean().nullable().optional().transform((v) => v ?? false),
    lowMediumCost: z.boolean().nullable().optional().transform((v) => v ?? false),
    freezerFriendly: z.boolean().nullable().optional().transform((v) => v ?? false),
    lowWaste: z.boolean().nullable().optional().transform((v) => v ?? false),
    lowTransFat: z.boolean().nullable().optional().transform((v) => v ?? false),
    limitedSaturatedFat: z.boolean().nullable().optional().transform((v) => v ?? false),
    healthyFats: z.boolean().nullable().optional().transform((v) => v ?? false),
    varietyOfFlavors: z.boolean().nullable().optional().transform((v) => v ?? false),
  }),
  preferredIngredients: z.array(z.string()),
  requiredSourceSignals: z.array(z.string()).nullable().optional(),
  requiredTagsOrTitleTerms: z.array(z.string()).nullable().optional(),
  allowComfortFood: z.boolean().nullable().optional().transform((v) => v ?? false),
  comfortFoodMode: z.enum(['allowed', 'preferred', 'required', 'avoid']).nullable().optional(),
  maxResults: z.number().int().min(1).nullable().optional(),
  perRecipePreferences: z.array(z.string()).nullable().optional(),
  allMustMatchTerms: z.array(z.string()).nullable().optional(),
  anyDishTypes: z.array(z.string()).nullable().optional(),
  requiredIngredientTerms: z.array(z.string()).nullable().optional(),
  minSpiceLevel: z.number().min(0).max(5).nullable().optional(),
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
  "requiredTagsOrTitleTerms": string[]|null (e.g. ["pasta"] if ≥1 pasta recipe required; use "cuisine:mexican" if ≥1 Mexican recipe required),
  "allowComfortFood": boolean,
  "comfortFoodMode": "allowed"|"preferred"|"required"|"avoid"|null  (null = not specified; "allowed" = ok but not prioritised; "preferred" = give bonus; "required" = at least one; "avoid" = mild penalty),
  "maxResults": number|null,
  "perRecipePreferences": string[]|null  (per-recipe qualities every selected recipe should have; e.g. ["cheesy"] when user says "make them cheesy", "all cheesy", "cheesy recipes", "extra cheesy"),
  "allMustMatchTerms": string[]|null  (dish-type terms that EVERY recipe must match in title or tags; used when the entire request is "N [dish] recipes"),
  "anyDishTypes": string[]|null  (dish-type terms where EACH recipe must match AT LEAST ONE — for "soups or stews", "noodles or dumplings"),
  "requiredIngredientTerms": string[]|null  (ingredient terms ALL selected recipes must contain — for "recipes with eggs", "containing chocolate"),
  "minSpiceLevel": number|null  (0=not spicy, 1=mild, 2=medium, 3=hot, 4=very hot, 5=extreme; set to 2 for "spicy recipes")
}

Flex meal rule:
- If mealCount > requiredProteinSlots.length, do NOT add extra "other" entries.
- Instead, set flexMealCount = mealCount - requiredProteinSlots.length.
- Example: "5 recipes: 1 chicken, 1 pork, 1 beef, 1 vegetarian" → mealCount=5, requiredProteinSlots=["chicken","pork","beef","vegetarian"], flexMealCount=1.
- Only use "other" in requiredProteinSlots if the user EXPLICITLY asked for an "other" or unspecified protein type.

Other rules:
- "at least one HelloFresh" → requiredSourceSignals: ["hellofresh"]
- "at least one pasta" → requiredTagsOrTitleTerms: ["pasta"]
- "1 mexican" / "one mexican recipe" / "a mexican meal" → requiredTagsOrTitleTerms: ["cuisine:mexican"]
- "1 italian" → requiredTagsOrTitleTerms: ["cuisine:italian"] (and so on for other cuisines)
- Cuisine terms go in requiredTagsOrTitleTerms as "cuisine:<name>"; they do NOT become protein slots
- "comfort food" → allowComfortFood: true, comfortFoodMode: "allowed"
- "one of the meals can be a comfort food" → allowComfortFood: true, comfortFoodMode: "allowed"
- "I want comfort food" / "comfort food night" / "I love comfort food" → allowComfortFood: true, comfortFoodMode: "preferred"
- "make sure one meal is a comfort food" → allowComfortFood: true, comfortFoodMode: "required"
- "no comfort food" / "avoid comfort food" / "healthy, not comfort food" → allowComfortFood: false, comfortFoodMode: "avoid"
- "freeze and reheat" / "meal prep" → goals.freezerFriendly: true
- "low waste" / "ingredient overlap" → goals.lowWaste: true
- "monounsaturated fats" / "omega-3" → goals.healthyFats: true
- "no trans fats" / "low trans fats" → goals.lowTransFat: true
- "limited saturated fats" → goals.limitedSaturatedFat: true
- "promotes weight loss" → goals.weightLoss: true
- "higher protein" / "high protein" → goals.highProtein: true
- "lower fat" / "low fat" → goals.lowFat: true
- "low calorie" / "low cal" / "lower calorie" → goals.highProtein: true AND goals.lowFat: true (NOT a calorie count target — portion size is always adjustable, so focus on macro quality)
- "easy and quick" / "weeknight" → goals.quickEasy: true
- "low to medium priced" / "budget" → goals.lowMediumCost: true
- "variety of flavors" → goals.varietyOfFlavors: true
- For macro ranges like "Fat 15%-25%": fatPct = { minPct: 15, maxPct: 25 }
- For preferred ingredients: extract the listed ingredient names verbatim
- mealCount = requiredProteinSlots.length + (flexMealCount ?? 0)
- "make them cheesy" / "all cheesy" / "cheesy recipes" / "extra cheesy" / "full of cheese" → perRecipePreferences: ["cheesy"]
- perRecipePreferences captures qualities that EVERY recipe in the plan should have
- If the user says "give me N recipes" with no protein terms, set requiredProteinSlots: [] and flexMealCount: N
- "give me N [protein] recipes" where ALL N should be that protein → set requiredProteinSlots to N copies of that protein, flexMealCount: 0
  Examples: "give me 3 chicken recipes" → requiredProteinSlots: ["chicken","chicken","chicken"], flexMealCount: 0
            "4 vegetarian meals" → requiredProteinSlots: ["vegetarian","vegetarian","vegetarian","vegetarian"], flexMealCount: 0
            "2 beef dishes" → requiredProteinSlots: ["beef","beef"], flexMealCount: 0
- "give me N [dish] recipes" where [dish] is a DISH TYPE (NOT a protein, NOT a raw ingredient) → set allMustMatchTerms: ["dish"], requiredProteinSlots: [], flexMealCount: N
  Dish types: pasta, tacos, soup, chili, stir-fry, pizza, curry, burgers, sandwiches, salads, wraps, dumplings, ramen, sushi, risotto, casserole, lasagna, etc.
  Examples: "give me 3 chili recipes" → allMustMatchTerms: ["chili"], flexMealCount: 3
            "5 soup dishes" → allMustMatchTerms: ["soup"], flexMealCount: 5
            "give me some stir-fry meals" → allMustMatchTerms: ["stir-fry"], flexMealCount: N
            "3 pasta recipes" → allMustMatchTerms: ["pasta"], flexMealCount: 3
            "give me 4 taco recipes" → allMustMatchTerms: ["taco"], flexMealCount: 4
- allMustMatchTerms is for when the dish type IS the entire request (all N must be that type)
- Use requiredTagsOrTitleTerms for "at least one" constraints within a mixed plan
- Do NOT set allMustMatchTerms when user says "give me N recipes" with no dish qualifier
- CRITICAL: Raw ingredient words (eggs, chocolate, salmon, cheese, spinach, garlic, butter, flour, etc.) ALWAYS go in requiredIngredientTerms, NEVER in allMustMatchTerms
- NEVER put the same term in both allMustMatchTerms and requiredIngredientTerms
- "soups or stews" / "noodles or dumplings" / "pasta or rice dishes" → anyDishTypes: ["soup","stew"] etc. (OR logic — each recipe satisfies any one term)
- "with eggs" / "containing chocolate" / "that use salmon" / "recipes using shrimp" / "recipes with X and Y" → requiredIngredientTerms: ["egg","chocolate"] etc. (ALL selected recipes must contain the ingredient)
  Examples: "4 recipes with chocolate" → requiredIngredientTerms: ["chocolate"], allMustMatchTerms: null, flexMealCount: 4
            "3 recipes using salmon and lemon" → requiredIngredientTerms: ["salmon","lemon"], allMustMatchTerms: null
            "give me recipes with eggs" → requiredIngredientTerms: ["egg"], allMustMatchTerms: null
- "spicy recipes" / "spicy dishes" / "recipes with heat" / "hot and spicy" → minSpiceLevel: 2 (never set minSpiceLevel to null for non-spicy queries, omit it instead)
- "very spicy" / "extra hot" → minSpiceLevel: 3
- Cooking method terms like "one-pot", "sheet pan", "slow cooker", "instant pot", "air fryer" go in allMustMatchTerms: ["one pot"] (normalize to no-hyphen form)
- For multi-cuisine OR: "italian or mexican" → anyDishTypes: ["cuisine:italian","cuisine:mexican"]`;

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
      warnings.push(`AI query parsing fell back to offline parser (schema mismatch: ${issues}).`);
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

  // --- Explicit meal count (e.g. "5 recipes", "5 hearty meals", "choose 5") ---
  let explicitMealCount: number | undefined;
  // Allow up to 2 optional modifier words between the count and the meal-unit word
  // e.g. "5 hearty meals", "5 weeknight dinners", "5 hearty weeknight meals"
  const mealCountMatch = q.match(/\b(?:choose|pick|select|plan|want|need)?\s*(\d+)\s*(?:\w+\s+){0,2}(?:recipes?|meals?|dishes?|dinners?|options?|ideas?)\b/i);
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

  // --- Dish-type constraint: "N [dish] recipes" → all must match ---
  // Must run BEFORE the fallback so it can set explicitMealCount.
  const allMustMatchTerms: string[] = [];
  // anyDishTypes: OR logic, "soups or stews", "noodles or dumplings"
  const anyDishTypes: string[] = [];

  if (slots.length === 0) {
    const PROTEIN_TYPE_WORDS = new Set([
      'chicken', 'pork', 'beef', 'vegetarian', 'veggie', 'vegan',
      'seafood', 'fish', 'shrimp', 'salmon', 'turkey', 'other',
    ]);
    // Flavor/modifier descriptors that are NOT dish types
    const IGNORE_DISH_WORDS = new Set([
      'more', 'some', 'great', 'good', 'easy', 'quick', 'simple',
      'healthy', 'new', 'different', 'random', 'various', 'variety',
      'spicy', 'spicier', 'hot', 'mild', 'sweet', 'savory', 'hearty',
      'light', 'fresh', 'warm', 'cold', 'classic', 'traditional', 'modern',
      'fun', 'creative', 'unique', 'favorite', 'popular', 'impressive',
    ]);

    // --- Cooking-method detection (before dishMatch so "one-pot" doesn't get swallowed) ---
    // "give me 4 one-pot dinners", "5 sheet pan meals", "3 slow cooker recipes"
    const COOKING_METHODS: [RegExp, string][] = [
      [/\bone[\s-]pot\b/i, 'one pot'],
      [/\bsheet[\s-]pan\b/i, 'sheet pan'],
      [/\bslow[\s-]cooker\b/i, 'slow cooker'],
      [/\binstant[\s-]pot\b/i, 'instant pot'],
      [/\bair[\s-]fry(?:er)?\b/i, 'air fry'],
      [/\bpressure[\s-]cook(?:er)?\b/i, 'pressure cooker'],
      [/\bskillet\b/i, 'skillet'],
    ];
    for (const [re, term] of COOKING_METHODS) {
      if (re.test(q)) {
        allMustMatchTerms.push(term);
        // Extract count before or after the cooking method
        const countMatch = q.match(new RegExp(`(\\d+)\\s+${term.replace(' ', '[\\s-]')}|${term.replace(' ', '[\\s-]')}\\s+(?:\\w+\\s+){0,2}(\\d+)`, 'i'))
          ?? q.match(/\b(\d+)\b/);
        if (countMatch && explicitMealCount === undefined) {
          explicitMealCount = parseInt(countMatch[1] ?? countMatch[2] ?? '3', 10);
        }
        break; // only one cooking method at a time
      }
    }

    // --- OR dish-type detection: "4 soups or stews", "noodles or dumplings" ---
    if (allMustMatchTerms.length === 0) {
      // Count + "X or Y [dishes?]" or just "X or Y" at the start
      const orCountMatch = q.match(/\b(\d+)\s+([\w-]+)\s+or\s+([\w-]+)(?:\s+(?:recipes?|meals?|dishes?|dinners?))?\b/i);
      if (orCountMatch) {
        const t1 = orCountMatch[2].toLowerCase().replace(/s$/i, ''); // de-pluralize
        const t2 = orCountMatch[3].toLowerCase().replace(/s$/i, '');
        if (!PROTEIN_TYPE_WORDS.has(t1) && !PROTEIN_TYPE_WORDS.has(t2) && !IGNORE_DISH_WORDS.has(t1)) {
          anyDishTypes.push(t1, t2);
          if (explicitMealCount === undefined) {
            explicitMealCount = parseInt(orCountMatch[1], 10);
          }
        }
      }
      // Bare "X or Y dishes" without leading count — use explicit meal count if found
      if (anyDishTypes.length === 0) {
        const orBareMatch = q.match(/\b([\w-]+)\s+or\s+([\w-]+)\s+(?:recipes?|meals?|dishes?|dinners?)\b/i);
        if (orBareMatch) {
          const t1 = orBareMatch[1].toLowerCase().replace(/s$/i, '');
          const t2 = orBareMatch[2].toLowerCase().replace(/s$/i, '');
          if (!PROTEIN_TYPE_WORDS.has(t1) && !PROTEIN_TYPE_WORDS.has(t2) && !IGNORE_DISH_WORDS.has(t1)) {
            anyDishTypes.push(t1, t2);
          }
        }
      }
    }

    // --- Standard dish-type: "N [dish] recipes" → allMustMatchTerms ---
    if (allMustMatchTerms.length === 0 && anyDishTypes.length === 0) {
      const dishMatch = q.match(
        /\b(?:give me|get me|show me|find me|want|need|i want|i need|make)?\s*(\d+)\s+([\w][\w\s-]{0,40}?)\s+(?:recipes?|meals?|dishes?|dinners?)\b/i
      );
      if (dishMatch) {
        const dishTerm = dishMatch[2].trim().toLowerCase().replace(/\s+/g, ' ');
        if (
          !PROTEIN_TYPE_WORDS.has(dishTerm) &&
          !IGNORE_DISH_WORDS.has(dishTerm) &&
          dishTerm.length > 2
        ) {
          allMustMatchTerms.push(dishTerm);
          if (explicitMealCount === undefined) {
            explicitMealCount = parseInt(dishMatch[1], 10);
          }
        }
      }
    }
  }

  // Fall back to default 3-slot plan if no slots detected AND no explicit meal count.
  if (slots.length === 0 && explicitMealCount === undefined && anyDishTypes.length === 0) {
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
  // Note: "low calorie" is treated as a macro-quality goal rather than an absolute
  // calorie target. Since any recipe can be divided into smaller portions, the calorie
  // count per listed serving is irrelevant — what matters is nutritional composition.
  // So "low calorie" → highProtein + lowFat (good macro ratios / protein density).
  const lowCalorieTerm = /\blow[\s-]?cal(?:orie)?s?\b/i.test(q);
  const goals: WeeklyPlanRequest['goals'] = {
    weightLoss: /weight\s*loss|promot(?:e|es|ing)\s+weight/i.test(q),
    highProtein: /high(?:er)?\s*protein/i.test(q) || lowCalorieTerm,
    lowFat: /low(?:er)?\s*fat/i.test(q) || lowCalorieTerm,
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
  // "at least one pasta", "at least one pasta recipe", "one pasta dish", etc.
  if (/\bat\s+least\s+one\s+pasta\b|\bat\s+least\s+one\s+(?:recipe\s+)?(?:has|with|contains?)\s+pasta\b|\bpasta\s+(?:recipe|dish|meal)\b|\bone\s+(?:meal|recipe)\s+(?:can\s+)?(?:be|is)\s+pasta\b/i.test(q)) {
    requiredTagsOrTitleTerms.push('pasta');
  }

  // --- Cuisine requirements (e.g. "1 mexican", "one italian meal") ---
  const CUISINE_TERMS = [
    'mexican', 'italian', 'asian', 'thai', 'chinese', 'japanese', 'indian',
    'mediterranean', 'korean', 'french', 'greek', 'american', 'spanish',
    'middle eastern', 'moroccan', 'vietnamese', 'tex-mex', 'cajun',
  ];
  for (const cuisine of CUISINE_TERMS) {
    // Match "1 mexican", "one mexican", "a mexican (meal|recipe|dish)", "mexican recipe", "mediterranean week"
    const escaped = cuisine.replace(/-/g, '[\\s-]');
    const re = new RegExp(
      `(?:\\b(?:1|one|a|an)\\s+${escaped}\\b|\\b${escaped}\\s+(?:meal|recipe|dish|food|week|cooking|cuisine|style)\\b|\\b${escaped}\\b)`,
      'i'
    );
    if (re.test(q)) {
      requiredTagsOrTitleTerms.push(`cuisine:${cuisine}`);
    }
  }

  // --- Per-recipe preferences ---
  const perRecipePreferences: string[] = [];
  if (/\bmake\s+them\s+chees(?:y|ier)\b|\ball\s+(?:\w+\s+)?chees(?:y|ier)\b|\bchees(?:y|ier)\s+(?:recipes?|meals?|dishes?)\b|\bextra\s+chees(?:y|ier)\b|\bfull\s+of\s+cheese\b/i.test(q)) {
    perRecipePreferences.push('cheesy');
  }

  // --- Comfort food ---
  const allowComfortFood = /comfort\s+food/i.test(q);
  let comfortFoodMode: WeeklyPlanRequest['comfortFoodMode'];
  if (/no\s+comfort\s+food|avoid\s+comfort\s+food|not\s+comfort\s+food/i.test(q)) {
    comfortFoodMode = 'avoid';
  } else if (/\bone\s+(?:of\s+the\s+)?meals?\s+(?:can|could)\s+be\s+(?:a\s+)?comfort/i.test(q)) {
    comfortFoodMode = 'allowed';
  } else if (/\bi\s+(?:want|love|need)\s+comfort\s+food|\bcomfort\s+food\s+night\b|\bcomfort\s+food\s+week\b/i.test(q)) {
    comfortFoodMode = 'preferred';
  } else if (/\bcomfort\s+food\b/i.test(q)) {
    comfortFoodMode = 'allowed';
  }

  // --- Required ingredient terms (all recipes must contain these) ---
  // Matches "with eggs", "containing chocolate", "that use salmon", "using shrimp"
  const requiredIngredientTerms: string[] = [];
  const ingMatch = q.match(/\b(?:with|containing|that\s+(?:use|uses|has|have|include|includes)|using|made\s+with)\s+([\w\s,]+?)(?:\s*(?:and\s+[\w]+\s+)?(?:recipes?|meals?|dishes?)|[,;.]|$)/i);
  if (ingMatch) {
    const raw = ingMatch[1];
    const terms = raw
      .split(/\band\b|,/i)
      .map((s) => s.trim().replace(/s$/i, '')) // de-pluralize: "eggs" → "egg"
      .filter((s) => s.length > 2 && !/^(?:a|an|the|some|more|any|all)$/i.test(s));
    requiredIngredientTerms.push(...terms);
  }

  // --- Minimum spice level ---
  let minSpiceLevel: number | undefined;
  if (/\bvery\s+spic(?:y|ier)\b|\bextra\s+(?:hot|spicy)\b|\bfiery\b|\bextreme(?:ly)?\s+spicy\b/i.test(q)) {
    minSpiceLevel = 3;
  } else if (/\bspic(?:y|ier)\b|\bwith\s+(?:some\s+)?heat\b|\bhot\s+(?:and\s+)?spicy\b/i.test(q)) {
    minSpiceLevel = 2;
  }

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
    ...(comfortFoodMode !== undefined ? { comfortFoodMode } : {}),
    ...(perRecipePreferences.length > 0 ? { perRecipePreferences } : {}),
    ...(allMustMatchTerms.length > 0 ? { allMustMatchTerms } : {}),
    ...(anyDishTypes.length > 0 ? { anyDishTypes } : {}),
    ...(requiredIngredientTerms.length > 0 ? { requiredIngredientTerms } : {}),
    ...(minSpiceLevel !== undefined ? { minSpiceLevel } : {}),
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

  // Sanitize AI-returned nullable values: null → undefined
  const minSpiceLevel = (request.minSpiceLevel != null) ? request.minSpiceLevel : undefined;

  // Sanitize null arrays from AI
  const requiredIngredientTerms = (request.requiredIngredientTerms ?? []).filter(Boolean) as string[];
  const anyDishTypes = (request.anyDishTypes ?? []).filter(Boolean) as string[];

  // Deduplicate: remove from allMustMatchTerms any term that already appears in
  // requiredIngredientTerms (ingredient words like "chocolate" or "eggs" should
  // only ever be in requiredIngredientTerms, not dish-type filters)
  const ingTermSet = new Set(requiredIngredientTerms.map((t) => t.toLowerCase()));
  const allMustMatchTerms = (request.allMustMatchTerms ?? [])
    .filter(Boolean)
    .filter((t) => !ingTermSet.has(t.toLowerCase())) as string[];

  return {
    ...request,
    mealCount,
    requiredProteinSlots: slots, // never padded with 'other'
    flexMealCount: flexMealCount > 0 ? flexMealCount : undefined,
    preferredIngredients,
    goals: request.goals ?? {},
    ...(allMustMatchTerms.length > 0 ? { allMustMatchTerms } : { allMustMatchTerms: undefined }),
    ...(anyDishTypes.length > 0 ? { anyDishTypes } : { anyDishTypes: undefined }),
    ...(requiredIngredientTerms.length > 0 ? { requiredIngredientTerms } : { requiredIngredientTerms: undefined }),
    ...(minSpiceLevel !== undefined ? { minSpiceLevel } : { minSpiceLevel: undefined }),
  };
}
