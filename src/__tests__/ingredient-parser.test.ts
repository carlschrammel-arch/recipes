/**
 * Tests for Ingredient Parser
 */

import { describe, it, expect } from 'vitest';
import { parseIngredient, extractMainIngredient } from '../ingredient-parser.js';

describe('parseIngredient', () => {
  it('should parse simple ingredient with quantity and unit', () => {
    const result = parseIngredient('2 cups flour');
    expect(result.quantity).toBe(2);
    expect(result.unit).toBe('cup');
    expect(result.ingredient).toBe('flour');
  });

  it('should parse ingredient with fraction', () => {
    const result = parseIngredient('1/2 cup sugar');
    expect(result.quantity).toBe(0.5);
    expect(result.unit).toBe('cup');
    expect(result.ingredient).toBe('sugar');
  });

  it('should parse ingredient with unicode fraction', () => {
    const result = parseIngredient('½ cup butter');
    expect(result.quantity).toBe(0.5);
    expect(result.unit).toBe('cup');
    expect(result.ingredient).toBe('butter');
  });

  it('should parse ingredient with mixed number and fraction', () => {
    const result = parseIngredient('1 1/2 cups milk');
    expect(result.quantity).toBe(1.5);
    expect(result.unit).toBe('cup');
    expect(result.ingredient).toBe('milk');
  });

  it('should parse ingredient with tablespoon', () => {
    const result = parseIngredient('3 tablespoons olive oil');
    expect(result.quantity).toBe(3);
    expect(result.unit).toBe('tbsp');
    expect(result.ingredient).toBe('olive oil');
  });

  it('should parse ingredient with teaspoon abbreviation', () => {
    const result = parseIngredient('1 tsp salt');
    expect(result.quantity).toBe(1);
    expect(result.unit).toBe('tsp');
    expect(result.ingredient).toBe('salt');
  });

  it('should parse ingredient with notes in parentheses', () => {
    const result = parseIngredient('2 cups chicken broth (or vegetable broth)');
    expect(result.quantity).toBe(2);
    expect(result.unit).toBe('cup');
    expect(result.ingredient).toBe('chicken broth');
    expect(result.notes).toBe('or vegetable broth');
  });

  it('should parse ingredient with notes after comma', () => {
    const result = parseIngredient('1 lb chicken breast, sliced');
    expect(result.quantity).toBe(1);
    expect(result.unit).toBe('lb');
    expect(result.ingredient).toBe('chicken breast');
    expect(result.notes).toBe('sliced');
  });

  it('should parse ingredient without unit', () => {
    const result = parseIngredient('3 eggs');
    expect(result.quantity).toBe(3);
    expect(result.unit).toBeNull();
    expect(result.ingredient).toBe('eggs');
  });

  it('should parse ingredient with "of"', () => {
    const result = parseIngredient('1 cup of rice');
    expect(result.quantity).toBe(1);
    expect(result.unit).toBe('cup');
    expect(result.ingredient).toBe('rice');
  });

  it('should handle ingredient with no quantity', () => {
    const result = parseIngredient('salt and pepper to taste');
    expect(result.quantity).toBeNull();
    expect(result.ingredient).toBe('salt and pepper to taste');
  });

  it('should parse ingredient with ounces', () => {
    const result = parseIngredient('8 oz cream cheese');
    expect(result.quantity).toBe(8);
    expect(result.unit).toBe('oz');
    expect(result.ingredient).toBe('cream cheese');
  });

  it('should parse ingredient with grams', () => {
    const result = parseIngredient('250g pasta');
    expect(result.quantity).toBe(250);
    expect(result.unit).toBe('g');
    expect(result.ingredient).toBe('pasta');
  });

  it('should preserve original text', () => {
    const original = '2 cups all-purpose flour, sifted';
    const result = parseIngredient(original);
    expect(result.original).toBe(original);
  });
});

describe('extractMainIngredient', () => {
  it('should remove modifiers like "fresh"', () => {
    const ing = parseIngredient('2 cups fresh basil');
    const main = extractMainIngredient(ing);
    expect(main).toBe('basil');
  });

  it('should remove modifiers like "chopped"', () => {
    const ing = parseIngredient('1 cup chopped onion');
    const main = extractMainIngredient(ing);
    expect(main).toBe('onion');
  });

  it('should remove multiple modifiers', () => {
    const ing = parseIngredient('2 boneless skinless chicken breasts');
    const main = extractMainIngredient(ing);
    expect(main).toBe('chicken breasts');
  });
});
