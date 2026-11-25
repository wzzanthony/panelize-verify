// Panelize Verify — GeminiVerificationService.
//
// Pipeline for one session:
//   extractClaims  -> claims tagged with the anonymous answers containing them
//   verifyClaims   -> one Google-Search-grounded call for all verifiable claims
//   compareAnswers -> blind pairwise judgement using the verification results
// Inputs are the prompt and the anonymous answers only: no model names, no
// human vote, no A/B labels.

import { buildAnonymousAnswers, anonymousVerdictToAnswer } from './anonymizer.js';
import { parseGroundingMetadata, evidenceForSpan } from './grounding.js';
import {
  CLAIM_EXTRACTION_INSTRUCTIONS,
  FACT_CHECK_INSTRUCTIONS,
  JUDGE_INSTRUCTIONS,
  buildExtractionInput,
  buildFactCheckInput,
  buildJudgeInput
} from './prompts.js';
import {
  parseJson,
  parseFactCheckSections,
  validateClaimExtraction,
  validateJudgeOutput,
  validateOutput
} from './schema.js';
import { GeminiApiError, ERROR_MESSAGES } from './gemini-client.js';

export { parseGroundingMetadata, validateOutput };

/** @typedef {import('./types.js').VerifiedClaim} VerifiedClaim */
/** @typedef {import('./types.js').GeminiEvaluation} GeminiEvaluation */

