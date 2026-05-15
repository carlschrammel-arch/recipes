# AI Options for Natural Language Recipe Search

## Comparison

| Option | Cost/query | Reasoning Quality | Setup Effort | Privacy |
|---|---|---|---|---|
| **OpenAI API — gpt-4o-mini** ⭐ | ~$0.007 | Excellent | Easy | Cloud |
| **OpenAI API — gpt-4o** | ~$0.07 | Best | Easy | Cloud |
| ChatGPT Plus (manual) | $0 extra | Excellent | None | Cloud |
| GitHub Copilot | $0 (included) | Good | None | Cloud |
| Azure OpenAI | ~$0.007 | Excellent | Medium | Cloud, enterprise |
| Azure AI Search | $50+/month | Good (rigid) | Hard | Cloud |
| Ollama (local) | Free | Weaker | Medium | Local |

---

## ⭐ Recommended: OpenAI API

The best balance of quality, cost, and simplicity. A typical query with your full recipe collection costs under one cent.

### 1. Create an OpenAI account

Go to [platform.openai.com](https://platform.openai.com) and sign up (your ChatGPT Plus account works here too).

### 2. Add credits

- Go to **Settings → Billing → Add payment method**
- Add a credit card and purchase a credit top-up ($5 minimum)
- Credits do not expire; $5 will last hundreds of queries at gpt-4o-mini prices

### 3. Create an API key

- Go to **[platform.openai.com/api-keys](https://platform.openai.com/api-keys)**
- Click **Create new secret key**
- Give it a name like `recipe-search`
- Copy the key — it starts with `sk-` and you can only see it once

### 4. Set the environment variable

Add to your `~/.zshrc` (so it persists across terminal sessions):

```bash
echo 'export OPENAI_API_KEY=sk-YOUR_KEY_HERE' >> ~/.zshrc
source ~/.zshrc
```

Or set it for just one session:

```bash
export OPENAI_API_KEY=sk-YOUR_KEY_HERE
```

### 5. Use it

```bash
recipe-context ask "give me 5 recipes that are low calorie, high protein, that kids would like. one chicken, one beef, one pork, one veggie, one mexican"

# See token usage and exact cost for each query
recipe-context ask "quick weeknight dinners under 30 minutes" --verbose

# Use the smarter (more expensive) model when needed
recipe-context ask "creative dinner party menu, nothing too common" --model gpt-4o
```

### Model options

| Model | Cost (input/output per 1M tokens) | Use when |
|---|---|---|
| `gpt-4o-mini` (default) | $0.15 / $0.60 | Everyday queries — default, great quality |
| `gpt-4o` | $2.50 / $10.00 | Complex multi-constraint queries |

---

## ChatGPT Plus (manual — no API key needed)

If you already have a ChatGPT Plus subscription you can query your recipes without any setup, though it requires a manual step each time.

1. Run the build to generate context files:
   ```bash
   recipe-context build -i "~/Library/Mobile Documents/com~apple~CloudDocs/Export 2026-05-14 11.56.58 All Recipes.paprikarecipes" -o ./dist/recipe-context
   ```
2. Open [chatgpt.com](https://chatgpt.com) and create a **Project**
3. Upload `dist/recipe-context/context.project.md` as the Project instructions
4. Upload `dist/recipe-context/catalog.selection.jsonl` as a Project file
5. Ask anything in the chat — the recipes are loaded into the Project context and persist across conversations

This is free beyond the Plus subscription and lets you have back-and-forth conversations about your meal plan.

---

## GitHub Copilot (if you have a subscription)

You can paste the catalog directly into a Copilot Chat session and ask your question. No API key needed.

1. After running `build`, open `dist/recipe-context/catalog.selection.jsonl` in VS Code
2. Open Copilot Chat and reference the file with `#catalog.selection.jsonl`
3. Ask: _"From this catalog, give me 5 low-calorie high-protein recipes that kids would like — one chicken, one beef, one pork, one veggie, one Mexican"_

**Limitation:** Copilot Chat context windows are smaller than the API; works best with collections under ~500 recipes.

---

## Azure OpenAI (enterprise / privacy-sensitive use)

Same models as OpenAI but hosted in your own Azure subscription. Data does not leave your Azure region and is not used for model training.

1. Go to [portal.azure.com](https://portal.azure.com) and create an **Azure OpenAI** resource
2. Deploy a model (e.g., `gpt-4o-mini`) in **Azure AI Foundry**
3. Copy the endpoint URL and API key from the resource
4. Set environment variables:
   ```bash
   export AZURE_OPENAI_API_KEY=your-key
   export AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
   export AZURE_OPENAI_DEPLOYMENT=gpt-4o-mini
   ```
5. Update the `ask` command call to use the Azure client (code change needed in `src/ask.ts`)

Only worth the extra setup if data residency or compliance is a concern.

---

## Ollama (local / free / offline)

Runs a model entirely on your Mac. Free, private, no internet required after setup — but reasoning quality is noticeably weaker on complex multi-constraint queries.

### Setup

1. Download and install Ollama: [ollama.com](https://ollama.com)

2. Pull a model (choose based on your RAM):
   ```bash
   # 8 GB RAM minimum — decent quality
   ollama pull llama3.1:8b

   # 16 GB RAM — better quality
   ollama pull llama3.1:70b-instruct-q4_K_M

   # Best local option if you have 32+ GB
   ollama pull mixtral:8x7b
   ```

3. Start the server (runs in background):
   ```bash
   ollama serve
   ```

4. The OpenAI SDK supports Ollama via a base URL override — update `src/ask.ts`:
   ```ts
   const client = new OpenAI({
     apiKey: 'ollama',           // any non-empty string
     baseURL: 'http://localhost:11434/v1',
   });
   ```
   And pass your Ollama model name via `--model llama3.1:8b`.

**Realistic expectation:** Works well for simple queries ("chicken recipes under 30 minutes"). Complex multi-constraint queries like "low calorie, high protein, kid-friendly, one of each protein type" benefit significantly from GPT-4o-mini's stronger reasoning.

---

## Not recommended: Azure AI Search

Azure AI Search is designed for keyword and vector search over documents, not natural language reasoning over structured recipe metadata. It would require setting up an Azure subscription, an indexing pipeline, and an embedding job — significantly more complexity than the API approach — and still wouldn't handle complex multi-constraint queries as well as a language model. Skip it.
