import {
  createSession,
  submitVote,
  addPostRevealFeedback,
  canRevealGemini,
  markVerificationRunning,
  markVerificationDone,
  markVerificationError,
  normalizeRestoredSession,
  VoteLockedError
} from '../modules/verify/session-state.js';
import {
  createAnonymousMapping,
  anonymousVerdictToAnswer,
  redactModelIdentity,
  buildAnonymousAnswers,
  REDACTION_TOKEN
} from '../modules/verify/anonymizer.js';
import { createCompletionDetector, promptMatchesUserTurn } from '../modules/verify/completion-detector.js';
import { compareJudgements, computeAgreementStats } from '../modules/verify/agreement.js';
import { normalizeSettings, exportSessionsJson } from '../modules/verify/storage.js';

const fixedNow = () => new Date('2026-11-21T10:00:00Z');

function makeSession(overrides = {}) {
  return createSession({
    prompt: 'When was the Eiffel Tower finished?',
    answerA: { model: 'chatgpt', modelName: 'ChatGPT', content: 'In 1889. As ChatGPT, I am sure.', completedAt: 'now' },
    answerB: { model: 'claude', modelName: 'Claude', content: 'It was completed in 1887.', completedAt: 'now' },
    now: fixedNow,
    randomBit: () => 1,
    ...overrides
  });
}

const evaluation = { model: 'm', verdict: 'A', reasoning: 'r', claims: [], evaluatedAt: 'now' };

describe('session state: human-first rules (Test 3)', () => {
  it('requires both answers', () => {
    expect(() => createSession({ prompt: 'p', answerA: { content: 'x' }, answerB: { content: ' ' } })).toThrow();
  });

  it('hides Gemini results until the vote is submitted', () => {
    let session = markVerificationDone(markVerificationRunning(makeSession()), evaluation);
    expect(canRevealGemini(session)).toBe(false);
    session = submitVote(session, 'B', { now: fixedNow });
    expect(canRevealGemini(session)).toBe(true);
  });

  it('records SKIPPED explicitly and then allows the reveal', () => {
    let session = submitVote(makeSession(), 'SKIPPED', { explanation: 'ignored' });
    expect(session.humanVote.preference).toBe('SKIPPED');
    expect(session.humanVote.explanation).toBeUndefined();
    session = markVerificationDone(session, evaluation);
    expect(canRevealGemini(session)).toBe(true);
  });

  it('locks the first vote and keeps later opinions as post-reveal feedback', () => {
    let session = submitVote(makeSession(), 'A', { explanation: ' clearer ', now: fixedNow });
    expect(session.humanVote).toEqual({ preference: 'A', submittedAt: fixedNow().toISOString(), explanation: 'clearer' });
    expect(() => submitVote(session, 'B')).toThrow(VoteLockedError);
    expect(() => addPostRevealFeedback(session, 'B')).toThrow(); // not revealed yet
    session = markVerificationDone(session, evaluation);
    session = addPostRevealFeedback(session, 'B', { explanation: 'after evidence' });
    expect(session.humanVote.preference).toBe('A');
    expect(session.postRevealFeedback).toHaveLength(1);
    expect(session.postRevealFeedback[0].preference).toBe('B');
  });

  it('rejects unknown preferences', () => {
    expect(() => submitVote(makeSession(), 'C')).toThrow();
  });

  it('stores verification errors without any evaluation', () => {
    const session = markVerificationError(markVerificationRunning(makeSession()), { code: 'TIMEOUT', message: 'slow' });
    expect(session.verification.status).toBe('error');
    expect(session.geminiEvaluation).toBeUndefined();
    expect(canRevealGemini(submitVote(session, 'A'))).toBe(false);
  });

  it('resets a verification that was running when the page closed', () => {
    const session = normalizeRestoredSession(markVerificationRunning(makeSession()));
    expect(session.verification.status).toBe('idle');
  });
});

