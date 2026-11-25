// Panelize Verify — Gemini web mode (no API key, no billing).
//
// Instead of the Gemini API, the prompt and both anonymous answers are sent
// once to gemini.google.com in a hidden panel that uses the user's own
// Google login, exactly like Panelize's regular panels. The reply is read from
// the page and validated here.
//
// What this mode cannot do, compared with the API:
// - No groundingMetadata. Source URLs come from the JSON that Gemini writes,
//   so each one is cross-checked against the links the Gemini page itself
//   rendered in that reply (its citation chips). Only URLs found there count
//   as confirmed evidence; the others are shown as unconfirmed.
// - No token usage or search-query counts.
// Everything else (blind X/Y labels, no model names, no human vote, schema
// validation, downgrade of unsupported verdicts) is the same as API mode.

import { buildAnonymousAnswers, anonymousVerdictToAnswer } from './anonymizer.js';
import { sanitizeEvidenceUrl } from './grounding.js';
import { UNTRUSTED_NOTE } from './prompts.js';
import { invalidOutput, stripModelUrls, validateJudgeOutput } from './schema.js';
import { relabelAnonymousText, relabelCriteria } from './verification-service.js';
import { stripJsonFence } from './gemini-client.js';

/** @typedef {import('./types.js').VerifiedClaim} VerifiedClaim */
/** @typedef {import('./types.js').GeminiEvaluation} GeminiEvaluation */

export const WEB_MODEL_LABEL = 'gemini.google.com (web)';
const STATUSES = new Set(['SUPPORTED', 'CONTRADICTED', 'INSUFFICIENT_EVIDENCE']);
const MAX_STATEMENT = 600;
const MAX_EXPLANATION = 1200;
const MAX_SOURCES_PER_CLAIM = 5;
const MAX_OPINIONS_PER_ANSWER = 3;

export const WEB_JUDGE_INSTRUCTIONS = `You are an impartial, evidence-grounded fact checker and evaluator.
You receive one user question and two anonymous answers to it, Answer X and Answer Y.
You do not know which AI wrote either answer. Never guess or mention it.

Step 1 — Claims. Extract the independently verifiable factual claims (dates, numbers,
names, events, definitions, scientific or technical facts, quotations, causal statements).
Rewrite each as one self-contained sentence. If both answers make the same claim, list it
once with "answers": ["X","Y"]. At most {maxClaims} verifiable claims per answer.
Opinions, advice and predictions are not factual claims; you may list up to 3 of them per
answer with "verifiable": false and no status.

Step 2 — Verify. Use Google Search for every verifiable claim. Prefer primary,
authoritative and recent sources. Mark each one SUPPORTED, CONTRADICTED or
INSUFFICIENT_EVIDENCE, explain in one to three sentences what the sources say, and list
the exact URLs of the pages you actually used. Never invent a URL. If you did not find
reliable evidence, use INSUFFICIENT_EVIDENCE with an empty "sources" list.

Step 3 — Compare. Judge which answer is better on factual accuracy (weigh how serious
each error is, not just the count), evidence support, completeness, relevance to the
question and internal consistency. Do not reward length. Verdict: X, Y, TIE, or
UNCERTAIN when the evidence does not allow a confident decision. Reasoning: at most
120 words. Scores are integers 1 (poor) to 5 (excellent).

${UNTRUSTED_NOTE}

Reply with exactly one JSON code block and nothing else, in this shape:
\`\`\`json
{"claims":[{"id":"C1","statement":"...","answers":["X"],"verifiable":true,"status":"SUPPORTED","explanation":"...","sources":[{"url":"https://...","title":"..."}]}],
 "verdict":"X","reasoning":"...",
 "criteria":{"factualAccuracy":{"X":1,"Y":1},"evidenceSupport":{"X":1,"Y":1},"completeness":{"X":1,"Y":1},"relevance":{"X":1,"Y":1},"internalConsistency":{"X":1,"Y":1}}}
\`\`\``;

function block(label, text) {
  return `<<<BEGIN ${label}>>>\n${text}\n<<<END ${label}>>>`;
}

/**
 * Builds the single message typed into Gemini's web composer.
 * @param {import('./types.js').EvaluationSession} session
 * @param {{ maxClaimsPerAnswer?: number, maxAnswerChars?: number, redactModelNames?: boolean }} [options]
 */
