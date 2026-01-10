/**
 * Tests for Parsers
 */

import { describe, it, expect } from 'vitest';
import { htmlParser } from '../parsers/html-parser.js';
import { textParser } from '../parsers/text-parser.js';
import { mcbParser, jsonParser } from '../parsers/mcb-parser.js';

describe('HTML Parser', () => {
  it('should identify HTML files by extension', () => {
    expect(htmlParser.canParse('/path/to/recipe.html')).toBe(true);
    expect(htmlParser.canParse('/path/to/recipe.htm')).toBe(true);
    expect(htmlParser.canParse('/path/to/recipe.txt')).toBe(false);
  });

  it('should identify HTML content', () => {
    const content = Buffer.from('<!DOCTYPE html><html><body>Recipe</body></html>');
    expect(htmlParser.canParse('/path/to/file', content)).toBe(true);
  });

  it('should parse basic HTML recipe', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head><title>Test Recipe</title></head>
      <body>
        <h1 class="recipe-title">Chocolate Chip Cookies</h1>
        <div class="recipe-ingredients">
          <ul>
            <li>2 cups flour</li>
            <li>1 cup sugar</li>
            <li>1 cup chocolate chips</li>
          </ul>
        </div>
        <div class="recipe-directions">
          <p>Preheat oven to 350F.</p>
          <p>Mix dry ingredients.</p>
          <p>Bake for 12 minutes.</p>
        </div>
      </body>
      </html>
    `;
    
    const content = Buffer.from(html);
    const recipes = await htmlParser.parse('/test/recipe.html', content);
    
    expect(recipes.length).toBe(1);
    expect(recipes[0].title).toBe('Chocolate Chip Cookies');
    expect(recipes[0].ingredients.length).toBe(3);
    expect(recipes[0].instructions.length).toBeGreaterThan(0);
  });

  it('should parse schema.org JSON-LD recipe', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <script type="application/ld+json">
        {
          "@type": "Recipe",
          "name": "Banana Bread",
          "recipeIngredient": ["3 bananas", "2 cups flour", "1 cup sugar"],
          "recipeInstructions": ["Mash bananas", "Mix with flour and sugar", "Bake at 350F"]
        }
        </script>
      </head>
      <body></body>
      </html>
    `;
    
    const content = Buffer.from(html);
    const recipes = await htmlParser.parse('/test/recipe.html', content);
    
    expect(recipes.length).toBe(1);
    expect(recipes[0].title).toBe('Banana Bread');
    expect(recipes[0].ingredients.length).toBe(3);
    expect(recipes[0].instructions.length).toBe(3);
  });
});

describe('Text Parser', () => {
  it('should identify text files by extension', () => {
    expect(textParser.canParse('/path/to/recipe.txt')).toBe(true);
    expect(textParser.canParse('/path/to/recipe.html')).toBe(false);
  });

  it('should parse Paprika text format', async () => {
    const text = `
Chocolate Chip Cookies

Ingredients:
2 cups flour
1 cup sugar
1 cup chocolate chips
2 eggs

Directions:
Preheat oven to 350F.
Mix dry ingredients in a bowl.
Add wet ingredients.
Drop by spoonfuls onto baking sheet.
Bake for 12 minutes.

Source: Grandma's cookbook

Prep Time: 15 minutes
Cook Time: 12 minutes
Servings: 24 cookies
`;
    
    const content = Buffer.from(text);
    const recipes = await textParser.parse('/test/recipe.txt', content);
    
    expect(recipes.length).toBe(1);
    expect(recipes[0].title).toBe('Chocolate Chip Cookies');
    expect(recipes[0].ingredients.length).toBe(4);
    expect(recipes[0].instructions.length).toBe(5);
    expect(recipes[0].source).toBe("Grandma's cookbook");
    expect(recipes[0].prep_time).toBe('15 minutes');
    expect(recipes[0].cook_time).toBe('12 minutes');
    expect(recipes[0].servings).toBe('24 cookies');
  });

  it('should parse generic text recipe', async () => {
    const text = `
Pasta Carbonara

1 lb spaghetti
4 eggs
1 cup parmesan
8 oz pancetta
salt and pepper

Boil pasta in salted water.
Fry pancetta until crispy.
Mix eggs with parmesan.
Combine hot pasta with egg mixture.
Add pancetta and serve.
`;
    
    const content = Buffer.from(text);
    const recipes = await textParser.parse('/test/recipe.txt', content);
    
    expect(recipes.length).toBe(1);
    expect(recipes[0].title).toBe('Pasta Carbonara');
    expect(recipes[0].ingredients.length).toBeGreaterThan(0);
    expect(recipes[0].instructions.length).toBeGreaterThan(0);
  });
});

describe('JSON Parser', () => {
  it('should identify JSON files by extension', () => {
    expect(jsonParser.canParse('/path/to/recipe.json')).toBe(true);
    expect(jsonParser.canParse('/path/to/recipe.txt')).toBe(false);
  });

  it('should parse JSON recipe', async () => {
    const json = {
      name: 'Test Recipe',
      ingredients: ['1 cup flour', '2 eggs'],
      directions: ['Mix', 'Bake'],
      servings: '4',
      prep_time: '10 min',
      cook_time: '30 min',
      source: 'Test Kitchen',
    };
    
    const content = Buffer.from(JSON.stringify(json));
    const recipes = await jsonParser.parse('/test/recipe.json', content);
    
    expect(recipes.length).toBe(1);
    expect(recipes[0].title).toBe('Test Recipe');
    expect(recipes[0].ingredients.length).toBe(2);
    expect(recipes[0].instructions.length).toBe(2);
  });

  it('should parse array of recipes', async () => {
    const json = [
      { name: 'Recipe 1', ingredients: ['a'], directions: ['b'] },
      { name: 'Recipe 2', ingredients: ['c'], directions: ['d'] },
    ];
    
    const content = Buffer.from(JSON.stringify(json));
    const recipes = await jsonParser.parse('/test/recipes.json', content);
    
    expect(recipes.length).toBe(2);
    expect(recipes[0].title).toBe('Recipe 1');
    expect(recipes[1].title).toBe('Recipe 2');
  });
});

describe('MCB Parser', () => {
  it('should identify Paprika recipe files by extension', () => {
    expect(mcbParser.canParse('/path/to/recipe.paprikarecipe')).toBe(true);
    expect(mcbParser.canParse('/path/to/recipes.paprikarecipes')).toBe(true);
    expect(mcbParser.canParse('/path/to/recipe.mcb')).toBe(true);
    expect(mcbParser.canParse('/path/to/recipe.txt')).toBe(false);
  });

  it('should identify gzipped content by magic bytes', () => {
    const gzipMagic = Buffer.from([0x1f, 0x8b, 0x08, 0x00]);
    expect(mcbParser.canParse('/path/to/file', gzipMagic)).toBe(true);
  });

  it('should identify ZIP content by magic bytes', () => {
    const zipMagic = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    expect(mcbParser.canParse('/path/to/file', zipMagic)).toBe(true);
  });
});
