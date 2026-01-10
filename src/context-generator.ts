/**
 * Context Generator - Generates ChatGPT-friendly context files
 * Optimized for ChatGPT Plus Projects with compact catalog and full data in JSONL
 */

import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import type { 
  NormalizedRecipe, 
  RecipeIndex, 
  RecipeIndexEntry,
  MealType,
  PrimaryProtein,
  UserConfig,
} from './types.js';
import { getUniqueRecipes, type DeduplicationResult } from './deduplicator.js';
import { 
  generateSelectionIndex, 
  isHelloFresh as checkIsHelloFresh,
  isPastaRecipe as checkIsPastaRecipe,
  isComfortFood,
  isFreezerFriendlyGuess,
  generateDataQualityReport,
  type SelectionIndexStats,
  type DataQualityReport,
} from './selection-index.js';

export interface ContextGeneratorConfig {
  maxChars: number;
  maxRecipesInContext: number;
  includePerRecipeMarkdown: boolean;
  hellofreshFormat: boolean;
}

const DEFAULT_CONFIG: ContextGeneratorConfig = {
  maxChars: 200000,
  maxRecipesInContext: 500,
  includePerRecipeMarkdown: true,
  hellofreshFormat: false,
};

/**
 * Generate all output files
 */
export async function generateOutput(
  dedupeResult: DeduplicationResult,
  outputPath: string,
  userConfig?: UserConfig,
  generatorConfig?: Partial<ContextGeneratorConfig>
): Promise<{ selectionStats: SelectionIndexStats | null; dataQualityReport: DataQualityReport | null }> {
  const config = { ...DEFAULT_CONFIG, ...generatorConfig };
  
  // Create output directories
  await mkdir(outputPath, { recursive: true });
  await mkdir(join(outputPath, 'recipes'), { recursive: true });

  const uniqueRecipes = getUniqueRecipes(dedupeResult);

  // Sort recipes by ID for deterministic output
  const sortedRecipes = [...dedupeResult.recipes].sort((a, b) => a.id.localeCompare(b.id));
  const sortedUniqueRecipes = [...uniqueRecipes].sort((a, b) => a.id.localeCompare(b.id));

  // Generate selection index first to get stats and records
  const { stats: selectionStats, records: selectionRecords } = await generateSelectionIndex(sortedUniqueRecipes, outputPath);
  
  // Generate data quality report
  const dataQualityReport = generateDataQualityReport(selectionRecords);

  // Generate all outputs
  await Promise.all([
    generateJsonl(sortedRecipes, outputPath),
    generateIndex(sortedRecipes, sortedUniqueRecipes, outputPath),
    generateProjectContext(sortedUniqueRecipes, outputPath, config, userConfig, selectionStats, dataQualityReport),
    generatePromptExamples(outputPath),
    config.includePerRecipeMarkdown 
      ? generatePerRecipeMarkdown(sortedUniqueRecipes, outputPath, config.hellofreshFormat) 
      : Promise.resolve(),
  ]);

  return { selectionStats, dataQualityReport };
}

/**
 * Generate JSONL file with all recipes (sorted by ID for determinism)
 */
async function generateJsonl(recipes: NormalizedRecipe[], outputPath: string): Promise<void> {
  const lines = recipes.map(r => JSON.stringify(r));
  await writeFile(join(outputPath, 'recipes.normalized.jsonl'), lines.join('\n'));
}

/**
 * Generate index JSON file
 */
