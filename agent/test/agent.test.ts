import {test} from 'node:test'
import assert from 'node:assert/strict'
import {parseMessage} from '../src/mcp.ts'
import {applicableRulesQuery, compareRules, CLOSING, describeComparison, finishAnswer, kbSourceTitles, normalize, reportRule, rulesForAuthorityQuery} from '../src/agent.ts'
import {describeRule, evaluate, strictest, toWattHours, type Finding, type Rule} from '../src/rules.ts'

const texts = (findings: Finding[]) => findings.map((finding) => finding.text)

const iata: Rule = {
  title: 'Spare lithium batteries',
  authority: {name: 'IATA', kind: 'industry'},
  scope: 'worldwide',
  limits: {freeMaxWh: 100, approvalMaxWh: 160, approvalMaxCount: 2},
  onboard: {checkedBaggage: 'forbidden', protection: 'required'},
}
const strictAirline: Rule = {
  title: 'Power banks on board',
  authority: {name: 'Example Air', kind: 'airline'},
  scope: 'carrier',
  status: 'disputed',
  limits: {freeMaxWh: 100, approvalMaxWh: 160, approvalMaxCount: 2, totalMaxCount: 5},
  onboard: {useInFlight: 'forbidden', overheadBin: 'forbidden'},
}

test('converts mAh to Wh at the label voltage, or at an assumed 3.7 V', () => {
  assert.deepEqual(toWattHours({mAh: 20000}), {wh: 74, assumedVolts: 3.7})
  assert.deepEqual(toWattHours({mAh: 26800, volts: 3.6}), {wh: 96.5})
  assert.deepEqual(toWattHours({wh: 99.9, mAh: 27000}), {wh: 99.9})
  assert.throws(() => toWattHours({}), /Give the capacity/)
})

test('places a battery in the free band, the approval band or over the maximum', () => {
  assert.equal(evaluate(iata, {wh: 74, count: 3}).verdict, 'allowed')
  assert.equal(evaluate(iata, {wh: 130, count: 2}).verdict, 'approval')
  assert.equal(evaluate(iata, {wh: 130, count: 3}).verdict, 'forbidden')
  assert.equal(evaluate(iata, {wh: 161, count: 1}).verdict, 'forbidden')
  assert.equal(evaluate({...iata, limits: {}}, {wh: 50, count: 1}).verdict, 'conditions')
})

test('applies a total count cap and lists on-board conditions', () => {
  const result = evaluate(strictAirline, {wh: 74, count: 6})
  assert.equal(result.verdict, 'forbidden')
  assert.match(texts(result.reasons).join(' '), /6 power banks is more than the 5 allowed/)
  assert.deepEqual(texts(result.advisories), ['do not use it to charge devices during the flight', 'keep it with you, not in the overhead bin'])
  assert.equal(evaluate(strictAirline, {wh: 130, count: 3}).verdict, 'forbidden')
})

test('the strictest rule wins across legs', () => {
  assert.equal(strictest(['allowed', 'approval', 'allowed']), 'approval')
  assert.equal(strictest(['allowed', 'unknown']), 'unknown')
  assert.equal(strictest(['approval', 'forbidden']), 'forbidden')
  assert.equal(strictest(['conditions', 'conditions']), 'allowed')
  assert.equal(strictest([]), 'allowed')
})

test('handles a ceiling with no stated approval, and conditions-only rules', () => {
  const japan: Rule = {title: 'Mobile batteries', authority: {name: 'MLIT', kind: 'regulator'}, scope: 'departing', limits: {maxWh: 160, totalMaxCount: 2}}
  const within = evaluate(japan, {wh: 130, count: 2})
  assert.equal(within.verdict, 'allowed')
  assert.match(within.reasons[0].text, /does not say whether approval is needed above 100 Wh/)
  assert.equal(evaluate(japan, {wh: 161, count: 1}).verdict, 'forbidden')
  assert.equal(evaluate(japan, {wh: 50, count: 3}).verdict, 'forbidden')
  const ccc: Rule = {title: '3C mark', authority: {name: 'CAAC', kind: 'regulator'}, scope: 'domestic', onboard: {certification: 'CCC (3C) mark'}}
  const result = evaluate(ccc, {wh: 74, count: 1})
  assert.equal(result.verdict, 'conditions')
  assert.deepEqual(texts(result.advisories), ['it must carry the CCC (3C) mark'])
})

