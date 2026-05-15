/**
 * Ask - Natural language recipe search using OpenAI
 *
 * Sends the full ingredient list for every recipe alongside compact metadata
 * so the AI reasons from actual recipe content, not just heuristic tags.
 * The LLM returns recipe IDs; we look them up and display full details.
 */

import OpenAI from 'openai';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import type { SelectionRecord } from './selection-index.js';
import type { NormalizedRecipe } from './types.js';

export interface AskOptions {
  apiKey?: string;
  model?: string;
  dataPath: string;
  verbose?: boolean;
}

interface RecipeSelection {
  id: string;
  title: string;
  section: string;   // which catalog section the AI picked from
  reason: string;
}

interface AskResponse {
  summary: string;
  selections: RecipeSelection[];
}

// Cuisine keywords to pull out of tags for the compact catalog row
const CUISINE_KEYWORDS = new Set([
  'mexican', 'italian', 'asian', 'chinese', 'japanese', 'thai', 'indian',
  'mediterranean', 'american', 'greek', 'french', 'korean', 'vietnamese',
  'middle eastern', 'spanish', 'moroccan', 'cajun', 'tex-mex', 'peruvian',
  'turkish', 'german', 'british', 'irish', 'nordic', 'hawaiian',
]);

// Leave headroom for system prompt + query + JSON response.
// gpt-4o-mini has a 128K token limit; at ~3.2 chars/token for pipe-delimited
// text, 380K chars ≈ 119K tokens, leaving ~9K for prompts and response.
const MAX_CATALOG_CHARS = 380_000;

const SYSTEM_PROMPT = `You are a helpful recipe selection assistant.

The recipe catalog is divided into labeled sections. Each section header looks like:
  === SECTION NAME ===
Every recipe row within that section belongs to that category — you do NOT need to verify ingredients for categorization.

Column meanings (same for every section):
  id     – use this EXACTLY in your JSON response (it is a short hex string like a1b2c3d4e5f6a7b8)
  title  – recipe name
  time   – total time in minutes
  kcal   – calories per serving (blank = unknown)
  prot%  – protein % of calories (blank = unknown)
  kid    – kid-friendly bucket: High / Med / Low
  spice  – spice level
  ing    – actual ingredient names (use for calorie/protein/kid judgments)

MANDATORY RULE — SECTION BOUNDARIES:
When the user asks for "one chicken, one seafood, one vegetarian …" you MUST pick exactly ONE recipe from the matching catalog section for each requested category. You may NEVER pick a recipe from a section that does not match the requested category — even if the calorie/protein goals would be better met by a recipe in a different section. Category accuracy is the top priority. Calorie and protein are secondary.

If no recipe in the matching section meets the calorie/protein goal, pick the closest available recipe in that section and note the trade-off in the reason field. Do NOT substitute a recipe from another section.

Secondary preferences (apply within each section):
- Low calorie: prefer kcal < 500; if kcal is missing, look for lean proteins and vegetables in ing.
- High protein: prefer prot% ≥ 30 or lean meat/fish/legumes/eggs in ing.
- Kid-friendly: prefer kid:High; avoid spice:hot.

Respond ONLY with a JSON object — no markdown, no extra text:
{
  "summary": "One or two sentences explaining your selections.",
  "selections": [
    { "id": "<exact_id_from_catalog>", "title": "<exact_title>", "section": "<SECTION_NAME>", "reason": "<concise reason>" }
  ]
}`;

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function extractCuisine(tags: string[]): string {
  return tags.find(t => CUISINE_KEYWORDS.has(t.toLowerCase())) ?? '';
}

/**
 * Serialize a SelectionRecord + actual ingredient list into a compact
 * pipe-delimited catalog line the AI can reason from.
 */
