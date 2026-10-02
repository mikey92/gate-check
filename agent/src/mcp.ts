// A small client for Sanity Context MCP (streamable HTTP, JSON-RPC 2.0).
// Context MCP is read-only and stateless, so each call is one POST.

export type ToolResult = {text: string; isError: boolean}

export class ContextMcp {
  private nextId = 1
  private readonly url: string
  private readonly token: string

  constructor(url: string, token: string) {
    this.url = url
    this.token = token
  }

  async listTools(): Promise<{name: string; description?: string}[]> {
    const result = await this.request('tools/list')
    return result.tools ?? []
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const result = await this.request('tools/call', {name, arguments: args})
    const text = (result.content ?? [])
      .filter((part: {type: string}) => part.type === 'text')
      .map((part: {text: string}) => part.text)
      .join('\n')
    return {text, isError: Boolean(result.isError)}
  }

  private async request(method: string, params?: Record<string, unknown>) {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({jsonrpc: '2.0', id: this.nextId++, method, params}),
    })
    const body = await response.text()
    if (!response.ok) {
      throw new Error(`Context MCP ${method} failed with ${response.status}: ${body.slice(0, 300)}`)
    }
    const message = parseMessage(body)
    if (message.error) {
      throw new Error(`Context MCP ${method} error ${message.error.code}: ${message.error.message}`)
    }
    return message.result
  }
}

// The server may answer with plain JSON or with a server-sent event stream that carries the JSON.
export function parseMessage(body: string) {
  const trimmed = body.trim()
  if (trimmed.startsWith('{')) return JSON.parse(trimmed)
  const data = trimmed
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
  const last = data.at(-1)
  if (!last) throw new Error(`Context MCP returned no JSON-RPC message: ${trimmed.slice(0, 200)}`)
  return JSON.parse(last)
}
