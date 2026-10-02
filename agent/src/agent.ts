import {ContextMcp} from './mcp.ts'
import {OFF_TOPIC_REPLY} from './guard.ts'
import {outputText, planConnected, replayable, respond, type PlanEnv, type ResponseItem} from './plan.ts'
import {describeRule, evaluate, LABEL, SEVERITY, strictest, toWattHours, type Battery, type Finding, type Rule, type Verdict} from './rules.ts'

export type Env = {
  AI: Ai
  SANITY_CONTEXT_TOKEN: string
  KB_MCP_URL: string
  DATA_MCP_URL: string
  MODEL: string
  REASONING?: string
  // The owner's ChatGPT plan (see plan.ts): the model and reasoning effort to use on it.
  PLAN_MODEL?: string
  PLAN_EFFORT?: string
} & PlanEnv

export type Step = {tool: string; input: unknown; summary: string}
// kind: official, news or aggregator (a third-party copy), so the page can list official pages first and label the rest.
export type Page = {title: string; url: string; kind?: string}
// sources: every page behind the tool results the answer was written from, collected in code rather than by the model.
// report: the rule engine's verdict when the agent ran check_power_bank, so the page can show it before the answer.
// usage: model calls and tokens, which is what the daily free allowance is spent on.
export type Usage = {calls: number; input: number; output: number}
export type Answer = {answer: string; steps: Step[]; model: string; sources: Page[]; report?: CheckReport; usage: Usage}
export type AgentEvent = {type: 'step'; step: Step} | {type: 'report'; report: CheckReport}

type ToolCall = {id: string; name: string; args: Record<string, unknown>}
type ToolResult = {output: string; summary: string; pages?: Page[]; report?: CheckReport}

// Nemotron reasons before it answers; REASONING picks how much (reasoning tokens are output tokens: time and allowance).
const REASONING: Record<string, Record<string, boolean>> = {
  off: {enable_thinking: false},
  low: {enable_thinking: true, low_effort: true},
  normal: {enable_thinking: true},
}

const MAX_TURNS = 6
const MAX_TOOL_OUTPUT = 12000
const MAX_ENTRIES_PER_READ = 4
const CONTEXT_TTL_MS = 10 * 60 * 1000
export const CLOSING = 'Check with your airline before you fly.'
// The on-board conditions every rule may set; compare_rules lines one of them up across all authorities.
export const ONBOARD_FIELDS = ['checkedBaggage', 'useInFlight', 'rechargeInFlight', 'overheadBin', 'keepVisible', 'protection', 'labelRequired', 'certification'] as const
type OnboardField = (typeof ONBOARD_FIELDS)[number]

