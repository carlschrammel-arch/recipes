/**
 * Tests for Normalizer
 */

import { describe, it, expect } from 'vitest';
import { normalizeRecipe } from '../normalizer.js';
import type { RawRecipe } from '../types.js';

function createRawRecipe(overrides: Partial<RawRecipe> = {}): RawRecipe {
  return {
    title: 'Test Recipe',
    ingredients: ['1 cup flour', '2 eggs'],
    instructions: ['Mix ingredients', 'Bake at 350F for 30 minutes'],
    source_file: '/test/recipe.txt',
    source_format: 'txt',
    parse_warnings: [],
    ...overrides,
  };
}

describe('normalizeRecipe', () => {
  describe('basic normalization', () => {
    it('should generate a stable ID', () => {
      const raw = createRawRecipe({ title: 'Chocolate Cake' });
      const result = normalizeRecipe(raw);
      
      expect(result.id).toBeDefined();
      expect(result.id.length).toBe(16);
      
      // Same input should produce same ID
      const result2 = normalizeRecipe(raw);
      expect(result2.id).toBe(result.id);
    });

    it('should clean title', () => {
      const raw = createRawRecipe({ title: 'Recipe: My Great Dish' });
      const result = normalizeRecipe(raw);
      expect(result.title).toBe('My Great Dish');
    });

    it('should parse ingredients', () => {
      const raw = createRawRecipe({ 
        ingredients: ['2 cups flour', '1/2 tsp salt'] 
      });
      const result = normalizeRecipe(raw);
      
      expect(result.ingredients.length).toBe(2);
      expect(result.ingredients[0].quantity).toBe(2);
      expect(result.ingredients[0].unit).toBe('cup');
      expect(result.ingredients[0].ingredient).toBe('flour');
    });
  });

  describe('time parsing', () => {
    it('should parse prep time in minutes', () => {
      const raw = createRawRecipe({ prep_time: '15 minutes' });
      const result = normalizeRecipe(raw);
      expect(result.prep_time_minutes).toBe(15);
    });

    it('should parse cook time in hours and minutes', () => {
      const raw = createRawRecipe({ cook_time: '1 hour 30 minutes' });
      const result = normalizeRecipe(raw);
      expect(result.cook_time_minutes).toBe(90);
    });

    it('should calculate total time from prep + cook', () => {
      const raw = createRawRecipe({ 
        prep_time: '15 min',
        cook_time: '30 min',
      });
      const result = normalizeRecipe(raw);
      expect(result.total_time_minutes).toBe(45);
    });

    it('should parse ISO 8601 duration', () => {
      const raw = createRawRecipe({ total_time: 'PT1H30M' });
      const result = normalizeRecipe(raw);
      expect(result.total_time_minutes).toBe(90);
    });
  });

  describe('servings parsing', () => {
    it('should parse simple servings', () => {
      const raw = createRawRecipe({ servings: '4' });
      const result = normalizeRecipe(raw);
      expect(result.yield_servings).toBe(4);
    });

    it('should parse "serves X" format', () => {
      const raw = createRawRecipe({ servings: 'Serves 6' });
      const result = normalizeRecipe(raw);
      expect(result.yield_servings).toBe(6);
    });

    it('should parse range and return average', () => {
      const raw = createRawRecipe({ servings: '4-6 servings' });
      const result = normalizeRecipe(raw);
      expect(result.yield_servings).toBe(5);
    });
  });

  describe('meal type derivation', () => {
    it('should identify breakfast recipes', () => {
      const raw = createRawRecipe({ title: 'Fluffy Pancakes' });
      const result = normalizeRecipe(raw);
      expect(result.meal_type).toBe('breakfast');
    });

    it('should identify dessert recipes', () => {
      const raw = createRawRecipe({ title: 'Chocolate Chip Cookies' });
      const result = normalizeRecipe(raw);
      expect(result.meal_type).toBe('dessert');
    });

    it('should default to dinner', () => {
      const raw = createRawRecipe({ title: 'Chicken Stir Fry' });
      const result = normalizeRecipe(raw);
      expect(result.meal_type).toBe('dinner');
    });
  });

  describe('protein derivation', () => {
    it('should identify chicken', () => {
      const raw = createRawRecipe({ 
        ingredients: ['2 chicken breasts', '1 cup rice'] 
      });
      const result = normalizeRecipe(raw);
      expect(result.primary_protein).toBe('chicken');
    });

    it('should identify beef', () => {
      const raw = createRawRecipe({ 
        ingredients: ['1 lb ground beef', '1 onion'] 
      });
      const result = normalizeRecipe(raw);
      expect(result.primary_protein).toBe('beef');
    });

    it('should identify fish', () => {
      const raw = createRawRecipe({ 
        ingredients: ['2 salmon fillets', 'lemon juice'] 
      });
      const result = normalizeRecipe(raw);
      expect(result.primary_protein).toBe('fish');
    });

    it('should return other for no protein', () => {
      const raw = createRawRecipe({ 
        ingredients: ['2 cups flour', '1 cup sugar'] 
      });
      const result = normalizeRecipe(raw);
      expect(result.primary_protein).toBe('other');
    });
  });

  describe('equipment derivation', () => {
    it('should identify oven', () => {
      const raw = createRawRecipe({ 
        instructions: ['Preheat oven to 375F', 'Bake for 20 minutes'] 
      });
      const result = normalizeRecipe(raw);
      expect(result.equipment).toContain('oven');
    });

    it('should identify slow cooker', () => {
      const raw = createRawRecipe({ 
        instructions: ['Add all ingredients to slow cooker', 'Cook on low for 8 hours'] 
      });
      const result = normalizeRecipe(raw);
      expect(result.equipment).toContain('slow_cooker');
    });

    it('should identify instant pot', () => {
      const raw = createRawRecipe({ 
        instructions: ['Set Instant Pot to pressure cook', 'Cook for 15 minutes'] 
      });
      const result = normalizeRecipe(raw);
      expect(result.equipment).toContain('instant_pot');
    });

    it('should identify air fryer', () => {
      const raw = createRawRecipe({ 
        instructions: ['Place in air fryer at 400F', 'Cook for 12 minutes'] 
      });
      const result = normalizeRecipe(raw);
      expect(result.equipment).toContain('air_fryer');
    });
  });

  describe('spice level derivation', () => {
    it('should rate mild for no spicy ingredients', () => {
      const raw = createRawRecipe({ 
        ingredients: ['chicken', 'salt', 'pepper'] 
      });
      const result = normalizeRecipe(raw);
      expect(result.spice_level).toBe(0);
    });

    it('should rate medium for jalapeño', () => {
      const raw = createRawRecipe({ 
        ingredients: ['chicken', '2 jalapeños, diced'] 
      });
      const result = normalizeRecipe(raw);
      expect(result.spice_level).toBe(2);
    });

    it('should rate very hot for ghost pepper', () => {
      const raw = createRawRecipe({ 
        ingredients: ['chicken', '1 ghost pepper'] 
      });
      const result = normalizeRecipe(raw);
      expect(result.spice_level).toBe(3);
    });
  });

  describe('kid-friendly score', () => {
    it('should score high for pasta', () => {
      const raw = createRawRecipe({ 
        title: 'Mac and Cheese',
        ingredients: ['pasta', 'cheese', 'butter'],
      });
      const result = normalizeRecipe(raw);
      expect(result.kid_friendly_score).toBeGreaterThan(0.5);
    });

    it('should score low for spicy dishes', () => {
      const raw = createRawRecipe({ 
        title: 'Spicy Thai Curry',
        ingredients: ['chicken', 'ghost pepper', 'sriracha'],
      });
      const result = normalizeRecipe(raw);
      expect(result.kid_friendly_score).toBeLessThan(0.5);
    });
  });

  describe('weeknight score', () => {
    it('should score high for quick recipes', () => {
      const raw = createRawRecipe({ 
        total_time: '20 minutes',
        ingredients: ['chicken', 'salt', 'oil'],
      });
      const result = normalizeRecipe(raw);
      expect(result.weeknight_score).toBeGreaterThan(0.6);
    });

    it('should score low for long recipes', () => {
      const raw = createRawRecipe({ 
        total_time: '3 hours',
        ingredients: Array(20).fill('ingredient'),
      });
      const result = normalizeRecipe(raw);
      expect(result.weeknight_score).toBeLessThan(0.5);
    });
  });

  describe('cost tier derivation', () => {
    it('should identify high cost for seafood', () => {
      const raw = createRawRecipe({ 
        ingredients: ['2 lobster tails', 'butter'] 
      });
      const result = normalizeRecipe(raw);
      expect(result.cost_tier).toBe('high');
    });

    it('should identify low cost for budget ingredients', () => {
      const raw = createRawRecipe({ 
        ingredients: ['rice', 'canned beans', 'chicken thighs'] 
      });
      const result = normalizeRecipe(raw);
      expect(result.cost_tier).toBe('low');
    });
  });

  describe('cuisine derivation', () => {
    it('should identify Italian cuisine', () => {
      const raw = createRawRecipe({ 
        title: 'Spaghetti Carbonara',
        ingredients: ['pasta', 'pancetta', 'parmesan'],
      });
      const result = normalizeRecipe(raw);
      expect(result.cuisine).toBe('Italian');
    });

    it('should identify Mexican cuisine', () => {
      const raw = createRawRecipe({ 
        title: 'Chicken Tacos',
        categories: ['mexican'],
      });
      const result = normalizeRecipe(raw);
      expect(result.cuisine).toBe('Mexican');
    });
  });
});
