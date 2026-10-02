# Gate Check

**Can this power bank fly?** An agent that answers from airline, regulator and IATA rules kept as structured content in Sanity, evaluates them in code, and tells you where the sources disagree.

**Try it:** https://gate-check.mikey9220.workers.dev

Power bank rules are a mess of copies. IATA and the FAA set watt-hour limits; airlines add their own count limits and, since 2025, bans on using or recharging power banks in flight or storing them in the overhead bin; some countries add certification marks. News articles and travel blogs restate all of this and go out of date. A traveller holding a "27,000 mAh" battery has to convert it to watt-hours, find every rule that applies to every leg, and pick the strictest.

Gate Check does that with two kinds of content:

- **Structured rules** (`batteryRule`): the watt-hour bands, count limits and on-board switches of each authority, each field backed by the exact quoted wording and the page it came from. Code converts mAh to Wh and evaluates every applicable rule; the strictest one wins.
- **A Knowledge Base** built from the captured pages themselves (official pages, news, third-party copies), which reconciles them ahead of time and records where they conflict.

## How it works

```
question ──> Cloudflare Worker (tool-calling loop on Workers AI)
                 │
                 ├─ check_power_bank ─┐   rule engine in code (mAh → Wh, bands, counts, strictest wins)
                 ├─ find_rules        ├──> Sanity Context MCP "gate-check-data"  (GROQ mode)
                 ├─ run_groq ─────────┘     dataset: authority, batteryRule, source
                 │
                 └─ read_entries / search_entries ──> Sanity Context MCP "gate-check-rules" (Knowledge Base mode)
                                                      Knowledge Base built from the source pages
```

`POST /api/check` runs the rule engine with no model at all; the agent calls the same function as a tool.

## Repository

| Path | What it is |
|---|---|
| `studio/` | Sanity Studio and schema: `authority`, `batteryRule`, `source` |
| `data/authorities.json`, `data/rules.json` | Structured rules; every field has a quote and a source |
| `data/sources/*.md` | Captured copies of each page, quoted rather than paraphrased, with URL, kind, language and capture time |
| `scripts/build-dataset.mjs` | Checks every reference and writes `data/dataset.ndjson` for `sanity dataset import` |
| `agent/src/rules.ts` | Unit conversion and rule evaluation |
| `agent/src/agent.ts` | Tools and the agent loop |
| `agent/src/mcp.ts` | Minimal Sanity Context MCP client (streamable HTTP, JSON-RPC) |
| `agent/src/page.ts` | The web page |

## Run it yourself

```sh
node scripts/build-dataset.mjs
cd studio && npx sanity schema deploy && npx sanity dataset import ../data/dataset.ndjson production --replace

cd ../agent && npm install && npm test
npx wrangler secret put SANITY_CONTEXT_TOKEN   # organization token with Context Viewer
npx wrangler deploy
```

Sanity project ID `nkpgzr3t`, dataset `production` (public).

## Limits

- Rules are a snapshot from the capture date on each source. Always check with your airline before you fly.
- When only mAh is given, Wh is computed at 3.7 V; the Wh printed on the battery wins.
- The demo runs on Cloudflare's free Workers AI allocation and is rate limited.
