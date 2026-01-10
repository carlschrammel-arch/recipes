/**
 * Search - Search and filter recipes
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import type { NormalizedRecipe, RecipeIndex, SearchOptions } from './types.js';

/**
 * Load recipes from JSONL file
 */
export async function loadRecipes(outputPath: string): Promise<NormalizedRecipe[]> {
  const jsonlPath = join(outputPath, 'recipes.normalized.jsonl');
  const content = await readFile(jsonlPath, 'utf-8');
  
  return content
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as NormalizedRecipe);
}

/**
 * Load recipe index
 */
export async function loadIndex(outputPath: string): Promise<RecipeIndex> {
  const indexPath = join(outputPath, 'recipes.index.json');
  const content = await readFile(indexPath, 'utf-8');
  return JSON.parse(content) as RecipeIndex;
}

/**
 * Search recipes with various filters
 */
export function searchRecipes(recipes: NormalizedRecipe[], options: SearchOptions): NormalizedRecipe[] {
  let results = [...recipes];

  // Text search
  if (options.query) {
    const queryTerms = options.query.toLowerCase().split(/\s+/);
    results = results.filter(recipe => {
      const searchText = [
        recipe.title,
        ...recipe.ingredients.map(i => i.ingredient),
        ...recipe.tags,
        recipe.cuisine || '',
        recipe.notes || '',
      ].join(' ').toLowerCase();

      return queryTerms.every(term => searchText.includes(term));
    });
  }

  // Tag filter
  if (options.tags && options.tags.length > 0) {
    const searchTags = options.tags.map(t => t.toLowerCase());
    results = results.filter(recipe => 
      searchTags.some(tag => recipe.tags.includes(tag))
    );
  }

  // Meal type filter
  if (options.mealType) {
    results = results.filter(recipe => recipe.meal_type === options.mealType);
  }

  // Protein filter
  if (options.protein) {
    results = results.filter(recipe => recipe.primary_protein === options.protein);
  }

  // Max time filter
  if (options.maxTime) {
    results = results.filter(recipe => 
      recipe.total_time_minutes !== null && 
      recipe.total_time_minutes <= options.maxTime!
    );
  }

  // Weeknight score filter
  if (options.minWeeknightScore !== undefined) {
    results = results.filter(recipe => 
      recipe.weeknight_score >= options.minWeeknightScore!
    );
  }

  // Kid-friendly score filter
  if (options.minKidFriendlyScore !== undefined) {
    results = results.filter(recipe => 
      recipe.kid_friendly_score >= options.minKidFriendlyScore!
    );
  }

  // Sort by relevance (for now, by weeknight score)
  results.sort((a, b) => b.weeknight_score - a.weeknight_score);

  // Apply limit
  if (options.limit) {
    results = results.slice(0, options.limit);
  }

  return results;
}

/**
 * Format search results for display
 */
export function formatSearchResults(recipes: NormalizedRecipe[]): string {
  if (recipes.length === 0) {
    return 'No recipes found matching your criteria.';
  }

  const lines: string[] = [
    `Found ${recipes.length} recipe(s):\n`,
  ];

  for (const recipe of recipes) {
    const time = recipe.total_time_minutes 
      ? `${recipe.total_time_minutes} min` 
      : 'time unknown';
    const protein = recipe.primary_protein !== 'other' 
      ? ` | ${recipe.primary_protein}` 
      : '';
    const tags = recipe.tags.slice(0, 3).join(', ');

    lines.push(`  ${recipe.title}`);
    lines.push(`    ${time}${protein} | ${recipe.meal_type}`);
    if (tags) {
      lines.push(`    Tags: ${tags}`);
    }
    lines.push(`    Weeknight: ${(recipe.weeknight_score * 100).toFixed(0)}% | Kid-friendly: ${(recipe.kid_friendly_score * 100).toFixed(0)}%`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Get quick stats from index
 */
export function formatStats(index: RecipeIndex): string {
  const lines: string[] = [
    '📊 Recipe Collection Statistics\n',
    `Total recipes: ${index.total_recipes}`,
    `Unique recipes: ${index.unique_recipes}`,
    `Duplicate groups: ${index.duplicate_groups}`,
    '',
    '📋 By Meal Type:',
  ];

  for (const [type, count] of Object.entries(index.meal_type_counts)) {
    lines.push(`  ${type}: ${count}`);
  }

  lines.push('');
  lines.push('🥩 By Protein:');

  const sortedProteins = Object.entries(index.protein_counts)
    .sort((a, b) => b[1] - a[1]);
  
  for (const [protein, count] of sortedProteins) {
    lines.push(`  ${protein}: ${count}`);
  }

  lines.push('');
  lines.push('🏷️ Top Tags:');

  const sortedTags = Object.entries(index.tag_counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  
  for (const [tag, count] of sortedTags) {
    lines.push(`  ${tag}: ${count}`);
  }

  return lines.join('\n');
}