test('separates recommendations from bans', () => {
  const icao: Rule = {title: 'Power banks', authority: {name: 'ICAO', kind: 'regulator'}, scope: 'worldwide', onboard: {useInFlight: 'discouraged', rechargeInFlight: 'forbidden'}}
  assert.deepEqual(texts(evaluate(icao, {wh: 74, count: 1}).advisories), ['it should not be used to charge devices in flight (a recommendation)', 'do not recharge it from seat power'])
  const delta: Rule = {title: 'Power banks', authority: {name: 'Delta', kind: 'airline'}, scope: 'carrier', limits: {freeMaxWh: 100, totalMaxCount: 2}, onboard: {useInFlight: 'restricted'}}
  assert.equal(evaluate(delta, {wh: 130, count: 1}).verdict, 'forbidden')
  assert.deepEqual(texts(evaluate(delta, {wh: 74, count: 1}).advisories), ['do not use it to charge devices during taxi, take-off or landing'])
})

test('names the fields behind each finding, including which count limit applied', () => {
  assert.deepEqual(evaluate(iata, {wh: 74, count: 1}).reasons, [{text: '74 Wh is within the 100 Wh no-approval limit', fields: ['limits.freeMaxWh']}])
  assert.deepEqual(evaluate(iata, {wh: 130, count: 3}).reasons.map((reason) => reason.fields), [['limits.freeMaxWh', 'limits.approvalMaxWh'], ['limits.approvalMaxCount']])
  assert.deepEqual(evaluate(strictAirline, {wh: 74, count: 6}).reasons[1].fields, ['limits.totalMaxCount'])
  assert.deepEqual(evaluate(strictAirline, {wh: 74, count: 1}).advisories.map((advisory) => advisory.fields), [['onboard.useInFlight'], ['onboard.overheadBin']])
})

test('attaches the quoted wording behind each finding to the report', () => {
  const policy = {title: 'Policy page', url: 'https://example.com/policy'}
  const rule = {
    ...strictAirline,
    limits: {freeMaxWh: 100, totalMaxCount: 1},
    quotes: [
      {field: 'limits.freeMaxWh', text: 'up to 100 Wh', source: policy},
      {field: 'limits.totalMaxCount', text: 'one power bank per passenger', source: policy},
      {field: 'onboard.overheadBin', text: 'not in the overhead bin', source: policy},
    ],
  }
  const report = reportRule(rule, {wh: 74, count: 2})
  assert.equal(report.verdict, 'forbidden')
  assert.deepEqual(report.reasons.map((reason) => reason.quotes.map((quote) => quote.text)), [['up to 100 Wh'], ['one power bank per passenger']])
  assert.deepEqual(report.advisories.map((advisory) => advisory.quotes.length), [0, 1])
  assert.equal(report.status, 'disputed')
})

test('describes a rule with its status', () => {
  const text = describeRule(strictAirline, {wh: 74, count: 1})
  assert.match(text, /^- Example Air — Power banks on board \(carrier, status: disputed\): ALLOWED\./)
  assert.match(text, /Also: do not use it to charge devices during the flight/)
})

test('user text enters GROQ only as escaped string literals', () => {
  const query = applicableRulesQuery(['Korean Air', 'x") || true || ("'], ['KR', 'US'], false)
  assert.match(query, /authority->name match "Korean Air"/)
  assert.match(query, /authority->name match "x\\"\) \|\| true \|\| \(\\""/)
  assert.match(query, /scope in \["worldwide", "guidance"\]/)
  assert.match(query, /scope == "departing" && authority->country in \["KR","US"\]/)
  assert.doesNotMatch(query, /scope == "domestic"/)
  assert.match(rulesForAuthorityQuery('OZ'), /lower\(@\) == lower\("OZ"\)/)
})

