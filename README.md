# Recipe Context Builder

A local, offline-first tool that consolidates Paprika 3 recipe exports into a normalized dataset and generates ChatGPT-friendly context files for weekly meal planning.

## Features

- 📥 **Import recipes** from Paprika 3 exports (HTML, TXT, JSON, .paprikarecipe files)
- 🔄 **Normalize** recipes into a consistent schema with derived metadata
- 🔍 **Deduplicate** near-identical recipes using title and ingredient similarity
- 📊 **Generate** ChatGPT-compatible context files for meal planning
- 🏷️ **Auto-tag** recipes with meal type, protein, cuisine, and more
- ⚡ **Score** recipes for weeknight-friendliness and kid appeal
- 🔎 **Search** your recipe collection from the command line

## Quick Start

### Installation

```bash
# Clone or download this project
cd recipe-context-builder

# Install dependencies
npm install

# Build the project
npm run build

# Make CLI available globally (optional)
npm link
```

### Basic Usage

```bash
# Build context from your recipe folder
recipe-context build -i "/path/to/recipes" -o "./output"

# Or use npm run dev for development
npm run dev -- build -i "./fixtures/sample-recipes" -o "./output"
```

### Find Your iCloud Paprika Exports

Paprika exports are typically saved to iCloud Drive. The path on macOS is:

```
~/Library/Mobile Documents/com~apple~CloudDocs/
```

Look for folders named like:
```
Export 2025-11-12 22.30.23 Todo
```

Full example:
```bash
recipe-context build \
  -i "~/Library/Mobile Documents/com~apple~CloudDocs/Export 2025-11-12 22.30.23 Todo" \
  -o "./dist/recipe-context"
```

## Commands

### `build` - Import and Process Recipes

```bash
recipe-context build --input <path> --output <path> [options]

Options:
  -i, --input <path>       Input folder containing recipe exports (required)
  -o, --output <path>      Output folder for generated files (default: ./dist/recipe-context)
  -c, --config <path>      Path to config file (YAML or JSON)
  --max-chars <number>     Maximum characters in context file (default: 200000)
  --max-recipes <number>   Maximum recipes in context catalog
  -f, --format <type>      Output format: markdown, jsonl, or both (default: both)
  -v, --verbose            Show verbose output
```

### `search` - Search Your Recipes

```bash
recipe-context search [options]

Options:
  -q, --query <text>       Search query (matches title, ingredients, tags)
  -t, --tags <tags>        Filter by tags (comma-separated)
  -m, --meal-type <type>   Filter by meal type (breakfast/lunch/dinner/snack/dessert)
  -p, --protein <type>     Filter by primary protein (chicken/beef/pork/fish/etc.)
  --max-time <minutes>     Maximum total time in minutes
  --weeknight              Show only weeknight-friendly (score > 0.6)
  --kid-friendly           Show only kid-friendly (score > 0.6)
  -l, --limit <number>     Maximum results to show (default: 20)
  -d, --data <path>        Path to recipe data folder (default: ./dist/recipe-context)
```

Examples:
```bash
# Search for chicken recipes under 30 minutes
recipe-context search -q "chicken" --max-time 30

# Find weeknight-friendly pasta dishes
recipe-context search -q "pasta" --weeknight

# Search by tags
recipe-context search -t "italian,quick"
```

### `stats` - View Collection Statistics

```bash
recipe-context stats [-d, --data <path>]
```

### `init` - Create Sample Config File

```bash
recipe-context init [-o, --output <path>]
```

### `info` - Show Helpful Information

```bash
recipe-context info
```

### `validate` - Validate Output Quality

```bash
recipe-context validate [-o, --output <path>]
```

Runs quality checks on the generated output to ensure it's ready for ChatGPT Plus:
- Minimum recipe count
- Ingredient and instruction coverage
- Parse error rate
- Context file size limits
- Determinism check (consistent ordering)

## Output Files

After running `build`, you'll find these files in your output folder:

| File | Description |
|------|-------------|
| `recipes.normalized.jsonl` | All recipes in JSONL format (one per line) |
| `recipes.index.json` | Searchable index with tag counts and statistics |
| `context.project.md` | Main ChatGPT project context document |
| `prompt.examples.md` | Example prompts for ChatGPT including weekly meal planning |
| `recipes/` | Individual recipe markdown files |
| `report.md` | Import report with stats, duplicates, and errors |

### Using with ChatGPT

1. Open your ChatGPT Project settings
2. Paste the contents of `context.project.md` as your project context
3. For larger collections, reference `recipes.normalized.jsonl` for retrieval

The context file includes:
- Recipe catalog index table
- Tag glossary with counts
- Weeknight Winners (top 50 quick recipes)
- Kid-Friendly Picks (top 50)
- Recipes grouped by protein

## Configuration

Create a config file to customize behavior:

```bash
recipe-context init -o config.yaml
```

### Sample Config (config.yaml)

