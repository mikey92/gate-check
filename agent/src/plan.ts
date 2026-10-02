// The model on the owner's ChatGPT plan. chatgpt.com refuses calls from Cloudflare Workers, so the Worker sends
// each Responses call to the relay on the owner's machine (relay/plan-relay.mjs, behind a Cloudflare tunnel),
// which holds the plan's tokens and forwards the call to the Codex Responses endpoint.

export type PlanEnv = {PLAN_RELAY_URL?: string; PLAN_RELAY_KEY?: string}
export type ResponseItem = Record<string, any>
export type ResponseResult = {output: ResponseItem[]; usage?: {input_tokens?: number; output_tokens?: number}}

export function planConnected(env: PlanEnv): boolean {
  return Boolean(env.PLAN_RELAY_URL && env.PLAN_RELAY_KEY)
}

// One Responses call. The endpoint only streams, and its response.completed event leaves the output out,
// so the items are collected from response.output_item.done events.
export async function respond(env: PlanEnv, body: Record<string, unknown>): Promise<ResponseResult> {
  const res = await fetch(`${env.PLAN_RELAY_URL}/responses`, {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-relay-key': env.PLAN_RELAY_KEY ?? ''},
    body: JSON.stringify({...body, store: false, stream: true}),
  })
  if (!res.ok || !res.body) throw new Error(`ChatGPT plan HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return readCompleted(res.body)
}

export async function readCompleted(body: ReadableStream<Uint8Array>): Promise<ResponseResult> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader()
  const items: ResponseItem[] = []
  let buffer = ''
  for (;;) {
    const {value, done} = await reader.read()
    if (value) buffer += value
    let end: number
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('')
      if (!data || data === '[DONE]') continue
      const event = JSON.parse(data) as {type?: string; item?: ResponseItem; response?: ResponseResult & {error?: {message?: string}}; message?: string}
      if (event.type === 'response.output_item.done' && event.item) items.push(event.item)
      if (event.type === 'response.completed' && event.response) {
        return {output: items.length ? items : (event.response.output ?? []), usage: event.response.usage}
      }
      if (event.type === 'response.failed' || event.type === 'error') {
        throw new Error(`ChatGPT plan: ${event.response?.error?.message ?? event.message ?? event.type}`)
      }
    }
    if (done) throw new Error('ChatGPT plan: the stream ended before the response completed')
  }
}

// Items go back as input on the next turn. With store off, the server keeps nothing, so their ids are dropped.
export function replayable(output: ResponseItem[]): ResponseItem[] {
  return output.map(({id, ...item}) => item)
}

export function outputText(output: ResponseItem[]): string {
  return output
    .filter((item) => item.type === 'message')
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text)
    .join('')
}
