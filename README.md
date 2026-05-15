# Recipe Context Builder

A local CLI tool that reads your Paprika 3 recipe library, normalises and deduplicates every recipe into a structured dataset, and lets you query your own collection in plain English using OpenAI — returning real recipes with real ingredients, not hallucinations.

```
recipe-context build           # import + normalise your Paprika export
recipe-context ask "..."       # natural-language search against your library
recipe-context plan "..."      # deterministic weekly meal plan (AI parses intent, not recipes)
recipe-context search -q "..." # offline keyword/tag/filter search

recipe-context plan "Choose 5 recipes that meet this criteria:
1 chicken
1 pork
1 beef
1 vegetarian or vegan
At least 2 meals are kid friendly
These macronutrients goals: Fat: 15% - 25%, Carbohydrates: 45% - 65%, Protein: 25% - 35%
Promotes weight loss
Higher in protein
Lower in fat
Easy and quick to make
Low to medium priced
Variety of flavors
Prefer having these ingredients but does not need to have any: Lentils, black beans, bison, clams, chicken breast, shrimp, crab, edamame, pork loin, tofu, sirloin steak, tuna, oats, and chickpeas.
Can freeze and reheat for meal prep
Has a low or no food waste when buying groceries for all recipes.  May be overlap of ingredients in recipes.
No or very low trans fats
At least some of the meals contain monounsaturated fats or omega-3 fats
Limited amount of saturated fats
At least one recipe from Hello Fresh
At least one that has pasta
One of the meals can be a comfort food" --verbose --auto-enrich

```

---

## Table of Contents

