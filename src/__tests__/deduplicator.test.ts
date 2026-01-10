/**
 * Tests for Deduplicator
 */

import { describe, it, expect } from 'vitest';
import { deduplicateRecipes, getUniqueRecipes } from '../deduplicator.js';
import type { NormalizedRecipe } from '../types.js';

function createRecipe(overrides: Partial<NormalizedRecipe> = {}): NormalizedRecipe {
  return {
    id: Math.random().toString(36).slice(2, 14),
    title: 'Test Recipe',
    source_name: null,
    source_url: null,
    yield_servings: 4,
    prep_time_minutes: 15,
    cook_time_minutes: 30,
    total_time_minutes: 45,
    ingredients: [
      { original: '1 cup flour', quantity: 1, unit: 'cup', ingredient: 'flour', notes: null },
      { original: '2 eggs', quantity: 2, unit: null, ingredient: 'eggs', notes: null },
    ],
    instructions: ['Mix ingredients', 'Bake'],
    tags: [],
    notes: null,
    nutrition: null,
    cuisine: null,
    meal_type: 'dinner',
    kid_friendly_score: 0.5,
    weeknight_score: 0.5,
    spice_level: 0,
    equipment: [],
    primary_protein: 'other',
    cost_tier: 'medium',
    duplicate_group_id: null,
    parse_warnings: [],
    source_file: '/test/recipe.txt',
    imported_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('deduplicateRecipes', () => {
  it('should not flag unique recipes as duplicates', () => {
    const recipes = [
      createRecipe({ 
        id: '1', 
        title: 'Chocolate Cake',
        ingredients: [
          { original: '2 cups flour', quantity: 2, unit: 'cup', ingredient: 'flour', notes: null },
          { original: '1 cup cocoa', quantity: 1, unit: 'cup', ingredient: 'cocoa', notes: null },
        ],
      }),
      createRecipe({ 
        id: '2', 
        title: 'Chicken Stir Fry',
        ingredients: [
          { original: '1 lb chicken', quantity: 1, unit: 'lb', ingredient: 'chicken', notes: null },
          { original: '2 cups vegetables', quantity: 2, unit: 'cup', ingredient: 'vegetables', notes: null },
        ],
      }),
    ];

    const result = deduplicateRecipes(recipes);
    
    expect(result.duplicateGroups.length).toBe(0);
    expect(result.stats.duplicatesFound).toBe(0);
    expect(result.stats.uniqueRecipes).toBe(2);
  });

  it('should identify exact duplicate titles', () => {
    const recipes = [
      createRecipe({ 
        id: '1', 
        title: 'Chocolate Cake',
        ingredients: [
          { original: '2 cups flour', quantity: 2, unit: 'cup', ingredient: 'flour', notes: null },
        ],
      }),
      createRecipe({ 
        id: '2', 
        title: 'Chocolate Cake',
        ingredients: [
          { original: '2 cups flour', quantity: 2, unit: 'cup', ingredient: 'flour', notes: null },
        ],
      }),
    ];

    const result = deduplicateRecipes(recipes);
    
    expect(result.duplicateGroups.length).toBe(1);
    expect(result.stats.duplicatesFound).toBe(1);
    expect(result.stats.uniqueRecipes).toBe(1);
  });

  it('should identify similar titles with different wording', () => {
    const recipes = [
      createRecipe({ 
        id: '1', 
        title: 'Easy Chocolate Cake',
        ingredients: [
          { original: 'flour', quantity: 2, unit: 'cup', ingredient: 'flour', notes: null },
          { original: 'cocoa', quantity: 1, unit: 'cup', ingredient: 'cocoa', notes: null },
          { original: 'sugar', quantity: 1, unit: 'cup', ingredient: 'sugar', notes: null },
        ],
      }),
      createRecipe({ 
        id: '2', 
        title: 'Simple Chocolate Cake',
        ingredients: [
          { original: 'flour', quantity: 2, unit: 'cup', ingredient: 'flour', notes: null },
          { original: 'cocoa', quantity: 1, unit: 'cup', ingredient: 'cocoa', notes: null },
          { original: 'sugar', quantity: 1, unit: 'cup', ingredient: 'sugar', notes: null },
        ],
      }),
    ];

    const result = deduplicateRecipes(recipes);
    
    expect(result.duplicateGroups.length).toBe(1);
  });

  it('should identify recipes with similar ingredients', () => {
    const recipes = [
      createRecipe({ 
        id: '1', 
        title: 'Grandma\'s Chocolate Cake',
        ingredients: [
          { original: 'flour', quantity: 2, unit: 'cup', ingredient: 'flour', notes: null },
          { original: 'cocoa', quantity: 1, unit: 'cup', ingredient: 'cocoa powder', notes: null },
          { original: 'sugar', quantity: 1, unit: 'cup', ingredient: 'sugar', notes: null },
          { original: 'eggs', quantity: 2, unit: null, ingredient: 'eggs', notes: null },
        ],
      }),
      createRecipe({ 
        id: '2', 
        title: 'Mom\'s Chocolate Cake',
        ingredients: [
          { original: 'flour', quantity: 2, unit: 'cup', ingredient: 'flour', notes: null },
          { original: 'cocoa', quantity: 1, unit: 'cup', ingredient: 'cocoa powder', notes: null },
          { original: 'sugar', quantity: 1, unit: 'cup', ingredient: 'sugar', notes: null },
          { original: 'eggs', quantity: 2, unit: null, ingredient: 'eggs', notes: null },
        ],
      }),
    ];

    const result = deduplicateRecipes(recipes);
    
    expect(result.duplicateGroups.length).toBe(1);
  });

  it('should select the most complete recipe as canonical', () => {
    const recipes = [
      createRecipe({ 
        id: '1', 
        title: 'Chocolate Cake',
        source_url: null,
        notes: null,
      }),
      createRecipe({ 
        id: '2', 
        title: 'Chocolate Cake',
        source_url: 'https://example.com/recipe',
        notes: 'A delicious cake recipe',
      }),
    ];

    const result = deduplicateRecipes(recipes);
    
    expect(result.duplicateGroups.length).toBe(1);
    expect(result.duplicateGroups[0].canonical_id).toBe('2');
  });

  it('should merge multiple duplicate groups', () => {
    const sharedIngredients = [
      { original: 'flour', quantity: 2, unit: 'cup', ingredient: 'flour', notes: null },
      { original: 'sugar', quantity: 1, unit: 'cup', ingredient: 'sugar', notes: null },
    ];

    const recipes = [
      createRecipe({ id: '1', title: 'Chocolate Cake', ingredients: sharedIngredients }),
      createRecipe({ id: '2', title: 'Chocolate Cake Recipe', ingredients: sharedIngredients }),
      createRecipe({ id: '3', title: 'Best Chocolate Cake', ingredients: sharedIngredients }),
    ];

    const result = deduplicateRecipes(recipes);
    
    expect(result.duplicateGroups.length).toBe(1);
    expect(result.duplicateGroups[0].recipes.length).toBe(3);
  });

  it('should update recipe duplicate_group_id', () => {
    const recipes = [
      createRecipe({ id: '1', title: 'Same Recipe' }),
      createRecipe({ id: '2', title: 'Same Recipe' }),
    ];

    const result = deduplicateRecipes(recipes);
    
    const recipe1 = result.recipes.find(r => r.id === '1');
    const recipe2 = result.recipes.find(r => r.id === '2');
    
    expect(recipe1?.duplicate_group_id).toBeDefined();
    expect(recipe1?.duplicate_group_id).toBe(recipe2?.duplicate_group_id);
  });
});

describe('getUniqueRecipes', () => {
  it('should return only canonical recipes from duplicate groups', () => {
    const recipes = [
      createRecipe({ id: '1', title: 'Chocolate Cake' }),
      createRecipe({ id: '2', title: 'Chocolate Cake', source_url: 'https://example.com' }),
      createRecipe({ id: '3', title: 'Chicken Dinner' }),
    ];

    const dedupeResult = deduplicateRecipes(recipes);
    const unique = getUniqueRecipes(dedupeResult);
    
    expect(unique.length).toBe(2);
    expect(unique.map(r => r.id)).toContain('3'); // Non-duplicate
    expect(unique.map(r => r.id)).toContain(dedupeResult.duplicateGroups[0].canonical_id);
  });

  it('should return all recipes when no duplicates', () => {
    const recipes = [
      createRecipe({ 
        id: '1', 
        title: 'Recipe A',
        ingredients: [
          { original: '1 cup apples', quantity: 1, unit: 'cup', ingredient: 'apples', notes: null },
        ],
      }),
      createRecipe({ 
        id: '2', 
        title: 'Recipe B',
        ingredients: [
          { original: '1 lb beef', quantity: 1, unit: 'lb', ingredient: 'beef', notes: null },
        ],
      }),
      createRecipe({ 
        id: '3', 
        title: 'Recipe C',
        ingredients: [
          { original: '1 cup carrots', quantity: 1, unit: 'cup', ingredient: 'carrots', notes: null },
        ],
      }),
    ];

    const dedupeResult = deduplicateRecipes(recipes);
    const unique = getUniqueRecipes(dedupeResult);
    
    expect(unique.length).toBe(3);
  });
});