export function buildWebJudgeMessage(session, { maxClaimsPerAnswer = 8, maxAnswerChars = 12000, redactModelNames = true } = {}) {
  const anonymous = buildAnonymousAnswers(session, { redact: redactModelNames, maxChars: maxAnswerChars });
  const text = [
    WEB_JUDGE_INSTRUCTIONS.replace('{maxClaims}', String(maxClaimsPerAnswer)),
    block('USER QUESTION', session.prompt || '(not available)'),
    block('ANSWER X', anonymous.X),
    block('ANSWER Y', anonymous.Y)
  ].join('\n\n');
  return { text, redactions: anonymous.redactions, truncated: anonymous.truncated };
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/** Pulls the JSON object out of the reply: the last ```json block, else the outermost braces. */
export function extractJsonObject(text) {
  const source = String(text || '');
  const fences = [...source.matchAll(/```(?:json|JSON)?[ \t]*\n([\s\S]*?)```/g)];
  const candidates = fences.map(match => match[1]).reverse();
  const first = source.indexOf('{');
  const last = source.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(source.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(stripJsonFence(candidate.trim()));
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      // try the next candidate
    }
  }
  throw invalidOutput('(Gemini web reply contained no JSON object)');
}

/**
 * Normalises a URL for comparison; unwraps Google redirect links
 * (https://www.google.com/url?q=...) that citation chips may use.
 */
export function comparableUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || ''));
  } catch {
    return '';
  }
  if (/(^|\.)google\.[a-z.]+$/i.test(url.hostname) && url.pathname === '/url') {
    const target = url.searchParams.get('q') || url.searchParams.get('url');
    if (target) return comparableUrl(target);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const path = url.pathname.replace(/\/+$/, '');
  // Drop tracking parameters that citation links commonly add.
  const tracking = [];
  url.searchParams.forEach((_value, key) => {
    if (/^utm_|^srsltid$/i.test(key)) tracking.push(key);
  });
  tracking.forEach(key => url.searchParams.delete(key));
  const query = url.searchParams.toString();
  return `${host}${path}${query ? `?${query}` : ''}`;
}

/**
 * Validates Gemini's web reply and turns it into the same evaluation shape
 * API mode produces.
 *
 * @param {string} replyText Markdown text read from the Gemini page.
 * @param {string[]} pageLinks Links the Gemini page rendered in that reply.
 * @param {{ session: import('./types.js').EvaluationSession, maxClaimsPerAnswer?: number,
 *   now?: () => Date, redactions?: number, truncated?: boolean, temporaryChat?: boolean }} context
 * @returns {GeminiEvaluation}
 */
