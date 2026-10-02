import {ask, checkPowerBank, CLOSING, type AgentEvent, type Answer, type Env as AgentEnv} from './agent.ts'
import {ContextMcp} from './mcp.ts'
import {page} from './page.ts'

// DEBUG_ERRORS is only set on preview versions, to see why a model call failed.
// ANSWERS keeps finished answers by model and question, so a repeated question (such as the examples on the page) answers at once.
type Env = AgentEnv & {LIMITER?: RateLimit; DEBUG_ERRORS?: string; ANSWERS?: KVNamespace}
type Result = Answer & {ms: number; cached?: boolean}

const MAX_QUESTION = 500
const ANSWER_TTL_SECONDS = 30 * 24 * 60 * 60

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(page, {headers: {'content-type': 'text/html; charset=utf-8'}})
    }

    if (request.method === 'GET' && url.pathname === '/api/authorities') {
      const data = new ContextMcp(env.DATA_MCP_URL, env.SANITY_CONTEXT_TOKEN)
      const result = await data.callTool('groq_query', {
        query: '*[_type == "authority" && count(*[_type == "batteryRule" && references(^._id)]) > 0] | order(kind asc, name asc){name, kind, country, codes}',
      })
      return json(JSON.parse(result.text).result ?? [])
    }

    if (request.method !== 'POST' || (url.pathname !== '/api/ask' && url.pathname !== '/api/check')) {
      return new Response('Not found', {status: 404})
    }
    const client = request.headers.get('cf-connecting-ip') ?? 'unknown'
    if (env.LIMITER && !(await env.LIMITER.limit({key: client})).success) {
      return json({error: 'Too many requests in a minute. Try again shortly.'}, 429)
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const started = Date.now()

    // /api/check runs the rule engine directly, with no model: the same tool the agent calls.
    if (url.pathname === '/api/check') {
      try {
        const data = new ContextMcp(env.DATA_MCP_URL, env.SANITY_CONTEXT_TOKEN)
        const {output, report} = await checkPowerBank(data, body)
        return json({result: output, report, ms: Date.now() - started})
      } catch (error) {
        return json(errorBody(error, env), 502)
      }
    }

    const question = typeof body.question === 'string' ? body.question.trim() : ''
    if (!question || question.length > MAX_QUESTION) {
      return json({error: `Ask a question of 1 to ${MAX_QUESTION} characters.`}, 400)
    }
    // Preview versions may try other models or reasoning levels per request (planModel "" skips the ChatGPT plan),
    // and skip the answer cache with "fresh".
    const preview = Boolean(env.DEBUG_ERRORS)
    const pick = (name: string, fallback?: string) => (preview && typeof body[name] === 'string' ? (body[name] as string) || undefined : fallback)
    const model = pick('model', env.MODEL) ?? env.MODEL
    const planModel = pick('planModel', env.PLAN_MODEL)
    const settings = {...env, MODEL: model, REASONING: pick('reasoning', env.REASONING), PLAN_MODEL: planModel, PLAN_EFFORT: pick('planEffort', env.PLAN_EFFORT)}
    // Only answers from the intended model are kept, not ones from the Workers AI fallback.
    const intended = planModel ? `${planModel} (ChatGPT plan)` : model
    const store = preview && body.fresh === true ? undefined : env.ANSWERS
    const key = await answerKey(planModel ?? model, question)
    const answer = async (onEvent: (event: AgentEvent) => void): Promise<Result> => {
      const cached = await store?.get<Result>(key, 'json')
      if (cached) return {...cached, cached: true}
      const result = {...(await ask(settings, question, onEvent)), ms: Date.now() - started}
      if (store && result.model === intended && result.answer.replace(CLOSING, '').trim().length > 20) {
        ctx.waitUntil(store.put(key, JSON.stringify(result), {expirationTtl: ANSWER_TTL_SECONDS}))
      }
      return result
    }

    if (!(request.headers.get('accept') ?? '').includes('text/event-stream')) {
      try {
        return json(await answer(() => {}))
      } catch (error) {
        return json(errorBody(error, env), 502)
      }
    }

    // Server-sent events: each tool call as it finishes, the rule engine's verdict as soon as it exists, then the answer.
    const {readable, writable} = new TransformStream()
    const writer = writable.getWriter()
    const encoder = new TextEncoder()
    const send = async (event: string, data: unknown) => {
      try {
        await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      } catch {
        // The reader went away; the answer is still cached for next time.
      }
    }
    ctx.waitUntil(
      (async () => {
        try {
          const result = await answer((event) => void send(event.type, event.type === 'step' ? event.step : event.report))
          if (result.cached) {
            for (const step of result.steps) await send('step', step)
            if (result.report) await send('report', result.report)
          }
          await send('answer', result)
        } catch (error) {
          await send('error', errorBody(error, env))
        } finally {
          await writer.close().catch(() => {})
        }
      })(),
    )
    return new Response(readable, {headers: {'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache'}})
  },
}

async function answerKey(model: string, question: string): Promise<string> {
  const normalized = question.toLowerCase().replace(/\s+/g, ' ').trim()
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${model}\n${normalized}`))
  return `answer:v2:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

function errorBody(error: unknown, env: Env) {
  console.error(error)
  const message = error instanceof Error ? error.message : 'Unknown error'
  const shown = message.startsWith('Give the capacity')
    ? message
    : /4006|daily free allocation/i.test(message)
      ? "Today's free AI allowance is used up. The quick check above works without AI, and the agent is back after 00:00 UTC."
      : 'The agent failed to answer. Please try again.'
  return env.DEBUG_ERRORS ? {error: shown, detail: message} : {error: shown}
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json'}})
}