async function generateIndex(
  allRecipes: NormalizedRecipe[], 
  uniqueRecipes: NormalizedRecipe[],
  outputPath: string
): Promise<void> {
  const tagCounts: Record<string, number> = {};
  const proteinCounts: Record<PrimaryProtein, number> = {} as Record<PrimaryProtein, number>;
  const mealTypeCounts: Record<MealType, number> = {} as Record<MealType, number>;

  for (const recipe of uniqueRecipes) {
    for (const tag of recipe.tags) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
    proteinCounts[recipe.primary_protein] = (proteinCounts[recipe.primary_protein] || 0) + 1;
    mealTypeCounts[recipe.meal_type] = (mealTypeCounts[recipe.meal_type] || 0) + 1;
  }

  const indexEntries: RecipeIndexEntry[] = uniqueRecipes.map(r => ({
    id: r.id,
    title: r.title,
    meal_type: r.meal_type,
    primary_protein: r.primary_protein,
    total_time_minutes: r.total_time_minutes,
    tags: r.tags,
    weeknight_score: r.weeknight_score,
    kid_friendly_score: r.kid_friendly_score,
    duplicate_group_id: r.duplicate_group_id,
  }));

  const duplicateGroupCount = new Set(
    allRecipes.filter(r => r.duplicate_group_id).map(r => r.duplicate_group_id)
  ).size;

  const index: RecipeIndex = {
    version: '1.0.0',
    generated_at: new Date().toISOString(),
    total_recipes: allRecipes.length,
    unique_recipes: uniqueRecipes.length,
    duplicate_groups: duplicateGroupCount,
    recipes: indexEntries,
    tag_counts: tagCounts,
    protein_counts: proteinCounts,
    meal_type_counts: mealTypeCounts,
  };

  await writeFile(
    join(outputPath, 'recipes.index.json'), 
    JSON.stringify(index, null, 2)
  );
}

/**
 * Generate the main ChatGPT project context markdown
 * Optimized for ChatGPT Plus Projects - compact catalog with IDs only
 */
async function generateProjectContext(
  recipes: NormalizedRecipe[],
  outputPath: string,
  config: ContextGeneratorConfig,
  userConfig?: UserConfig,
  selectionStats?: SelectionIndexStats,
  dataQualityReport?: DataQualityReport
): Promise<void> {
  const sections: string[] = [];

  // Count HelloFresh and other stats
  const hellofreshCount = recipes.filter(r => checkIsHelloFresh(r)).length;
  const pastaCount = recipes.filter(r => checkIsPastaRecipe(r).result).length;
  const comfortFoodCount = recipes.filter(r => isComfortFood(r)).length;
  const under45Count = recipes.filter(r => r.total_time_minutes !== null && r.total_time_minutes <= 45).length;

  // Header with strict instructions and rules block
  sections.push(`# Recipe Project Context

*Generated: ${new Date().toISOString()}*
*Total Recipes: ${recipes.length}*

---

## 🚨 RULES FOR RECIPE SELECTION

\`\`\`
This file has ${recipes.length} recipes. The catalog table below lists all of them.

When suggesting recipes:
- Pick from the catalog table
- Use exact titles 
- Include ID numbers
- Don't suggest recipes not in this file

The catalog shows: ID | Title | Protein | Time | Weeknight | Kid-Friendly | Source

Sections below index recipes by: HelloFresh, Pasta, Comfort Food, Freezer-Friendly
\`\`\`

---

## Catalog Notes

Some recipes have incomplete metadata. Here's how to handle missing data:

| Field | If Missing | Inference Rule |
|-------|------------|----------------|
| total_time_minutes | null | Use weeknight_score as proxy (high = quick) |
| freezer_friendly | "unknown" | Check is_freezer_candidate_heuristic for hints |
| nutrition data | null values | Skip macro filtering, focus on protein type |
| kid_friendly_score | Always present | Based on ingredient heuristics |

**Key**: When filtering by a field that's null/unknown for a recipe, that recipe should be 
INCLUDED in results but marked appropriately (e.g., "time unknown" or "freezer TBD").

---

## Data Quality

| Metric | Percentage |
|--------|------------|
| Time Missing | ${dataQualityReport?.pct_time_missing ?? 'N/A'}% |
| Nutrition Missing | ${dataQualityReport?.pct_nutrition_missing ?? 'N/A'}% |
| Protein Unknown | ${dataQualityReport?.pct_protein_unknown ?? 'N/A'}% |
| Freezer Unknown | ${dataQualityReport?.pct_freezer_unknown ?? 'N/A'}% |
| Macros Incomplete | ${dataQualityReport?.pct_macros_incomplete ?? 'N/A'}% |

---

## Quick Stats

| Metric | Count |
|--------|-------|
| Total Recipes | ${recipes.length} |
| HelloFresh | ${hellofreshCount} |
| Pasta Dishes | ${pastaCount} |
| Comfort Food | ${comfortFoodCount} |
| Under 45 Minutes | ${under45Count} |
| Vegetarian | ${selectionStats?.vegetarian_count ?? 'N/A'} |
| Vegan | ${selectionStats?.vegan_count ?? 'N/A'} |
| Freezer-Friendly | ${selectionStats?.freezer_friendly_count ?? 'N/A'} |
| Macros Available | ${recipes.length - (selectionStats?.macros_incomplete_count ?? 0)} |

---

`);

  // User preferences if provided
  if (userConfig) {
    sections.push(generatePreferencesSection(userConfig));
  }

  // Compact Recipe Catalog (with IDs and FULL titles)
  const catalogSection = generateCompactCatalog(recipes, config.maxRecipesInContext);
  sections.push(catalogSection);

  // Under 45 Minutes Index
  sections.push(generateTagIndex(recipes, 'Under 45 Minutes', 
    r => r.total_time_minutes !== null && r.total_time_minutes <= 45));

  // HelloFresh Recipes Index
  sections.push(generateSourceIndex(recipes, 'HelloFresh', 
    r => checkIsHelloFresh(r), 'HelloFresh Recipes'));

  // Pasta Recipes Index
  sections.push(generateTagIndex(recipes, 'Pasta Recipes', 
    r => checkIsPastaRecipe(r).result));

  // Comfort Food Index
  sections.push(generateTagIndex(recipes, 'Comfort Food Recipes', 
    r => isComfortFood(r)));

  // Freezer-Friendly Recipes Index (yes only)
  sections.push(generateTagIndex(recipes, 'Freezer-Friendly Recipes', 
    r => isFreezerFriendlyGuess(r).result === 'yes'));

  // Kid-Friendly Top 50
  sections.push(generateTopListCompact(
    recipes,
    'Top 50 Kid-Friendly Recipes',
    r => r.kid_friendly_score,
    50
  ));

  // Weeknight-Friendly Top 50
  sections.push(generateTopListCompact(
    recipes,
    'Top 50 Weeknight-Friendly Recipes',
    r => r.weeknight_score,
    50
  ));

  // Protein Buckets (with counts and IDs)
  sections.push(generateProteinBucketsCompact(recipes));

  // Tag Glossary
  sections.push(generateTagGlossary(recipes));

  let content = sections.join('\n');

  // Check size and truncate if needed
  if (content.length > config.maxChars) {
    content = truncateContent(content, config.maxChars, recipes.length);
  }

  await writeFile(join(outputPath, 'context.project.md'), content);
}