const TOOLS = [
  tool('check_power_bank', 'Decide whether a power bank may fly. Converts mAh to Wh and evaluates every applicable rule (each airline named, the departure countries\' regulators, and worldwide guidance) in code. Use it for every "can I bring" question that gives a capacity; without a capacity, use find_rules or compare_rules.', {
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
  tool('compare_rules', 'One on-board condition across every stored airline and regulator, grouped by what each one says, with the quoted wording. Use it for questions across authorities, e.g. "which airlines ban power banks from the overhead bin".', {
    field: {
      type: 'string',
      enum: [...ONBOARD_FIELDS],
      description: 'checkedBaggage; useInFlight (charging devices from it in flight); rechargeInFlight (charging it from seat power); overheadBin; keepVisible; protection (covered terminals); labelRequired (printed capacity); certification.',
    },
  }, ['field']),
  tool('read_entries', 'Read Knowledge Base entries by path, copied verbatim from the outline. Read the most relevant entries in one call.', {
    paths: {type: 'array', items: {type: 'string'}, description: `Entry paths from the outline, at most ${MAX_ENTRIES_PER_READ}.`},
  }, ['paths']),
  tool('search_entries', 'Keyword search over the Knowledge Base when the outline does not show where an answer lives. Returns ranked entry paths to read next.', {
    query: {type: 'string'},
  }, ['query']),
  tool('run_groq', 'Read-only GROQ on the structured dataset. Last resort. Types: authority {name, kind, country, codes}; batteryRule {title, scope, status, effectiveFrom, limits, onboard, note, authority->, source->, quotes[]{field, text, source->}}; source {title, url, kind, language, capturedAt, authority->}.', {
    query: {type: 'string'},
  }, ['query']),
]

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return {type: 'function', function: {name, description, parameters: {type: 'object', properties, required}}}
}

type Context = {at: number; outline: string; kbId: string; pages: Map<string, Page>}
let cachedContext: Context | undefined

// Knowledge Base entries cite the documents they were written from by title; the dataset maps each
// rule or source title to the page behind it, so the answer can link every page it rests on.
async function loadContext(kb: ContextMcp, data: ContextMcp): Promise<Context> {
  if (cachedContext && Date.now() - cachedContext.at < CONTEXT_TTL_MS) return cachedContext
  const [outline, docs] = await Promise.all([
    kb.callTool('initial_context', {}),
    groq(data, '*[_type in ["source", "batteryRule"]]{title, "page": select(_type == "source" => {title, url, kind}, source->{title, url, kind})}'),
  ])
  const kbId = outline.text.match(/\bkb[a-zA-Z0-9]+/)?.[0]
  if (!kbId) throw new Error('No Knowledge Base id in initial context')
  const pages = new Map((docs as {title: string; page?: Page}[]).filter((doc) => doc.page?.url).map((doc) => [doc.title, doc.page as Page]))
  cachedContext = {at: Date.now(), outline: outline.text, kbId, pages}
  return cachedContext
}

// The "## Sources" list at the end of a Knowledge Base entry: "1. <document title> — Dataset".
export function kbSourceTitles(entryText: string): string[] {
  const titles: string[] = []
  for (const section of entryText.split(/^## Sources\s*$/m).slice(1)) {
    for (const line of section.split('\n')) {
      const match = line.match(/^\d+\.\s+(.+?)\s+—\s+\S+\s*$/)
      if (match) titles.push(match[1])
      else if (line.startsWith('#')) break
    }
  }
  return titles
}

// onEvent reports each finished tool call (and the rule engine's verdict) while the model is still working.
// The model runs on the owner's ChatGPT plan when one is connected (PLAN_MODEL), and on Workers AI otherwise or if that fails.
export async function ask(env: Env, question: string, onEvent: (event: AgentEvent) => void = () => {}, now = new Date()): Promise<Answer> {
  const kb = new ContextMcp(env.KB_MCP_URL, env.SANITY_CONTEXT_TOKEN)
  const data = new ContextMcp(env.DATA_MCP_URL, env.SANITY_CONTEXT_TOKEN)
  const context = await loadContext(kb, data)
  const steps: Step[] = []
  const sources = new Map<string, Page>()
  let report: CheckReport | undefined
  const usage: Usage = {calls: 0, input: 0, output: 0}
  const instructions = systemPrompt(context, now)
  // Runs one tool call, reports it, and returns what the model reads back.
  const use = async (call: ToolCall): Promise<string> => {
    const result = await runTool(call, {kb, data, kbId: context.kbId, pages: context.pages})
    for (const page of result.pages ?? []) sources.set(page.url, page)
    const step = {tool: call.name, input: call.args, summary: result.summary}
    steps.push(step)
    onEvent({type: 'step', step})
    if (result.report) {
      report = result.report
      onEvent({type: 'report', report})
    }
    return result.output.slice(0, MAX_TOOL_OUTPUT)
  }
  const done = (text: string, model: string): Answer => ({answer: finishAnswer(text), steps, model, sources: officialFirst([...sources.values()]), report, usage})

  let planError = ''
  if (env.PLAN_MODEL && planConnected(env)) {
    try {
      return done(await planLoop(env, env.PLAN_MODEL, env.PLAN_EFFORT ?? 'low', instructions, question, use, usage), `${env.PLAN_MODEL} (ChatGPT plan)`)
    } catch (error) {
      planError = error instanceof Error ? error.message : String(error)
      console.error('ChatGPT plan failed; answering with Workers AI:', planError)
    }
  }
  try {
    return done(await workersAiLoop(env, instructions, question, use, usage), env.MODEL)
  } catch (error) {
    if (!planError || !(error instanceof Error)) throw error
    throw new Error(`${error.message} (after the ChatGPT plan failed: ${planError})`)
  }
}

const RESPONSE_TOOLS = TOOLS.map(({function: fn}) => ({type: 'function', ...fn}))
const WRAP_UP = 'Stop calling tools and answer from what you have read so far.'

async function planLoop(
  plan: PlanEnv,
  model: string,
  effort: string,
  instructions: string,
  question: string,
  use: (call: ToolCall) => Promise<string>,
  usage: Usage,
): Promise<string> {
  const input: ResponseItem[] = [{type: 'message', role: 'user', content: [{type: 'input_text', text: question}]}]
  const run = async (toolChoice: string) => {
    const result = await respond(plan, {
      model,
      instructions,
      input,
      tools: RESPONSE_TOOLS,
      tool_choice: toolChoice,
      parallel_tool_calls: true,
      reasoning: {effort},
      include: ['reasoning.encrypted_content'],
    })
    usage.calls++
    usage.input += result.usage?.input_tokens ?? 0
    usage.output += result.usage?.output_tokens ?? 0
    input.push(...replayable(result.output))
    return result.output
  }
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const output = await run('auto')
    const calls = output.filter((item) => item.type === 'function_call')
    if (calls.length === 0) return outputText(output)
    for (const call of calls) {
      const args = typeof call.arguments === 'string' ? safeJson(call.arguments) : (call.arguments ?? {})
      input.push({type: 'function_call_output', call_id: call.call_id, output: await use({id: call.call_id, name: call.name, args})})
    }
  }
  input.push({type: 'message', role: 'user', content: [{type: 'input_text', text: WRAP_UP}]})
  return outputText(await run('none'))
}

async function workersAiLoop(env: Env, instructions: string, question: string, use: (call: ToolCall) => Promise<string>, usage: Usage): Promise<string> {
  const messages: Record<string, unknown>[] = [
    {role: 'system', content: instructions},
    {role: 'user', content: question},
  ]
  const reasoning = REASONING[env.REASONING ?? '']
  const run = async (payload: Record<string, unknown>) => {
    const options = {...payload, max_tokens: 1500, temperature: 0.1, ...(reasoning ? {chat_template_kwargs: reasoning} : {})}
    const raw = (await env.AI.run(env.MODEL as keyof AiModels, options as never)) as {usage?: {prompt_tokens?: number; completion_tokens?: number}}
    usage.calls++
    usage.input += raw?.usage?.prompt_tokens ?? 0
    usage.output += raw?.usage?.completion_tokens ?? 0
    return normalize(raw)
  }
  let nudged = false
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const reply = await run({messages, tools: TOOLS})
    if (reply.calls.length === 0) {
      // Some models return an empty message right after reading a tool result; ask once for the answer itself.
      if (!reply.text.trim() && !nudged) {
        nudged = true
        messages.push({role: 'user', content: 'Write the answer now, from the tool results above.'})
        continue
      }
      return reply.text
    }
    messages.push({
      role: 'assistant',
      content: reply.text,
      tool_calls: reply.calls.map((call) => ({id: call.id, type: 'function', function: {name: call.name, arguments: JSON.stringify(call.args)}})),
    })
    for (const call of reply.calls) messages.push({role: 'tool', tool_call_id: call.id, name: call.name, content: await use(call)})
  }
  messages.push({role: 'user', content: WRAP_UP})
  return (await run({messages})).text
}

