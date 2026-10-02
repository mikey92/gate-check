# Gate Check

**Can this power bank fly?** An agent that answers from airline, regulator and IATA rules kept as structured content in Sanity, evaluates them in code, and shows the exact wording behind every verdict, including where the sources disagree.

**Try it:** https://gate-check.mikey9220.workers.dev

Power bank rules changed fast in 2025 and 2026. ICAO limited power banks to two per passenger and banned recharging them on board from 27 March 2026; Korea, Japan and Hong Kong followed with their own dates; Emirates allows one and bans using it; IATA's 2026 guidance lists 100–160 Wh power banks as forbidden while ICAO still allows them with the airline's approval. News articles, airport pages and travel blogs restate all of this and go out of date. A traveller holding a "27,000 mAh" battery has to convert it to watt-hours, find every rule that applies to every leg, and pick the strictest.

Gate Check does that with two kinds of content:

- **Structured rules** (`batteryRule`): the watt-hour bands, count limits and on-board conditions of each authority. Every field is backed by a quote copied from a captured page, and the dataset build fails if one is missing. Code converts mAh to Wh and evaluates every applicable rule; the strictest one decides.
- **A Knowledge Base** built from the same rules and the captured pages themselves (official pages, news, third-party copies). Sanity Context found five conflicts between them; two were resolved as standing instructions, three were differences between authorities and are described in the Knowledge Base's purpose.

## How it works

```
question ──> Cloudflare Worker (tool-calling loop on Workers AI)
                 │
                 ├─ check_power_bank ─┐   rule engine in code (mAh → Wh, bands, counts, strictest wins)
                 ├─ find_rules        ├──> Sanity Context MCP "gate-check-data"  (GROQ mode)
                 ├─ run_groq ─────────┘     dataset: authority, batteryRule, source
                 │
                 └─ read_entries / search_entries ──> Sanity Context MCP "gate-check-rules" (Knowledge Base mode)
                                                      Knowledge Base built from 30 rules and 60 captured pages
```

`POST /api/check` runs the rule engine with no model at all and returns a report: the overall verdict, the rule that decided it, and one card per rule with the quoted wording behind each finding. The agent calls the same function as a tool.

## Repository

| Path | What it is |
|---|---|
| `studio/` | Sanity Studio and schema: `authority`, `batteryRule`, `source` |
| `data/authorities.json`, `data/rules.json` | Structured rules; each quote names a source and a statement in it |
| `data/sources/*.md` | Captured copies of each page: URL, kind, language, capture time, an excerpt, and the statements quoted from it |
| `scripts/build-dataset.mjs` | Copies quote text from the sources, checks every reference and that every rule field has a quote, and writes `data/dataset.ndjson` |
| `agent/src/rules.ts` | Unit conversion and rule evaluation; each finding names the fields it rests on |
| `agent/src/agent.ts` | Tools, the report and the agent loop |
| `agent/src/mcp.ts` | Minimal Sanity Context MCP client (streamable HTTP, JSON-RPC) |
| `agent/src/page.ts` | The web page |

## Run it yourself

```sh
node scripts/build-dataset.mjs
cd studio && npx sanity schema deploy && npx sanity dataset import ../data/dataset.ndjson --dataset production --replace

cd ../agent && npm install && npm test
npx wrangler secret put SANITY_CONTEXT_TOKEN   # organization token with Context Viewer
npx wrangler deploy
```

Sanity project ID `nkpgzr3t`, dataset `production` (public).

## Limits

- Rules are a snapshot from the capture date on each source (2 October 2026). Always check with your airline before you fly.
- When only mAh is given, Wh is computed at 3.7 V; the Wh printed on the battery wins.
- ICAO's addendum is treated as applying to every trip. National law decides how it applies to purely domestic flights.
- The demo runs on Cloudflare's free Workers AI allocation and is rate limited.