describe('anonymization (Test 4: blind evaluation)', () => {
  it('maps X/Y to A/B both ways', () => {
    const swapped = createAnonymousMapping(() => 1);
    expect(swapped).toEqual({ X: 'B', Y: 'A' });
    expect(anonymousVerdictToAnswer('X', swapped)).toBe('B');
    expect(anonymousVerdictToAnswer('Y', swapped)).toBe('A');
    expect(anonymousVerdictToAnswer('TIE', swapped)).toBe('TIE');
    expect(anonymousVerdictToAnswer('UNCERTAIN', swapped)).toBe('UNCERTAIN');
    expect(createAnonymousMapping(() => 0)).toEqual({ X: 'A', Y: 'B' });
  });

  it('uses both orders over many sessions (position randomization)', () => {
    const seen = new Set();
    for (let i = 0; i < 64; i += 1) seen.add(createAnonymousMapping().X);
    expect(seen).toEqual(new Set(['A', 'B']));
  });

  it('redacts self-references of the compared models', () => {
    const { text, redactions } = redactModelIdentity(
      'I am Claude, made by Anthropic. GPT-4o and ChatGPT differ.', ['chatgpt', 'claude'], 'What is TCP?'
    );
    expect(text).not.toMatch(/claude|anthropic|chatgpt|gpt/i);
    expect(text).toContain(REDACTION_TOKEN);
    expect(redactions).toBe(4);
  });

  it('keeps model names the prompt itself asks about', () => {
    const { text } = redactModelIdentity('Claude is an assistant by Anthropic.', ['claude'], 'Who makes Claude?');
    expect(text).toContain('Claude');
    expect(text).not.toContain('Anthropic');
  });

  it('builds the anonymous pair in mapped order and truncates long answers', () => {
    const session = makeSession();
    const pair = buildAnonymousAnswers(session, { maxChars: 20 });
    expect(pair.X.startsWith('It was completed in')).toBe(true); // X = B
    expect(pair.Y).not.toContain('ChatGPT');
    expect(pair.truncated).toBe(true);
  });
});

describe('completion detector', () => {
  const baseline = { supported: true, userTurnCount: 1, lastUserHash: 'old' };
  const state = (extra) => ({
    supported: true, userTurnCount: 2, lastUserHash: 'new', lastUserText: 'When was the Eiffel Tower finished?',
    generating: false, hasAnswer: true, text: 'In 1889', textHash: 'h1', ...extra
  });

  it('never accepts the previous turn\'s answer', () => {
    const detector = createCompletionDetector({ prompt: 'When was the Eiffel Tower finished?', baseline, stableMs: 1000 });
    const old = state({ userTurnCount: 1, lastUserHash: 'old', lastUserText: 'older question' });
    expect(detector.update(old, 0).phase).toBe('waiting');
    expect(detector.update(old, 10000).phase).toBe('waiting');
  });

  it('waits while generating and until the text is stable', () => {
    const detector = createCompletionDetector({ prompt: 'When was the Eiffel Tower finished?', baseline, stableMs: 1000 });
    expect(detector.update(state({ generating: true }), 0).phase).toBe('generating');
    expect(detector.update(state({ textHash: 'h2', text: 'In 1889, in Paris' }), 500).phase).toBe('stabilizing');
    expect(detector.update(state({ textHash: 'h2', text: 'In 1889, in Paris' }), 1600)).toEqual({ phase: 'complete', text: 'In 1889, in Paris' });
  });

  it('flags a new turn that does not match the prompt', () => {
    const detector = createCompletionDetector({ prompt: 'When was the Eiffel Tower finished?', baseline });
    expect(detector.update(state({ lastUserText: 'something else entirely' }), 0).phase).toBe('mismatch');
  });

  it('matches prompts despite whitespace differences', () => {
    expect(promptMatchesUserTurn('Hello   world\nagain', 'Hello world again')).toBe(true);
    expect(promptMatchesUserTurn('Hello', '')).toBe(false);
  });
});