/**
 * Check if recipe is from HelloFresh (use the centralized version)
 */
function isHelloFresh(recipe: NormalizedRecipe): boolean {
  return checkIsHelloFresh(recipe);
}

/**
 * Check if recipe is a pasta dish (use the centralized version)
 */
function isPastaRecipe(recipe: NormalizedRecipe): boolean {
  return checkIsPastaRecipe(recipe).result;
}

/**
 * Check if recipe is freezer-friendly (use the centralized version)
 */
function isFreezerFriendly(recipe: NormalizedRecipe): boolean {
  return isFreezerFriendlyGuess(recipe).result === 'yes';
}

/**
 * Generate compact catalog table with IDs and FULL titles (no truncation)
 */
function generateCompactCatalog(recipes: NormalizedRecipe[], maxRecipes: number): string {
  const sortedRecipes = [...recipes].sort((a, b) => a.title.localeCompare(b.title));
  const displayRecipes = sortedRecipes.slice(0, maxRecipes);

  const lines: string[] = [
    '## Recipe Catalog\n',
    '*Note: For filtering, use catalog.selection.jsonl which has machine-friendly fields.*\n',
    '| ID | Title | Protein | Time | Weeknight | Kid-Friendly | Source |',
    '|----|-------|---------|------|-----------|--------------|--------|',
  ];

  for (const recipe of displayRecipes) {
    const time = recipe.total_time_minutes ? `${recipe.total_time_minutes}m` : '-';
    const weeknight = recipe.weeknight_score.toFixed(1);
    const kidFriendly = recipe.kid_friendly_score.toFixed(1);
    const source = (recipe.source_name || '-').slice(0, 15);
    // Use FULL title - no truncation!
    const escapedTitle = escapeMarkdown(recipe.title);
    lines.push(
      `| ${recipe.id} | ${escapedTitle} | ${recipe.primary_protein} | ${time} | ${weeknight} | ${kidFriendly} | ${source} |`
    );
  }

  if (sortedRecipes.length > maxRecipes) {
    lines.push(`\n*Showing ${maxRecipes} of ${sortedRecipes.length} recipes. Full list in catalog.selection.jsonl*`);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Generate source-based index (e.g., HelloFresh)
 */
function generateSourceIndex(
  recipes: NormalizedRecipe[], 
  sourceName: string,
  filterFn: (r: NormalizedRecipe) => boolean,
  title: string
): string {
  const matching = recipes.filter(filterFn);
  
  if (matching.length === 0) {
    return `## ${title}\n\nNo ${sourceName} recipes found.\n\n`;
  }

  const lines: string[] = [
    `## ${title} (${matching.length})\n`,
  ];

  for (const r of matching.slice(0, 100)) {
    lines.push(`- \`${r.id}\` ${r.title}`);
  }

  if (matching.length > 100) {
    lines.push(`\n*...and ${matching.length - 100} more*`);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Generate tag-based index
 */
function generateTagIndex(
  recipes: NormalizedRecipe[],
  title: string,
  filterFn: (r: NormalizedRecipe) => boolean
): string {
  const matching = recipes.filter(filterFn);
  
  if (matching.length === 0) {
    return `## ${title}\n\nNone found.\n\n`;
  }

  const lines: string[] = [
    `## ${title} (${matching.length})\n`,
  ];

  for (const r of matching.slice(0, 75)) {
    lines.push(`- \`${r.id}\` ${r.title}`);
  }

  if (matching.length > 75) {
    lines.push(`\n*...and ${matching.length - 75} more*`);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Generate compact top-N list by score (with IDs)
 */
function generateTopListCompact(
  recipes: NormalizedRecipe[],
  title: string,
  scoreFunc: (r: NormalizedRecipe) => number,
  limit: number
): string {
  const sorted = [...recipes].sort((a, b) => scoreFunc(b) - scoreFunc(a));
  const top = sorted.slice(0, limit);

  const lines: string[] = [
    `## ${title}\n`,
  ];

  for (const r of top) {
    const time = r.total_time_minutes ? ` (${r.total_time_minutes}min)` : '';
    lines.push(`- \`${r.id}\` ${r.title}${time}`);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Generate protein buckets with IDs
 */
function generateProteinBucketsCompact(recipes: NormalizedRecipe[]): string {
  const buckets: Record<string, NormalizedRecipe[]> = {};

  for (const recipe of recipes) {
    const protein = recipe.primary_protein;
    if (!buckets[protein]) {
      buckets[protein] = [];
    }
    buckets[protein].push(recipe);
  }

  const lines: string[] = ['## Recipes by Protein\n'];

  const sortedProteins = Object.entries(buckets).sort((a, b) => b[1].length - a[1].length);

  for (const [protein, recipeList] of sortedProteins) {
    lines.push(`### ${protein.charAt(0).toUpperCase() + protein.slice(1)} (${recipeList.length})`);
    const displayRecipes = recipeList.slice(0, 15);
    for (const r of displayRecipes) {
      lines.push(`- \`${r.id}\` ${r.title}`);
    }
    if (recipeList.length > 15) {
      lines.push(`- *...and ${recipeList.length - 15} more*`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generate tag glossary
 */
function generateTagGlossary(recipes: NormalizedRecipe[]): string {
  const tagCounts: Record<string, number> = {};
  
  for (const recipe of recipes) {
    for (const tag of recipe.tags) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }

  const sortedTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30);

  if (sortedTags.length === 0) {
    return '## Tag Glossary\n\nNo tags found.\n\n';
  }

  const lines: string[] = [
    '## Tag Glossary\n',
    'Top tags by frequency:\n',
  ];

  for (const [tag, count] of sortedTags) {
    lines.push(`- **${tag}**: ${count} recipes`);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Generate prompt examples file with STRICT and FLEXIBLE modes
 */
async function generatePromptExamples(outputPath: string): Promise<void> {
  const content = `# Example Prompts for ChatGPT Plus Recipe Project

## How to Use

Copy-paste one of these prompts into ChatGPT after loading the project files.

---

## STRICT MODE (Verified Data Only)

Use this when you need exact matches and can't accept uncertainty.
Recipes with missing data for a required field will be EXCLUDED.

\`\`\`
STRICT MODE: Suggest 5 dinner recipes from this Project that meet ALL criteria:

HARD REQUIREMENTS (must have data, not null/unknown):
- total_time_minutes <= 45
- nutrition data available (macros_incomplete = false)
- freezer_friendly = "yes" (not "unknown")

PROTEIN MIX:
- 2 chicken
- 1 beef  
- 1 fish or seafood
- 1 vegetarian

PREFERENCES:
- weeknight_score > 0.6
- kid_friendly_score > 0.5 for at least 3 recipes

OUTPUT: For each recipe, show:
1. ID and exact title (paprika_title_exact)
2. Total time
3. Macros (protein%, carbs%, fat%)
4. Freezer status

RULES:
- ONLY include recipes where required fields have actual values
- Skip recipes with null time or unknown freezer status
- Use IDs and titles exactly as shown in catalog
\`\`\`

---

## FLEXIBLE MODE (With Inference Rules)

Use this for broader results. Recipes with missing data are INCLUDED but handled per inference rules.

\`\`\`
FLEXIBLE MODE: Suggest 7 dinner recipes from this Project for weekly meal prep.

CRITERIA:
- Mix of proteins: chicken, beef, pork, fish, vegetarian
- At least 3 should be kid-friendly (kid_friendly_score >= 0.6)
- Prefer weeknight_score >= 0.5
- Prefer freezer-friendly

INFERENCE RULES (when data is missing):
1. If total_time_minutes is null:
   - Use weeknight_score as proxy (> 0.7 = probably quick)
   - Mark in output as "time: unknown (weeknight score: X)"
   
2. If freezer_friendly = "unknown":
   - Check is_freezer_candidate_heuristic field
   - If true: include with note "freezer: likely (heuristic)"
   - If false: include with note "freezer: unknown"
   
3. If macros_incomplete = true:
   - Still include recipe
   - Use nutrition_profile if available, else mark "macros: unavailable"

4. If protein_g is null:
   - Infer from primary_protein (chicken/beef/fish = high protein guess)
   - Mark as "protein: inferred from type"

OUTPUT FORMAT:
For each recipe:
- ID: [id]
- Title: [paprika_title_exact]  
- Protein: [primary_protein]
- Time: [total_time_minutes or inference]
- Freezer: [freezer_friendly or inference]
- Notes: [any warnings or inferences applied]

RULES:
- Use ONLY recipes from this Project's catalog
- Apply inference rules for missing data rather than excluding
- Be transparent about which values are inferred vs. confirmed
\`\`\`

---

## Quick Prompts

### Weekly Meal Plan
\`\`\`
Pick 5 recipes from this Project: 1 chicken, 1 pork, 1 beef, 1 fish, 1 vegetarian.
At least 2 should be kid_friendly_bucket = "High".
At least 2 should have freezer_friendly = "yes" or is_freezer_candidate_heuristic = true.
Include at least 1 HelloFresh recipe.
Show ID, title, time, and freezer status for each.
\`\`\`

### Under 30 Minutes
\`\`\`
Find 5 recipes from this Project where total_time_minutes <= 30.
If time is null, exclude the recipe.
Show ID, title, protein type, and actual time.
\`\`\`

### Kid-Friendly Night
\`\`\`
List 5 recipes from this Project with kid_friendly_bucket = "High" and spice_level <= 2.
Show ID, title, and kid_friendly_score.
\`\`\`

### Pasta Night
\`\`\`
Find 5 pasta recipes from this Project (is_pasta = true) with different primary_protein values.
Show ID, title, protein, and time.
\`\`\`

### Freezer Meal Prep
\`\`\`
Find 5 recipes from this Project where freezer_friendly = "yes".
For any with freezer_friendly = "unknown", check if is_freezer_candidate_heuristic = true and include those too.
Show ID, title, freezer status, and reheat_quality.
\`\`\`

### HelloFresh Week
\`\`\`
List all recipes from this Project where is_hellofresh = true.
Sort by weeknight_score descending.
Show ID, title, weeknight_score, and total_time.
\`\`\`

### High Protein / Low Fat
\`\`\`
Find 5 recipes from this Project where:
- nutrition_profile = "lean" OR (macro_pct_protein >= 30 AND macro_pct_fat <= 25)
If macros_incomplete = true, use primary_protein as guide (fish/chicken/tofu = likely lean).
Show ID, title, macros, and nutrition_profile.
\`\`\`

---

## Field Reference (catalog.selection.jsonl)

Key fields for filtering:
- \`id\` - Unique recipe ID
- \`title\` / \`paprika_title_exact\` - Recipe name (use exact)
- \`primary_protein\` - chicken, beef, pork, fish, seafood, vegetarian, etc.
- \`total_time_minutes\` - null if unknown
- \`freezer_friendly\` - "yes", "no", or "unknown"
- \`is_freezer_candidate_heuristic\` - true if recipe TYPE suggests freezable
- \`kid_friendly_score\` / \`kid_friendly_bucket\` - 0-1 score or High/Med/Low
- \`weeknight_score\` / \`weeknight_bucket\` - 0-1 score or High/Med/Low
- \`is_hellofresh\` - boolean
- \`is_pasta\` - boolean
- \`nutrition_profile\` - "lean", "balanced", "comfort", or "unknown"
- \`macros_incomplete\` - true if nutrition data missing
- \`warnings\` - array of data quality issues

---

## Getting Full Recipe

When you need ingredients and instructions:

\`\`\`
Show me the full recipe for [exact title] (ID: [id]) from the JSONL file.
\`\`\`

`;

  await writeFile(join(outputPath, 'prompt.examples.md'), content);
}

/**
 * Generate user preferences section
 */
function generatePreferencesSection(config: UserConfig): string {
  const lines: string[] = ['## Household Preferences\n'];

  if (config.dietary_preferences) {
    const prefs = Object.entries(config.dietary_preferences)
      .filter(([, v]) => v)
      .map(([k]) => k.replace(/_/g, ' '));
    if (prefs.length > 0) {
      lines.push(`**Dietary**: ${prefs.join(', ')}`);
    }
  }

  if (config.household_notes) {
    if (config.household_notes.kid_friendly) {
      lines.push('**Kid-friendly meals preferred**');
    }
    if (config.household_notes.spice_tolerance) {
      lines.push(`**Spice tolerance**: ${config.household_notes.spice_tolerance}`);
    }
    if (config.household_notes.num_servings) {
      lines.push(`**Default servings**: ${config.household_notes.num_servings}`);
    }
  }

  if (config.excluded_ingredients && config.excluded_ingredients.length > 0) {
    lines.push(`**Excluded ingredients**: ${config.excluded_ingredients.join(', ')}`);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Truncate content with notice
 */
function truncateContent(content: string, maxChars: number, totalRecipes: number): string {
  const notice = `

---

⚠️ **Content Truncated**

This context file has been truncated to fit within the ${maxChars.toLocaleString()} character limit. 
Full recipe data is available in:
- \`recipes.normalized.jsonl\` - Complete recipe data (one per line)
- \`recipes.index.json\` - Searchable index
- \`recipes/\` folder - Individual recipe markdown files

To get details on a specific recipe, reference the JSONL file or ask for a recipe by name.

`;

  const truncated = content.slice(0, maxChars - notice.length);
  
  // Try to truncate at a section boundary
  const lastSection = truncated.lastIndexOf('\n## ');
  if (lastSection > maxChars * 0.5) {
    return truncated.slice(0, lastSection) + notice;
  }

  return truncated + notice;
}

/**
 * Generate individual markdown files for each recipe
 */
async function generatePerRecipeMarkdown(
  recipes: NormalizedRecipe[],
  outputPath: string,
  hellofreshFormat: boolean
): Promise<void> {
  const recipesDir = join(outputPath, 'recipes');

  await Promise.all(recipes.map(async (recipe) => {
    const slug = generateSlug(recipe.title);
    const filename = `${slug}-${recipe.id.slice(0, 6)}.md`;
    const content = formatRecipeMarkdown(recipe, hellofreshFormat);
    await writeFile(join(recipesDir, filename), content);
  }));
}

/**
 * Generate URL-friendly slug from title
 */
function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

/**
 * Format a single recipe as markdown
 */
function formatRecipeMarkdown(recipe: NormalizedRecipe, hellofreshFormat: boolean): string {
  const lines: string[] = [
    `# ${recipe.title}`,
    '',
  ];

  // Metadata
  if (recipe.source_name || recipe.source_url) {
    const source = recipe.source_url 
      ? `[${recipe.source_name || 'Source'}](${recipe.source_url})`
      : recipe.source_name;
    lines.push(`**Source:** ${source}`);
  }

  if (recipe.yield_servings) {
    lines.push(`**Servings:** ${recipe.yield_servings}`);
  }

  if (recipe.total_time_minutes) {
    lines.push(`**Total Time:** ${formatTime(recipe.total_time_minutes)}`);
  }

  if (recipe.cuisine) {
    lines.push(`**Cuisine:** ${recipe.cuisine}`);
  }

  if (recipe.tags.length > 0) {
    lines.push(`**Tags:** ${recipe.tags.join(', ')}`);
  }

  lines.push('');

  // Ingredients
  lines.push('## Ingredients\n');
  for (const ing of recipe.ingredients) {
    if (hellofreshFormat) {
      // Amount-first format
      const qty = ing.quantity !== null ? formatQuantity(ing.quantity) : '';
      const unit = ing.unit || '';
      const notes = ing.notes ? ` (${ing.notes})` : '';
      lines.push(`- ${qty} ${unit} ${ing.ingredient}${notes}`.trim());
    } else {
      lines.push(`- ${ing.original}`);
    }
  }
  lines.push('');

  // Instructions
  lines.push('## Instructions\n');
  recipe.instructions.forEach((step, i) => {
    lines.push(`${i + 1}. ${step}`);
  });
  lines.push('');

  // Notes
  if (recipe.notes) {
    lines.push('## Notes\n');
    lines.push(recipe.notes);
    lines.push('');
  }

  // Nutrition
  if (recipe.nutrition) {
    lines.push('## Nutrition (per serving)\n');
    const n = recipe.nutrition;
    if (n.calories) lines.push(`- Calories: ${n.calories}`);
    if (n.protein_g) lines.push(`- Protein: ${n.protein_g}g`);
    if (n.carbs_g) lines.push(`- Carbs: ${n.carbs_g}g`);
    if (n.fat_g) lines.push(`- Fat: ${n.fat_g}g`);
    if (n.sodium_mg) lines.push(`- Sodium: ${n.sodium_mg}mg`);
    lines.push('');
  }

  // Metadata footer
  lines.push('---');
  lines.push(`*Meal Type: ${recipe.meal_type} | Protein: ${recipe.primary_protein} | Weeknight Score: ${recipe.weeknight_score.toFixed(2)} | Kid-Friendly: ${recipe.kid_friendly_score.toFixed(2)}*`);

  return lines.join('\n');
}

/**
 * Format time in minutes to human readable
 */
function formatTime(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} minutes`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (mins === 0) {
    return `${hours} hour${hours > 1 ? 's' : ''}`;
  }
  return `${hours}h ${mins}m`;
}

/**
 * Format quantity with fractions
 */
function formatQuantity(value: number): string {
  const fractions: Record<number, string> = {
    0.25: '¼',
    0.333: '⅓',
    0.5: '½',
    0.667: '⅔',
    0.75: '¾',
  };

  const whole = Math.floor(value);
  const frac = value - whole;

  for (const [key, char] of Object.entries(fractions)) {
    if (Math.abs(frac - parseFloat(key)) < 0.05) {
      return whole > 0 ? `${whole} ${char}` : char;
    }
  }

  if (whole > 0 && frac > 0.05) {
    return value.toFixed(1);
  }
  
  return whole.toString();
}

/**
 * Escape markdown special characters
 */
function escapeMarkdown(text: string): string {
  return text.replace(/[|]/g, '\\|');
}
