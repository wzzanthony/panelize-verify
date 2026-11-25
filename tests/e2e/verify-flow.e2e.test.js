import { test, expect } from '@playwright/test';
import { launchExtension, openMultiPanel } from './extension-harness.js';
import { renderVerifyChatFixture, renderGeminiWebJudgeFixture } from './fixtures/verify-chat-fixture.js';

const PROMPT = 'When was the Eiffel Tower completed?';
const JUDGE_REASONING = 'Answer X states the correct completion year; Answer Y gives 1887, which sources contradict.';

function geminiResponse(text, groundingMetadata) {
  return {
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP', groundingMetadata }],
    usageMetadata: { totalTokenCount: 42 }
  };
}

function factCheckBody() {
  const text = [
    '### C1', 'STATUS: SUPPORTED', 'EXPLANATION: The tower was completed in March 1889.', '',
    '### C2', 'STATUS: CONTRADICTED', 'EXPLANATION: Sources give 1889, not 1887.'
  ].join('\n');
  const s1 = 'The tower was completed in March 1889.';
  const s2 = 'Sources give 1889, not 1887.';
  return geminiResponse(text, {
    webSearchQueries: ['eiffel tower completed year'],
    searchEntryPoint: { renderedContent: '<div style="font:13px sans-serif">Search: <a href="https://www.google.com/search?q=eiffel">eiffel tower completed year</a></div>' },
    groundingChunks: [
      { web: { uri: 'https://www.toureiffel.paris/en/the-monument/history', title: 'toureiffel.paris' } },
      { web: { uri: 'https://www.britannica.com/topic/Eiffel-Tower-Paris-France', title: 'britannica.com' } }
    ],
    groundingSupports: [
      { segment: { startIndex: text.indexOf(s1), endIndex: text.indexOf(s1) + s1.length, text: s1 }, groundingChunkIndices: [0] },
      { segment: { startIndex: text.indexOf(s2), endIndex: text.indexOf(s2) + s2.length, text: s2 }, groundingChunkIndices: [1] }
    ]
  });
}

