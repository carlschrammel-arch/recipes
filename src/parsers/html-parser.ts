/**
 * HTML Parser - Parses Paprika HTML exports
 */

import { JSDOM } from 'jsdom';
import type { Parser, RawRecipe } from '../types.js';

export const htmlParser: Parser = {
  name: 'HTML Parser',
  extensions: ['.html', '.htm'],

  canParse(filePath: string, content?: Buffer): boolean {
    const ext = filePath.toLowerCase();
    if (ext.endsWith('.html') || ext.endsWith('.htm')) {
      return true;
    }
    
    // Check content for HTML markers
    if (content) {
      const text = content.toString('utf-8', 0, 500).toLowerCase();
      return text.includes('<!doctype html') || text.includes('<html');
    }
    
    return false;
  },

  async parse(filePath: string, content: Buffer): Promise<RawRecipe[]> {
    const html = content.toString('utf-8');
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const warnings: string[] = [];

    // Try to detect if this is a Paprika export or generic HTML
    const isPaprikaExport = detectPaprikaFormat(doc);

    if (isPaprikaExport) {
      return parsePaprikaHtml(doc, filePath, html, warnings);
    }

    // Try to parse as generic recipe HTML (schema.org, etc.)
    return parseGenericHtml(doc, filePath, html, warnings);
  },
};

function detectPaprikaFormat(doc: Document): boolean {
  // Paprika exports have specific structure: .recipe container with .infobox, .ingredients, .directions
  // They also use schema.org microdata with itemprop attributes
  
  // Check for Paprika HTML export structure
  const paprikaIndicators = [
    '.recipe .infobox',
    '.recipe .ingredientsbox',
    '.recipe .directionsbox',
    '.recipe h1.name',
    '.recipe [itemprop="name"]',
    '.ingredients.text',
    '.directions.text',
  ];

  for (const selector of paprikaIndicators) {
    if (doc.querySelector(selector)) {
      return true;
    }
  }

  // Check for schema.org Recipe microdata (common in Paprika exports)
  if (doc.querySelector('[itemtype*="schema.org/Recipe"]')) {
    return true;
  }

  // Check for Paprika-specific structure: ingredients with itemprop in a specific container
  const hasIngredients = doc.querySelectorAll('[itemprop="recipeIngredient"]').length > 0;
  const hasDirections = doc.querySelector('.directions') !== null;
  if (hasIngredients && hasDirections) {
    return true;
  }

  // Legacy checks
  const html = doc.documentElement.outerHTML.toLowerCase();
  if (html.includes('paprika') || html.includes('recipe manager')) {
    return true;
  }

  return false;
}

