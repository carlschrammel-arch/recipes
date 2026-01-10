/**
 * Deduplicator - Identifies and groups near-duplicate recipes
 * Uses blocking strategy to avoid O(n²) comparisons for scalability
 */

import { createHash } from 'crypto';
import type { NormalizedRecipe, DuplicateGroup } from './types.js';

export interface DeduplicationResult {
  recipes: NormalizedRecipe[];
  duplicateGroups: DuplicateGroup[];
  stats: {
    totalRecipes: number;
    uniqueRecipes: number;
    duplicateGroups: number;
    duplicatesFound: number;
    blocksCreated: number;
    comparisonsPerformed: number;
  };
}

interface DeduplicationConfig {
  titleSimilarityThreshold: number;  // 0-1
  ingredientSimilarityThreshold: number;  // 0-1
  combinedThreshold: number;  // 0-1
}

const DEFAULT_CONFIG: DeduplicationConfig = {
  titleSimilarityThreshold: 0.7,
  ingredientSimilarityThreshold: 0.6,
  combinedThreshold: 0.65,
};

/**
 * Generate blocking keys for a recipe
 * Recipes must share at least one blocking key to be compared
 */
function generateBlockingKeys(recipe: NormalizedRecipe): string[] {
  const keys: Set<string> = new Set();
  
  // Block 1: Normalized title prefix (first 3-4 significant words)
  const titleWords = normalizeTitle(recipe.title).split(' ').slice(0, 4);
  if (titleWords.length >= 2) {
    keys.add(`title:${titleWords.slice(0, 2).join('-')}`);
    if (titleWords.length >= 3) {
      keys.add(`title:${titleWords.slice(0, 3).join('-')}`);
    }
  }
  
  // Block 2: Primary protein (if not "other")
  if (recipe.primary_protein !== 'other') {
    keys.add(`protein:${recipe.primary_protein}`);
  }
  
  // Block 3: First significant ingredient word
  const firstIngredients = recipe.ingredients.slice(0, 3);
  for (const ing of firstIngredients) {
    const ingWord = normalizeIngredientForComparison(ing.ingredient).split(' ')[0];
    if (ingWord && ingWord.length > 2) {
      keys.add(`ing:${ingWord}`);
    }
  }
  
  // Block 4: Exact title hash (for exact duplicates)
  const exactKey = normalizeTitle(recipe.title).replace(/\s+/g, '');
  if (exactKey.length > 0) {
    keys.add(`exact:${exactKey.slice(0, 20)}`);
  }
  
  return Array.from(keys);
}

/**
 * Find and group duplicate recipes using blocking for scalability
 */
export function deduplicateRecipes(
  recipes: NormalizedRecipe[], 
  config: Partial<DeduplicationConfig> = {}
): DeduplicationResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const duplicateGroups: DuplicateGroup[] = [];
  const assignedGroups = new Map<string, string>(); // recipe id -> group id
  
  // Build blocking index
  const blockIndex = new Map<string, Set<number>>(); // blocking key -> recipe indices
  
  for (let i = 0; i < recipes.length; i++) {
    const keys = generateBlockingKeys(recipes[i]);
    for (const key of keys) {
      if (!blockIndex.has(key)) {
        blockIndex.set(key, new Set());
      }
      blockIndex.get(key)!.add(i);
    }
  }
  
  // Track which pairs we've already compared
  const comparedPairs = new Set<string>();
  let comparisonsPerformed = 0;
  
  // Compare recipes within each block
  for (const [, indices] of blockIndex) {
    const indexArray = Array.from(indices);
    
    for (let a = 0; a < indexArray.length; a++) {
      for (let b = a + 1; b < indexArray.length; b++) {
        const i = indexArray[a];
        const j = indexArray[b];
        
        // Skip if already compared
        const pairKey = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (comparedPairs.has(pairKey)) continue;
        comparedPairs.add(pairKey);
        
        comparisonsPerformed++;
        
        const similarity = calculateSimilarity(recipes[i], recipes[j]);
        
        if (similarity >= cfg.combinedThreshold) {
          mergeIntoGroups(
            recipes, i, j, similarity, 
            duplicateGroups, assignedGroups
          );
        }
      }
    }
  }

  // Update recipes with duplicate group IDs
  const updatedRecipes = recipes.map(recipe => ({
    ...recipe,
    duplicate_group_id: assignedGroups.get(recipe.id) || null,
  }));

  return {
    recipes: updatedRecipes,
    duplicateGroups,
    stats: {
      totalRecipes: recipes.length,
      uniqueRecipes: recipes.length - duplicateGroups.reduce((sum, g) => sum + g.recipes.length - 1, 0),
      duplicateGroups: duplicateGroups.length,
      duplicatesFound: duplicateGroups.reduce((sum, g) => sum + g.recipes.length - 1, 0),
      blocksCreated: blockIndex.size,
      comparisonsPerformed,
    },
  };
}