function addUsage(total, usage) {
  if (!usage) return total;
  return {
    promptTokens: total.promptTokens + (usage.promptTokenCount || 0),
    outputTokens: total.outputTokens + (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
    totalTokens: total.totalTokens + (usage.totalTokenCount || 0),
    calls: total.calls + 1,
    searchQueries: total.searchQueries
  };
}

/** Rewrites "Answer X/Y" in judge text to the labels the user sees. */
export function relabelAnonymousText(text, mapping) {
  return String(text || '')
    .replace(/\b(Answers?)\s+([XY])(\s*(?:,|&|and|or|vs\.?)\s*)([XY])\b/g, (_, word, first, joiner, second) =>
      `${word} ${mapping[first]}${joiner}${mapping[second]}`)
    .replace(/\b(Answers?)\s+([XY])\b/g, (_, word, label) => `${word} ${mapping[label]}`);
}

export function relabelCriteria(criteria, mapping) {
  const out = {};
  for (const [key, scores] of Object.entries(criteria || {})) {
    out[key] = { [mapping.X]: scores.X, [mapping.Y]: scores.Y };
  }
  return out;
}

/**
 * @param {{ client: ReturnType<typeof import('./gemini-client.js').createGeminiClient>,
 *   now?: () => Date }} deps
 */
export function createGeminiVerificationService({ client, now = () => new Date() }) {
  async function extractClaims({ prompt, answers, maxClaimsPerAnswer = 8, signal }) {
    const response = await client.generate({
      systemInstruction: CLAIM_EXTRACTION_INSTRUCTIONS.replace('{maxClaims}', String(maxClaimsPerAnswer)),
      userText: buildExtractionInput({ prompt, answers }),
      json: true,
      signal
    });
    const claims = validateClaimExtraction(parseJson(response.text), { maxClaimsPerAnswer });
    return { claims, usage: response.usage };
  }

  /**
   * @param {{ prompt: string, claims: { id: string, statement: string }[], signal?: AbortSignal }} input
   */
  async function verifyClaims({ prompt, claims, signal }) {
    const results = new Map();
    if (claims.length === 0) {
      return { results, grounding: parseGroundingMetadata(null), usage: null, warnings: [] };
    }
    const response = await client.generate({
      systemInstruction: FACT_CHECK_INSTRUCTIONS,
      userText: buildFactCheckInput({ prompt, claims }),
      useSearch: true,
      signal
    });
    const grounding = parseGroundingMetadata(response.candidate);
    if (grounding.chunks.length === 0) {
      // Without search evidence nothing may be marked verified.
      throw new GeminiApiError('SEARCH_UNAVAILABLE', ERROR_MESSAGES.SEARCH_UNAVAILABLE);
    }
    const retrievedAt = now().toISOString();
    const sections = parseFactCheckSections(response.parts, claims.map(claim => claim.id));
    const warnings = [];
    let downgraded = 0;
    for (const claim of claims) {
      const section = sections.get(claim.id);
      if (!section) {
        results.set(claim.id, {
          status: 'INSUFFICIENT_EVIDENCE',
          explanation: 'Gemini returned no assessment for this claim.',
          evidence: []
        });
        continue;
      }
      const evidence = evidenceForSpan(section, grounding, retrievedAt);
      let status = section.status;
      let explanation = section.explanation || 'No explanation given.';
      if ((status === 'SUPPORTED' || status === 'CONTRADICTED') && evidence.length === 0) {
        downgraded += 1;
        explanation = `No search source was attached to this judgement, so it is not counted as verified (Gemini said ${status}). ${explanation}`;
        status = 'INSUFFICIENT_EVIDENCE';
      }
      results.set(claim.id, { status, modelStatus: section.status, explanation, evidence });
    }
    if (downgraded > 0) {
      warnings.push(`${downgraded} claim(s) were downgraded to INSUFFICIENT_EVIDENCE because no grounding source was attached.`);
    }
    if (sections.size < claims.length) {
      warnings.push(`${claims.length - sections.size} claim(s) received no assessment from Gemini.`);
    }
    return { results, grounding, usage: response.usage, warnings };
  }

  async function compareAnswers({ prompt, answers, verification, signal }) {
    const response = await client.generate({
      systemInstruction: JUDGE_INSTRUCTIONS,
      userText: buildJudgeInput({ prompt, answers, verification }),
      json: true,
      signal
    });
    return { judge: validateJudgeOutput(parseJson(response.text)), usage: response.usage };
  }

  /**
   * Runs the full pipeline for a session.
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
    const mapping = session.anonymization;
    const anonymous = buildAnonymousAnswers(session, { redact: redactModelNames, maxChars: maxAnswerChars });
    const answers = { X: anonymous.X, Y: anonymous.Y };
    const prompt = session.prompt;
    let usage = { promptTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0, searchQueries: 0 };
    const warnings = [];
    if (anonymous.truncated) warnings.push('At least one answer was truncated before verification to limit cost.');

    onProgress('extracting');
    const extraction = await extractClaims({ prompt, answers, maxClaimsPerAnswer, signal });
    usage = addUsage(usage, extraction.usage);

    onProgress('verifying');
    const verifiable = extraction.claims.filter(claim => claim.verifiable);
    const checked = await verifyClaims({ prompt, claims: verifiable, signal });
    usage = addUsage(usage, checked.usage);
    usage.searchQueries += checked.grounding.webSearchQueries.length;
    warnings.push(...checked.warnings);

    const summaryForJudge = extraction.claims.map(claim => {
      const result = claim.verifiable ? checked.results.get(claim.id) : null;
      return {
        id: claim.id,
        foundIn: claim.answers,
        statement: claim.statement,
        status: result ? result.status : 'NOT_VERIFIABLE',
        explanation: result ? result.explanation : 'Opinion, advice or otherwise not objectively checkable.',
        sources: result ? result.evidence.map(item => item.title || 'source') : []
      };
    });

    onProgress('judging');
    const compared = await compareAnswers({ prompt, answers, verification: summaryForJudge, signal });
    usage = addUsage(usage, compared.usage);

    /** @type {VerifiedClaim[]} */
    const claims = [];
    for (const claim of extraction.claims) {
      const result = claim.verifiable ? checked.results.get(claim.id) : null;
      for (const label of claim.answers) {
        claims.push({
          id: `${claim.id}-${mapping[label]}`,
          sharedId: claim.id,
          answerId: mapping[label],
          statement: claim.statement,
          status: result ? result.status : 'NOT_VERIFIABLE',
          ...(result?.modelStatus ? { modelStatus: result.modelStatus } : {}),
          explanation: result ? result.explanation : 'Opinion, advice or otherwise not objectively checkable; not fact-checked.',
          evidence: result ? result.evidence : []
        });
      }
    }

    return {
      model: client.model,
      verdict: anonymousVerdictToAnswer(compared.judge.verdict, mapping),
      anonymousVerdict: compared.judge.verdict,
      reasoning: relabelAnonymousText(compared.judge.reasoning, mapping),
      criteria: relabelCriteria(compared.judge.criteria, mapping),
      claims,
      evaluatedAt: now().toISOString(),
      warnings,
      webSearchQueries: checked.grounding.webSearchQueries,
      searchEntryPointHtml: checked.grounding.searchEntryPointHtml || undefined,
      usage,
      redactions: anonymous.redactions,
      groundingMetadata: checked.grounding.raw
    };
  }

  return { extractClaims, verifyClaims, compareAnswers, evaluate };
}