function formatRecord(r: SelectionRecord, ingredients: string): string {
  const time = r.total_time_minutes != null ? `${r.total_time_minutes}min` : 'time?';
  const kcal = r.calories != null ? `${r.calories}kcal` : '';
  const protPct = r.macro_pct_protein != null ? `${Math.round(r.macro_pct_protein)}%prot` : '';
  const cuisine = extractCuisine(r.tags);
  const remainingTags = r.tags
    .filter(t => t.toLowerCase() !== cuisine.toLowerCase())
    .slice(0, 4)
    .join(',');

  const parts = [
    r.id,
    r.title,
    r.primary_protein,
    cuisine,
    time,
    kcal,
    protPct,
    `kid:${r.kid_friendly_bucket}`,
    `spice:${r.spice_level_label}`,
    r.is_vegetarian ? 'veg' : '',
    `sat_fat:${r.saturated_fat_risk}`,
    remainingTags,
    ingredients ? `ing:[${ingredients}]` : '',
  ].filter(Boolean);

  return parts.join('|');
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

async function loadSelectionRecords(dataPath: string): Promise<SelectionRecord[]> {
  const jsonlPath = join(dataPath, 'catalog.selection.jsonl');
  if (!existsSync(jsonlPath)) {
    throw new Error(
      `Selection catalog not found at ${jsonlPath}\nRun 'recipe-context build' first.`,
    );
  }
  const content = await readFile(jsonlPath, 'utf-8');
  return content
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as SelectionRecord);
}

/**
 * Load all normalized recipes and return a map of id → recipe.
 * Used for both the ingredient catalog and post-selection display.
 */
async function loadNormalizedRecipes(dataPath: string): Promise<Map<string, NormalizedRecipe>> {
  const jsonlPath = join(dataPath, 'recipes.normalized.jsonl');
  if (!existsSync(jsonlPath)) return new Map();
  const content = await readFile(jsonlPath, 'utf-8');
  const map = new Map<string, NormalizedRecipe>();
  for (const line of content.split('\n').filter(Boolean)) {
    const r = JSON.parse(line) as NormalizedRecipe;
    map.set(r.id, r);
  }
  return map;
}

/**
 * Extract a compact ingredient string — just the top 6 ingredient names.
 * Keeping this short is important: even at 6 items, 2 300 recipes stay under
 * the 128K-token context window for gpt-4o-mini.
 */