/**
 * Merge two recipes into duplicate groups
 */
function mergeIntoGroups(
  recipes: NormalizedRecipe[],
  i: number,
  j: number,
  similarity: number,
  duplicateGroups: DuplicateGroup[],
  assignedGroups: Map<string, string>
): void {
  const recipe1 = recipes[i];
  const recipe2 = recipes[j];
  
  const groupId1 = assignedGroups.get(recipe1.id);
  const groupId2 = assignedGroups.get(recipe2.id);

  if (!groupId1 && !groupId2) {
    // Create new group
    const groupId = generateGroupId();
    assignedGroups.set(recipe1.id, groupId);
    assignedGroups.set(recipe2.id, groupId);
    
    duplicateGroups.push({
      group_id: groupId,
      canonical_id: selectCanonical([recipe1, recipe2]).id,
      recipes: [
        {
          id: recipe1.id,
          title: recipe1.title,
          source_file: recipe1.source_file,
          similarity_score: 1,
        },
        {
          id: recipe2.id,
          title: recipe2.title,
          source_file: recipe2.source_file,
          similarity_score: similarity,
        },
      ],
    });
  } else if (groupId1 && !groupId2) {
    // Add to existing group
    assignedGroups.set(recipe2.id, groupId1);
    const group = duplicateGroups.find(g => g.group_id === groupId1)!;
    group.recipes.push({
      id: recipe2.id,
      title: recipe2.title,
      source_file: recipe2.source_file,
      similarity_score: similarity,
    });
    // Recalculate canonical
    const groupRecipes = recipes.filter(r => assignedGroups.get(r.id) === groupId1);
    group.canonical_id = selectCanonical(groupRecipes).id;
  } else if (!groupId1 && groupId2) {
    // Add to existing group
    assignedGroups.set(recipe1.id, groupId2);
    const group = duplicateGroups.find(g => g.group_id === groupId2)!;
    group.recipes.push({
      id: recipe1.id,
      title: recipe1.title,
      source_file: recipe1.source_file,
      similarity_score: similarity,
    });
    // Recalculate canonical
    const groupRecipes = recipes.filter(r => assignedGroups.get(r.id) === groupId2);
    group.canonical_id = selectCanonical(groupRecipes).id;
  } else if (groupId1 && groupId2 && groupId1 !== groupId2) {
    // Merge groups
    const group1 = duplicateGroups.find(g => g.group_id === groupId1)!;
    const group2 = duplicateGroups.find(g => g.group_id === groupId2)!;
    
    // Move all recipes from group2 to group1
    for (const recipe of group2.recipes) {
      assignedGroups.set(recipe.id, groupId1);
      group1.recipes.push(recipe);
    }
    
    // Remove group2
    const group2Index = duplicateGroups.findIndex(g => g.group_id === groupId2);
    duplicateGroups.splice(group2Index, 1);
    
    // Recalculate canonical
    const groupRecipes = recipes.filter(r => assignedGroups.get(r.id) === groupId1);
    group1.canonical_id = selectCanonical(groupRecipes).id;
  }
}

/**
 * Calculate overall similarity between two recipes
 */
function calculateSimilarity(a: NormalizedRecipe, b: NormalizedRecipe): number {
  const titleSim = calculateTitleSimilarity(a.title, b.title);
  const ingredientSim = calculateIngredientSimilarity(a, b);
  
  // Weighted average: title is more important
  return titleSim * 0.6 + ingredientSim * 0.4;
}

/**
 * Calculate title similarity using normalized Levenshtein distance
 */