function parsePaprikaHtml(doc: Document, filePath: string, rawHtml: string, warnings: string[]): RawRecipe[] {
  const recipes: RawRecipe[] = [];

  // Extract title - Paprika uses h1.name or [itemprop="name"]
  const title = extractText(doc, [
    'h1.name',
    'h1[itemprop="name"]',
    '[itemprop="name"]',
    '.recipe-title',
    'h1.title',
    'h1',
    '.name',
  ]);

  if (!title) {
    warnings.push('Could not extract recipe title');
    return [{
      title: 'Unknown Recipe',
      ingredients: [],
      instructions: [],
      source_file: filePath,
      source_format: 'html',
      raw_text: rawHtml,
      parse_warnings: ['Could not parse recipe structure'],
    }];
  }

  // Extract ingredients - Paprika uses [itemprop="recipeIngredient"] or .ingredients p.line
  const ingredients = extractListItems(doc, [
    '[itemprop="recipeIngredient"]',
    '.ingredients .line',
    '.ingredients p',
    '.ingredientsbox p',
    '.recipe-ingredients li',
    '.ingredients li',
    '.ingredient',
  ]);

  // Extract instructions - Paprika uses .directions p.line or [itemprop="recipeInstructions"]
  const instructions = extractInstructions(doc, [
    '.directions .line',
    '.directions p',
    '[itemprop="recipeInstructions"] .line',
    '[itemprop="recipeInstructions"] p',
    '.directionsbox p',
    '.recipe-directions li',
    '.recipe-directions p',
    '.instruction',
    '.step',
  ]);

  // Extract source/URL  
  const sourceUrl = extractAttribute(doc, [
    '.source a',
    '.recipe-source a',
    'a[itemprop="url"]',
    '.metadata a',
  ], 'href');

  const source = extractText(doc, [
    '.source',
    '.recipe-source',
    '[itemprop="author"]',
  ]) || extractSourceFromUrl(sourceUrl);

  // Extract servings
  const servings = extractText(doc, [
    '[itemprop="recipeYield"]',
    '.recipe-yield',
    '.yield',
    '.servings',
  ]);

  // Extract times
  const prepTime = extractText(doc, [
    '[itemprop="prepTime"]',
    '.recipe-prep-time',
    '.prep-time',
  ]);

  const cookTime = extractText(doc, [
    '[itemprop="cookTime"]',
    '.recipe-cook-time',
    '.cook-time',
  ]);

  const totalTime = extractText(doc, [
    '[itemprop="totalTime"]',
    '.recipe-total-time',
    '.total-time',
  ]);

  // Extract notes
  const notes = extractText(doc, [
    '.notes .text',
    '.notesbox .text',
    '.recipe-notes',
    '.notes',
    '[itemprop="description"]',
  ]);

  // Extract categories - Paprika uses [itemprop="recipeCategory"]
  const categoriesText = extractText(doc, [
    '[itemprop="recipeCategory"]',
    '.categories',
    '.recipe-categories',
  ]);
  const categories = categoriesText 
    ? categoriesText.split(/[,\n]+/).map(c => c.trim()).filter(Boolean)
    : [];

  // Extract nutrition
  const nutrition = extractText(doc, [
    '[itemprop="nutrition"]',
    '.nutrition .text',
    '.nutritionbox .text',
    '.recipe-nutrition',
    '.nutrition',
  ]);

  recipes.push({
    title,
    source,
    source_url: sourceUrl,
    servings,
    prep_time: prepTime,
    cook_time: cookTime,
    total_time: totalTime,
    ingredients,
    instructions,
    categories,
    notes,
    nutrition,
    source_file: filePath,
    source_format: 'html',
    parse_warnings: warnings,
  });

  return recipes;
}

/**
 * Extract source name from URL
 */
function extractSourceFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

function parseGenericHtml(doc: Document, filePath: string, rawHtml: string, warnings: string[]): RawRecipe[] {
  // Try to find JSON-LD schema.org recipe data
  const jsonLdScripts = doc.querySelectorAll('script[type="application/ld+json"]');
  
  for (const script of jsonLdScripts) {
    try {
      const data = JSON.parse(script.textContent || '');
      const recipe = findRecipeInJsonLd(data);
      if (recipe) {
        return [parseSchemaOrgRecipe(recipe, filePath, warnings)];
      }
    } catch {
      // Continue to next script
    }
  }

  // Fall back to heuristic parsing
  const title = extractText(doc, ['h1', 'h2', '.title', '.recipe-name']) || 'Unknown Recipe';
  
  // Try to find ingredients and instructions from common patterns
  const ingredients = extractListItems(doc, [
    'ul li',
    '.ingredients li',
  ]).filter(i => looksLikeIngredient(i));

  const instructions = extractInstructions(doc, [
    'ol li',
    '.instructions li',
    '.directions li',
    'p',
  ]).filter(i => looksLikeInstruction(i));

  if (ingredients.length === 0 && instructions.length === 0) {
    warnings.push('Could not extract structured recipe data');
  }

  return [{
    title,
    ingredients,
    instructions,
    source_file: filePath,
    source_format: 'html',
    raw_text: rawHtml,
    parse_warnings: warnings,
  }];
}

