// Panelize Verify — validation of Gemini outputs.
//
// Model output is untrusted. Each validator returns a cleaned copy or throws
// an INVALID_OUTPUT error; nothing unvalidated reaches the UI or storage.

import { ANONYMOUS_VERDICTS } from './types.js';
import { GeminiApiError, ERROR_MESSAGES, stripJsonFence } from './gemini-client.js';

const MAX_STATEMENT = 600;
const MAX_EXPLANATION = 1200;
const MAX_REASONING = 2000;
const CHECKED_STATUSES = new Set(['SUPPORTED', 'CONTRADICTED', 'INSUFFICIENT_EVIDENCE']);

export function invalidOutput(detail) {
  return new GeminiApiError('INVALID_OUTPUT', `${ERROR_MESSAGES.INVALID_OUTPUT} ${detail}`.trim());
}

export function parseJson(text) {
  try {
    return JSON.parse(stripJsonFence(text));
  } catch {
    throw invalidOutput('(not valid JSON)');
  }
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/**
 * URLs the model writes itself are unverified; only grounding chunks count
 * as sources, so written links are removed from displayed explanations.
 */
export function stripModelUrls(text) {
  return String(text || '')
    .replace(/\[([^\]]*)\]\((?:https?:\/\/|www\.)[^)]*\)/gi, '$1')
    .replace(/(?:https?:\/\/|www\.)[^\s)\]]+/gi, '[link removed]');
}

/**
 * @param {any} data
 * @param {{ maxClaimsPerAnswer: number }} limits
 * @returns {{ id: string, statement: string, answers: ('X'|'Y')[], verifiable: boolean }[]}
 */
export function validateClaimExtraction(data, { maxClaimsPerAnswer }) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.claims)) {
    throw invalidOutput('(missing "claims" array)');
  }
  const seen = new Map();
  const perAnswer = { X: 0, Y: 0 };
  const opinionsPerAnswer = { X: 0, Y: 0 };
  const result = [];
  for (const raw of data.claims) {
    const statement = cleanText(raw?.statement, MAX_STATEMENT);
    if (!statement) continue;
    const answers = [...new Set((Array.isArray(raw?.answers) ? raw.answers : [])
      .filter(answer => answer === 'X' || answer === 'Y'))];
    if (answers.length === 0) continue;
    const verifiable = raw?.verifiable !== false;
    const key = statement.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const existing = seen.get(key);
    if (existing) {
      // Local de-duplication on top of the model's.
      existing.answers = [...new Set([...existing.answers, ...answers])].sort();
      continue;
    }
    const counter = verifiable ? perAnswer : opinionsPerAnswer;
    const limit = verifiable ? maxClaimsPerAnswer : 3;
    const kept = answers.filter(answer => counter[answer] < limit);
    if (kept.length === 0) continue;
    kept.forEach(answer => { counter[answer] += 1; });
    const claim = { id: `C${result.length + 1}`, statement, answers: kept.sort(), verifiable };
    seen.set(key, claim);
    result.push(claim);
  }
  return result;
}

/**
 * Parses the sectioned fact-check text and records where each section sits
 * (in UTF-8 bytes within its part) so grounding supports can be matched.
 *
 * @param {string[]} parts Response text parts.
 * @param {string[]} expectedIds
 * @returns {Map<string, { status: string, explanation: string, partIndex: number,
 *   startByte: number, endByte: number, text: string }>}
 */
export function parseFactCheckSections(parts, expectedIds) {
  const expected = new Set(expectedIds);
  const encoder = new TextEncoder();
  const sections = new Map();
  parts.forEach((partText, partIndex) => {
    if (!partText) return;
    const headings = [...partText.matchAll(/^[ \t]*#{2,4}[ \t]*\**[ \t]*(C\d+)\b.*$/gm)];
    headings.forEach((match, position) => {
      const id = match[1];
      if (!expected.has(id) || sections.has(id)) return;
      const start = match.index;
      const end = position + 1 < headings.length ? headings[position + 1].index : partText.length;
      const text = partText.slice(start, end);
      const statusMatch = text.match(/STATUS\**\s*:\s*\**\s*([A-Z_ ]+)/i);
      const status = statusMatch ? statusMatch[1].trim().toUpperCase().replace(/\s+/g, '_') : '';
      const explanationMatch = text.match(/EXPLANATION\**\s*:\s*\**\s*([\s\S]*)/i);
      sections.set(id, {
        status: CHECKED_STATUSES.has(status) ? status : 'INSUFFICIENT_EVIDENCE',
        statusRecognized: CHECKED_STATUSES.has(status),
        explanation: cleanText(stripModelUrls(explanationMatch ? explanationMatch[1] : ''), MAX_EXPLANATION),
        partIndex,
        startByte: encoder.encode(partText.slice(0, start)).length,
        endByte: encoder.encode(partText.slice(0, end)).length,
        text
      });
    });
  });
  return sections;
}

function cleanScore(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 5 ? number : null;
}

/**
 * @param {any} data
 * @returns {{ verdict: import('./types.js').AnonymousVerdict, reasoning: string, criteria: object }}
 */
export function validateJudgeOutput(data) {
  if (!data || typeof data !== 'object') {
    throw invalidOutput('(judge output is not an object)');
  }
  const verdict = typeof data.verdict === 'string' ? data.verdict.trim().toUpperCase() : '';
  if (!ANONYMOUS_VERDICTS.includes(verdict)) {
    throw invalidOutput(`(unknown verdict "${String(data.verdict).slice(0, 20)}")`);
  }
  const reasoning = cleanText(stripModelUrls(data.reasoning), MAX_REASONING);
  if (!reasoning) {
    throw invalidOutput('(judge reasoning is empty)');
  }
  const criteria = {};
  const rawCriteria = data.criteria && typeof data.criteria === 'object' ? data.criteria : {};
  for (const key of ['factualAccuracy', 'evidenceSupport', 'completeness', 'relevance', 'internalConsistency']) {
    const entry = rawCriteria[key];
    if (entry && typeof entry === 'object') {
      criteria[key] = { X: cleanScore(entry.X), Y: cleanScore(entry.Y) };
    }
  }
  return { verdict: /** @type {any} */ (verdict), reasoning, criteria };
}

/** Generic entry point named in the spec. */
export function validateOutput(kind, data, options = {}) {
  switch (kind) {
    case 'claims':
      return validateClaimExtraction(data, /** @type {any} */ (options));
    case 'judge':
      return validateJudgeOutput(data);
    default:
      throw new Error(`Unknown output kind: ${kind}`);
  }
}
