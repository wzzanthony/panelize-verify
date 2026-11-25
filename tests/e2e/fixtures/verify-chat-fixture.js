/**
 * Chat page for Panelize Verify E2E runs, shaped like ChatGPT or Claude:
 * an earlier turn is already on the page, and sending appends a user turn
 * and streams the reply in chunks while a "stop" control is shown.
 *
 * @param {object} options
 * @param {'chatgpt' | 'claude'} options.provider
 * @param {string[]} options.chunks HTML chunks of the streamed reply.
 * @param {number} [options.chunkDelayMs]
 * @returns {string}
 */
export function renderVerifyChatFixture({ provider, chunks, chunkDelayMs = 300 }) {
  const isClaude = provider === 'claude';
  const composer = isClaude
    ? `<fieldset>
         <div class="ProseMirror" contenteditable="true" role="textbox"></div>
         <button type="button" aria-label="Send message">Send</button>
       </fieldset>`
    : `<form data-type="unified-composer">
         <div id="prompt-textarea" contenteditable="true" role="textbox" aria-label="Chat with ChatGPT"></div>
         <button type="button" data-testid="send-button" aria-label="Send prompt">Send</button>
       </form>`;
  const userTurn = isClaude
    ? '<div data-testid="user-message"></div>'
    : '<div data-message-author-role="user"></div>';
  const assistantTurn = isClaude
    ? '<div data-is-streaming="true"><div class="font-claude-response"></div></div>'
    : '<div data-message-author-role="assistant"><div class="markdown"></div></div>';
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${provider} verify fixture</title></head>
<body>
  <main id="thread">
    ${userTurn.replace('></div>', '>An earlier question</div>')}
    ${assistantTurn.replace('data-is-streaming="true"', 'data-is-streaming="false"').replace('"markdown"></div>', '"markdown"><p>EARLIER ANSWER</p></div>').replace('"font-claude-response"></div>', '"font-claude-response"><p>EARLIER ANSWER</p></div>')}
  </main>
  ${composer}
  <script>
    const config = ${JSON.stringify({ isClaude, chunks, chunkDelayMs })};
    window.__fixture = { sentTexts: [] };
    const thread = document.getElementById('thread');
    const input = document.querySelector('[contenteditable="true"]');
    const send = document.querySelector('button[aria-label^="Send"]');
    function html(markup) {
      const template = document.createElement('template');
      template.innerHTML = markup.trim();
      return template.content.firstElementChild;
    }
    send.addEventListener('click', () => {
      const text = input.textContent;
      if (!text.trim()) return;
      window.__fixture.sentTexts.push(text);
      input.textContent = '';
      const user = html(${JSON.stringify(userTurn)});
      user.textContent = text;
      thread.append(user);
      const turn = html(${JSON.stringify(assistantTurn)});
      thread.append(turn);
      const body = turn.querySelector('.markdown, .font-claude-response');
      let stop = null;
      if (!config.isClaude) {
        stop = html('<button type="button" data-testid="stop-button" aria-label="Stop streaming">Stop</button>');
        document.body.append(stop);
      }
      config.chunks.forEach((chunk, index) => {
        setTimeout(() => {
          body.insertAdjacentHTML('beforeend', chunk);
          if (index === config.chunks.length - 1) {
            if (stop) stop.remove();
            if (config.isClaude) turn.setAttribute('data-is-streaming', 'false');
          }
        }, config.chunkDelayMs * (index + 1));
      });
    });
  </script>
</body>
</html>`;
}

/**
 * gemini.google.com shaped page for Verify web mode: the composer and send
 * button Panelize's content script targets, the temporary chat toggle, and a
 * reply that streams a JSON code block plus one citation chip. The reply is
 * built from what was sent, because the X/Y order is random. Calls the
 * `__recordGeminiWeb` binding (if exposed) with what happened.
 *
 * @returns {string}
 */
export function renderGeminiWebJudgeFixture({ chunkDelayMs = 400 } = {}) {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Gemini verify fixture</title></head>
<body>
  <div id="temp-slot"><button type="button" aria-label="Turn on temporary chat">Temp</button></div>
  <main id="thread"></main>
  <div class="ql-editor" contenteditable="true"></div>
  <button type="button" aria-label="Send message">Send</button>
  <script>
    const record = (event) => { try { window.__recordGeminiWeb && window.__recordGeminiWeb(event); } catch (e) {} };
    const temp = document.querySelector('#temp-slot button');
    temp.addEventListener('click', () => {
      const on = temp.getAttribute('aria-label') === 'Turn off temporary chat';
      temp.setAttribute('aria-label', on ? 'Turn on temporary chat' : 'Turn off temporary chat');
      record({ type: 'temp-chat', on: !on });
    });
    const input = document.querySelector('.ql-editor');
    const send = document.querySelector('button[aria-label="Send message"]');
    const thread = document.getElementById('thread');
    send.addEventListener('click', () => {
      const text = input.innerText;
      if (!text.trim()) return;
      record({ type: 'sent', text, temporaryChat: temp.getAttribute('aria-label') === 'Turn off temporary chat' });
      input.textContent = '';
      const user = document.createElement('user-query');
      user.textContent = text;
      thread.append(user);
      const xHas1889 = text.indexOf('1889') < text.indexOf('<<<BEGIN ANSWER Y>>>');
      const right = xHas1889 ? 'X' : 'Y';
      const wrong = xHas1889 ? 'Y' : 'X';
      const data = {
        claims: [
          { id: 'C1', statement: 'The Eiffel Tower was completed in 1889.', answers: [right], verifiable: true, status: 'SUPPORTED',
            explanation: 'The official site dates completion to March 1889.',
            sources: [{ url: 'https://www.toureiffel.paris/en/the-monument/history', title: 'toureiffel.paris' }] },
          { id: 'C2', statement: 'The Eiffel Tower opened in 1887.', answers: [wrong], verifiable: true, status: 'CONTRADICTED',
            explanation: 'Construction started in 1887; it opened in 1889.',
            sources: [{ url: 'https://www.britannica.com/topic/Eiffel-Tower-Paris-France', title: 'britannica.com' }] }
        ],
        logic: {
          [right]: { verdict: 'SOUND', issues: [] },
          [wrong]: { verdict: 'FLAWED', issues: [{ type: 'CALCULATION_ERROR', severity: 'high', quote: '1887', explanation: 'Confuses the start of construction with the opening.' }] }
        },
        verdict: right,
        reasoning: 'Answer ' + right + ' gives the correct year; Answer ' + wrong + ' is contradicted by sources.',
        criteria: { factualAccuracy: { X: xHas1889 ? 5 : 2, Y: xHas1889 ? 2 : 5 } }
      };
      const response = document.createElement('model-response');
      response.innerHTML = '<message-content><div class="markdown"></div></message-content>';
      thread.append(response);
      const stop = document.createElement('button');
      stop.setAttribute('aria-label', 'Stop response');
      document.body.append(stop);
      const body = response.querySelector('.markdown');
      setTimeout(() => {
        const report = document.createElement('p');
        report.textContent = '验收报告：事实核查、逻辑审查、验收结论如下。';
        body.append(report);
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.className = 'language-json';
        code.textContent = JSON.stringify(data, null, 1);
        pre.append(code);
        body.append(pre);
      }, ${JSON.stringify(chunkDelayMs)});
      setTimeout(() => {
        const chip = document.createElement('a');
        chip.href = 'https://www.google.com/url?q=https%3A%2F%2Fwww.toureiffel.paris%2Fen%2Fthe-monument%2Fhistory&sa=D';
        chip.textContent = 'toureiffel.paris';
        response.append(chip);
        stop.remove();
      }, ${JSON.stringify(chunkDelayMs * 2)});
    });
  </script>
</body>
</html>`;
}
