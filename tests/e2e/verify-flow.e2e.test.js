import { test, expect } from '@playwright/test';
import { launchExtension, openMultiPanel } from './extension-harness.js';
import { renderVerifyChatFixture, renderGeminiWebJudgeFixture } from './fixtures/verify-chat-fixture.js';

const PROMPT = 'When was the Eiffel Tower completed?';
const JUDGE_REASONING = 'Answer X states the correct completion year; Answer Y gives 1887, which sources contradict.';

/** Opens the Verify window from the status bar; it is a separate browser window. */
async function openVerifyWindow(page) {
  const popupPromise = page.waitForEvent('popup');
  await page.locator('#verify-bar').getByRole('button', { name: /打开|去投票/ }).click();
  const win = await popupPromise;
  await win.waitForLoadState();
  const dock = win.locator('#verify-dock');
  await expect(dock).toBeVisible();
  return { win, dock };
}

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
    const bar = page.locator('#verify-bar');
    await expect(bar).toBeVisible();
    await expect(page.locator('#verify-dock')).toBeHidden();

    // Configure API mode, key and consent through the settings dialog.
    await bar.getByRole('button', { name: 'Verify settings' }).click();
    const modal = page.locator('.pv-modal');
    await modal.getByRole('radio', { name: /API mode/ }).check();
    await modal.locator('input[type="password"]').fill('AIzaE2E_TEST_KEY_000000000000000000');
    await modal.getByText('I understand that verification sends').click();
    await expect(modal.getByRole('checkbox', { name: /Verify automatically/ })).toBeChecked();
    await modal.getByRole('button', { name: 'Save' }).click();
    await expect(modal.getByText('Saved.')).toBeVisible();
    await modal.getByRole('button', { name: 'Close' }).click();

    await page.locator('#unified-input').fill(PROMPT);
    await page.locator('#send-all-btn').click();

    // Both replies are captured after streaming ends; Gemini runs in the
    // background and the bar says when it is done, without its verdict.
    await expect(bar).toContainText('验证完成 · 投票后查看', { timeout: 30000 });
    expect(geminiRequests).toHaveLength(3);
    expect(await bar.innerText()).not.toContain('Answer A is better');

    const { win, dock } = await openVerifyWindow(page);
    await expect(dock.getByRole('radio', { name: 'Answer A is better' })).toBeVisible();
    await expect(dock.getByText('Results are hidden until you submit or skip your vote')).toBeVisible();

    const beforeVote = await dock.innerText();
    expect(beforeVote).not.toContain('sources contradict');
    expect(beforeVote).not.toContain('Gemini Preference');
    expect(beforeVote).not.toMatch(/Contradicted|Supported:/);
    await page.screenshot({ path: testInfo.outputPath('1-before-vote.png') });
    await win.screenshot({ path: testInfo.outputPath('1-window-before-vote.png') });

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
    await win.screenshot({ path: testInfo.outputPath('2-window-after-vote.png'), fullPage: true });
    await expect(bar).toContainText('结果已揭晓');

    // Test 8: reload restores the saved, revealed session (the window closes
    // with the page and opens again from the bar).
    await page.reload();
    await expect(page.locator('#verify-bar')).toContainText('结果已揭晓');
    const reopened = await openVerifyWindow(page);
    await expect(reopened.dock.locator('.pv-locked')).toContainText('Your vote: Answer B');
    await expect(reopened.dock.locator('.pv-agree-DISAGREE')).toHaveText('Disagree');
    expect(errors).toEqual([]);
  } finally {
    await extension.close();
  }
});

test('Verify web mode: answers in the panels, Gemini verifies in the background, the bar says when, results in the Verify window after the vote', async ({}, testInfo) => {
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
    const bar = page.locator('#verify-bar');
    const pane = page.locator('#verify-judge-pane');

    // Web mode is the default; the bar asks for the one-time consent. No key.
    await expect(bar).toContainText('首次使用需确认');
    await bar.getByRole('button', { name: '允许 Gemini 验证' }).click();
    await expect(bar).toContainText('待命');

    await page.locator('#unified-input').fill(PROMPT);
    await page.locator('#send-all-btn').click();

    // Gemini works in the background; its page (the thumbnail) is covered.
    await expect(pane.locator('.pv-judge-cover')).toContainText('Gemini 验证中', { timeout: 30000 });
    await expect(pane).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('web-1-running.png') });

    await expect(bar).toContainText('验证完成 · 投票后查看', { timeout: 60000 });
    await expect(bar.getByRole('button', { name: /验证完成 · 打开/ })).toBeVisible();
    await expect(pane.locator('.pv-judge-cover')).toContainText('投票后可看');
    await expect(pane.locator('iframe.pv-judge-frame')).toHaveCount(1);
    expect(apiRequests).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('web-2-done-before-vote.png') });

    // Only the verifier got a message; the Gemini panel at the top got no prompt.
    const sent = geminiEvents.filter(event => event.type === 'sent');
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('专业验收团队');
    expect(sent.some(event => event.text.trim() === PROMPT)).toBe(false);
    expect(sent[0].temporaryChat).toBe(true);
    expect(sent[0].text).toContain('<<<BEGIN ANSWER X>>>');
    expect(sent[0].text).not.toMatch(/chatgpt|claude|openai|anthropic/i);

    const { win, dock } = await openVerifyWindow(page);
    const beforeVote = await dock.innerText();
    expect(beforeVote).not.toContain('gives the correct year');
    expect(beforeVote).not.toContain('Gemini Preference');
    await win.screenshot({ path: testInfo.outputPath('web-3-window-before-vote.png') });

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
    await expect(dock.locator('.pv-count.pv-status-SUPPORTED').first()).toHaveText('Supported: 1');
    // Gemini's readable report, and its page, after the vote.
    await expect(dock.getByText('Gemini 验收报告（全文）')).toBeVisible();
    await expect(pane.locator('.pv-judge-cover')).toBeHidden();
    await win.screenshot({ path: testInfo.outputPath('web-4-window-after-vote.png'), fullPage: true });
    await pane.locator('.pv-judge-peek').click();
    await expect(pane).toHaveClass(/pv-judge-open/);
    await page.screenshot({ path: testInfo.outputPath('web-5-gemini-page-open.png') });
    expect(errors).toEqual([]);
  } finally {
    await extension.close();
  }
});