function ingredientSummary(recipe: NormalizedRecipe): string {
  return recipe.ingredients
    .slice(0, 6)
    .map(i => i.ingredient)
    .filter(Boolean)
    .join(', ');
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function askRecipes(query: string, options: AskOptions): Promise<void> {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OpenAI API key required.\n' +
      'Set the OPENAI_API_KEY environment variable or use the --api-key option.',
    );
  }

  const model = options.model ?? 'gpt-4o-mini';

  // Load selection records and all normalized recipes in parallel
  const [records, recipeMap] = await Promise.all([
    loadSelectionRecords(options.dataPath),
    loadNormalizedRecipes(options.dataPath),
  ]);

  if (records.length === 0) {
    throw new Error("No recipes found in catalog. Run 'recipe-context build' first.");
  }

  // Build catalog with actual ingredients included in each row.
  // Use a sectioned format: === CHICKEN RECIPES === ... === SEAFOOD RECIPES === ...
  // This lets the AI pick from clearly labeled groups without needing to do
  // ingredient-based category verification itself.

  interface RowPair { r: SelectionRecord; row: string; }

  const colHeader = 'id|title|time|kcal|prot%|kid|spice|ing';

  // Compact row: drop heuristic protein/cuisine/tags columns that confused the AI
  function compactRow(r: SelectionRecord, normalized: NormalizedRecipe | undefined): string {
    const time = r.total_time_minutes != null ? `${r.total_time_minutes}min` : 'time?';
    const kcal = r.calories != null ? `${r.calories}kcal` : '';
    const protPct = r.macro_pct_protein != null ? `${Math.round(r.macro_pct_protein)}%prot` : '';
    const ing = normalized ? ingredientSummary(normalized) : '';
    return [r.id, r.title, time, kcal, protPct, `kid:${r.kid_friendly_bucket}`, `spice:${r.spice_level_label}`, ing ? `ing:[${ing}]` : ''].filter(Boolean).join('|');
  }

  // Classify each record into a named bucket using ingredient text (not heuristic fields).
  const SEAFOOD_TERMS = /\b(shrimp|prawn|salmon|tuna|cod|tilapia|halibut|scallop|crab|lobster|clam|mussel|squid|octopus|anchov|sardine|mahi|trout|bass|snapper|catfish|swordfish|seafood)\b/i;
  const SEAFOOD_PROTEIN = new Set<string>(['fish', 'seafood']);
  const VEG_PROTEIN = new Set<string>(['tofu', 'legumes', 'eggs', 'vegetarian']);
  const MEAT_TERMS = /\b(chicken|beef|pork|steak|lamb|veal|turkey|bison|venison|duck|ham|bacon|sausage|salami|pepperoni|prosciutto|chorizo|shrimp|salmon|tuna|cod|tilapia|scallop|crab|lobster|clam|mussel|fish)\b/i;

  const buckets: Record<string, RowPair[]> = {
    seafood: [], vegetarian: [], mexican: [],
    chicken: [], beef: [], pork: [], turkey: [], other: [],
  };

  for (const r of records) {
    const norm = recipeMap.get(r.id);
    const ingText = norm ? norm.ingredients.map(i => i.ingredient).join(' ') : '';
    const tags = r.tags.map(t => t.toLowerCase());
    const row = compactRow(r, norm);
    const pair: RowPair = { r, row };

    if (SEAFOOD_TERMS.test(ingText) || SEAFOOD_PROTEIN.has(r.primary_protein) || tags.some(t => ['seafood', 'fish', 'shrimp', 'salmon', 'tuna'].includes(t))) {
      buckets.seafood.push(pair);
    } else if ((r.is_vegetarian || VEG_PROTEIN.has(r.primary_protein)) && !MEAT_TERMS.test(ingText)) {
      buckets.vegetarian.push(pair);
    } else if (tags.includes('mexican') || tags.includes('tex-mex')) {
      buckets.mexican.push(pair);
    } else if (r.primary_protein === 'chicken') {
      buckets.chicken.push(pair);
    } else if (r.primary_protein === 'beef') {
      buckets.beef.push(pair);
    } else if (r.primary_protein === 'pork') {
      buckets.pork.push(pair);
    } else if (r.primary_protein === 'turkey') {
      buckets.turkey.push(pair);
    } else {
      buckets.other.push(pair);
    }
  }

  // Shuffle within each bucket for variety across repeated queries.
  for (const bucket of Object.values(buckets)) {
    for (let i = bucket.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bucket[i], bucket[j]] = [bucket[j], bucket[i]];
    }
  }

  // Assemble sectioned catalog, capping each bucket to fit the context window.
  const QUOTA_PER_BUCKET = 140;
  const sectionParts: string[] = [];
  let charCount = 0;
  const bucketCounts: string[] = [];

  for (const [name, bucket] of Object.entries(buckets)) {
    if (bucket.length === 0) continue;
    const label = `=== ${name.toUpperCase()} RECIPES ===`;
    const rows = bucket.slice(0, QUOTA_PER_BUCKET).map(p => p.row);
    const section = `${label}\n${colHeader}\n${rows.join('\n')}`;
    if (charCount + section.length + 2 > MAX_CATALOG_CHARS) break;
    sectionParts.push(section);
    charCount += section.length + 2;
    bucketCounts.push(`${name}:${rows.length}`);
  }

  const catalog = sectionParts.join('\n\n');
  const sentCount = sectionParts.reduce((n, s) => n + s.split('\n').length - 2, 0); // minus label+header per section

  if (options.verbose) {
    console.log(
      `Sending ${sentCount} of ${records.length} recipes in ${sectionParts.length} sections (${(catalog.length / 1024).toFixed(1)} KB) to ${model}…`,
    );
    console.log(`  Sections: ${bucketCounts.join(', ')}`);
  }

  // Build a map of bucket name → Set of IDs for server-side validation.
  const bucketIdSets: Record<string, Set<string>> = {};
  for (const [name, bucket] of Object.entries(buckets)) {
    bucketIdSets[name] = new Set(bucket.map(p => p.r.id));
  }

  // Call OpenAI
  const client = new OpenAI({ apiKey });

  // Build an explicit section-mapping hint appended to the user message.
  // This tells the model exactly which section to use for each category word
  // it encounters in the query.
  const sectionHint = Object.keys(buckets)
    .filter(k => buckets[k].length > 0)
    .map(k => `  ${k} → use the ${k.toUpperCase()} RECIPES section`)
    .join('\n');

  const chatResponse = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `RECIPE CATALOG:\n${catalog}\n\n` +
          `SECTION MAPPING (mandatory — pick from the named section for each category):\n${sectionHint}\n\n` +
          `USER QUERY: ${query}`,
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.2,
  });

  const raw = chatResponse.choices[0]?.message?.content;
  if (!raw) {
    throw new Error('Empty response from OpenAI API.');
  }

  const result = JSON.parse(raw) as AskResponse;

  // Server-side validation: warn if the AI picked from the wrong section.
  for (const sel of result.selections) {
    if (!sel.section) continue;
    const sectionName = sel.section.replace(/\s*RECIPES\s*/i, '').toLowerCase().trim();
    const idSet = bucketIdSets[sectionName];
    if (idSet && !idSet.has(sel.id)) {
      process.stderr.write(
        `Warning: AI picked "${sel.title}" (${sel.id}) for the ${sectionName} category ` +
        `but that ID is not in the ${sectionName.toUpperCase()} RECIPES section.\n`,
      );
    }
  }

  // Display results
  console.log(`\n${result.summary}\n`);

  // Build a title→recipe fallback map for when ID lookup returns wrong recipe.
  const recipeByTitle = new Map<string, NormalizedRecipe>();
  for (const recipe of recipeMap.values()) {
    recipeByTitle.set(recipe.title.toLowerCase().trim(), recipe);
  }

  for (let i = 0; i < result.selections.length; i++) {
    const sel = result.selections[i];
    // Primary lookup by ID; fall back to title match if ID returns a mismatch.
    let recipe = recipeMap.get(sel.id);
    if (!recipe || recipe.title.toLowerCase().trim() !== sel.title.toLowerCase().trim()) {
      recipe = recipeByTitle.get(sel.title.toLowerCase().trim()) ?? recipe;
    }

    const num = `${i + 1}.`;
    console.log(`${num} ${sel.title}`);

    if (recipe) {
      const timePart = recipe.total_time_minutes
        ? `${recipe.total_time_minutes} min`
        : 'time unknown';

      // Derive protein label from actual ingredients when possible
      const ingText = recipe.ingredients.map(i => i.ingredient).join(' ').toLowerCase();
      const detectedProteins: string[] = [];
      if (/bison|buffalo/.test(ingText)) detectedProteins.push('bison');
      else if (/\bbeef|ground beef|steak|chuck/.test(ingText)) detectedProteins.push('beef');
      else if (/\bchicken/.test(ingText)) detectedProteins.push('chicken');
      else if (/\bpork|sausage|bacon|ham/.test(ingText)) detectedProteins.push('pork');
      else if (/\bturkey/.test(ingText)) detectedProteins.push('turkey');
      else if (/\bsalmon|tuna|cod|tilapia|shrimp|fish/.test(ingText)) detectedProteins.push('fish/seafood');
      else if (/\btofu|tempeh/.test(ingText)) detectedProteins.push('tofu');
      else if (/\blentil|chickpea|black bean|kidney bean/.test(ingText)) detectedProteins.push('legumes');
      const proteinLabel = detectedProteins.length > 0 ? detectedProteins.join(', ') : (recipe.primary_protein !== 'other' ? recipe.primary_protein : '');

      const cuisinePart = recipe.cuisine ? ` | ${recipe.cuisine}` : '';
      console.log(`   ${timePart}${proteinLabel ? ` | ${proteinLabel}` : ''}${cuisinePart}`);

      // Show calories; derive protein% from selection record if nutrition_g looks like percentage
      const selRecord = records.find(r => r.id === sel.id);
      if (recipe.nutrition?.calories != null) {
        const prot = selRecord?.macro_pct_protein != null
          ? ` | ${Math.round(selRecord.macro_pct_protein)}% protein`
          : (recipe.nutrition.protein_g != null && recipe.nutrition.protein_g >= 1
            ? ` | ${recipe.nutrition.protein_g}g protein`
            : '');
        console.log(`   ${recipe.nutrition.calories} kcal${prot}`);
      }

      // Show top ingredients
      if (recipe.ingredients.length > 0) {
        const topIng = recipe.ingredients.slice(0, 6).map(i => i.ingredient).filter(Boolean).join(', ');
        console.log(`   Ingredients: ${topIng}`);
      }

      if (recipe.tags.length > 0) {
        console.log(`   Tags: ${recipe.tags.slice(0, 5).join(', ')}`);
      }
    }

    console.log(`   → ${sel.reason}`);
    console.log('');
  }

  if (options.verbose && chatResponse.usage) {
    const { prompt_tokens, completion_tokens } = chatResponse.usage;
    // gpt-4o-mini pricing as of 2025: $0.15/1M input, $0.60/1M output
    const costUsd =
      (prompt_tokens / 1_000_000) * 0.15 +
      (completion_tokens / 1_000_000) * 0.6;
    console.log(
      `[API: ${prompt_tokens} prompt + ${completion_tokens} completion tokens | ~$${costUsd.toFixed(4)}]`,
    );
  }
}