function findRecipeInJsonLd(data: unknown): Record<string, unknown> | null {
  if (!data) return null;

  if (Array.isArray(data)) {
    for (const item of data) {
      const result = findRecipeInJsonLd(item);
      if (result) return result;
    }
    return null;
  }

  if (typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (obj['@type'] === 'Recipe' || obj['@type']?.toString().includes('Recipe')) {
      return obj;
    }
    if (obj['@graph'] && Array.isArray(obj['@graph'])) {
      return findRecipeInJsonLd(obj['@graph']);
    }
  }

  return null;
}

function parseSchemaOrgRecipe(data: Record<string, unknown>, filePath: string, warnings: string[]): RawRecipe {
  const getString = (key: string): string | undefined => {
    const val = data[key];
    return typeof val === 'string' ? val : undefined;
  };

  const getArray = (key: string): string[] => {
    const val = data[key];
    if (Array.isArray(val)) {
      return val.map(v => typeof v === 'string' ? v : v?.text || String(v));
    }
    if (typeof val === 'string') {
      return val.split('\n').filter(Boolean);
    }
    return [];
  };

  return {
    title: getString('name') || 'Unknown Recipe',
    source: getString('author') || (data.author as Record<string, unknown>)?.name as string,
    source_url: getString('url'),
    servings: getString('recipeYield'),
    prep_time: getString('prepTime'),
    cook_time: getString('cookTime'),
    total_time: getString('totalTime'),
    ingredients: getArray('recipeIngredient'),
    instructions: getArray('recipeInstructions'),
    categories: getArray('recipeCategory'),
    notes: getString('description'),
    source_file: filePath,
    source_format: 'html',
    parse_warnings: warnings,
  };
}

// Helper functions

function extractText(doc: Document, selectors: string[]): string | undefined {
  for (const selector of selectors) {
    const el = doc.querySelector(selector);
    if (el?.textContent?.trim()) {
      return el.textContent.trim();
    }
  }
  return undefined;
}

function extractAttribute(doc: Document, selectors: string[], attr: string): string | undefined {
  for (const selector of selectors) {
    const el = doc.querySelector(selector);
    if (el?.getAttribute(attr)) {
      return el.getAttribute(attr) || undefined;
    }
  }
  return undefined;
}

function extractListItems(doc: Document, selectors: string[]): string[] {
  const items: string[] = [];
  
  for (const selector of selectors) {
    const els = doc.querySelectorAll(selector);
    if (els.length > 0) {
      els.forEach(el => {
        const text = el.textContent?.trim();
        if (text) {
          items.push(text);
        }
      });
      if (items.length > 0) break;
    }
  }
  
  return items;
}

function extractInstructions(doc: Document, selectors: string[]): string[] {
  const items = extractListItems(doc, selectors);
  
  // Clean up and split by newlines if needed
  const cleaned: string[] = [];
  for (const item of items) {
    const lines = item.split(/\n+/).map(l => l.trim()).filter(Boolean);
    cleaned.push(...lines);
  }
  
  return cleaned;
}

function looksLikeIngredient(text: string): boolean {
  // Simple heuristic: contains a number or common measurement words
  const lower = text.toLowerCase();
  return /\d/.test(text) || 
    /\b(cup|tbsp|tsp|oz|lb|pound|ounce|gram|kg|ml|liter|teaspoon|tablespoon|pinch|dash)\b/.test(lower) ||
    /\b(salt|pepper|oil|butter|flour|sugar|egg|milk|water|chicken|beef|onion|garlic)\b/.test(lower);
}

function looksLikeInstruction(text: string): boolean {
  // Simple heuristic: starts with action verb or has cooking keywords
  const lower = text.toLowerCase();
  const actionVerbs = ['add', 'mix', 'stir', 'cook', 'bake', 'heat', 'combine', 'whisk', 'pour', 'slice', 'chop', 'dice', 'preheat', 'let', 'place', 'remove', 'serve', 'season', 'set', 'bring'];
  
  return actionVerbs.some(v => lower.startsWith(v) || lower.includes(` ${v} `)) ||
    /\b(minutes?|hours?|degrees?|oven|pan|pot|bowl|until|medium|high|low)\b/.test(lower);
}
