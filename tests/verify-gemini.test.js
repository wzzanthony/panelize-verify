import { createGeminiClient, GeminiApiError } from '../modules/verify/gemini-client.js';
import { createGeminiVerificationService, relabelAnonymousText } from '../modules/verify/verification-service.js';
import { parseGroundingMetadata, sanitizeEvidenceUrl, evidenceForSpan } from '../modules/verify/grounding.js';
import { parseFactCheckSections, validateClaimExtraction, validateJudgeOutput } from '../modules/verify/schema.js';
import { createSession, submitVote } from '../modules/verify/session-state.js';

const API_KEY = 'AIzaTEST_KEY_1234567890abcdefghij';

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function textCandidate(text, groundingMetadata) {
  return { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP', groundingMetadata }], usageMetadata: { totalTokenCount: 10 } };
}

function byteIndex(text, fragment) {
  const index = text.indexOf(fragment);
  return new TextEncoder().encode(text.slice(0, index)).length;
}

const FACT_CHECK_TEXT = [
  '### C1',
  'STATUS: SUPPORTED',
  'EXPLANATION: The tower was completed in March 1889 for the World\'s Fair.',
  '',
  '### C2',
  'STATUS: CONTRADICTED',
  'EXPLANATION: Sources give 1889, not 1887. See https://fake-model-url.example/made-up',
  '',
  '### C3',
  'STATUS: SUPPORTED',
  'EXPLANATION: I believe this is right.',
  '',
  '### C4',
  'STATUS: INSUFFICIENT_EVIDENCE',
  'EXPLANATION: No reliable source found.'
].join('\n');

function groundingFor(text) {
  const s1 = 'The tower was completed in March 1889';
  const s2 = 'Sources give 1889, not 1887.';
  return {
    webSearchQueries: ['eiffel tower completion date'],
    searchEntryPoint: { renderedContent: '<div class="chip">eiffel tower</div>' },
    groundingChunks: [
      { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', title: 'toureiffel.paris' } },
      { web: { uri: 'javascript:alert(1)', title: 'evil' } },
      { web: { uri: 'https://www.britannica.com/topic/Eiffel-Tower', title: 'britannica.com' } }
    ],
    groundingSupports: [
      { segment: { startIndex: byteIndex(text, s1), endIndex: byteIndex(text, s1) + s1.length, text: s1 }, groundingChunkIndices: [0, 1], confidenceScores: [0.9, 0.5] },
      { segment: { startIndex: byteIndex(text, s2), endIndex: byteIndex(text, s2) + s2.length, text: s2 }, groundingChunkIndices: [2] }
    ]
  };
}

function makeSession() {
  return createSession({
    prompt: 'When was the Eiffel Tower completed?',
    answerA: { model: 'chatgpt', modelName: 'ChatGPT', content: 'As ChatGPT I can say: it was completed in 1889. Paris is lovely.', completedAt: 't' },
    answerB: { model: 'claude', modelName: 'Claude', content: 'Claude here. It opened in 1887 and is 330 m tall.', completedAt: 't' },
    randomBit: () => 1 // X = B, Y = A
  });
}

function makeFetch({ factCheckText = FACT_CHECK_TEXT, grounding = groundingFor(FACT_CHECK_TEXT), judge } = {}) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const index = calls.length;
    if (index === 1) {
      return jsonResponse(textCandidate(JSON.stringify({
        claims: [
          { id: 'C1', statement: 'The Eiffel Tower was completed in 1889.', answers: ['Y'], verifiable: true },
          { id: 'C2', statement: 'The Eiffel Tower opened in 1887.', answers: ['X'], verifiable: true },
          { id: 'C3', statement: 'The Eiffel Tower is 330 m tall.', answers: ['X'], verifiable: true },
          { id: 'C4', statement: 'The tower has 1,665 steps.', answers: ['X', 'Y'], verifiable: true },
          { id: 'C5', statement: 'Paris is lovely.', answers: ['Y'], verifiable: false }
        ]
      })));
    }
    if (index === 2) {
      return jsonResponse(textCandidate(factCheckText, grounding));
    }
    return jsonResponse(textCandidate(JSON.stringify(judge || {
      verdict: 'Y',
      reasoning: 'Answer Y gives the correct year while Answer X contains a contradicted date.',
      criteria: { factualAccuracy: { X: 2, Y: 5 } }
    })));
  });
  return { fetchImpl, calls };
}

function service(fetchImpl) {
  const client = createGeminiClient({ apiKey: API_KEY, model: 'gemini-test-model', fetchImpl, retryBaseMs: 1 });
  return createGeminiVerificationService({ client, now: () => new Date('2026-11-21T00:00:00Z') });
}