test('lines one on-board condition up across authorities, strictest first', () => {
  const page = {title: 'Policy', url: 'https://example.com/policy'}
  const result = describeComparison('overheadBin', [
    {title: 'Guidance', scope: 'guidance', status: 'disputed', value: 'discouraged', authority: 'EASA', source: page, quotes: [{text: 'should not be stowed in overhead bins'}]},
    {title: 'Power banks', scope: 'carrier', status: 'confirmed', value: 'forbidden', authority: 'Korean Air', source: page, quotes: [{text: 'not in the overhead bin'}]},
    {title: 'Rules', scope: 'carrier', value: 'unknown', authority: 'ANA'},
    {title: 'Rules', scope: 'departing', authority: 'FAA', source: {title: 'PackSafe', url: 'https://example.com/faa'}},
  ])
  assert.deepEqual(result.output.split('\n').slice(1), [
    'forbidden:',
    '- Korean Air — Power banks (carrier): "not in the overhead bin"',
    'discouraged:',
    '- EASA — Guidance (guidance, status: disputed): "should not be stowed in overhead bins"',
    'not stated: ANA, FAA',
  ])
  assert.equal(result.summary, 'Compared 4 rules on overheadBin: 1 forbidden, 1 discouraged')
  assert.deepEqual(result.pages, [page, page])
})

test('compare_rules only queries known on-board fields', async () => {
  const data = {callTool: () => assert.fail('no query for an unknown field')}
  const result = await compareRules(data as never, 'overheadBin}[0..9999]{...')
  assert.match(result.output, /^Unknown field/)
})

test('strips citation markers and always ends with the closing line', () => {
  assert.equal(finishAnswer('The FAA does not ban it【national_regulators/usa】.'), `The FAA does not ban it.\n\n${CLOSING}`)
  assert.equal(finishAnswer(`Yes.\n\n${CLOSING}`), `Yes.\n\n${CLOSING}`)
})

test('reads the cited document titles from Knowledge Base entries', () => {
  const entries = [
    '# Japan MLIT Rules', '', 'Body [1][2].', '', '## Sources', '', '1. New rules for mobile batteries from 24 April 2026 — Dataset',
    '2. ICAO Doc 9284 2025–2026 Edition, Addendum No. 1 (27/3/26) — draft text as reproduced in IATA operator guidance, Appendix C — Dataset', '',
    '# Korean carriers', '', '## Sources', '', '1. Korean Air restricted items: power banks — Dataset', '',
  ].join('\n')
  assert.deepEqual(kbSourceTitles(entries), [
    'New rules for mobile batteries from 24 April 2026',
    'ICAO Doc 9284 2025–2026 Edition, Addendum No. 1 (27/3/26) — draft text as reproduced in IATA operator guidance, Appendix C',
    'Korean Air restricted items: power banks',
  ])
  assert.deepEqual(kbSourceTitles('# No sources here'), [])
})

test('reads JSON-RPC from plain JSON and from an event stream', () => {
  assert.deepEqual(parseMessage('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}').result, {ok: true})
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n\n'
  assert.deepEqual(parseMessage(sse).result, {tools: []})
})

test('normalizes both Workers AI response shapes', () => {
  const classic = normalize({response: null, tool_calls: [{name: 'check_power_bank', arguments: {mAh: 20000}}]})
  assert.deepEqual(classic.calls, [{id: 'call_0', name: 'check_power_bank', args: {mAh: 20000}}])
  const openai = normalize({choices: [{message: {content: 'Hi', tool_calls: [{id: 'a1', function: {name: 'read_entries', arguments: '{"paths":["x"]}'}}]}}]})
  assert.equal(openai.text, 'Hi')
  assert.deepEqual(openai.calls, [{id: 'a1', name: 'read_entries', args: {paths: ['x']}}])
})
