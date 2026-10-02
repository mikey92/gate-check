import {ContextMcp} from './mcp.ts'
import {describeRule, evaluate, LABEL, strictest, toWattHours, type Rule} from './rules.ts'

export type Env = {
  AI: Ai
  SANITY_CONTEXT_TOKEN: string
  KB_MCP_URL: string
  DATA_MCP_URL: string
  MODEL: string
}

export type Step = {tool: string; input: unknown; summary: string}
export type Answer = {answer: string; steps: Step[]; model: string}

type ToolCall = {id: string; name: string; args: Record<string, unknown>}

const MAX_TURNS = 6
const MAX_TOOL_OUTPUT = 12000
const CONTEXT_TTL_MS = 10 * 60 * 1000

const TOOLS = [
  tool('check_power_bank', 'Decide whether a power bank may fly. Converts mAh to Wh and evaluates every applicable rule (each airline named, the departure countries\' regulators, and worldwide guidance) in code. Use it for every "can I bring" question.', {
    mAh: {type: 'number', description: 'Capacity in mAh, if that is what the label shows.'},
    volts: {type: 'number', description: 'Nominal voltage from the label, if known (usually 3.6 or 3.7).'},
    wh: {type: 'number', description: 'Capacity in Wh, if the label shows it.'},
    count: {type: 'integer', description: 'How many power banks the traveller carries. Default 1.'},
    airlines: {type: 'array', items: {type: 'string'}, description: 'Airline names or IATA codes for every leg, e.g. ["Korean Air", "UA"].'},
    departFrom: {type: 'array', items: {type: 'string'}, description: 'ISO country codes of every departure airport, e.g. ["KR", "US"].'},
    domestic: {type: 'boolean', description: 'True when a leg starts and ends in the same country.'},
  }, []),
  tool('find_rules', 'One authority\'s rules with the exact quoted wording behind every field. Use it when asked what an airline or regulator says.', {
    authority: {type: 'string', description: 'Airline or regulator name or code, e.g. "Asiana", "OZ", "FAA".'},
  }, ['authority']),
  tool('read_entries', 'Read Knowledge Base entries by path, copied verbatim from the outline. Read every relevant entry in one call.', {
    paths: {type: 'array', items: {type: 'string'}, description: 'Entry paths from the outline, at most 8.'},
  }, ['paths']),
  tool('search_entries', 'Keyword search over the Knowledge Base when the outline does not show where an answer lives. Returns ranked entry paths to read next.', {
    query: {type: 'string'},
  }, ['query']),
  tool('run_groq', 'Read-only GROQ on the structured dataset (types: authority, batteryRule, source). Last resort.', {
    query: {type: 'string'},
  }, ['query']),
]

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return {type: 'function', function: {name, description, parameters: {type: 'object', properties, required}}}
}

type Context = {at: number; outline: string; schema: string; kbId: string; sourceIndex: string}
let cachedContext: Context | undefined

// Knowledge Base entries cite sources by title; the dataset knows each title's URL, kind and capture date.
async function loadContext(kb: ContextMcp, data: ContextMcp): Promise<Context> {
  if (cachedContext && Date.now() - cachedContext.at < CONTEXT_TTL_MS) return cachedContext
  const [outline, schema, sources] = await Promise.all([
    kb.callTool('initial_context', {}),
    data.callTool('initial_context', {}),
    groq(data, '*[_type == "source"] | order(title asc){title, url, kind, capturedAt, "authority": authority->name}'),
  ])
  const kbId = outline.text.match(/\bkb[a-zA-Z0-9]+/)?.[0]
  if (!kbId) throw new Error('No Knowledge Base id in initial context')
  const sourceIndex = (sources as {title: string; url: string; kind: string; capturedAt: string; authority: string}[])
    .map((s) => `- ${s.title} (${s.authority}, ${s.kind}, captured ${s.capturedAt.slice(0, 10)}): ${s.url}`)
    .join('\n')
  cachedContext = {at: Date.now(), outline: outline.text, schema: schema.text, kbId, sourceIndex}
  return cachedContext
}

