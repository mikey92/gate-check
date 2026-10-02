import {ask, checkPowerBank, type Env as AgentEnv} from './agent.ts'
import {ContextMcp} from './mcp.ts'
import {page} from './page.ts'

type Env = AgentEnv & {LIMITER?: RateLimit}

const MAX_QUESTION = 500

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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

    if (request.method === 'POST' && (url.pathname === '/api/ask' || url.pathname === '/api/check')) {
      const client = request.headers.get('cf-connecting-ip') ?? 'unknown'
      if (env.LIMITER && !(await env.LIMITER.limit({key: client})).success) {
        return json({error: 'Too many requests in a minute. Try again shortly.'}, 429)
      }
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      const started = Date.now()
      try {
        // /api/check runs the rule engine directly, with no model: the same tool the agent calls.
        if (url.pathname === '/api/check') {
          const data = new ContextMcp(env.DATA_MCP_URL, env.SANITY_CONTEXT_TOKEN)
          const {output} = await checkPowerBank(data, body)
          return json({result: output, ms: Date.now() - started})
        }
        const question = typeof body.question === 'string' ? body.question.trim() : ''
        if (!question || question.length > MAX_QUESTION) {
          return json({error: `Ask a question of 1 to ${MAX_QUESTION} characters.`}, 400)
        }
        const answer = await ask(env, question)
        return json({...answer, ms: Date.now() - started})
      } catch (error) {
        console.error(error)
        const message = error instanceof Error ? error.message : 'Unknown error'
        return json({error: message.startsWith('Give the capacity') ? message : 'The agent failed to answer. Please try again.'}, 502)
      }
    }

    return new Response('Not found', {status: 404})
  },
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json'}})
}