describe('Gemini verification pipeline', () => {
  it('Test 4: requests contain no model names, no vote and no A/B labels', async () => {
    const { fetchImpl, calls } = makeFetch();
    const session = submitVote(makeSession(), 'A', { explanation: 'VOTE-SENTINEL-REASON' });
    await service(fetchImpl).evaluate(session);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      const body = JSON.stringify(call.body);
      expect(body).not.toMatch(/chatgpt|claude|openai|anthropic/i);
      expect(body).not.toMatch(/VOTE-SENTINEL|humanVote|submittedAt|anonymization/);
      expect(body).not.toMatch(/Answer [AB]\b/);
      expect(call.url).not.toContain(API_KEY);
      expect(call.init.headers['x-goog-api-key']).toBe(API_KEY);
      expect(call.url).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-test-model:generateContent$/);
    }
    // Only the fact-check step uses Google Search.
    expect(calls.map(call => Boolean(call.body.tools))).toEqual([false, true, false]);
    expect(calls[1].body.tools).toEqual([{ googleSearch: {} }]);
    // Opinions are not sent to search.
    expect(JSON.stringify(calls[1].body)).not.toContain('Paris is lovely');
  });

  it('Test 5: classifies claims with evidence from grounding metadata only', async () => {
    const { fetchImpl } = makeFetch();
    const evaluation = await service(fetchImpl).evaluate(makeSession());
    const byStatement = Object.fromEntries(evaluation.claims.map(claim => [`${claim.answerId}:${claim.statement}`, claim]));

    const c1 = byStatement['A:The Eiffel Tower was completed in 1889.'];
    expect(c1.status).toBe('SUPPORTED');
    expect(c1.evidence.map(item => item.url)).toEqual(['https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc']);
    expect(c1.evidence[0].title).toBe('toureiffel.paris');
    expect(c1.evidence[0].confidence).toBe(0.9);
    expect(c1.evidence[0].snippet).toBeUndefined();

    const c2 = byStatement['B:The Eiffel Tower opened in 1887.'];
    expect(c2.status).toBe('CONTRADICTED');
    expect(c2.evidence.map(item => item.url)).toEqual(['https://www.britannica.com/topic/Eiffel-Tower']);
    // URL the model wrote itself is never used as evidence.
    expect(JSON.stringify(evaluation.claims)).not.toContain('fake-model-url');

    const c3 = byStatement['B:The Eiffel Tower is 330 m tall.'];
    expect(c3.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(c3.modelStatus).toBe('SUPPORTED');

    const shared = evaluation.claims.filter(claim => claim.sharedId === 'C4');
    expect(shared.map(claim => claim.answerId).sort()).toEqual(['A', 'B']);
    expect(shared.every(claim => claim.status === 'INSUFFICIENT_EVIDENCE')).toBe(true);

    expect(byStatement['A:Paris is lovely.'].status).toBe('NOT_VERIFIABLE');
    expect(evaluation.warnings.join(' ')).toMatch(/downgraded/);
    expect(evaluation.searchEntryPointHtml).toContain('chip');
    expect(evaluation.webSearchQueries).toEqual(['eiffel tower completion date']);
  });

  it('maps the anonymous verdict back to A/B', async () => {
    const { fetchImpl } = makeFetch();
    const evaluation = await service(fetchImpl).evaluate(makeSession()); // X = B, Y = A
    expect(evaluation.anonymousVerdict).toBe('Y');
    expect(evaluation.verdict).toBe('A');
    expect(evaluation.reasoning).toBe('Answer A gives the correct year while Answer B contains a contradicted date.');
    expect(evaluation.criteria.factualAccuracy).toEqual({ A: 5, B: 2 });
  });

  it('Test 7: fails clearly when search returns no evidence', async () => {
    const { fetchImpl, calls } = makeFetch({ grounding: { groundingChunks: [] } });
    await expect(service(fetchImpl).evaluate(makeSession())).rejects.toMatchObject({ code: 'SEARCH_UNAVAILABLE' });
    expect(calls).toHaveLength(2); // no judge verdict without evidence
  });

  it('Test 7: rejects an invalid judge verdict instead of inventing one', async () => {
    const { fetchImpl } = makeFetch({ judge: { verdict: 'MAYBE', reasoning: 'x' } });
    await expect(service(fetchImpl).evaluate(makeSession())).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });
});