const KIND_ORDER = ['official', 'news', 'aggregator']

// Official pages first, then news, then third-party copies; the order within each kind is the order they were read.
export function officialFirst(pages: Page[]): Page[] {
  const rank = (page: Page) => (KIND_ORDER.includes(page.kind ?? '') ? KIND_ORDER.indexOf(page.kind!) : KIND_ORDER.length)
  return pages.map((page, index) => ({page, index})).sort((a, b) => rank(a.page) - rank(b.page) || a.index - b.index).map(({page}) => page)
}

// Some models add citation markers such as 【national_regulators/usa】 despite the prompt; the page lists the sources itself.
export function finishAnswer(text: string): string {
  const answer = text.replace(/[ \t]*【[^】]*】/g, '').trim()
  return answer.endsWith(CLOSING) ? answer : `${answer}\n\n${CLOSING}`
}

type ToolDeps = {kb: ContextMcp; data: ContextMcp; kbId: string; pages: Map<string, Page>}

async function runTool(call: ToolCall, deps: ToolDeps): Promise<ToolResult> {
  try {
    switch (call.name) {
      case 'check_power_bank': {
        const {output, summary, report} = await checkPowerBank(deps.data, call.args)
        const pages = [...report.rules, ...report.guidance].flatMap((rule) => (rule.source ? [rule.source] : []))
        return {output, summary, pages, report}
      }
      case 'find_rules': {
        const name = String(call.args.authority ?? '')
        const rows = (await groq(deps.data, rulesForAuthorityQuery(name))) as {source?: Page}[]
        const pages = rows.flatMap((row) => (row.source?.url ? [{title: row.source.title, url: row.source.url, kind: row.source.kind}] : []))
        return {output: rows.length ? JSON.stringify(rows, null, 1) : `No rules stored for "${name}".`, summary: `Rules for "${name}": ${rows.length} found`, pages}
      }
      case 'compare_rules':
        return await compareRules(deps.data, String(call.args.field ?? ''))
      case 'read_entries': {
        const paths = (Array.isArray(call.args.paths) ? call.args.paths : []).map(String).slice(0, MAX_ENTRIES_PER_READ)
        const result = await deps.kb.callTool('knowledge_base_read', {knowledgeBase: deps.kbId, paths})
        const pages = kbSourceTitles(result.text).flatMap((title) => deps.pages.get(title) ?? [])
        return {output: result.text, summary: `Read ${paths.length} entr${paths.length === 1 ? 'y' : 'ies'}: ${paths.join(', ')}`, pages}
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

export type Quote = {field: string; text: string; source?: Page}
type StoredRule = Rule & {quotes?: Quote[]}
type Grounded = Finding & {quotes: Quote[]}

export type RuleReport = {
  authority: string
  title: string
  scope: Rule['scope']
  effectiveFrom?: string
  status?: Rule['status']
  verdict: Verdict
  reasons: Grounded[]
  advisories: Grounded[]
  note?: string
  source?: Page
}

export type CheckReport = {battery: Battery; overall: Verdict; decidedBy?: string; rules: RuleReport[]; guidance: RuleReport[]; unmatched: string[]}

// Each finding carries the quoted wording of the fields it rests on, so the page can show the receipts.
export function reportRule(rule: StoredRule, battery: Battery): RuleReport {
  const {verdict, reasons, advisories} = evaluate(rule, battery)
  const ground = (finding: Finding): Grounded => ({...finding, quotes: (rule.quotes ?? []).filter((quote) => finding.fields.includes(quote.field))})
  return {
    authority: rule.authority.name,
    title: rule.title,
    scope: rule.scope,
    effectiveFrom: rule.effectiveFrom,
    status: rule.status,
    verdict,
    reasons: reasons.map(ground),
    advisories: advisories.map(ground),
    note: rule.note,
    source: rule.source,
  }
}

export async function checkPowerBank(data: ContextMcp, args: Record<string, unknown>): Promise<{output: string; summary: string; report: CheckReport}> {
  const {wh, assumedVolts} = toWattHours({wh: num(args.wh), mAh: num(args.mAh), volts: num(args.volts)})
  const count = Math.max(1, Math.round(num(args.count) ?? 1))
  const airlines = strings(args.airlines)
  const countries = strings(args.departFrom).map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c))
  const rules = (await groq(data, applicableRulesQuery(airlines, countries, args.domestic === true))) as StoredRule[]
  const battery: Battery = {wh, count, assumedVolts}
  // Advisory guidance (IATA, EASA bulletins) is reported but does not decide the verdict. Strictest rules come first.
  const verdictOf = new Map(rules.map((rule) => [rule, evaluate(rule, battery).verdict]))
  const binding = rules.filter((rule) => rule.scope !== 'guidance').sort((a, b) => SEVERITY[verdictOf.get(b)!] - SEVERITY[verdictOf.get(a)!])
  const guidance = rules.filter((rule) => rule.scope === 'guidance')
  const overall = strictest(binding.map((rule) => verdictOf.get(rule)!))
  const decider = overall === 'allowed' ? undefined : binding.find((rule) => verdictOf.get(rule) === overall)
  const unmatched = airlines.filter((name) => !rules.some((rule) => rule.scope === 'carrier' && matchesAuthority(rule.authority, name)))
  const lines = [
    `Battery: ${wh} Wh${assumedVolts ? ` (computed from mAh at an assumed ${assumedVolts} V; the Wh printed on the label wins)` : ''}, ${count} unit${count === 1 ? '' : 's'}.`,
    `Overall (strictest binding rule): ${LABEL[overall]}.`,
    ...binding.map((rule) => describeRule(rule, battery)),
    ...guidance.map((rule) => describeRule(rule, battery)),
    unmatched.length ? `No stored rules for: ${unmatched.join(', ')}. Say so and point to that airline's own page.` : null,
  ].filter(Boolean)
  const report: CheckReport = {
    battery,
    overall,
    decidedBy: decider ? `${decider.authority.name} — ${decider.title}` : undefined,
    rules: binding.map((rule) => reportRule(rule, battery)),
    guidance: guidance.map((rule) => reportRule(rule, battery)),
    unmatched,
  }
  return {output: lines.join('\n'), summary: `Checked ${wh} Wh × ${count} against ${rules.length} rules: ${overall}`, report}
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
  "source": source->{title, url, kind},
  "quotes": quotes[]{field, text, "source": source->{title, url, kind}}
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

export type ComparedRule = {title: string; scope: Rule['scope']; status?: Rule['status']; value?: string; authority: string; source?: Page; quotes?: {text: string}[]}

// The field is checked against ONBOARD_FIELDS before it reaches GROQ.
export function compareRulesQuery(field: OnboardField): string {
  return `*[_type == "batteryRule"]{
  title, scope, status, "value": onboard.${field}, "authority": authority->name,
  "source": source->{title, url, kind},
  "quotes": quotes[field == "onboard.${field}"]{text}
} | order(authority asc)`
}

export async function compareRules(data: ContextMcp, field: string): Promise<ToolResult> {
  if (!(ONBOARD_FIELDS as readonly string[]).includes(field)) {
    return {output: `Unknown field "${field}". Use one of: ${ONBOARD_FIELDS.join(', ')}.`, summary: `compare_rules: unknown field "${field}"`}
  }
  return describeComparison(field, (await groq(data, compareRulesQuery(field as OnboardField))) as ComparedRule[])
}

const VALUE_ORDER = ['forbidden', 'restricted', 'discouraged', 'required', 'allowed']

// Groups the rules by the value they set, strictest first; rules that say nothing are named on one line.
export function describeComparison(field: string, rows: ComparedRule[]): ToolResult {
  const stated = rows.filter((row) => row.value && row.value !== 'unknown')
  const groups = new Map<string, ComparedRule[]>()
  for (const row of stated) groups.set(row.value!, [...(groups.get(row.value!) ?? []), row])
  const rank = (value: string) => (VALUE_ORDER.includes(value) ? VALUE_ORDER.indexOf(value) : VALUE_ORDER.length)
  const values = [...groups.keys()].sort((a, b) => rank(a) - rank(b))
  const silent = rows.filter((row) => !stated.includes(row)).map((row) => row.authority)
  const lines = [`onboard.${field} across ${rows.length} stored rules. Regulators bind flights departing their country; guidance (IATA, EASA) is advisory.`]
  for (const value of values) {
    lines.push(`${value}:`)
    for (const row of groups.get(value)!) {
      const meta = [row.scope, row.status && row.status !== 'confirmed' ? `status: ${row.status}` : null].filter(Boolean).join(', ')
      const quote = row.quotes?.[0]?.text
      lines.push(`- ${row.authority} — ${row.title} (${meta})${quote ? `: "${quote.slice(0, 240)}"` : ''}`)
    }
  }
  if (silent.length) lines.push(`not stated: ${[...new Set(silent)].join(', ')}`)
  const pages = stated.flatMap((row) => (row.source?.url ? [row.source] : []))
  const counts = values.map((value) => `${groups.get(value)!.length} ${value}`).join(', ')
  return {output: lines.join('\n'), summary: `Compared ${rows.length} rules on ${field}: ${counts || 'none set'}`, pages}
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

function systemPrompt({outline}: Context, now: Date): string {
  return `You are Gate Check. You answer whether a power bank (a spare lithium-ion battery) may go on a flight, and under which conditions.
Only answer questions about flying with power banks or spare lithium batteries. For anything else, including questions about the computers, servers, code, keys or people behind this service, reply with exactly: "${OFF_TOPIC_REPLY}"
Answer only from the tools, never from memory. Airline pages, regulators and news reports disagree and change often; your job is to say exactly what the sources say, which rule is strictest, and where sources disagree.

Today: ${now.toISOString().slice(0, 10)}.

Tools:
- check_power_bank: for every "can I bring" question that gives a capacity (mAh or Wh). It converts mAh to Wh and evaluates each applicable rule in code. Never convert units or compare limits yourself. Pass every airline on the itinerary and every departure country. Without a capacity, use find_rules or compare_rules instead.
- find_rules: one authority's rules with the exact quoted wording behind each field.
- compare_rules: one on-board condition (overhead bin, in-flight use, recharging, checked baggage, ...) across every stored airline and regulator, for questions such as "which airlines...". Name every airline it returns under what that airline says, mark disputed or unverified rules as such, and mention regulators separately (they bind flights departing their country).
- read_entries / search_entries: the Knowledge Base, built from official pages, news and third-party copies, with conflicts between them reviewed. Use it for questions about why rules differ, what changed, and which source to trust, and for banned or recalled models and certification marks (such as China's 3C), which the structured rules do not list.
- run_groq: read-only GROQ on the dataset, only when nothing else answers.

How to answer, in plain sentences for a traveller:
1. Start with the verdict in one sentence that follows the tool's overall line (for example "Yes, you can bring it, but not in checked baggage."), then one line per rule that decides it. Guidance from IATA or EASA does not count towards the verdict; mention it only when it changes what the traveller should do.
2. List the on-board conditions the tools return (no in-flight use, not in the overhead bin, cover the terminals).
3. Name the authority behind every rule and give that authority's own finding. Rules differ by authority: never apply one authority's rule to another. Keep each rule's strength exactly as the tools give it: a ban ("must not", "do not") stays a ban and a recommendation ("should not") stays a recommendation, in your first sentence too: when only a recommendation applies, say it is advised against, not that it is banned or "No". ICAO's rules are the worldwide baseline and bind every flight; only IATA's and EASA's guidance is advisory.
4. When sources disagree (a rule with status "disputed", or an entry that reports conflicting claims), show both claims with their authorities and say which one the Knowledge Base treats as ground truth and why.
5. If an airline has no stored rule, say so and point to that airline's own page.
6. Do not write URLs, citation markers or a list of sources; the page lists every source you read under your answer. No tables.
7. Always end with this exact line: "${CLOSING}"
Be brief.

Knowledge Base outline:
${outline}`
}