function calculateTitleSimilarity(a: string, b: string): number {
  const normA = normalizeTitle(a);
  const normB = normalizeTitle(b);

  if (normA === normB) return 1;

  // Use Jaccard similarity of words
  const wordsA = new Set(normA.split(' '));
  const wordsB = new Set(normB.split(' '));

  const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
  const union = new Set([...wordsA, ...wordsB]);

  return intersection.size / union.size;
}

/**
 * Calculate ingredient similarity using Jaccard index
 */
function calculateIngredientSimilarity(a: NormalizedRecipe, b: NormalizedRecipe): number {
  const ingredientsA = new Set(
    a.ingredients.map(i => normalizeIngredientForComparison(i.ingredient))
  );
  const ingredientsB = new Set(
    b.ingredients.map(i => normalizeIngredientForComparison(i.ingredient))
  );

  if (ingredientsA.size === 0 && ingredientsB.size === 0) return 1;
  if (ingredientsA.size === 0 || ingredientsB.size === 0) return 0;

  const intersection = new Set([...ingredientsA].filter(x => ingredientsB.has(x)));
  const union = new Set([...ingredientsA, ...ingredientsB]);

  return intersection.size / union.size;
}

/**
 * Normalize title for comparison
 */
function normalizeTitle(title: string): string {
  const stopwords = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'with', 'from', 'for', 'to', 'in', 'on',
    'easy', 'quick', 'simple', 'best', 'perfect', 'amazing', 'delicious', 'homemade',
    'my', 'our', 'your', 'moms', "mom's", 'grandmas', "grandma's",
  ]);

  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(word => !stopwords.has(word) && word.length > 0);

  // Only filter out single-character words if there are longer words present
  const longWords = words.filter(w => w.length > 1);
  const result = longWords.length > 0 ? longWords : words;
  
  return result.sort().join(' ');
}

/**
 * Normalize ingredient for comparison
 */
function normalizeIngredientForComparison(ingredient: string): string {
  const modifiers = [
    'fresh', 'frozen', 'canned', 'dried', 'ground', 'minced', 'diced', 'chopped',
    'sliced', 'shredded', 'grated', 'melted', 'softened', 'cold', 'warm', 'hot',
    'cooked', 'raw', 'boneless', 'skinless', 'organic', 'low-fat', 'unsalted',
    'large', 'medium', 'small', 'extra', 'virgin',
  ];

  let normalized = ingredient.toLowerCase().replace(/[^a-z\s]/g, '');
  
  for (const mod of modifiers) {
    normalized = normalized.replace(new RegExp(`\\b${mod}\\b`, 'g'), '');
  }

  return normalized.replace(/\s+/g, ' ').trim();
}

/**
 * Select the canonical (best) recipe from a group
 */
function selectCanonical(recipes: NormalizedRecipe[]): NormalizedRecipe {
  // Score each recipe based on completeness
  const scored = recipes.map(recipe => {
    let score = 0;
    
    if (recipe.source_url) score += 3;
    if (recipe.notes) score += 2;
    if (recipe.nutrition) score += 2;
    if (recipe.total_time_minutes) score += 1;
    if (recipe.yield_servings) score += 1;
    if (recipe.tags.length > 0) score += 1;
    if (recipe.cuisine) score += 1;
    if (recipe.instructions.length > 0) score += recipe.instructions.length * 0.1;
    if (recipe.ingredients.length > 0) score += recipe.ingredients.length * 0.1;
    if (recipe.parse_warnings.length === 0) score += 2;
    
    return { recipe, score };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  return scored[0].recipe;
}

/**
 * Generate a unique group ID
 */
function generateGroupId(): string {
  return createHash('md5')
    .update(Math.random().toString() + Date.now().toString())
    .digest('hex')
    .slice(0, 8);
}

/**
 * Get unique recipes (filter out duplicates, keeping only canonical)
 */
export function getUniqueRecipes(result: DeduplicationResult): NormalizedRecipe[] {
  const canonicalIds = new Set(result.duplicateGroups.map(g => g.canonical_id));
  const duplicateIds = new Set(
    result.duplicateGroups.flatMap(g => 
      g.recipes.map(r => r.id).filter(id => id !== g.canonical_id)
    )
  );

  return result.recipes.filter(r => !duplicateIds.has(r.id));
}