```yaml
# Dietary preferences - used for tagging and filtering
dietary_preferences:
  high_protein: false
  low_fat: false
  vegetarian: false

# Household preferences
household_notes:
  kid_friendly: true          # Prioritize kid-friendly recipes
  spice_tolerance: medium     # mild | medium | hot | very_hot
  num_servings: 4             # Default serving size

# Ingredients to exclude/avoid
excluded_ingredients:
  - shellfish
  - peanuts

# Use HelloFresh-style ingredient formatting (quantity first)
hellofresh_format: true

# Context generation settings
max_recipes_in_context: 500   # Maximum recipes in context.project.md
max_chars: 200000             # Maximum characters in context file
```

Use with:
```bash
recipe-context build -i ./recipes -c config.yaml
```

## Normalized Recipe Schema

Each recipe is normalized to this schema:

```typescript
{
  id: string;                    // Stable hash from title+source+ingredients
  title: string;
  source_name: string | null;    // Website name or source
  source_url: string | null;
  yield_servings: number | null;
  prep_time_minutes: number | null;
  cook_time_minutes: number | null;
  total_time_minutes: number | null;
  ingredients: [{
    original: string;            // Original ingredient line
    quantity: number | null;
    unit: string | null;
    ingredient: string;
    notes: string | null;
  }];
  instructions: string[];
  tags: string[];
  notes: string | null;
  nutrition: {
    calories: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    sodium_mg: number | null;
  } | null;
  cuisine: string | null;        // Italian, Mexican, Chinese, etc.
  meal_type: string;             // breakfast | lunch | dinner | snack | dessert
  kid_friendly_score: number;    // 0-1 (higher = more kid-friendly)
  weeknight_score: number;       // 0-1 (higher = easier weeknight meal)
  spice_level: number;           // 0-3 (0=mild, 3=very hot)
  equipment: string[];           // oven, slow_cooker, air_fryer, etc.
  primary_protein: string;       // chicken, beef, fish, vegetarian, etc.
  cost_tier: string;             // low | medium | high
  duplicate_group_id: string | null;
  parse_warnings: string[];
}
```

## Derived Metadata Heuristics

The tool automatically derives useful metadata:

### Kid-Friendly Score (0-1)
- ✅ Bonus: pasta, mac & cheese, pizza, tacos, chicken nuggets
- ❌ Penalty: very spicy ingredients, exotic vegetables

### Weeknight Score (0-1)
- ✅ Bonus: <35 min total time, <10 ingredients, simple equipment
- ❌ Penalty: >60 min time, many ingredients, complex equipment

### Spice Level (0-3)
- 0: Mild (no spicy ingredients)
- 1: Medium (poblano, paprika)
- 2: Hot (jalapeño, cayenne, sriracha)
- 3: Very Hot (habanero, ghost pepper)

### Cost Tier
- Low: Budget proteins (eggs, chicken thighs, beans), pantry staples
- Medium: Standard ingredients
- High: Seafood, premium cuts, specialty ingredients

## Supported File Formats

| Format | Extensions | Notes |
|--------|------------|-------|
| Paprika Native | `.paprikarecipe`, `.paprikarecipes` | Gzipped JSON |
| HTML | `.html`, `.htm` | Paprika exports, schema.org |
| Plain Text | `.txt` | Paprika text exports |
| JSON | `.json` | Direct JSON recipes |
| Archives | `.mcb`, `.zip` | Compressed recipe collections |

## Development

### Project Structure

```
src/
├── cli.ts                 # Command-line interface
├── build.ts               # Main build orchestrator
├── scanner.ts             # File system scanner
├── parsers/
│   ├── index.ts           # Parser registry
│   ├── html-parser.ts     # HTML/DOM parsing
│   ├── text-parser.ts     # Plain text parsing
│   └── mcb-parser.ts      # Paprika/ZIP parsing
├── ingredient-parser.ts   # Ingredient line parsing
├── normalizer.ts          # Recipe normalization & heuristics
├── deduplicator.ts        # Duplicate detection
├── context-generator.ts   # Output generation
├── search.ts              # Search functionality
├── report-generator.ts    # Import report
├── config-loader.ts       # Configuration handling
└── types.ts               # TypeScript types
```

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run with coverage
npm run test:coverage
```

### Building

```bash
# Compile TypeScript
npm run build

# Development mode (uses tsx)
npm run dev -- build -i ./fixtures/sample-recipes
```

## Troubleshooting

### "No recipe files found"

- Make sure your input path is correct
- Check that files have supported extensions (.html, .txt, .paprikarecipe, etc.)
- Run `recipe-context info` to see the expected iCloud path

### "Path not accessible"

- On macOS, ensure the app has permissions to access iCloud Drive
- Try copying the export folder to a local directory first

### Parse errors

- Check `report.md` for detailed error information
- Recipes with parse errors are still included with warnings
- Unknown formats are stored with raw text in the notes field

### Large collections

- Use `--max-chars` to limit the context file size
- Use `--max-recipes` to limit recipes in the catalog
- Reference `recipes.normalized.jsonl` for full data

## Requirements

- Node.js 20+ 
- macOS (for Paprika/iCloud integration)
- Works offline - no cloud APIs required

## License

MIT
