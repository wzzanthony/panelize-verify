// Panelize Verify — human vs Gemini comparison and statistics.

/** @typedef {import('./types.js').Preference} Preference */
/** @typedef {import('./types.js').JudgeVerdict} JudgeVerdict */

/**
 * @typedef {'AGREE' | 'DISAGREE' | 'PARTIAL' | 'NO_HUMAN_VOTE' | 'AI_UNCERTAIN' | 'PENDING'} Agreement
 */

/**
 * Tie and Uncertain are kept apart from agree/disagree:
 *  - SKIPPED vote -> NO_HUMAN_VOTE (never counted as a tie)
 *  - UNCERTAIN verdict -> AI_UNCERTAIN
 *  - one side TIE, the other A/B -> PARTIAL
 * @param {Preference | undefined} human
 * @param {JudgeVerdict | undefined} gemini
 * @returns {Agreement}
 */
export function compareJudgements(human, gemini) {
  if (!human || !gemini) return 'PENDING';
  if (human === 'SKIPPED') return 'NO_HUMAN_VOTE';
  if (gemini === 'UNCERTAIN') return 'AI_UNCERTAIN';
  if (human === gemini) return 'AGREE';
  if (human === 'TIE' || gemini === 'TIE') return 'PARTIAL';
  return 'DISAGREE';
}

export const AGREEMENT_LABELS = {
  AGREE: 'Agree',
  DISAGREE: 'Disagree',
  PARTIAL: 'Partial (one side chose Tie)',
  NO_HUMAN_VOTE: 'No human vote (skipped)',
  AI_UNCERTAIN: 'Gemini uncertain',
  PENDING: 'Pending'
};

/**
 * Agreement rate over sessions with both a real vote and a decisive or tie
 * verdict. Skipped votes and Uncertain verdicts are reported separately.
 * @param {import('./types.js').EvaluationSession[]} sessions
 */
export function computeAgreementStats(sessions) {
  const counts = { AGREE: 0, DISAGREE: 0, PARTIAL: 0, NO_HUMAN_VOTE: 0, AI_UNCERTAIN: 0, PENDING: 0 };
  const modelWins = {};
  for (const session of sessions) {
    const result = compareJudgements(session.humanVote?.preference, session.geminiEvaluation?.verdict);
    counts[result] += 1;
    const verdict = session.geminiEvaluation?.verdict;
    if (verdict === 'A' || verdict === 'B') {
      const model = (verdict === 'A' ? session.answerA : session.answerB)?.model || 'unknown';
      modelWins[model] = (modelWins[model] || 0) + 1;
    }
  }
  const comparable = counts.AGREE + counts.DISAGREE + counts.PARTIAL;
  return {
    total: sessions.length,
    counts,
    comparable,
    agreementRate: comparable > 0 ? counts.AGREE / comparable : null,
    geminiWinsByModel: modelWins
  };
}