export async function ask(env: Env, question: string, now = new Date()): Promise<Answer> {
  const kb = new ContextMcp(env.KB_MCP_URL, env.SANITY_CONTEXT_TOKEN)
  const data = new ContextMcp(env.DATA_MCP_URL, env.SANITY_CONTEXT_TOKEN)
  const context = await loadContext(kb, data)
  const steps: Step[] = []
  const messages: Record<string, unknown>[] = [
    {role: 'system', content: systemPrompt(context, now)},
    {role: 'user', content: question},
  ]

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const reply = normalize(await env.AI.run(env.MODEL as keyof AiModels, {messages, tools: TOOLS, max_tokens: 1500, temperature: 0.1} as never))
    if (reply.calls.length === 0) return {answer: reply.text.trim(), steps, model: env.MODEL}
    messages.push({
      role: 'assistant',
      content: reply.text,
      tool_calls: reply.calls.map((call) => ({id: call.id, type: 'function', function: {name: call.name, arguments: JSON.stringify(call.args)}})),
    })
    for (const call of reply.calls) {
      const {output, summary} = await runTool(call, {kb, data, kbId: context.kbId})
      steps.push({tool: call.name, input: call.args, summary})
      messages.push({role: 'tool', tool_call_id: call.id, name: call.name, content: output.slice(0, MAX_TOOL_OUTPUT)})
    }
  }
  messages.push({role: 'user', content: 'Stop calling tools and answer from what you have read so far.'})
  const last = normalize(await env.AI.run(env.MODEL as keyof AiModels, {messages, max_tokens: 1500, temperature: 0.1} as never))
  return {answer: last.text.trim(), steps, model: env.MODEL}
}

type ToolDeps = {kb: ContextMcp; data: ContextMcp; kbId: string}

async function runTool(call: ToolCall, deps: ToolDeps): Promise<{output: string; summary: string}> {
  try {
    switch (call.name) {
      case 'check_power_bank':
        return await checkPowerBank(deps.data, call.args)
      case 'find_rules': {
        const name = String(call.args.authority ?? '')
        const rows = (await groq(deps.data, rulesForAuthorityQuery(name))) as unknown[]
        return {output: rows.length ? JSON.stringify(rows, null, 1) : `No rules stored for "${name}".`, summary: `Rules for "${name}": ${rows.length} found`}
      }
      case 'read_entries': {
        const paths = (Array.isArray(call.args.paths) ? call.args.paths : []).map(String).slice(0, 8)
        const result = await deps.kb.callTool('knowledge_base_read', {knowledgeBase: deps.kbId, paths})
        return {output: result.text, summary: `Read ${paths.length} entr${paths.length === 1 ? 'y' : 'ies'}: ${paths.join(', ')}`}
      }
      case 'search_entries': {
        const query = String(call.args.query ?? '').slice(0, 200)
        const result = await deps.kb.callTool('knowledge_base_search', {knowledgeBase: deps.kbId, query})
        return {output: result.text, summary: `Searched the Knowledge Base for "${query}"`}
      }
      case 'run_groq': {
        const query = String(call.args.query ?? '')
        const rows = await groq(deps.data, query)
        return {output: JSON.stringify(rows, null, 1), summary: `GROQ: ${query}`}
      }
      default:
        return {output: `Unknown tool ${call.name}`, summary: `Unknown tool ${call.name}`}
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {output: `Tool error: ${message}`, summary: `${call.name} failed: ${message}`}
  }
}

export async function checkPowerBank(data: ContextMcp, args: Record<string, unknown>): Promise<{output: string; summary: string}> {
  const {wh, assumedVolts} = toWattHours({wh: num(args.wh), mAh: num(args.mAh), volts: num(args.volts)})
  const count = Math.max(1, Math.round(num(args.count) ?? 1))
  const airlines = strings(args.airlines)
  const countries = strings(args.departFrom).map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c))
  const rules = (await groq(data, applicableRulesQuery(airlines, countries, args.domestic === true))) as Rule[]
  const battery = {wh, count, assumedVolts}
  // Advisory guidance (IATA, EASA bulletins) is reported but does not decide the verdict.
  const binding = rules.filter((rule) => rule.scope !== 'guidance')
  const overall = strictest(binding.map((rule) => evaluate(rule, battery).verdict))
  const unmatched = airlines.filter((name) => !rules.some((rule) => rule.scope === 'carrier' && matchesAuthority(rule.authority, name)))
  const lines = [
    `Battery: ${wh} Wh${assumedVolts ? ` (computed from mAh at an assumed ${assumedVolts} V; the Wh printed on the label wins)` : ''}, ${count} unit${count === 1 ? '' : 's'}.`,
    `Overall (strictest binding rule): ${LABEL[overall]}.`,
    ...binding.map((rule) => describeRule(rule, battery)),
    ...rules.filter((rule) => rule.scope === 'guidance').map((rule) => describeRule(rule, battery)),
    unmatched.length ? `No stored rules for: ${unmatched.join(', ')}. Say so and point to that airline's own page.` : null,
  ].filter(Boolean)
  return {output: lines.join('\n'), summary: `Checked ${wh} Wh × ${count} against ${rules.length} rules: ${overall}`}
}

