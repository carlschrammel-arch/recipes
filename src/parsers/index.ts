/**
 * Parser Registry - Manages all recipe parsers
 */

import type { Parser, RawRecipe } from '../types.js';
import { htmlParser } from './html-parser.js';
import { textParser } from './text-parser.js';
import { mcbParser, jsonParser } from './mcb-parser.js';
import type { ScannedFile } from '../scanner.js';

// Register all parsers in order of preference
const parsers: Parser[] = [
  mcbParser,   // Most specific - Paprika native format
  jsonParser,  // Direct JSON
  htmlParser,  // HTML exports
  textParser,  // Plain text fallback
];

/**
 * Parse a scanned file using the appropriate parser
 */
export async function parseFile(file: ScannedFile): Promise<RawRecipe[]> {
  // Find the first parser that can handle this file
  for (const parser of parsers) {
    if (parser.canParse(file.path, file.content)) {
      try {
        const recipes = await parser.parse(file.path, file.content);
        return recipes;
      } catch (err) {
        // Try next parser
        continue;
      }
    }
  }

  // No parser could handle the file
  return [{
    title: `Unparsed: ${file.name}`,
    ingredients: [],
    instructions: [],
    source_file: file.path,
    source_format: 'unknown',
    raw_text: file.content.toString('utf-8', 0, 2000),
    parse_warnings: ['No parser could handle this file format'],
  }];
}

/**
 * Get parser by name
 */
export function getParser(name: string): Parser | undefined {
  return parsers.find(p => p.name.toLowerCase().includes(name.toLowerCase()));
}

/**
 * Get all registered parsers
 */
export function getAllParsers(): Parser[] {
  return [...parsers];
}

export { htmlParser, textParser, mcbParser, jsonParser };