describe('human vs Gemini agreement (Test 6)', () => {
  it.each([
    ['A', 'B', 'DISAGREE'],
    ['A', 'A', 'AGREE'],
    ['TIE', 'TIE', 'AGREE'],
    ['TIE', 'A', 'PARTIAL'],
    ['B', 'TIE', 'PARTIAL'],
    ['A', 'UNCERTAIN', 'AI_UNCERTAIN'],
    ['SKIPPED', 'A', 'NO_HUMAN_VOTE'],
    [undefined, 'A', 'PENDING']
  ])('human %s vs Gemini %s -> %s', (human, gemini, expected) => {
    expect(compareJudgements(human, gemini)).toBe(expected);
  });

  it('computes agreement only over comparable sessions', () => {
    const mk = (human, verdict) => ({
      answerA: { model: 'chatgpt' }, answerB: { model: 'claude' },
      humanVote: human ? { preference: human } : undefined,
      geminiEvaluation: verdict ? { verdict } : undefined
    });
    const stats = computeAgreementStats([mk('A', 'A'), mk('A', 'B'), mk('SKIPPED', 'B'), mk('B', 'UNCERTAIN')]);
    expect(stats.comparable).toBe(2);
    expect(stats.agreementRate).toBe(0.5);
    expect(stats.counts.NO_HUMAN_VOTE).toBe(1);
    expect(stats.geminiWinsByModel).toEqual({ chatgpt: 1, claude: 2 });
  });
});

describe('settings and export', () => {
  it('falls back to defaults for invalid settings', () => {
    const settings = normalizeSettings({ model: 'bad model!', maxClaimsPerAnswer: 999, autoVerify: 'yes' });
    expect(settings.model).toBe('gemini-3.5-flash-lite');
    expect(settings.maxClaimsPerAnswer).toBe(8);
    expect(settings.autoVerify).toBe(true);
    expect(settings.consentAcknowledged).toBe(false);
  });

  it('exports JSON without raw grounding metadata by default', () => {
    const session = { ...makeSession(), geminiEvaluation: { ...evaluation, groundingMetadata: { big: true } } };
    const exported = JSON.parse(exportSessionsJson([session]));
    expect(exported.format).toBe('panelize-verify-sessions');
    expect(exported.sessions[0].geminiEvaluation.groundingMetadata).toBeUndefined();
    expect(JSON.parse(exportSessionsJson([session], { includeGroundingMetadata: true }))
      .sessions[0].geminiEvaluation.groundingMetadata).toEqual({ big: true });
  });
});

describe('completion detector fallbacks (real pages drift)', () => {
  const prompt = 'When was the **Eiffel Tower** finished?';
  const reply = (extra = {}) => ({
    supported: true, generating: false, hasAnswer: true,
    userTurnCount: 0, lastUserText: '', lastUserHash: undefined,
    text: 'In 1889.', textHash: 'new', ...extra
  });

  it('accepts a changed reply when the page shows no user turns at all', () => {
    const baseline = { supported: true, userTurnCount: 0, hasAnswer: true, textHash: 'old' };
    const detector = createCompletionDetector({ prompt, baseline, stableMs: 1000 });
    expect(detector.update(reply({ textHash: 'old' }), 0).phase).toBe('waiting');
    expect(detector.update(reply(), 100).phase).toBe('stabilizing');
    expect(detector.update(reply(), 1200).phase).toBe('complete');
  });

  it('matches a prompt the page rendered without its Markdown', () => {
    const baseline = { supported: true, userTurnCount: 1, lastUserHash: 'old' };
    const detector = createCompletionDetector({ prompt, baseline, stableMs: 0 });
    expect(detector.update(reply({ userTurnCount: 2, lastUserText: 'When was the Eiffel Tower finished?' }), 0).phase).toBe('complete');
  });

  it('finishes when "generating" stays on but the text stopped changing', () => {
    const baseline = { supported: true, userTurnCount: 1, lastUserHash: 'old' };
    const detector = createCompletionDetector({ prompt, baseline, stableMs: 1000, stallMs: 5000 });
    const stuck = reply({ userTurnCount: 2, lastUserText: prompt, generating: true });
    expect(detector.update(stuck, 0).phase).toBe('generating');
    expect(detector.update(stuck, 4000).phase).toBe('generating');
    expect(detector.update(stuck, 5100).phase).toBe('complete');
  });
});