describe('Gemini client errors (Test 7)', () => {
  it('reports an invalid key without leaking it', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      error: { message: `API key not valid: ${API_KEY}`, details: [{ reason: 'API_KEY_INVALID' }] }
    }, 400));
    const client = createGeminiClient({ apiKey: API_KEY, model: 'm1', fetchImpl });
    const error = await client.generate({ systemInstruction: 's', userText: 'u' }).catch(e => e);
    expect(error).toBeInstanceOf(GeminiApiError);
    expect(error.code).toBe('INVALID_API_KEY');
    expect(error.message).not.toContain(API_KEY);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries rate limits, then reports quota exhaustion', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: 'Resource exhausted' } }, 429));
    const client = createGeminiClient({ apiKey: API_KEY, model: 'm1', fetchImpl, retryBaseMs: 1, maxRetries: 2 });
    await expect(client.generate({ systemInstruction: 's', userText: 'u' })).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('times out without retrying (a slow request may already be billed)', async () => {
    const fetchImpl = vi.fn((url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const client = createGeminiClient({ apiKey: API_KEY, model: 'm1', fetchImpl, timeoutMs: 20 });
    await expect(client.generate({ systemInstruction: 's', userText: 'u' })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('maps network failures, missing keys, bad model IDs and blocks', async () => {
    const offline = createGeminiClient({ apiKey: API_KEY, model: 'm1', fetchImpl: async () => { throw new TypeError('Failed to fetch'); }, maxRetries: 0 });
    await expect(offline.generate({ systemInstruction: 's', userText: 'u' })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(() => createGeminiClient({ apiKey: '', model: 'm1' })).toThrow(/API key/);
    expect(() => createGeminiClient({ apiKey: API_KEY, model: '../evil' })).toThrow();
    const blocked = createGeminiClient({ apiKey: API_KEY, model: 'm1', fetchImpl: async () => jsonResponse({ promptFeedback: { blockReason: 'SAFETY' } }) });
    await expect(blocked.generate({ systemInstruction: 's', userText: 'u' })).rejects.toMatchObject({ code: 'BLOCKED' });
  });
});

describe('grounding and output validation', () => {
  it('accepts only http(s) evidence URLs', () => {
    expect(sanitizeEvidenceUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(sanitizeEvidenceUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeEvidenceUrl('data:text/html,x')).toBeNull();
    expect(sanitizeEvidenceUrl('https://user:pw@example.com')).toBeNull();
    const parsed = parseGroundingMetadata({ groundingMetadata: groundingFor(FACT_CHECK_TEXT) });
    expect(parsed.chunks.map(chunk => chunk.index)).toEqual([0, 2]);
  });

  it('measures section offsets in UTF-8 bytes', () => {
    const text = '### C1\nSTATUS: SUPPORTED\nEXPLANATION: 埃菲尔铁塔建于1889年。\n### C2\nSTATUS: CONTRADICTED\nEXPLANATION: 错误。';
    const sections = parseFactCheckSections([text], ['C1', 'C2']);
    const fragment = '错误。';
    const start = byteIndex(text, fragment);
    const grounding = {
      chunks: [{ index: 0, url: 'https://a.example', title: 'a' }],
      supports: [{ partIndex: 0, startByte: start, endByte: start + new TextEncoder().encode(fragment).length, text: fragment, chunkIndices: [0], confidence: [] }]
    };
    expect(evidenceForSpan(sections.get('C1'), grounding, 't')).toEqual([]);
    expect(evidenceForSpan(sections.get('C2'), grounding, 't')).toHaveLength(1);
  });

  it('treats unknown statuses as insufficient evidence', () => {
    const sections = parseFactCheckSections(['### C1\nSTATUS: PROBABLY TRUE\nEXPLANATION: x'], ['C1']);
    expect(sections.get('C1').status).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('de-duplicates claims and limits them per answer', () => {
    const claims = validateClaimExtraction({
      claims: [
        { statement: 'Water boils at 100 C.', answers: ['X'] },
        { statement: 'water boils at 100 c', answers: ['Y'] },
        { statement: 'Second.', answers: ['X'] },
        { statement: 'Third.', answers: ['X'] },
        { statement: '', answers: ['X'] },
        { statement: 'No answer label.', answers: ['Z'] }
      ]
    }, { maxClaimsPerAnswer: 2 });
    expect(claims.map(claim => [claim.statement, claim.answers])).toEqual([
      ['Water boils at 100 C.', ['X', 'Y']],
      ['Second.', ['X']]
    ]);
  });

  it('validates judge output', () => {
    expect(validateJudgeOutput({ verdict: 'tie', reasoning: 'Both fine.' }).verdict).toBe('TIE');
    expect(() => validateJudgeOutput({ verdict: 'X', reasoning: '' })).toThrow();
    expect(relabelAnonymousText('Answer X beats Answer Y; Answers X and Y differ', { X: 'B', Y: 'A' }))
      .toBe('Answer B beats Answer A; Answers B and A differ');
  });
});
