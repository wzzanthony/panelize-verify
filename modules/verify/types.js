// Panelize Verify — shared type definitions (JSDoc) and enums.
//
// Panelize ships plain ES modules with no build step, so the TypeScript
// types from the spec are expressed as JSDoc and checked with `tsc --checkJs`
// (see `npm run typecheck`).

/** @typedef {'A' | 'B' | 'TIE' | 'SKIPPED'} Preference */
/** @typedef {'SUPPORTED' | 'CONTRADICTED' | 'INSUFFICIENT_EVIDENCE' | 'NOT_VERIFIABLE'} VerificationStatus */
/** @typedef {'A' | 'B' | 'TIE' | 'UNCERTAIN'} JudgeVerdict */
/** @typedef {'X' | 'Y' | 'TIE' | 'UNCERTAIN'} AnonymousVerdict */
/** @typedef {'A' | 'B'} AnswerId */
/** @typedef {'X' | 'Y'} AnonymousId */

/**
 * Evidence comes only from Gemini's grounding metadata, never from URLs the
 * model wrote in its text.
 * @typedef {object} Evidence
 * @property {string} url Grounding chunk URI (often a Google redirect URL).
 * @property {string} [title] Chunk title; for web chunks usually the domain.
 * @property {string} [publisher]
 * @property {string} [publishedAt] Not provided by grounding metadata; left unset.
 * @property {string} [retrievedAt] When the verification response arrived.
 * @property {string} [snippet] Source text; grounding does not return it, so unset.
 * @property {string} [citedText] Gemini's own sentence that this source supports.
 * @property {number} [confidence] Grounding support confidence, 0..1, if given.
 * @property {boolean} [confirmed] Web mode only: the URL also appeared in the
 *   Gemini page's own citation links. Unconfirmed sources never verify a claim.
 */

/**
 * @typedef {object} VerifiedClaim
 * @property {string} id
 * @property {string} sharedId Same value for one claim found in both answers.
 * @property {AnswerId} answerId
 * @property {string} statement
 * @property {VerificationStatus} status
 * @property {VerificationStatus} [modelStatus] What Gemini said, before evidence checks.
 * @property {string} explanation
 * @property {Evidence[]} evidence
 */

/**
 * @typedef {object} AnswerRecord
 * @property {string} model Provider id, e.g. "chatgpt".
 * @property {string} [modelName] Display name, e.g. "ChatGPT".
 * @property {string} content
 * @property {string} completedAt
 * @property {'auto' | 'manual'} [source]
 */

/**
 * @typedef {object} HumanVote
 * @property {Preference} preference
 * @property {string} submittedAt
 * @property {string} [explanation]
 */

/**
 * @typedef {object} PostRevealFeedback
 * @property {Preference} preference
 * @property {string} submittedAt
 * @property {string} [explanation]
 */

/**
 * @typedef {object} GeminiEvaluation
 * @property {string} model
 * @property {'api' | 'web'} [backend] How Gemini was reached; absent means 'api'.
 * @property {JudgeVerdict} verdict
 * @property {AnonymousVerdict} [anonymousVerdict] Verdict as Gemini gave it (X/Y).
 * @property {string} reasoning
 * @property {VerifiedClaim[]} claims
 * @property {string} evaluatedAt
 * @property {object} [criteria]
 * @property {string[]} [warnings]
 * @property {string[]} [webSearchQueries]
 * @property {string} [searchEntryPointHtml]
 * @property {object} [usage]
 * @property {number} [redactions] Model self-references redacted before sending.
 * @property {unknown} [groundingMetadata]
 */

/**
 * @typedef {object} VerificationState
 * @property {'idle' | 'running' | 'done' | 'error'} status
 * @property {string} [startedAt]
 * @property {string} [finishedAt]
 * @property {{ code: string, message: string }} [error]
 */

/**
 * @typedef {object} EvaluationSession
 * @property {string} id
 * @property {string} prompt
 * @property {AnswerRecord} answerA
 * @property {AnswerRecord} answerB
 * @property {{ X: AnswerId, Y: AnswerId }} anonymization Kept locally, never sent.
 * @property {HumanVote} [humanVote] The independent vote; immutable once set.
 * @property {PostRevealFeedback[]} postRevealFeedback
 * @property {GeminiEvaluation} [geminiEvaluation]
 * @property {VerificationState} verification
 * @property {string} createdAt
 */

export const PREFERENCES = Object.freeze(['A', 'B', 'TIE', 'SKIPPED']);
export const VERIFICATION_STATUSES = Object.freeze([
  'SUPPORTED', 'CONTRADICTED', 'INSUFFICIENT_EVIDENCE', 'NOT_VERIFIABLE'
]);
export const JUDGE_VERDICTS = Object.freeze(['A', 'B', 'TIE', 'UNCERTAIN']);
export const ANONYMOUS_VERDICTS = Object.freeze(['X', 'Y', 'TIE', 'UNCERTAIN']);
