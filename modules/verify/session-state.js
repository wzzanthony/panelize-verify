// Panelize Verify — evaluation session state.
//
// Pure functions; every change returns a new session object. The rules that
// keep the human vote independent live here so the UI cannot bypass them:
//   - Gemini results are revealed only after the vote is submitted or skipped.
//   - The first vote is immutable; later opinions are post-reveal feedback.

import { PREFERENCES } from './types.js';
import { createAnonymousMapping } from './anonymizer.js';

/** @typedef {import('./types.js').EvaluationSession} EvaluationSession */
/** @typedef {import('./types.js').AnswerRecord} AnswerRecord */
/** @typedef {import('./types.js').Preference} Preference */

export class VoteLockedError extends Error {
  constructor() {
    super('The independent vote is already locked');
    this.name = 'VoteLockedError';
  }
}

function nowIso(now) {
  return (typeof now === 'function' ? now() : new Date()).toISOString();
}

export function createSessionId(random = globalThis.crypto) {
  if (random?.randomUUID) {
    return random.randomUUID();
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * @param {{ prompt: string, answerA: AnswerRecord, answerB: AnswerRecord,
 *   id?: string, now?: () => Date, randomBit?: () => number }} input
 * @returns {EvaluationSession}
 */
export function createSession({ prompt, answerA, answerB, id, now, randomBit }) {
  if (typeof prompt !== 'string') {
    throw new TypeError('prompt must be a string');
  }
  if (!answerA?.content?.trim() || !answerB?.content?.trim()) {
    throw new Error('Both answers must be non-empty before a comparison can start');
  }
  return {
    id: id || createSessionId(),
    prompt,
    answerA: { ...answerA },
    answerB: { ...answerB },
    anonymization: createAnonymousMapping(randomBit),
    humanVote: undefined,
    postRevealFeedback: [],
    geminiEvaluation: undefined,
    verification: { status: 'idle' },
    createdAt: nowIso(now)
  };
}

/** @param {EvaluationSession} session */
export function isVoteLocked(session) {
  return Boolean(session?.humanVote);
}

/**
 * Gemini output may be shown only after the human decided (or skipped) and
 * the evaluation finished.
 * @param {EvaluationSession} session
 */
export function canRevealGemini(session) {
  return isVoteLocked(session) && session.verification?.status === 'done'
    && Boolean(session.geminiEvaluation);
}

/**
 * Errors carry no A/B preference, so they may be shown before the vote.
 * @param {EvaluationSession} session
 */
export function canShowGeminiError(session) {
  return session?.verification?.status === 'error';
}

function validatePreference(preference) {
  if (!PREFERENCES.includes(preference)) {
    throw new Error(`Invalid preference: ${String(preference)}`);
  }
}

function cleanExplanation(explanation) {
  if (typeof explanation !== 'string') return undefined;
  const trimmed = explanation.trim().slice(0, 2000);
  return trimmed || undefined;
}

/**
 * Locks the independent vote. SKIPPED is recorded explicitly.
 * @param {EvaluationSession} session
 * @param {Preference} preference
 * @param {{ explanation?: string, now?: () => Date }} [options]
 * @returns {EvaluationSession}
 */
export function submitVote(session, preference, { explanation, now } = {}) {
  if (isVoteLocked(session)) {
    throw new VoteLockedError();
  }
  validatePreference(preference);
  const vote = { preference, submittedAt: nowIso(now) };
  const reason = preference === 'SKIPPED' ? undefined : cleanExplanation(explanation);
  if (reason) vote.explanation = reason;
  return { ...session, humanVote: vote };
}

/**
 * Records a changed opinion after the reveal without touching the original.
 * @param {EvaluationSession} session
 * @param {Preference} preference
 * @param {{ explanation?: string, now?: () => Date }} [options]
 */
export function addPostRevealFeedback(session, preference, { explanation, now } = {}) {
  if (!canRevealGemini(session)) {
    throw new Error('Post-reveal feedback is only possible after the reveal');
  }
  if (preference === 'SKIPPED') {
    throw new Error('Post-reveal feedback must be A, B or TIE');
  }
  validatePreference(preference);
  const entry = { preference, submittedAt: nowIso(now) };
  const reason = cleanExplanation(explanation);
  if (reason) entry.explanation = reason;
  return {
    ...session,
    postRevealFeedback: [...(session.postRevealFeedback || []), entry]
  };
}

/**
 * @param {EvaluationSession} session
 * @param {{ now?: () => Date }} [options]
 */
export function markVerificationRunning(session, { now } = {}) {
  return { ...session, verification: { status: 'running', startedAt: nowIso(now) } };
}

/**
 * @param {EvaluationSession} session
 * @param {import('./types.js').GeminiEvaluation} evaluation
 * @param {{ now?: () => Date }} [options]
 */
export function markVerificationDone(session, evaluation, { now } = {}) {
  return {
    ...session,
    geminiEvaluation: evaluation,
    verification: {
      status: 'done',
      startedAt: session.verification?.startedAt,
      finishedAt: nowIso(now)
    }
  };
}

/**
 * @param {EvaluationSession} session
 * @param {{ code?: string, message?: string }} error
 * @param {{ now?: () => Date }} [options]
 */
export function markVerificationError(session, error, { now } = {}) {
  return {
    ...session,
    geminiEvaluation: undefined,
    verification: {
      status: 'error',
      startedAt: session.verification?.startedAt,
      finishedAt: nowIso(now),
      error: {
        code: String(error?.code || 'UNKNOWN_ERROR'),
        message: String(error?.message || 'Verification failed').slice(0, 500)
      }
    }
  };
}

/**
 * Sessions saved while verification was running cannot resume the request;
 * on restore they go back to idle so the user can retry.
 * @param {EvaluationSession} session
 */
export function normalizeRestoredSession(session) {
  if (session?.verification?.status === 'running') {
    return { ...session, verification: { status: 'idle' } };
  }
  return session;
}
