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
