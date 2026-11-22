// Panelize Verify — blind evaluation helpers.
//
// The A/B -> X/Y mapping is random per session and stays in the extension.
// Gemini only ever sees "Answer X" and "Answer Y".

/** @typedef {import('./types.js').AnswerId} AnswerId */
/** @typedef {import('./types.js').AnonymousVerdict} AnonymousVerdict */
/** @typedef {import('./types.js').JudgeVerdict} JudgeVerdict */

function secureRandomBit() {
  const buffer = new Uint8Array(1);
  globalThis.crypto.getRandomValues(buffer);
  return buffer[0] & 1;
}

/**
 * @param {() => number} [randomBit] Returns 0 or 1; injectable for tests.
 * @returns {{ X: AnswerId, Y: AnswerId }}
 */
export function createAnonymousMapping(randomBit = secureRandomBit) {
  return randomBit() === 0 ? { X: 'A', Y: 'B' } : { X: 'B', Y: 'A' };
}

/** @returns {{ A: 'X' | 'Y', B: 'X' | 'Y' }} */
export function invertMapping(mapping) {
  return mapping.X === 'A' ? { A: 'X', B: 'Y' } : { A: 'Y', B: 'X' };
}

/**
 * @param {AnonymousVerdict} verdict
 * @param {{ X: AnswerId, Y: AnswerId }} mapping
 * @returns {JudgeVerdict}
 */
export function anonymousVerdictToAnswer(verdict, mapping) {
  if (verdict === 'X') return mapping.X;
  if (verdict === 'Y') return mapping.Y;
  if (verdict === 'TIE') return 'TIE';
  return 'UNCERTAIN';
}

// Names a generator may use to identify itself or its vendor.
const PROVIDER_ALIASES = {
  chatgpt: ['ChatGPT', 'OpenAI', 'GPT-?\\d[\\w.-]*', 'GPT'],
  claude: ['Claude(?:\\s+(?:Opus|Sonnet|Haiku|Fable)(?:\\s*[\\d.]+)?)?', 'Anthropic'],
  gemini: ['Gemini(?:\\s+[\\d.]+(?:\\s+(?:Pro|Flash|Ultra))?)?', 'Google DeepMind', 'Bard'],
  grok: ['Grok', 'xAI'],
  deepseek: ['DeepSeek'],
  kimi: ['Kimi', 'Moonshot AI'],
  doubao: ['Doubao', '豆包', 'ByteDance'],
  'qwen-cn': ['Qwen', '通义千问', '千问'],
  'qwen-global': ['Qwen'],
  chatglm: ['ChatGLM', '智谱'],
  'zai-global': ['GLM', 'Z\\.ai'],
  yuanbao: ['Yuanbao', '元宝', 'Hunyuan', '混元']
};

export const REDACTION_TOKEN = '[an AI assistant]';

function aliasRegex(alias) {
  // \b does not work around CJK; use look-arounds on ASCII word characters.
  return new RegExp(`(?<![A-Za-z0-9_])${alias}(?![A-Za-z0-9_])`, 'gi');
}

/**
 * Replaces the generators' self-references with a neutral token, so the
 * judge cannot tell which model wrote which answer. A name the user's prompt
 * itself mentions is the topic, not a signature, and is kept.
 *
 * @param {string} text
 * @param {string[]} providerIds The providers being compared.
 * @param {string} prompt
 * @returns {{ text: string, redactions: number }}
 */
export function redactModelIdentity(text, providerIds, prompt = '') {
  let output = String(text || '');
  let redactions = 0;
  const promptText = String(prompt || '');
  const aliases = providerIds.flatMap(id => PROVIDER_ALIASES[id] || []);
  // Longest patterns first so "Claude Opus 5" is replaced as one unit.
  aliases.sort((a, b) => b.length - a.length);
  for (const alias of aliases) {
    if (aliasRegex(alias).test(promptText)) {
      continue;
    }
    output = output.replace(aliasRegex(alias), () => {
      redactions += 1;
      return REDACTION_TOKEN;
    });
  }
  return { text: output, redactions };
}

/**
 * Builds the anonymous answer pair for Gemini.
 * @param {import('./types.js').EvaluationSession} session
 * @param {{ redact?: boolean, maxChars?: number }} [options]
 * @returns {{ X: string, Y: string, truncated: boolean, redactions: number }}
 */
export function buildAnonymousAnswers(session, { redact = true, maxChars = 12000 } = {}) {
  const { anonymization: mapping } = session;
  const byId = { A: session.answerA, B: session.answerB };
  const providers = [session.answerA.model, session.answerB.model].filter(Boolean);
  let truncated = false;
  let redactions = 0;
  const prepare = (record) => {
    let text = record.content;
    if (redact) {
      const result = redactModelIdentity(text, providers, session.prompt);
      text = result.text;
      redactions += result.redactions;
    }
    if (text.length > maxChars) {
      text = `${text.slice(0, maxChars)}\n[... answer truncated for length ...]`;
      truncated = true;
    }
    return text;
  };
  return {
    X: prepare(byId[mapping.X]),
    Y: prepare(byId[mapping.Y]),
    truncated,
    redactions
  };
}