function matchesAuthority(authority: {name: string; codes?: string[]}, name: string): boolean {
  const wanted = name.toLowerCase()
  return authority.name.toLowerCase().includes(wanted) || (authority.codes ?? []).some((code) => code.toLowerCase() === wanted)
}

// User text only ever enters GROQ as JSON-escaped string literals.
function authorityCondition(name: string): string {
  const term = JSON.stringify(name.trim().slice(0, 60))
  return `(authority->name match ${term} || count(authority->codes[lower(@) == lower(${term})]) > 0)`
}

const RULE_PROJECTION = `{
  title, scope, effectiveFrom, status, limits, onboard, note,
  "authority": authority->{name, kind, country, codes},
  "source": source->{title, url}
}`

export function applicableRulesQuery(airlines: string[], countries: string[], domestic: boolean): string {
  const branches = ['scope in ["worldwide", "guidance"]']
  for (const airline of airlines.slice(0, 6)) branches.push(`(scope == "carrier" && ${authorityCondition(airline)})`)
  if (countries.length) {
    const list = JSON.stringify(countries.slice(0, 6))
    branches.push(`(scope == "departing" && authority->country in ${list})`)
    if (domestic) branches.push(`(scope == "domestic" && authority->country in ${list})`)
  }
  return `*[_type == "batteryRule" && (${branches.join(' || ')})]${RULE_PROJECTION} | order(scope asc)`
}

export function rulesForAuthorityQuery(name: string): string {
  return `*[_type == "batteryRule" && ${authorityCondition(name)}]{
  title, scope, effectiveFrom, status, limits, onboard, note,
  "authority": authority->{name, kind, country, website},
  "source": source->{title, url, kind, capturedAt, lastUpdated},
  "quotes": quotes[]{field, text, "source": source->title}
}`
}

// The Context MCP groq_query tool returns {meta, result}; this unwraps result.
async function groq(data: ContextMcp, query: string): Promise<unknown> {
  const response = await data.callTool('groq_query', {query})
  if (response.isError) throw new Error(response.text)
  const parsed = JSON.parse(response.text)
  return parsed.result ?? parsed
}

function num(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((s) => s.trim()).filter(Boolean) : []
}

// Workers AI returns either the classic {response, tool_calls} shape or an OpenAI-style {choices} shape.
export function normalize(raw: unknown): {text: string; calls: ToolCall[]} {
  const value = raw as Record<string, any>
  const message = value?.choices?.[0]?.message
  const text: string = message?.content ?? value?.response ?? ''
  const rawCalls: any[] = message?.tool_calls ?? value?.tool_calls ?? []
  const calls = rawCalls.map((call, index) => {
    const name = call.function?.name ?? call.name
    const rawArgs = call.function?.arguments ?? call.arguments ?? {}
    const args = typeof rawArgs === 'string' ? safeJson(rawArgs) : rawArgs
    return {id: call.id ?? `call_${index}`, name, args}
  })
  return {text: typeof text === 'string' ? text : JSON.stringify(text), calls}
}

function safeJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

function systemPrompt({outline, schema, sourceIndex}: Context, now: Date): string {
  return `You are Gate Check. You answer whether a power bank (a spare lithium-ion battery) may go on a flight, and under which conditions.
Answer only from the tools, never from memory. Airline pages, regulators and news reports disagree and change often; your job is to say exactly what the sources say, which rule is strictest, and where sources disagree.

Today: ${now.toISOString().slice(0, 10)}.

Tools:
- check_power_bank: for every "can I bring" question. It converts mAh to Wh and evaluates each applicable rule in code. Never convert units or compare limits yourself. Pass every airline on the itinerary and every departure country.
- find_rules: one authority's rules with the exact quoted wording behind each field.
- read_entries / search_entries: the Knowledge Base, built from official pages, news and third-party copies, with conflicts between them reviewed. Use it for questions about why rules differ, what changed, and which source to trust.
- run_groq: read-only GROQ on the dataset, only when nothing else answers.

How to answer:
1. Start with the verdict in one sentence, copied from the tool's overall line, then one line per rule that matters.
2. List the on-board conditions the tools return (no in-flight use, not in the overhead bin, cover the terminals).
3. When sources disagree (a rule with status "disputed", or an entry that reports conflicting claims), show both claims with their sources and say which one is ground truth and why.
4. If an airline has no stored rule, say so and point to that airline's own page.
5. Cite sources as markdown links, [title](url), taking each URL from the source index below. No bracket markers like 【】 or [1], and no tables.
6. End with: "Check with your airline before you fly."
Be brief.

Knowledge Base outline:
${outline}

Source index (title, authority, kind, capture date, URL):
${sourceIndex}

Structured dataset (GROQ mode initial context):
${schema.slice(0, 5000)}`
}
