// Power bank arithmetic and rule evaluation, done in code so the model never guesses a threshold.

export type Scope = 'carrier' | 'departing' | 'domestic' | 'worldwide' | 'guidance'

export type Rule = {
  title: string
  authority: {name: string; kind: string; country?: string; codes?: string[]}
  scope: Scope
  effectiveFrom?: string
  status?: 'confirmed' | 'disputed' | 'unverified'
  limits?: {freeMaxWh?: number; approvalMaxWh?: number; maxWh?: number; freeMaxCount?: number; approvalMaxCount?: number; totalMaxCount?: number}
  onboard?: {
    checkedBaggage?: string
    useInFlight?: string
    rechargeInFlight?: string
    overheadBin?: string
    keepVisible?: string
    protection?: string
    labelRequired?: string
    certification?: string
  }
  note?: string
  source?: {title: string; url: string}
}

export type Battery = {wh: number; count: number; assumedVolts?: number}
// "conditions": the rule sets no capacity limit of its own, only conditions such as a certification mark.
export type Verdict = 'allowed' | 'conditions' | 'approval' | 'forbidden' | 'unknown'

const NOMINAL_VOLTS = 3.7 // the usual cell voltage printed on power banks; the label wins when known

export function toWattHours(input: {wh?: number; mAh?: number; volts?: number}): {wh: number; assumedVolts?: number} {
  if (input.wh && input.wh > 0) return {wh: round1(input.wh)}
  if (!input.mAh || input.mAh <= 0) throw new Error('Give the capacity in Wh, or in mAh (with the voltage if you know it).')
  if (input.volts && input.volts > 0) return {wh: round1((input.mAh * input.volts) / 1000)}
  return {wh: round1((input.mAh * NOMINAL_VOLTS) / 1000), assumedVolts: NOMINAL_VOLTS}
}

export function evaluate(rule: Rule, battery: Battery): {verdict: Verdict; reasons: string[]; advisories: string[]} {
  const reasons: string[] = []
  const limits = rule.limits ?? {}
  let verdict: Verdict
  let bandCap: number | undefined

  if (limits.freeMaxWh !== undefined) {
    if (battery.wh <= limits.freeMaxWh) {
      verdict = 'allowed'
      reasons.push(`${battery.wh} Wh is within the ${limits.freeMaxWh} Wh no-approval limit`)
      bandCap = limits.freeMaxCount
    } else if (limits.approvalMaxWh !== undefined && battery.wh <= limits.approvalMaxWh) {
      verdict = 'approval'
      reasons.push(`${battery.wh} Wh is over ${limits.freeMaxWh} Wh, so the airline must approve it (up to ${limits.approvalMaxWh} Wh)`)
      bandCap = limits.approvalMaxCount
    } else {
      verdict = 'forbidden'
      reasons.push(
        limits.approvalMaxWh !== undefined
          ? `${battery.wh} Wh is over the ${limits.approvalMaxWh} Wh maximum`
          : `${battery.wh} Wh is over the ${limits.freeMaxWh} Wh limit, with no approval band for power banks`,
      )
    }
  } else if (limits.maxWh !== undefined || limits.approvalMaxWh !== undefined) {
    const ceiling = (limits.maxWh ?? limits.approvalMaxWh) as number
    if (battery.wh <= ceiling) {
      verdict = 'allowed'
      reasons.push(`${battery.wh} Wh is within the ${ceiling} Wh maximum${battery.wh > 100 ? '; this source does not say whether approval is needed above 100 Wh' : ''}`)
    } else {
      verdict = 'forbidden'
      reasons.push(`${battery.wh} Wh is over the ${ceiling} Wh maximum`)
    }
  } else {
    verdict = 'conditions'
    reasons.push('this source sets no watt-hour limit of its own')
  }

  const cap = minDefined(bandCap, limits.totalMaxCount)
  if (verdict !== 'forbidden' && cap !== undefined && battery.count > cap) {
    verdict = 'forbidden'
    reasons.push(`${battery.count} power banks is more than the ${cap} allowed`)
  }
  return {verdict, reasons, advisories: advisoriesFor(rule)}
}

function advisoriesFor(rule: Rule): string[] {
  const onboard = rule.onboard ?? {}
  const advisories: string[] = []
  if (onboard.checkedBaggage === 'forbidden') advisories.push('carry-on only, never in checked baggage')
  const use = {
    forbidden: 'do not use it to charge devices during the flight',
    restricted: 'do not use it to charge devices during taxi, take-off or landing',
    discouraged: 'it should not be used to charge devices in flight (a recommendation)',
  }[onboard.useInFlight ?? '']
  if (use) advisories.push(use)
  const recharge = {forbidden: 'do not recharge it from seat power', discouraged: 'it should not be recharged in flight (a recommendation)'}[onboard.rechargeInFlight ?? '']
  if (recharge) advisories.push(recharge)
  const bin = {forbidden: 'keep it with you, not in the overhead bin', discouraged: 'it should not go in the overhead bin (a recommendation)'}[onboard.overheadBin ?? '']
  if (bin) advisories.push(bin)
  if (onboard.keepVisible === 'required') advisories.push('keep it visible or supervised while it is in use')
  if (onboard.protection === 'required') advisories.push('cover the terminals or bag each power bank')
  if (onboard.labelRequired === 'required') advisories.push('the capacity must be printed and readable on it')
  if (onboard.certification) advisories.push(`it must carry the ${onboard.certification}`)
  return advisories
}

const SEVERITY: Record<Verdict, number> = {allowed: 0, conditions: 0, unknown: 1, approval: 2, forbidden: 3}

// The strictest binding rule decides: one leg that forbids it is enough to leave it at home.
export function strictest(verdicts: Verdict[]): Verdict {
  const worst = verdicts.reduce<Verdict>((acc, next) => (SEVERITY[next] > SEVERITY[acc] ? next : acc), 'allowed')
  return worst === 'conditions' ? 'allowed' : worst
}

export const LABEL: Record<Verdict, string> = {
  allowed: 'ALLOWED',
  conditions: 'CONDITIONS ONLY',
  approval: 'NEEDS AIRLINE APPROVAL',
  forbidden: 'NOT ALLOWED',
  unknown: 'UNKNOWN',
}

export function describeRule(rule: Rule, battery: Battery): string {
  const {verdict, reasons, advisories} = evaluate(rule, battery)
  const meta = [
    rule.scope === 'guidance' ? 'advisory guidance, not counted' : rule.scope,
    rule.effectiveFrom ? `effective ${rule.effectiveFrom}` : null,
    rule.status && rule.status !== 'confirmed' ? `status: ${rule.status}` : null,
  ]
    .filter(Boolean)
    .join(', ')
  return [
    `- ${rule.authority.name} — ${rule.title} (${meta}): ${LABEL[verdict]}. ${reasons.join('; ')}.`,
    advisories.length ? `  Also: ${advisories.join('; ')}.` : null,
    rule.note ? `  Note: ${rule.note}` : null,
    rule.source ? `  Source: ${rule.source.title} <${rule.source.url}>` : null,
  ]
    .filter(Boolean)
    .join('\n')
}

function minDefined(...values: (number | undefined)[]): number | undefined {
  const defined = values.filter((value): value is number => typeof value === 'number')
  return defined.length ? Math.min(...defined) : undefined
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}
