// Forwards the Worker's model calls to the owner's ChatGPT plan. chatgpt.com refuses calls from Cloudflare Workers,
// so the Worker sends them here, through a Cloudflare tunnel, and this relay calls the Codex Responses endpoint
// from the owner's machine. The OAuth tokens never leave this machine and are never logged.
//
//   PORT              local port the tunnel points at (default 8811; the relay listens on 127.0.0.1 only)
//   CODEX_AUTH        auth.json from `CODEX_HOME=<dir> codex login`, refreshed here before it expires
//   RELAY_KEY_FILE    shared key; the Worker sends it as x-relay-key (PLAN_RELAY_KEY secret)
//   END_AT            when to stop for good (ISO time); the relay then exits 0, which launchd leaves stopped
//
// It runs under sandbox-exec (relay.sb): it can read only itself, its key and the token file, write only the token file,
// listen on 127.0.0.1 and make outbound HTTPS calls. It runs no commands and touches nothing else on the machine.
import {createServer} from 'node:http'
import {readFileSync, writeFileSync, renameSync} from 'node:fs'
import {timingSafeEqual} from 'node:crypto'
import {Readable} from 'node:stream'

const PORT = Number(process.env.PORT ?? 8811)
const AUTH_FILE = process.env.CODEX_AUTH
const KEY = readFileSync(process.env.RELAY_KEY_FILE, 'utf8').trim()
const ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann' // Codex's OAuth client, which issued the tokens
const REFRESH_BEFORE_MS = 2 * 24 * 60 * 60 * 1000
const MAX_BODY = 4 * 1024 * 1024
const MAX_PER_MINUTE = 60 // a ceiling on the plan's use even if the key leaked; the Worker limits each visitor too
const END_AT = process.env.END_AT ? Date.parse(process.env.END_AT) : Infinity

let refreshing
const recent = []

function readAuth() {
  return JSON.parse(readFileSync(AUTH_FILE, 'utf8'))
}

function expiresAt(jwt) {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).exp * 1000
}

// Returns usable tokens, refreshing them (once, however many requests are waiting) when they are about to expire.
async function currentAuth() {
  const auth = readAuth()
  if (expiresAt(auth.tokens.access_token) - Date.now() > REFRESH_BEFORE_MS) return auth
  refreshing ??= refresh(auth).finally(() => (refreshing = undefined))
  return refreshing
}

async function refresh(auth) {
  const res = await fetch('https://auth.openai.com/oauth/token', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: auth.tokens.refresh_token, scope: 'openid profile email'}),
  })
  if (!res.ok) throw new Error(`token refresh failed: HTTP ${res.status}`)
  const data = await res.json()
  const next = {
    ...auth,
    tokens: {
      ...auth.tokens,
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? auth.tokens.refresh_token,
      id_token: data.id_token ?? auth.tokens.id_token,
    },
    last_refresh: new Date().toISOString(),
  }
  writeFileSync(`${AUTH_FILE}.tmp`, JSON.stringify(next, null, 2), {mode: 0o600})
  renameSync(`${AUTH_FILE}.tmp`, AUTH_FILE)
  log('refreshed the access token')
  return next
}

function log(message) {
  console.log(`${new Date().toISOString()} ${message}`)
}

function keyMatches(given) {
  const a = Buffer.from(String(given ?? ''))
  const b = Buffer.from(KEY)
  return a.length === b.length && timingSafeEqual(a, b)
}

function underLimit() {
  const now = Date.now()
  while (recent.length && now - recent[0] > 60_000) recent.shift()
  if (recent.length >= MAX_PER_MINUTE) return false
  recent.push(now)
  return true
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('request too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function reply(res, status, text) {
  res.writeHead(status, {'content-type': 'text/plain'})
  res.end(text)
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return reply(res, 200, 'ok')
  if (req.method !== 'POST' || req.url !== '/responses') return reply(res, 404, 'not found')
  if (!keyMatches(req.headers['x-relay-key'])) return reply(res, 401, 'unauthorized')
  if (!underLimit()) return reply(res, 429, 'too many requests')
  const started = Date.now()
  try {
    const body = await readBody(req)
    const auth = await currentAuth()
    const upstream = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${auth.tokens.access_token}`,
        'chatgpt-account-id': auth.tokens.account_id,
        'OpenAI-Beta': 'responses=experimental',
        originator: 'gate_check',
      },
      body,
    })
    res.writeHead(upstream.status, {'content-type': upstream.headers.get('content-type') ?? 'text/plain', 'cache-control': 'no-cache'})
    res.on('finish', () => log(`POST /responses ${upstream.status} ${Date.now() - started} ms`))
    if (upstream.body) Readable.fromWeb(upstream.body).pipe(res)
    else res.end()
  } catch (error) {
    log(`POST /responses failed: ${error.message}`)
    if (!res.headersSent) reply(res, 502, 'relay error')
    else res.end()
  }
})

function stopIfOver() {
  if (Date.now() < END_AT) return
  log('past END_AT; stopping for good')
  process.exit(0)
}
stopIfOver()
setInterval(stopIfOver, 10 * 60 * 1000)
server.listen(PORT, '127.0.0.1', () => log(`plan relay on 127.0.0.1:${PORT}, until ${process.env.END_AT ?? 'stopped'}`))
