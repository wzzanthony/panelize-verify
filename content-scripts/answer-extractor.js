// Panelize Verify — answer extractor.
//
// Reads the latest assistant reply for the Multi-Panel host so the reply can
// be compared and fact-checked. Self-contained (no imports) like the other
// content scripts. It is read-only: it never types, clicks or navigates.
//
// Protocol (host -> frame):
//   { type: 'PANELIZE_VERIFY_EXTRACT', context: 'multi-panel', requestId }
// Reply (frame -> host, posted only to the extension origin):
//   { type: 'PANELIZE_VERIFY_ANSWER_STATE', context: 'panelize-verify',
//     requestId, provider, supported, generating, userTurnCount,
//     lastUserText, lastUserHash, hasAnswer, text, textHash }
//
// Only the last user turn and the assistant reply after it are read; earlier
// history is never sent to the host.

(function() {
  'use strict';

  const EXTRACT_REQUEST = 'PANELIZE_VERIFY_EXTRACT';
  const ANSWER_STATE = 'PANELIZE_VERIFY_ANSWER_STATE';
  const REPLY_CONTEXT = 'panelize-verify';
  const MAX_ANSWER_CHARS = 200000;
  const MAX_LINKS = 200;
  const MAX_USER_TEXT_CHARS = 2000;

  /**
   * Provider adapters. Each lists selectors with fallbacks, most specific
   * first, because provider DOMs change without notice.
   */
  const ADAPTERS = {
    chatgpt: {
      userTurns: ['[data-message-author-role="user"]'],
      assistantTurns: ['[data-message-author-role="assistant"]'],
      content: ['.markdown', '[class*="markdown"]'],
      generating: ['button[data-testid="stop-button"]', '[data-testid="stop-button"]', '.result-streaming'],
      exclude: []
    },
    claude: {
      userTurns: ['[data-testid="user-message"]'],
      assistantTurns: ['[data-is-streaming]', '.font-claude-response', '.font-claude-message'],
      content: ['.font-claude-response', '.font-claude-message', '.standard-markdown', '.progressive-markdown'],
      generating: ['[data-is-streaming="true"]', 'button[aria-label="Stop response"]', 'button[aria-label="Stop Response"]'],
      exclude: ['[data-testid*="thinking"]', '[data-testid*="artifact"]']
    },
    gemini: {
      userTurns: ['user-query'],
      assistantTurns: ['model-response'],
      content: ['message-content .markdown', '.model-response-text', 'message-content'],
      generating: ['button[aria-label="Stop response"]', 'model-response [aria-busy="true"]', '.stop-icon'],
      exclude: ['model-thoughts', '.thoughts-container']
    }
  };

  // Elements whose text is UI chrome, not answer content.
  const SKIPPED_TAGS = new Set([
    'BUTTON', 'SVG', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA',
    'INPUT', 'SELECT', 'NAV', 'IMG', 'VIDEO', 'AUDIO', 'CANVAS', 'IFRAME'
  ]);
  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE',
    'FIGURE', 'FIGCAPTION', 'DL', 'DT', 'DD', 'DETAILS', 'SUMMARY'
  ]);

  function detectProvider(hostname = window.location.hostname) {
    if (hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com')
      || hostname === 'chat.openai.com') {
      return 'chatgpt';
    }
    if (hostname === 'claude.ai' || hostname.endsWith('.claude.ai')) {
      return 'claude';
    }
    if (hostname === 'gemini.google.com') {
      return 'gemini';
    }
    return null;
  }

  function queryAllFirstMatch(root, selectors) {
    for (const selector of selectors) {
      let found = [];
      try {
        found = Array.from(root.querySelectorAll(selector));
      } catch {
        continue;
      }
      if (found.length > 0) {
        return found;
      }
    }
    return [];
  }

  function queryFirst(root, selectors) {
    for (const selector of selectors) {
      try {
        const found = root.querySelector(selector);
        if (found) return found;
      } catch {
        // Skip selectors the engine cannot parse.
      }
    }
    return null;
  }

  /** Drops elements nested inside another element of the same list. */
  function outermostOnly(elements) {
    return elements.filter(element =>
      !elements.some(other => other !== element && other.contains(element)));
  }

  function isAfter(node, reference) {
    if (!reference) return true;
    // eslint-disable-next-line no-bitwise
    return Boolean(reference.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
      && !reference.contains(node);
  }

  function hashText(text) {
    // FNV-1a, enough to tell "changed" from "unchanged".
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `${text.length}:${hash.toString(16)}`;
  }

  // ===== MessageNormalizer: DOM -> Markdown-like plain text =====

  function codeLanguage(pre) {
    const code = pre.querySelector('code');
    const className = `${code?.className || ''} ${pre.className || ''}`;
    const match = className.match(/(?:^|\s)(?:language|lang)-([\w+#.-]+)/);
    return match ? match[1] : '';
  }

  function inlineText(node, excluded) {
    let out = '';
    node.childNodes.forEach(child => {
      out += renderNode(child, excluded, { inline: true });
    });
    return out;
  }

  function renderList(list, excluded, depth) {
    const ordered = list.tagName === 'OL';
    const start = Number.parseInt(list.getAttribute('start') || '1', 10) || 1;
    let index = start;
    let out = '\n';
    Array.from(list.children).forEach(item => {
      if (item.tagName !== 'LI') return;
      const marker = ordered ? `${index}. ` : '- ';
      index += 1;
      let body = '';
      item.childNodes.forEach(child => {
        if (child.nodeType === 1 && (child.tagName === 'UL' || child.tagName === 'OL')) {
          body += renderList(child, excluded, depth + 1);
        } else {
          body += renderNode(child, excluded, {});
        }
      });
      const indent = '  '.repeat(depth);
      const lines = body.replace(/^\n+|\n+$/g, '').split('\n');
      out += `${indent}${marker}${lines[0] || ''}\n`;
      lines.slice(1).forEach(line => {
        out += line.trim() ? `${indent}  ${line.replace(/^\s+/, '')}\n` : '';
      });
    });
    return `${out}\n`;
  }

  function renderTable(table) {
    const rows = Array.from(table.querySelectorAll('tr'));
    if (rows.length === 0) return '';
    const lines = rows.map(row => {
      const cells = Array.from(row.children)
        .filter(cell => cell.tagName === 'TD' || cell.tagName === 'TH')
        .map(cell => cell.textContent.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|'));
      return `| ${cells.join(' | ')} |`;
    });
    const headerCells = rows[0].children.length;
    if (headerCells > 0) {
      lines.splice(1, 0, `|${' --- |'.repeat(headerCells)}`);
    }
    return `\n\n${lines.join('\n')}\n\n`;
  }

  function renderNode(node, excluded, options = {}) {
    if (node.nodeType === 3) {
      return node.nodeValue.replace(/\s+/g, ' ');
    }
    if (node.nodeType !== 1) {
      return '';
    }
    const element = node;
    const tag = element.tagName.toUpperCase();
    if (SKIPPED_TAGS.has(tag) || excluded(element)) {
      return '';
    }
    if (element.getAttribute('aria-hidden') === 'true' && !element.classList.contains('katex')) {
      return '';
    }
    if (element.classList.contains('katex')) {
      const tex = element.querySelector('annotation[encoding="application/x-tex"]');
      if (tex) {
        const display = element.closest('.katex-display');
        return display ? `\n\n$$${tex.textContent.trim()}$$\n\n` : `$${tex.textContent.trim()}$`;
      }
    }
    switch (tag) {
      case 'BR':
        return '\n';
      case 'HR':
        return '\n\n---\n\n';
      case 'PRE': {
        const code = element.querySelector('code') || element;
        const body = code.textContent.replace(/\n+$/, '');
        return `\n\n\`\`\`${codeLanguage(element)}\n${body}\n\`\`\`\n\n`;
      }
      case 'CODE':
        return `\`${element.textContent}\``;
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6':
        return `\n\n${'#'.repeat(Number(tag[1]))} ${inlineText(element, excluded).trim()}\n\n`;
      case 'UL':
      case 'OL':
        return renderList(element, excluded, 0);
      case 'TABLE':
        return renderTable(element);
      case 'BLOCKQUOTE': {
        const body = collapse(inlineChildren(element, excluded));
        return `\n\n${body.split('\n').map(line => `> ${line}`).join('\n')}\n\n`;
      }
      case 'STRONG':
      case 'B':
        return `**${inlineText(element, excluded)}**`;
      case 'EM':
      case 'I':
        return `*${inlineText(element, excluded)}*`;
      case 'A': {
        const text = inlineText(element, excluded);
        const href = element.getAttribute('href') || '';
        return /^https?:\/\//i.test(href) && text.trim() && text.trim() !== href
          ? `[${text.trim()}](${href})`
          : text;
      }
      default: {
        const body = inlineChildren(element, excluded);
        if (BLOCK_TAGS.has(tag) && !options.inline) {
          return `\n${body}\n`;
        }
        return body;
      }
    }
  }

  function inlineChildren(element, excluded) {
    let out = '';
    element.childNodes.forEach(child => {
      out += renderNode(child, excluded, {});
    });
    return out;
  }

  function collapse(text) {
    // Keep code fences verbatim; tidy whitespace elsewhere.
    const parts = text.split(/(```[\s\S]*?```)/g);
    return parts.map((part, index) => {
      if (index % 2 === 1) return part;
      return part
        .replace(/[ \t]+\n/g, '\n')
        // Leading spaces come from source whitespace, except list nesting.
        .replace(/\n[ \t]+(- |\d+\. )?/g, (match, marker) => (marker ? match : '\n'))
        .replace(/(\S)[ \t]{2,}/g, '$1 ');
    }).join('')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function normalizeMessage(element, excludeSelectors = []) {
    const excluded = candidate => excludeSelectors.some(selector => {
      try {
        return candidate.matches(selector);
      } catch {
        return false;
      }
    });
    return collapse(renderNode(element, excluded, {}));
  }

  // ===== AnswerExtractor =====

  function readAnswerState(provider, root = document) {
    const adapter = ADAPTERS[provider];
    if (!adapter) {
      return { supported: false };
    }
    const userTurns = outermostOnly(queryAllFirstMatch(root, adapter.userTurns));
    const lastUser = userTurns[userTurns.length - 1] || null;
    const assistantTurns = outermostOnly(queryAllFirstMatch(root, adapter.assistantTurns))
      .filter(element => isAfter(element, lastUser));

    const texts = assistantTurns.map(turn => {
      const content = queryFirst(turn, adapter.content) || turn;
      return normalizeMessage(content, adapter.exclude);
    }).filter(Boolean);
    let text = texts.join('\n\n');
    if (text.length > MAX_ANSWER_CHARS) {
      text = text.slice(0, MAX_ANSWER_CHARS);
    }
    const lastUserText = lastUser
      ? lastUser.textContent.replace(/\s+/g, ' ').trim().slice(0, MAX_USER_TEXT_CHARS)
      : '';
    const generating = Boolean(queryFirst(root, adapter.generating));
    const links = collectLinks(assistantTurns);

    return {
      supported: true,
      generating,
      userTurnCount: userTurns.length,
      lastUserText,
      lastUserHash: hashText(lastUserText),
      hasAnswer: text.length > 0,
      text,
      textHash: hashText(text),
      links
    };
  }

  /**
   * Links the page itself rendered in the answer (citation chips, source
   * lists), outside code blocks. Used only to cross-check URLs a model wrote.
   */
  function collectLinks(turns) {
    const seen = new Set();
    const links = [];
    for (const turn of turns) {
      for (const anchor of turn.querySelectorAll('a[href]')) {
        if (links.length >= MAX_LINKS) return links;
        if (anchor.closest('pre, code')) continue;
        let href = '';
        try {
          href = new URL(anchor.getAttribute('href'), location.href).href;
        } catch {
          continue;
        }
        if (!/^https?:/i.test(href) || href.length > 2048 || seen.has(href)) continue;
        seen.add(href);
        links.push(href);
      }
    }
    return links;
  }

  // ===== Messaging =====

  function getExtensionOrigin() {
    try {
      const baseUrl = chrome.runtime.getURL('');
      const origin = typeof baseUrl === 'string' ? baseUrl.replace(/\/+$/, '') : '';
      return /^[a-z][a-z0-9+.-]*:\/\/[^/]+$/.test(origin) ? origin : null;
    } catch {
      return null;
    }
  }

  const EXTENSION_ORIGIN = getExtensionOrigin();

  function isFromMultiPanelHost(event) {
    return EXTENSION_ORIGIN !== null
      && event.origin === EXTENSION_ORIGIN
      && event.source === window.parent
      && window.parent !== window;
  }

  function handleMessage(event) {
    const data = event?.data;
    if (!data || typeof data !== 'object' || data.type !== EXTRACT_REQUEST
      || data.context !== 'multi-panel' || typeof data.requestId !== 'string') {
      return;
    }
    if (!isFromMultiPanelHost(event)) {
      return;
    }
    const provider = detectProvider();
    let state;
    try {
      state = readAnswerState(provider);
    } catch (error) {
      state = { supported: true, error: String(error?.message || error).slice(0, 200) };
    }
    window.parent.postMessage({
      type: ANSWER_STATE,
      context: REPLY_CONTEXT,
      requestId: data.requestId,
      provider,
      ...state
    }, EXTENSION_ORIGIN);
  }

  // The isolated world is invisible to page scripts; tests read this hook.
  window.PanelizeVerifyExtractor = {
    ADAPTERS,
    detectProvider,
    normalizeMessage,
    readAnswerState,
    hashText
  };

  if (!window.__panelizeVerifyExtractorInstalled) {
    window.__panelizeVerifyExtractorInstalled = true;
    window.addEventListener('message', handleMessage);
  }
})();
