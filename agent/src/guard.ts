// Gate Check only answers questions about flying with power banks. Anything else, and anything about the machines,
// code, keys or people behind the service, is refused here, before a model or a tool sees it.

export const OFF_TOPIC_REPLY = 'I can only help with flying with power banks: what you may bring, how many, and what you may do with them on board.'

// Questions that probe the service itself rather than the rules.
const PROBES = new RegExp(
  [
    String.raw`\bmac(book|os|intosh| ?mini| ?studio)?\b`,
    String.raw`\b(your|this|the owner'?s?) (computer|machine|server|laptop|device)\b`,
    String.raw`\b(relay|tunnel|server|terminal|shell|ssh|sudo|launchd|localhost|hostname|codex)\b`,
    String.raw`\bip address\b`,
    String.raw`\b(password|passcode|api[ -]?keys?|secrets?|credentials?|tokens?|cookies?)\b`,
    String.raw`\b(system prompt|your (instructions|prompt|rules|tools)|ignore (all|any|the|previous|prior|above)|jailbreak|developer mode)\b`,
    String.raw`\b(file ?system|home (folder|directory)|folders?|directories|environment variables?|\.env)\b`,
    String.raw`\bwho (runs|built|made|owns|operates)\b`,
    String.raw`맥북|맥\s?미니|맥\s?(컴퓨터|서버)|맥에서|서버|터널|릴레이|중계|토큰|비밀\s?번호|암호|api\s?키|시스템\s?프롬프트|프롬프트|지시\s?(사항|문)|무시하고|폴더|파일\s?목록|홈\s?디렉|누가\s?(만들|운영)`,
  ].join('|'),
  'i',
)

// Words a real question about carrying a power bank on a flight almost always has.
const TOPIC = new RegExp(
  [
    String.raw`power ?banks?|batter(y|ies)|\bmah\b|\bwh\b|watt|lithium|charg(er|ing|e)|recharg`,
    String.raw`flights?|\bfl(y|ying|ies)\b|airlines?|airports?|planes?|aircraft|cabin|carry[- ]?on|luggage|baggage|\bbags?\b|overhead|on ?board|travel|trip`,
    String.raw`\b(faa|tsa|icao|iata|easa|caa|molit|mlit|caac|cad)\b`,
    String.raw`korean air|asiana|jeju|delta|american airlines|southwest|emirates|singapore airlines|cathay|eva air|china airlines|\bjal\b|\bana\b|lufthansa|air france|british airways|qantas|jetstar|air canada|swiss|austrian|brussels`,
    String.raw`보조\s*배터리|배터리|비행|항공|기내|수하물|モバイルバッテリー|機内|充电宝|充電寶`,
  ].join('|'),
  'i',
)

export function offTopic(question: string): boolean {
  return PROBES.test(question) || !TOPIC.test(question)
}
