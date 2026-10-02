// Builds data/dataset.ndjson for `sanity dataset import` from:
//   data/authorities.json  airlines, regulators and industry bodies
//   data/rules.json        one structured rule per authority and scope; each quote names a source and a statement key
//   data/sources/*.md      captured pages: key: value front matter between --- fences, the excerpt, then
//                          "Statements quoted from this page:" with one `- Label: "text"` line per statement
// Quote text is copied from the source file, never typed twice, and every reference is checked,
// so a typo in a slug or a statement key fails the build instead of importing a dangling link.
import {readFileSync, readdirSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

const root = new URL('..', import.meta.url).pathname
const sourceDir = join(root, 'data/sources')
let keyCounter = 0
const key = () => `k${(keyCounter++).toString(36).padStart(4, '0')}`

const STATEMENTS_HEADING = 'Statements quoted from this page:'
const STATEMENT_LABELS = {
  maxWhNoApproval: 'Limit without approval',
  maxWhWithApproval: 'Limit with approval',
  count: 'Number allowed',
  carryOnOnly: 'Carry-on or checked',
  inflightUse: 'Using it in flight',
  inflightCharging: 'Recharging it in flight',
  overheadBin: 'Overhead bin',
  protection: 'Terminal protection',
  certification: 'Certification',
  labelling: 'Labelling',
  mAhToWh: 'mAh to Wh',
  effectiveDate: 'Effective date',
}

function parseStatements(file, body) {
  const at = body.indexOf(STATEMENTS_HEADING)
  if (at === -1) return {}
  const statements = {}
  for (const line of body.slice(at + STATEMENTS_HEADING.length).split('\n')) {
    if (!line.trim()) continue
    const match = line.match(/^- ([^:]+): "(.*)"$/)
    if (!match) throw new Error(`${file}: unreadable statement line: ${line}`)
    statements[match[1]] = match[2]
  }
  return statements
}

function parseSource(file) {
  const text = readFileSync(join(sourceDir, file), 'utf8')
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) throw new Error(`${file}: missing front matter`)
  const meta = Object.fromEntries(
    match[1].split('\n').map((line) => {
      const at = line.indexOf(':')
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()]
    }),
  )
  for (const field of ['title', 'url', 'kind', 'language', 'capturedAt', 'authority']) {
    if (!meta[field]) throw new Error(`${file}: missing ${field}`)
  }
  const body = match[2].trim()
  return {slug: file.replace(/\.md$/, ''), meta, body, statements: parseStatements(file, body)}
}

const span = (text) => ({_type: 'span', _key: key(), text, marks: []})

function toBlocks(markdown) {
  return markdown
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .flatMap((chunk) => {
      const lines = chunk.split('\n')
      if (lines.every((line) => line.startsWith('- '))) {
        return lines.map((line) => ({
          _type: 'block',
          _key: key(),
          style: 'normal',
          listItem: 'bullet',
          level: 1,
          markDefs: [],
          children: [span(line.slice(2))],
        }))
      }
      const heading = chunk.match(/^(#{1,4})\s+(.*)$/)
      return [
        {
          _type: 'block',
          _key: key(),
          style: heading ? `h${Math.min(heading[1].length + 1, 4)}` : 'normal',
          markDefs: [],
          children: [span(heading ? heading[2] : chunk.replace(/\n/g, ' '))],
        },
      ]
    })
}

const read = (name) => JSON.parse(readFileSync(join(root, 'data', name), 'utf8'))
const authorities = read('authorities.json')
const rules = read('rules.json')
const sources = readdirSync(sourceDir).filter((file) => file.endsWith('.md')).sort().map(parseSource)
const sourceBySlug = new Map(sources.map((source) => [source.slug, source]))

const ids = {
  authority: new Set(authorities.map((a) => `authority-${a.slug}`)),
  source: new Set(sources.map((s) => `source-${s.slug}`)),
}
const ref = (type, slug) => {
  const id = `${type}-${slug}`
  if (!ids[type].has(id)) throw new Error(`Unknown ${type} "${slug}"`)
  return {_type: 'reference', _ref: id}
}

function quoteText(rule, quote) {
  const label = STATEMENT_LABELS[quote.key]
  if (!label) throw new Error(`${rule}: unknown statement key "${quote.key}"`)
  const text = sourceBySlug.get(quote.source)?.statements[label]
  if (!text) throw new Error(`${rule}: source "${quote.source}" has no "${label}" statement`)
  return text
}

const documents = [
  ...authorities.map(({slug, ...fields}) => ({
    _id: `authority-${slug}`,
    _type: 'authority',
    ...fields,
    slug: {_type: 'slug', current: slug},
  })),
  ...sources.map(({slug, meta, body}) => ({
    _id: `source-${slug}`,
    _type: 'source',
    title: meta.title,
    url: meta.url,
    kind: meta.kind,
    publisher: meta.publisher,
    language: meta.language,
    capturedAt: meta.capturedAt,
    lastUpdated: meta.lastUpdated,
    authority: ref('authority', meta.authority),
    body: toBlocks(body),
  })),
  ...rules.map(({slug, authority, source, quotes = [], ...fields}) => ({
    _id: `rule-${slug}`,
    _type: 'batteryRule',
    ...fields,
    authority: ref('authority', authority),
    source: ref('source', source),
    quotes: quotes.map((quote) => ({
      _key: key(),
      _type: 'quote',
      field: quote.field,
      text: quoteText(slug, quote),
      source: ref('source', quote.source),
    })),
  })),
]

writeFileSync(join(root, 'data/dataset.ndjson'), documents.map((doc) => JSON.stringify(doc)).join('\n') + '\n')
console.log(`Wrote ${documents.length} documents (${authorities.length} authorities, ${rules.length} rules, ${sources.length} sources)`)