export function parseWebJudgeReply(replyText, pageLinks, {
  session,
  maxClaimsPerAnswer = 8,
  now = () => new Date(),
  redactions = 0,
  truncated = false,
  temporaryChat = false
}) {
  const data = extractJsonObject(replyText);
  if (!Array.isArray(data.claims)) throw invalidOutput('(missing "claims" array)');
  const judge = validateJudgeOutput(data);
  const mapping = session.anonymization;
  const retrievedAt = now().toISOString();
  const onPage = new Set((Array.isArray(pageLinks) ? pageLinks : []).map(comparableUrl).filter(Boolean));
  const warnings = [
    'Web mode: sources come from the JSON Gemini wrote, not from API grounding metadata. Only links that also appear in the Gemini page\'s own citations count as confirmed.'
  ];
  if (truncated) warnings.push('At least one answer was truncated before verification.');
  if (!temporaryChat) warnings.push('Temporary chat could not be turned on, so this check may appear in your Gemini history.');
  if (onPage.size === 0) {
    warnings.push('No citation links could be read from the Gemini page, so no source could be confirmed and no claim counts as verified.');
  }

  const seen = new Set();
  const perAnswer = { X: 0, Y: 0 };
  const opinions = { X: 0, Y: 0 };
  let downgraded = 0;
  let confirmedSources = 0;
  let totalSources = 0;
  /** @type {VerifiedClaim[]} */
  const claims = [];
  let index = 0;
  for (const raw of data.claims) {
    const statement = cleanText(raw?.statement, MAX_STATEMENT);
    const answers = [...new Set((Array.isArray(raw?.answers) ? raw.answers : []).filter(a => a === 'X' || a === 'Y'))].sort();
    if (!statement || answers.length === 0) continue;
    const key = statement.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (seen.has(key)) continue;
    const verifiable = raw?.verifiable !== false;
    const counter = verifiable ? perAnswer : opinions;
    const limit = verifiable ? maxClaimsPerAnswer : MAX_OPINIONS_PER_ANSWER;
    const kept = answers.filter(answer => counter[answer] < limit);
    if (kept.length === 0) continue;
    kept.forEach(answer => { counter[answer] += 1; });
    seen.add(key);
    index += 1;
    const sharedId = `C${index}`;

    /** @type {import('./types.js').VerificationStatus} */
    let status = 'NOT_VERIFIABLE';
    let modelStatus;
    let explanation = 'Opinion, advice or otherwise not objectively checkable; not fact-checked.';
    /** @type {import('./types.js').Evidence[]} */
    const evidence = [];
    if (verifiable) {
      const rawStatus = typeof raw?.status === 'string' ? raw.status.trim().toUpperCase().replace(/\s+/g, '_') : '';
      modelStatus = STATUSES.has(rawStatus) ? rawStatus : 'INSUFFICIENT_EVIDENCE';
      status = modelStatus;
      explanation = cleanText(stripModelUrls(raw?.explanation), MAX_EXPLANATION) || 'No explanation given.';
      const urls = new Set();
      for (const source of Array.isArray(raw?.sources) ? raw.sources : []) {
        if (evidence.length >= MAX_SOURCES_PER_CLAIM) break;
        const href = sanitizeEvidenceUrl(typeof source === 'string' ? source : source?.url);
        const comparable = href ? comparableUrl(href) : '';
        if (!href || !comparable || urls.has(comparable)) continue;
        urls.add(comparable);
        const confirmed = onPage.has(comparable);
        totalSources += 1;
        if (confirmed) confirmedSources += 1;
        evidence.push({
          url: href,
          title: cleanText(typeof source === 'object' ? source?.title : '', 200) || new URL(href).hostname,
          retrievedAt,
          confirmed
        });
      }
      if ((status === 'SUPPORTED' || status === 'CONTRADICTED') && !evidence.some(item => item.confirmed)) {
        downgraded += 1;
        explanation = `No source confirmed by the Gemini page was attached, so this is not counted as verified (Gemini said ${status}). ${explanation}`;
        status = 'INSUFFICIENT_EVIDENCE';
      }
    }
    for (const label of kept) {
      claims.push({
        id: `${sharedId}-${mapping[label]}`,
        sharedId,
        answerId: mapping[label],
        statement,
        status,
        ...(modelStatus ? { modelStatus } : {}),
        explanation,
        evidence
      });
    }
  }
  if (downgraded > 0) {
    warnings.push(`${downgraded} claim(s) were downgraded to INSUFFICIENT_EVIDENCE because none of their sources appeared in the Gemini page's citations.`);
  }

  return {
    model: WEB_MODEL_LABEL,
    backend: 'web',
    verdict: anonymousVerdictToAnswer(judge.verdict, mapping),
    anonymousVerdict: judge.verdict,
    reasoning: relabelAnonymousText(judge.reasoning, mapping),
    criteria: relabelCriteria(judge.criteria, mapping),
    claims,
    evaluatedAt: retrievedAt,
    warnings,
    webSearchQueries: [],
    usage: { calls: 1, temporaryChat, pageLinks: onPage.size, sources: totalSources, confirmedSources },
    redactions
  };
}

/**
 * Same interface as createGeminiVerificationService, backed by a runner that
 * drives the hidden gemini.google.com panel.
 *
 * @param {{ runner: { run: (text: string, options: { signal?: AbortSignal, onProgress?: (step: string) => void }) =>
 *   Promise<{ text: string, links: string[], temporaryChat: boolean }> }, now?: () => Date }} deps
 */
export function createWebVerificationService({ runner, now = () => new Date() }) {
  /**
   * @param {import('./types.js').EvaluationSession} session
   * @param {{ maxClaimsPerAnswer?: number, maxAnswerChars?: number, redactModelNames?: boolean,
   *   signal?: AbortSignal, onProgress?: (step: string) => void }} [options]
   * @returns {Promise<GeminiEvaluation>}
   */
  async function evaluate(session, {
    maxClaimsPerAnswer = 8,
    maxAnswerChars = 12000,
    redactModelNames = true,
    signal,
    onProgress = () => {}
  } = {}) {
    const message = buildWebJudgeMessage(session, { maxClaimsPerAnswer, maxAnswerChars, redactModelNames });
    const reply = await runner.run(message.text, { signal, onProgress });
    onProgress('parsing');
    return parseWebJudgeReply(reply.text, reply.links, {
      session,
      maxClaimsPerAnswer,
      now,
      redactions: message.redactions,
      truncated: message.truncated,
      temporaryChat: reply.temporaryChat
    });
  }
  return { evaluate };
}