test('Verify: capture both answers, vote first, then reveal the blind Gemini check', async ({}, testInfo) => {
  test.setTimeout(90000);
  const extension = await launchExtension({ viewport: { width: 1400, height: 1000 } });
  const geminiRequests = [];
  try {
    await extension.context.route('https://chatgpt.com/**', route => route.fulfill({
      contentType: 'text/html',
      body: renderVerifyChatFixture({
        provider: 'chatgpt',
        chunks: ['<p>The Eiffel Tower was completed in <strong>1889</strong> for the World\'s Fair.</p>', '<p>As ChatGPT, I am confident.</p>']
      })
    }));
    await extension.context.route('https://claude.ai/**', route => route.fulfill({
      contentType: 'text/html',
      body: renderVerifyChatFixture({
        provider: 'claude',
        chunks: ['<p>It opened in 1887.</p>', '<ul><li>Height: 330 m</li></ul>'],
        chunkDelayMs: 500
      })
    }));
    await extension.context.route('https://generativelanguage.googleapis.com/**', async route => {
      const request = route.request();
      const body = JSON.parse(request.postData() || '{}');
      geminiRequests.push({ url: request.url(), headers: request.headers(), body });
      const system = body.systemInstruction?.parts?.[0]?.text || '';
      let payload;
      if (system.startsWith('You extract')) {
        // Mapping is random, so claims refer to whichever label holds each text.
        const user = body.contents[0].parts[0].text;
        const xHas1889 = user.indexOf('1889') < user.indexOf('<<<BEGIN ANSWER Y>>>');
        payload = geminiResponse(JSON.stringify({ claims: [
          { id: 'C1', statement: 'The Eiffel Tower was completed in 1889.', answers: [xHas1889 ? 'X' : 'Y'], verifiable: true },
          { id: 'C2', statement: 'The Eiffel Tower opened in 1887.', answers: [xHas1889 ? 'Y' : 'X'], verifiable: true }
        ] }));
        globalThis.__xHas1889 = xHas1889;
      } else if (body.tools) {
        payload = factCheckBody();
      } else {
        const winner = globalThis.__xHas1889 ? 'X' : 'Y';
        payload = geminiResponse(JSON.stringify({
          verdict: winner,
          reasoning: winner === 'X' ? JUDGE_REASONING : JUDGE_REASONING.replace('Answer X', 'Answer @').replace('Answer Y', 'Answer X').replace('Answer @', 'Answer Y'),
          criteria: { factualAccuracy: { X: winner === 'X' ? 5 : 2, Y: winner === 'Y' ? 5 : 2 } }
        }));
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
    });

    const page = await openMultiPanel(extension, { providers: ['chatgpt', 'claude'], layout: '1x2' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const dock = page.locator('#verify-dock');
    await expect(dock).toBeVisible();

    // Configure API mode, key and consent through the settings dialog.
    await dock.getByRole('button', { name: 'Verify settings' }).click();
    const modal = page.locator('.pv-modal');
    await modal.getByRole('radio', { name: /API mode/ }).check();
    await modal.locator('input[type="password"]').fill('AIzaE2E_TEST_KEY_000000000000000000');
    await modal.getByText('I understand that verification sends').click();
    await modal.getByRole('button', { name: 'Save' }).click();
    await expect(modal.getByText('Saved.')).toBeVisible();
    await modal.getByRole('button', { name: 'Close' }).click();

    await page.locator('#unified-input').fill(PROMPT);
    await page.locator('#send-all-btn').click();

    // Both replies are captured after streaming ends; voting opens.
    await expect(dock.getByRole('radio', { name: 'Answer A is better' })).toBeVisible({ timeout: 30000 });
    await expect(dock.getByText('Results are hidden until you submit or skip your vote')).toBeVisible({ timeout: 30000 });
    expect(geminiRequests).toHaveLength(3);

    const beforeVote = await dock.innerText();
    expect(beforeVote).not.toContain('sources contradict');
    expect(beforeVote).not.toContain('Gemini Preference');
    expect(beforeVote).not.toMatch(/Contradicted|Supported:/);
    await page.screenshot({ path: testInfo.outputPath('1-before-vote.png') });

    // Captured text: only the new turn, full and normalized.
    await dock.locator('details.pv-answer summary').first().click();
    await dock.locator('details.pv-answer summary').nth(1).click();
    const answers = await dock.locator('.pv-answer-text').allInnerTexts();
    expect(answers[0]).toBe('The Eiffel Tower was completed in **1889** for the World\'s Fair.\n\nAs ChatGPT, I am confident.');
    expect(answers[1]).toBe('It opened in 1887.\n\n- Height: 330 m');
    expect(answers.join(' ')).not.toContain('EARLIER ANSWER');

    // Blind requests: no model names, key only in the header.
    for (const request of geminiRequests) {
      const serialized = JSON.stringify(request.body);
      expect(serialized).not.toMatch(/chatgpt|claude|openai|anthropic/i);
      expect(request.url).not.toContain('AIzaE2E');
      expect(request.headers['x-goog-api-key']).toBe('AIzaE2E_TEST_KEY_000000000000000000');
    }

    await dock.getByRole('radio', { name: 'Answer B is better' }).click();
    await dock.getByRole('button', { name: 'Submit Vote' }).click();

    await expect(dock.getByText('Gemini Preference')).toBeVisible();
    await expect(dock.locator('.pv-verdict')).toHaveText('Answer A is better');
    await expect(dock.locator('.pv-agree-DISAGREE')).toHaveText('Disagree');
    await expect(dock.getByText('Answer A states the correct completion year; Answer B gives 1887, which sources contradict.')).toBeVisible();
    await expect(dock.locator('a[href="https://www.britannica.com/topic/Eiffel-Tower-Paris-France"]')).toHaveCount(1);
    await expect(dock.locator('iframe.pv-search-suggestions')).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('2-after-vote.png'), fullPage: true });

    // Test 8: reload restores the saved, revealed session.
    await page.reload();
    await expect(page.locator('#verify-dock .pv-locked')).toContainText('Your vote: Answer B');
    await expect(page.locator('#verify-dock .pv-agree-DISAGREE')).toHaveText('Disagree');
    expect(errors).toEqual([]);
  } finally {
    await extension.close();
  }
});

test('Verify web mode: two answer panels on top, Gemini verifies below, no API call, results after the vote', async ({}, testInfo) => {
  test.setTimeout(120000);
  const extension = await launchExtension({ viewport: { width: 1400, height: 1000 } });
  const apiRequests = [];
  const geminiEvents = [];
  try {
    await extension.context.exposeBinding('__recordGeminiWeb', (_source, event) => { geminiEvents.push(event); });
    await extension.context.route('https://chatgpt.com/**', route => route.fulfill({
      contentType: 'text/html',
      body: renderVerifyChatFixture({
        provider: 'chatgpt',
        chunks: ['<p>The Eiffel Tower was completed in <strong>1889</strong> for the World\'s Fair.</p>', '<p>As ChatGPT, I am confident.</p>']
      })
    }));
    await extension.context.route('https://claude.ai/**', route => route.fulfill({
      contentType: 'text/html',
      body: renderVerifyChatFixture({ provider: 'claude', chunks: ['<p>It opened in 1887.</p>'], chunkDelayMs: 500 })
    }));
    await extension.context.route('https://gemini.google.com/**', route => route.fulfill({
      contentType: 'text/html',
      body: renderGeminiWebJudgeFixture()
    }));
    await extension.context.route('https://generativelanguage.googleapis.com/**', route => {
      apiRequests.push(route.request().url());
      return route.abort();
    });

    // Panelize's default three panels: Gemini at the top must not answer.
    const page = await openMultiPanel(extension, { providers: ['chatgpt', 'claude', 'gemini'], layout: '1x3' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const dock = page.locator('#verify-dock');
    const pane = page.locator('#verify-judge-pane');

    // Web mode is the default: only the consent is needed, no key.
    await dock.getByRole('button', { name: 'Verify settings' }).click();
    const modal = page.locator('.pv-modal');
    await expect(modal.getByRole('radio', { name: /Web mode/ })).toBeChecked();
    await expect(modal.locator('input[type="password"]')).toBeHidden();
    await modal.getByText('I understand that web mode sends').click();
    await modal.getByRole('button', { name: 'Save' }).click();
    await expect(modal.getByText('Saved.')).toBeVisible();
    await modal.getByRole('button', { name: 'Close' }).click();

    await page.locator('#unified-input').fill(PROMPT);
    await page.locator('#send-all-btn').click();

    // While Gemini works, the verifier panel below is covered.
    await expect(pane.locator('.pv-judge-cover')).toContainText('covered until you vote', { timeout: 30000 });
    await expect(pane).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('web-1-running.png') });

    await expect(dock.getByText('Results are hidden until you submit or skip your vote')).toBeVisible({ timeout: 60000 });
    await expect(pane.locator('.pv-judge-cover')).toContainText('covered until you vote or skip');
    await expect(pane.locator('iframe.pv-judge-frame')).toHaveCount(1);
    expect(apiRequests).toEqual([]);

    // Only the verifier got a message; the Gemini panel at the top got no prompt.
    const sent = geminiEvents.filter(event => event.type === 'sent');
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('专业验收团队');
    expect(sent.some(event => event.text.trim() === PROMPT)).toBe(false);
    expect(sent[0].temporaryChat).toBe(true);
    expect(sent[0].text).toContain('<<<BEGIN ANSWER X>>>');
    expect(sent[0].text).not.toMatch(/chatgpt|claude|openai|anthropic/i);

    const beforeVote = await dock.innerText();
    expect(beforeVote).not.toContain('gives the correct year');
    expect(beforeVote).not.toContain('Gemini Preference');

    await dock.getByRole('radio', { name: 'Answer B is better' }).click();
    await dock.getByRole('button', { name: 'Submit Vote' }).click();

    await expect(dock.locator('.pv-verdict')).toHaveText('Answer A is better');
    await expect(dock.locator('.pv-agree-DISAGREE')).toHaveText('Disagree');
    await expect(dock.getByText('Answer A gives the correct year; Answer B is contradicted by sources.')).toBeVisible();
    await expect(dock.getByText(/Gemini web mode .*temporary chat on · 1 of 2 cited sources confirmed/)).toBeVisible();
    // The contradicted claim cites a page Gemini did not show: not counted.
    await expect(dock.locator('.pv-unconfirmed')).toHaveCount(1);
    await expect(dock.getByText('B. Logic Review')).toBeVisible();
    await expect(dock.locator('.pv-logic-issues').getByText('Calculation error')).toBeVisible();
    // After the vote the verifier panel is uncovered: Gemini's own report is readable.
    await expect(pane.locator('.pv-judge-cover')).toBeHidden();
    await expect(dock.locator('.pv-count.pv-status-SUPPORTED').first()).toHaveText('Supported: 1');
    await page.screenshot({ path: testInfo.outputPath('web-2-after-vote.png'), fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    await extension.close();
  }
});