1. [How It Works](#how-it-works)
2. [Quick Start](#quick-start)
3. [Installation](#installation)
4. [Commands](#commands)
5. [The `ask` Command in Depth](#the-ask-command-in-depth)
6. [The `plan` Command in Depth](#the-plan-command-in-depth)
7. [The `build` Pipeline in Depth](#the-build-pipeline-in-depth)
8. [Normalized Recipe Schema](#normalized-recipe-schema)
9. [Derived Metadata Heuristics](#derived-metadata-heuristics)
10. [Supported File Formats](#supported-file-formats)
11. [Configuration](#configuration)
12. [Output Files](#output-files)
13. [Project Structure](#project-structure)
14. [Development](#development)
15. [Troubleshooting](#troubleshooting)

---

## Quick Start

```bash
# 1. Install dependencies and compile
git clone <this-repo>
cd recipes
npm install
npm run build

# 2. (Optional) make the CLI available globally
npm link

# 3. Import your Paprika recipes (auto-detects latest iCloud export)
recipe-context build
# or point at a specific file/folder:
recipe-context build -i "~/Library/Mobile Documents/com~apple~CloudDocs/Export 2025-11-12 22.30.23 Todo"

# 4. Set your OpenAI key
export OPENAI_API_KEY=sk-...

# 5. Natural-language recipe search
recipe-context ask "quick high-protein chicken dinner"

# 6. Weekly meal plan (AI parses your request; recipes chosen deterministically)
recipe-context plan "1 chicken, 1 beef, 1 pork, 1 vegetarian — high protein, kid friendly"

# 7. Offline keyword search (no API key needed)
recipe-context search -q "pasta" --weeknight --kid-friendly
```

> **No Paprika?** Point `build` at the `fixtures/sample-recipes` folder to try it with the bundled test data:
> ```bash
> npm run build   # compile TypeScript
> node dist/cli.js build -i ./fixtures/sample-recipes
> node dist/cli.js ask "something quick for dinner"
> ```

---

## How It Works

There are two distinct phases.

### Phase 1 — Build (one-time, run after any Paprika export)

```
Paprika export (.paprikarecipes / folder)
        │
        ▼
  [scanner] finds all recipe files
        │
        ▼
  [parsers] read each file into a raw recipe object
        │
        ▼
  [normalizer] derives metadata, generates a stable ID
        │
        ▼
  [deduplicator] groups near-identical recipes
        │
        ▼
  [context-generator] writes JSONL, index, markdown catalog
        │
        ▼
  dist/recipe-context/
    recipes.normalized.jsonl   ← full recipe data
    catalog.selection.jsonl    ← compact rows for AI
    recipes.index.json         ← searchable index
```

### Phase 2 — Ask (runs every query)

```
Your natural-language query
        │
        ▼
  [ask.ts] loads catalog.selection.jsonl + recipes.normalized.jsonl
        │
        ▼
  Recipes are classified into buckets:
    seafood / vegetarian / mexican / chicken / beef / pork / turkey / other
        │
        ▼
  Up to 140 recipes per bucket are sampled (shuffled for variety)
  and formatted as a compact pipe-delimited catalog, split into
  labeled sections:

    === CHICKEN RECIPES ===
    id|title|time|kcal|prot%|kid|spice|ing
    ...

    === SEAFOOD RECIPES ===
    id|title|time|kcal|prot%|kid|spice|ing
    ...
        │
        ▼
  Catalog + system prompt + your query → OpenAI (gpt-4o-mini)
        │
        ▼
  AI returns JSON: { summary, selections: [{ id, title, section, reason }] }
        │
        ▼
  [server-side validation] checks each returned ID belongs to
  the section the AI claimed it picked from
        │
        ▼
  IDs are looked up in recipes.normalized.jsonl for full details
  (title, time, ingredients, calories, tags, reason) are printed
```

**Why this design?**

The AI never sees full recipe text — that would cost far too many tokens across 2 000+ recipes. Instead each recipe becomes a single compact pipe-delimited line (~80 chars), with the top 6 ingredient names included. The ingredient names let the AI reason about calories and protein without seeing measurements or instructions.

The catalog is pre-sorted into labeled sections server-side, so the AI doesn't need to do its own ingredient-based category verification (which small models do poorly). It just picks the best row within each section it is handed.

**Token budget:**

- Context window: 128 000 tokens (gpt-4o-mini)
- Catalog budget: 380 000 chars ≈ 119 000 tokens (at ~3.2 chars/token for pipe-delimited text)
- Remaining for system prompt + query + response: ~9 000 tokens
- Typical query cost: **~$0.01** (63 000 prompt + 300 completion tokens at gpt-4o-mini pricing)

---

## Installation

**Requirements:** Node.js 20+, macOS (for Paprika iCloud auto-detection; manual `--input` works on any OS), OpenAI API key (only for `ask` and `plan`).

```bash
git clone <this-repo>
cd recipes

npm install          # install dependencies
npm run build        # compile TypeScript → dist/
npm link             # optional: adds recipe-context to your PATH
```

Verify it works:

```bash
node dist/cli.js --help
# or, after npm link:
recipe-context --help
```

---

## Commands

### `build` — Import and process recipes

```
recipe-context build [options]

  -i, --input <path>       Input folder or .paprikarecipes file
                           (auto-detects latest iCloud export if omitted)
  -o, --output <path>      Output folder (default: ./dist/recipe-context)
  -c, --config <path>      Config file path (YAML or JSON)
  --max-chars <number>     Maximum chars in context file (default: 200000)
  --max-recipes <number>   Maximum recipes in context catalog
  -f, --format <type>      markdown | jsonl | both (default: both)
  -v, --verbose            Verbose output
```

If `--input` is omitted the tool scans `~/Library/Mobile Documents/com~apple~CloudDocs/` for the most recent Paprika export folder automatically.

```bash
# Explicit path
recipe-context build -i "~/Library/Mobile Documents/com~apple~CloudDocs/Export 2025-11-12 22.30.23 Todo"

# Auto-detect from iCloud
recipe-context build

# Development mode against test fixtures
npm run dev -- build -i ./fixtures/sample-recipes -o ./dist/recipe-context
```

---

### `plan` — Weekly meal plan (requires OpenAI for query parsing)

```
recipe-context plan <query> [options]

  -d, --data <path>              Recipe data folder (default: ./dist/recipe-context)
  -k, --api-key <key>            OpenAI API key (falls back to OPENAI_API_KEY env var)
  -m, --model <model>            OpenAI model for query parsing (default: gpt-4o-mini)
  -v, --verbose                  Show score breakdowns and candidate counts
  --json                         Output full plan result as JSON
  --max-candidates <n>           Max candidates per slot for beam search (default: 75)
  --no-ai-parser                 Use offline regex parser only (no API call)
  --explain                      Ask AI to write a brief explanation of the selected plan
```

```bash
# Basic weekly plan
recipe-context plan "1 chicken, 1 pork, 1 beef, 1 vegetarian — high protein, kid friendly"

# With meal-prep goals and HelloFresh preference
recipe-context plan "weekly plan: freeze and reheat, at least one HelloFresh, one pasta dish" --verbose

# No internet required (offline regex parser)
recipe-context plan "4 dinners, prefer lentils and black beans" --no-ai-parser

# Output raw JSON for further processing
recipe-context plan "..." --json | jq '.selectedRecipes[].title'

# Add an AI explanation of why the plan was chosen
recipe-context plan "..." --explain
```

How it differs from `ask`:

| | `ask` | `plan` |
|---|---|---|
| AI role | Picks recipes from catalog | Parses your intent into constraints only |
| Recipe selection | AI | Deterministic TypeScript optimizer |
| Hallucination risk | Low (AI scans real rows) | None (all IDs validated post-selection) |
| Nutrition invented | Never | Never |
| Output | Recipe list | Meal plan + shopping overlap + alternatives |

---

### `ask` — Natural-language recipe search (requires OpenAI)

```
recipe-context ask <query> [options]

  -d, --data <path>        Recipe data folder (default: ./dist/recipe-context)
  --api-key <key>          OpenAI API key (falls back to OPENAI_API_KEY env var)
  --model <model>          OpenAI model (default: gpt-4o-mini)
  -v, --verbose            Show token counts, cost estimate, section breakdown
```

```bash
# Simple query
recipe-context ask "something quick for dinner tonight"

# Category + nutrition constraints
recipe-context ask "give me 5 recipes: all low calorie and high protein. one chicken, one mexican, one pork, one seafood, one vegetarian" --verbose

# Household preferences
recipe-context ask "a kid-friendly weeknight dinner under 30 minutes, no shellfish"
```

Set your API key once:

```bash
export OPENAI_API_KEY=sk-...
```

---

### `search` — Offline keyword/filter search

```
recipe-context search [options]

  -q, --query <text>       Full-text search (title, ingredients, tags)
  -t, --tags <tags>        Filter by tags (comma-separated)
  -m, --meal-type <type>   breakfast | lunch | dinner | snack | dessert
  -p, --protein <type>     chicken | beef | pork | fish | vegetarian | …
  --max-time <minutes>     Maximum total cook time
  --weeknight              Only weeknight-friendly recipes (score > 0.6)
  --kid-friendly           Only kid-friendly recipes (score > 0.6)
  -l, --limit <number>     Max results (default: 20)
  -d, --data <path>        Recipe data folder (default: ./dist/recipe-context)
```

No API key needed — runs entirely from the local JSONL index.

---

### `validate` — Check output quality

```bash
recipe-context validate [-o, --output <path>]
```

Runs sanity checks: minimum recipe count, ingredient coverage, parse error rate, context file size, and a determinism check (same input → same output ordering).

---

### `init` — Generate a sample config file

```bash
recipe-context init [-o, --output <path>]
```

---

### `info` — Print iCloud paths and environment info

```bash
recipe-context info
```

---

## The `plan` Command in Depth

The `plan` command is designed around one principle: **the AI is never the source of truth for recipe choices.**

### Pipeline

```
Your natural-language query
        │
        ▼
  [query-parser] AI (or offline regex) converts your query into
  a structured WeeklyPlanRequest:
    { mealCount, requiredProteinSlots, minKidFriendlyMeals,
      macroTargets, goals, preferredIngredients, … }

  No recipe IDs, titles, or nutrition values are in this output.
        │
        ▼
  [candidate-filter] Loads SelectionRecords from catalog.selection.jsonl.
  For each protein slot, filters to only recipes whose primary_protein
  matches (plus ingredient-level safety check for vegetarian/vegan).
        │
        ▼
  [scoring] Each candidate is scored against the WeeklyPlanRequest
  using only local data: macros, time, cost, kid-friendly score,
  preferred ingredients, freezer-friendliness, healthy fats, etc.
  Missing nutrition is noted — never guessed.
        │
        ▼
  [optimizer] Beam search (width 100) selects the best combination
  across all slots. Post-hoc enforcement of required singletons
  (e.g. "at least one HelloFresh", "at least one pasta dish").
  Shopping overlap and cuisine variety bonuses applied at plan level.
        │
        ▼
  [validation] Every selected ID is confirmed to exist in
  recipes.normalized.jsonl. Duplicate IDs, hallucinated titles,
  and unmet constraints are all flagged.
        │
        ▼
  [renderer] Markdown output: recipe cards, nutrition ("not available"
  when missing), shopping overlap, validation warnings, alternatives.
        │
        ▼
  [optional --explain] AI writes a natural-language explanation.
  Any recipe ID in the explanation that wasn't in the plan is discarded
  and the local renderer output is used instead.
```

### Query examples and what they parse to

```
"1 chicken, 1 pork, 1 beef, 1 vegetarian — at least 2 meals kid friendly,
 high protein, fat 20%-30%, prefer having garlic and olive oil, at least
 one HelloFresh, freeze and reheat friendly"
```

Parsed into:
```json
{
  "mealCount": 4,
  "requiredProteinSlots": ["chicken", "pork", "beef", "vegetarian"],
  "minKidFriendlyMeals": 2,
  "macroTargets": { "fatPct": { "minPct": 20, "maxPct": 30 } },
  "goals": { "highProtein": true, "freezerFriendly": true },
  "preferredIngredients": ["garlic", "olive oil"],
  "requiredSourceSignals": ["hellofresh"]
}
```

The AI (or offline parser) produces this JSON. The optimizer then does all recipe selection entirely from local data.

### Offline parser

`--no-ai-parser` skips the OpenAI call and uses a regex-based parser instead. It handles:
- `"1 chicken"` / `"one chicken"` → protein slots
- `"at least 2 meals kid friendly"` → `minKidFriendlyMeals: 2`
- `"fat 15%-25%"` → macro range
- `"HelloFresh"` → `requiredSourceSignals: ['hellofresh']`
- `"at least one pasta"` → `requiredTagsOrTitleTerms: ['pasta']`
- All goals (weight loss, high protein, low fat, freezer friendly, etc.)

### Typical cost

- Query parsing only: **~$0.001** (small structured output, 200–400 tokens)
- With `--explain`: **~$0.005** (additional 400–600 token completion)
- `--no-ai-parser`: **$0.00** (no API calls)

---

## The `ask` Command in Depth

### Catalog row format

Each recipe is encoded as a single pipe-delimited line:

```
a1b2c3d4e5f6a7b8|Chipotle Pork Tenderloin|35min|320kcal|38%prot|kid:High|spice:medium|ing:[pork tenderloins, chipotle chile powder, brown sugar, garlic powder, onion powder, salt]
```

| Column | Content |
|--------|---------|
| `id` | 16-hex-char stable hash |
| `title` | Recipe name |
| `time` | Total time in minutes |
| `kcal` | Calories per serving (blank if unknown) |
| `prot%` | Protein as % of total calories (blank if unknown) |
| `kid` | Kid-friendly bucket: High / Med / Low |
| `spice` | Spice level: mild / medium / hot / very_hot |
| `ing` | Top 6 ingredient names |

### Sectioned catalog

The catalog sent to OpenAI is pre-split into named sections:

```
=== SEAFOOD RECIPES ===
id|title|time|kcal|prot%|kid|spice|ing
<row>
<row>

=== VEGETARIAN RECIPES ===
id|title|time|kcal|prot%|kid|spice|ing
<row>
```

Pre-classifying server-side is what makes category constraints reliable. The system prompt tells the AI: "every row in a section already belongs to that category — pick from the section that matches each requested category". This avoids asking the model to do ingredient-based category reasoning across 1 000+ rows, which small models handle poorly.

### Bucket classification logic

Recipes are placed into exactly one bucket, evaluated in this priority order:

1. **seafood** — ingredient text matches any seafood term (shrimp, salmon, tuna, cod, tilapia, halibut, scallop, crab, lobster, etc.) OR `primary_protein` is `fish`/`seafood` OR tags include seafood/fish keywords
2. **vegetarian** — `is_vegetarian` flag OR protein is tofu/legumes/eggs/vegetarian AND no meat terms found in ingredient text
3. **mexican** — tags include `mexican` or `tex-mex`
4. **chicken / beef / pork / turkey** — `primary_protein` field (derived during normalisation)
5. **other** — everything else

Each bucket is shuffled independently before sampling, so repeated queries return different recipes.

### Stratified sampling

Rather than one global shuffle-and-truncate (which can drop all seafood recipes by chance), each bucket is capped at 140 recipes independently. This guarantees niche categories always appear in the catalog.

Total context sent: up to **1 120 recipes** across 8 sections (~190 KB, ~60 000 tokens).

### Explicit section mapping in the user message

Beyond the system prompt, the user message includes a mandatory section mapping that names the exact catalog section for each category word found in the query:

```
SECTION MAPPING (mandatory — pick from the named section for each category):
  chicken → use the CHICKEN RECIPES section
  mexican → use the MEXICAN RECIPES section
  pork → use the PORK RECIPES section
  seafood → use the SEAFOOD RECIPES section
  vegetarian → use the VEGETARIAN RECIPES section
```

### Server-side validation

After the AI responds, each returned ID is checked against the set of IDs in the section the AI claimed. Mismatches are printed to stderr:

```
Warning: AI picked "Some Recipe" (a1b2c3d4e5f6a7b8) for the seafood category
but that ID is not in the SEAFOOD RECIPES section.
```

### Stable recipe IDs

IDs are generated by SHA-256 hashing the normalised title + source URL + ingredient count + all ingredient names, then taking the first 16 hex characters (64 bits). The birthday-collision probability for a 2 300-recipe dataset is approximately 5 × 10⁻¹⁰.

Using all ingredients (not just first 5) in the hash means two recipes with the same title but different ingredients always get different IDs, preventing the display from showing the wrong recipe when the AI returns an ID.

---

## The `build` Pipeline in Depth

### 1. Scanning (`scanner.ts`)

Recursively walks the input path and collects files with recognised extensions. Also handles `.paprikarecipes` files (a ZIP archive of individual gzipped JSON blobs — Paprika's native export format). Auto-detection scans `~/Library/Mobile Documents/com~apple~CloudDocs/` for the newest folder matching Paprika's export naming convention.

### 2. Parsing (`parsers/`)

Each file extension has a dedicated parser:

| Parser | Formats |
|--------|---------|
| `mcb-parser.ts` | `.paprikarecipe`, `.paprikarecipes`, `.mcb` |
| `html-parser.ts` | `.html`, `.htm` (Paprika HTML export; schema.org `Recipe` markup) |
| `text-parser.ts` | `.txt` (Paprika text export format) |
| `index.ts` | `.json` (recipe objects or arrays) |

All parsers return a `RawRecipe` with the same fields: title, ingredients as raw strings, instructions as strings, servings, times, nutrition, categories, source URL, etc. Parse warnings are collected and surfaced in the build report.

### 3. Normalisation (`normalizer.ts`)

Converts each `RawRecipe` into a `NormalizedRecipe`:

- **Ingredient parsing** (`ingredient-parser.ts`) — splits raw lines like `"1½ cups all-purpose flour, sifted"` into `{ quantity: 1.5, unit: "cups", ingredient: "all-purpose flour", notes: "sifted" }` using regex patterns covering vulgar fractions, ranges, and common unit abbreviations
- **Time parsing** — handles `"30 minutes"`, `"1 hr 15 min"`, ISO 8601 `"PT45M"`, and bare integers
- **Servings parsing** — extracts numbers from strings like `"Serves 4"` or `"Makes 12 cookies"`
- **Heuristic metadata** — see [Derived Metadata Heuristics](#derived-metadata-heuristics)
- **ID generation** — SHA-256 of title + source + ingredient list → 16 hex chars

### 4. Deduplication (`deduplicator.ts`)

Compares recipes using a blocking strategy to avoid O(n²) comparisons across thousands of recipes.

**Blocking keys** (two recipes must share at least one to be compared against each other):
- Title prefix (first 2–3 significant words)
- Primary protein
- First significant ingredient word
- Exact normalised title hash (catches verbatim duplicates)

**Similarity scoring** within each block:
- Title similarity (Jaro-Winkler distance)
- Ingredient overlap (Jaccard similarity on normalised ingredient tokens)
- Combined weighted score

Pairs above the threshold (default combined score 0.65) are grouped. The canonical recipe (longest ingredient list) is kept active; others get `duplicate_group_id` set and are excluded from the AI catalog.

### 5. Output generation (`context-generator.ts`)

Writes all output files to the output folder:

- `recipes.normalized.jsonl` — one JSON object per line, every recipe
- `catalog.selection.jsonl` — pre-computed compact fields (calories, protein %, kid bucket, spice label, etc.) used by `ask`
- `recipes.index.json` — tag/protein/cuisine counts and overall stats
- `context.project.md` — single markdown document for pasting into a ChatGPT project
- `prompt.examples.md` — suggested queries

---

## Normalized Recipe Schema

```typescript
{
  id: string;                   // 16-char hex, stable across rebuilds
  title: string;
  source_name: string | null;
  source_url: string | null;
  yield_servings: number | null;
  prep_time_minutes: number | null;
  cook_time_minutes: number | null;
  total_time_minutes: number | null;
  ingredients: Array<{
    original: string;           // raw line from Paprika
    quantity: number | null;
    unit: string | null;
    ingredient: string;         // e.g. "chicken breast"
    notes: string | null;       // e.g. "boneless, skinless"
  }>;
  instructions: string[];
  tags: string[];               // from Paprika categories + explicit tags
  notes: string | null;
  nutrition: {
    calories: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    sodium_mg: number | null;
  } | null;
  cuisine: string | null;
  meal_type: 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'dessert';
  kid_friendly_score: number;   // 0–1
  weeknight_score: number;      // 0–1
  spice_level: 0 | 1 | 2 | 3;  // 0=mild … 3=very hot
  equipment: string[];
  primary_protein: string;      // "chicken" | "beef" | "pork" | "fish" | "vegetarian" | …
  cost_tier: 'low' | 'medium' | 'high';
  is_vegetarian: boolean;
  duplicate_group_id: string | null;
  parse_warnings: string[];
  source_file: string;
  imported_at: string;          // ISO 8601
}
```

---

## Derived Metadata Heuristics

All metadata is computed at normalisation time from the recipe text and ingredient list. No external API is called during build.

### Primary protein

Scans ingredient names for the first match in priority order:
bison → lamb → duck → venison → beef → pork → chicken → turkey → fish/seafood → tofu → eggs → legumes → vegetarian → other

### Cuisine

Matched from Paprika category tags first, then from title keywords (e.g. "Pad Thai" → Thai), then from ingredient signals (miso/soy/sake → Japanese).

### Meal type

Keyword signals: breakfast (eggs, pancake, waffle, oatmeal), dessert (cake, cookie, brownie, pie), lunch (sandwich, wrap, salad). Dinner is the default.

### Kid-friendly score (0–1)

| Signal | Effect |
|--------|--------|
| pasta, mac & cheese, pizza, tacos, nuggets, quesadilla | +0.2 |
| spice level ≥ 2 | −0.3 |
| spice level = 1 | −0.1 |
| exotic vegetables (kale, Brussels sprouts, mushrooms, etc.) | −0.05 each |
| peanut butter, honey | +0.1 |
| explicit kid-friendly tag | +0.2 |

### Weeknight score (0–1)

| Signal | Effect |
|--------|--------|
| total time ≤ 20 min | +0.4 |
| total time 21–35 min | +0.2 |
| total time 36–60 min | 0 |
| total time > 60 min | −0.3 |
| ≤ 8 ingredients | +0.2 |
| > 15 ingredients | −0.1 |
| slow cooker / instant pot / sheet pan | +0.1 |
| stand mixer / deep fryer | −0.1 |

### Spice level (0–3)

- **0 (mild)** — no spicy signals
- **1 (medium)** — paprika, mild chili powder, poblano
- **2 (hot)** — jalapeño, cayenne, sriracha, chipotle, red pepper flakes
- **3 (very hot)** — habanero, ghost pepper, scorpion pepper

### Cost tier

- **low** — budget proteins (eggs, chicken thighs, ground beef, beans, lentils), mostly pantry staples
- **medium** — standard grocery ingredients
- **high** — seafood, prime cuts, specialty cheeses, exotic produce

---

## Supported File Formats

| Format | Extensions | Notes |
|--------|------------|-------|
| Paprika native (single) | `.paprikarecipe` | Gzipped JSON blob |
| Paprika native (archive) | `.paprikarecipes` | ZIP of gzipped JSON blobs |
| HTML | `.html`, `.htm` | Paprika HTML export; schema.org `Recipe` markup |
| Plain text | `.txt` | Paprika text export format |
| JSON | `.json` | Recipe objects or arrays |
| MCB archive | `.mcb` | Compressed multi-recipe collection |

---

## Configuration

```bash
recipe-context init -o config.yaml   # generate sample config
recipe-context build -c config.yaml  # use it
```

```yaml
household_notes:
  kid_friendly: true
  spice_tolerance: medium      # mild | medium | hot | very_hot
  num_servings: 4

excluded_ingredients:
  - shellfish
  - peanuts

max_recipes_in_context: 500
max_chars: 200000

hellofresh_format: true        # quantity-first ingredient lines
```

---

## Output Files

| File | Description |
|------|-------------|
| `recipes.normalized.jsonl` | All normalised recipes, one JSON object per line |
| `catalog.selection.jsonl` | Compact pre-computed fields for the `ask` command |
| `recipes.index.json` | Tag/protein/cuisine counts and stats |
| `context.project.md` | Single markdown for a ChatGPT project |
| `prompt.examples.md` | Suggested queries |
| `report.md` | Build report: stats, duplicate groups, parse errors |

---

## Project Structure

```
src/
├── cli.ts                 # Commander.js CLI — build, ask, plan, search, …
├── build.ts               # Build orchestrator
├── scanner.ts             # File system walker, iCloud auto-detection
├── parsers/
│   ├── index.ts           # Dispatcher by file extension
│   ├── html-parser.ts     # HTML + schema.org parsing
│   ├── text-parser.ts     # Paprika plain text format
│   └── mcb-parser.ts      # Paprika ZIP/gzip format
├── ingredient-parser.ts   # Raw line → { quantity, unit, ingredient, notes }
├── normalizer.ts          # Raw → Normalized, all heuristics, ID generation
├── deduplicator.ts        # Blocking + similarity, duplicate grouping
├── context-generator.ts   # Writes all output files
├── selection-index.ts     # catalog.selection.jsonl schema + loader
├── search.ts              # Offline search index
├── ask.ts                 # OpenAI catalog assembly, query, display
├── report-generator.ts    # Build report markdown
├── config-loader.ts       # YAML/JSON config with defaults
├── validator.ts           # Output quality checks
├── types.ts               # All TypeScript types
└── planner/
    ├── index.ts           # planRecipes() — orchestrates the full pipeline
    ├── types.ts           # WeeklyPlanRequest, WeeklyPlanResult, etc.
    ├── query-parser.ts    # AI + offline regex → WeeklyPlanRequest
    ├── candidate-filter.ts# Per-slot recipe filtering (protein + safety)
    ├── scoring.ts         # Per-recipe deterministic score
    ├── optimizer.ts       # Beam search, shopping overlap, alternatives
    ├── validation.ts      # Post-selection hallucination guard
    └── renderer.ts        # Markdown output, verbose mode, AI safety check

fixtures/
└── sample-recipes/        # Test files (HTML, TXT, JSON)

src/__tests__/             # Vitest unit tests
```

---

## Development

```bash
# Compile TypeScript
npm run build

# Dev mode — run any command without compiling first (uses tsx)
npm run dev -- build -i ./fixtures/sample-recipes
npm run dev -- ask "quick chicken dinner" --verbose
npm run dev -- plan "1 chicken, 1 vegetarian, high protein" --no-ai-parser

# Run all tests
npm test

# Watch mode
npm run test:watch

# Run a single test file
npx vitest run src/__tests__/planner.test.ts

# Clean compiled output
npm run clean && npm run build
```

After `npm run build`, the compiled output lives in `dist/`. The entry point is `dist/cli.js`. The `recipe-context` binary (if you ran `npm link`) calls this file directly.

TypeScript target is ESM (`"type": "module"` in package.json). All internal imports use `.js` extensions as required by the ESM resolver.

---

## Troubleshooting

**"No recipe files found"**
Check that the input path exists and contains files with supported extensions. Run `recipe-context info` to see where the tool looks for iCloud exports.

**"No recipe files found"**
Check that the input path exists and contains files with supported extensions. Run `recipe-context info` to see where the tool looks for iCloud exports.

**"catalog.selection.jsonl not found"**
You haven't run `build` yet, or pointed `--data` at the wrong folder. Run `recipe-context build` first. The default output path is `./dist/recipe-context`.

**"Empty response from OpenAI API"**
Usually a token limit exceeded. Run with `--verbose` to see how many tokens are being sent. Reduce `QUOTA_PER_BUCKET` in `src/ask.ts` if needed.

**Wrong recipe shown for an AI selection**
The AI returned an ID that doesn't match any recipe in the current dataset — usually because `ask` is running against a stale build. Re-run `recipe-context build` to regenerate a fresh catalog.

**AI picks from the wrong category**
Run with `--verbose` to see if a validation warning appears. If the same category consistently fails, check the `primary_protein` field in `recipes.normalized.jsonl` and whether the relevant ingredient terms are covered by the regex patterns in `src/ask.ts`.

**`plan` returns fewer recipes than requested**
Some protein slots may have no candidates in your catalog (e.g. `seafood` if you have no seafood recipes). The validation output will name the empty slots. Try a different slot combination or use `--no-ai-parser` to debug what slots were parsed from your query.

**`plan --no-ai-parser` doesn't parse my query correctly**
The offline parser uses fixed regex patterns. Try rephrasing: `"1 chicken recipe, 1 beef recipe"` works better than `"some chicken and beef"`. Use `--verbose` to see the parsed `WeeklyPlanRequest` JSON.

**High API costs**
The default model is `gpt-4o-mini`. `ask` costs ~$0.01/query; `plan` costs ~$0.001 for query parsing plus ~$0.005 with `--explain`. Do not switch to `gpt-4o` without expecting a ~15× cost increase.

---

## Requirements

- Node.js 20+
- macOS (for Paprika iCloud auto-detection; manual `--input` path works on any OS)
- OpenAI API key (only for `ask` and `plan`; use `--no-ai-parser` for offline planning)

## License

MIT
