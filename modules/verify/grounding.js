// Panelize Verify — grounding metadata parsing.
//
// Evidence links come only from `groundingMetadata.groundingChunks`; URLs
// written in the model's text are never trusted. `groundingSupports` tie a
// byte range of the response to the chunks that support it, which is how a
// source is attached to a single claim.

const MAX_URL_LENGTH = 2048;

/**
 * Accepts only plain http(s) URLs without embedded credentials.
 * @returns {string | null}
 */
export function sanitizeEvidenceUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) {
    return null;
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    return null;
  }
  return url.href;
}

function cleanTitle(title) {
  return typeof title === 'string' ? title.replace(/\s+/g, ' ').trim().slice(0, 300) : undefined;
}

/**
 * @param {object} candidate A generateContent candidate.
 * @returns {{
 *   chunks: { index: number, url: string, title?: string }[],
 *   supports: { partIndex: number, startByte: number, endByte: number, text: string,
 *     chunkIndices: number[], confidence: number[] }[],
 *   webSearchQueries: string[],
 *   searchEntryPointHtml: string | null,
 *   raw: unknown
 * }}
 */
export function parseGroundingMetadata(candidate) {
  const metadata = candidate?.groundingMetadata;
  const empty = { chunks: [], supports: [], webSearchQueries: [], searchEntryPointHtml: null, raw: metadata ?? null };
  if (!metadata || typeof metadata !== 'object') {
    return empty;
  }
  const chunks = [];
  (Array.isArray(metadata.groundingChunks) ? metadata.groundingChunks : []).forEach((chunk, index) => {
    const url = sanitizeEvidenceUrl(chunk?.web?.uri);
    if (url) {
      chunks.push({ index, url, title: cleanTitle(chunk.web.title) });
    }
  });
  const supports = (Array.isArray(metadata.groundingSupports) ? metadata.groundingSupports : [])
    .map(support => {
      // The reference documents the range under `segment`; accept it at the
      // top level too.
      const segment = support?.segment || support || {};
      return {
        partIndex: Number.isInteger(segment.partIndex) ? segment.partIndex : 0,
        startByte: Number.isInteger(segment.startIndex) ? segment.startIndex : 0,
        endByte: Number.isInteger(segment.endIndex) ? segment.endIndex : -1,
        text: typeof segment.text === 'string' ? segment.text : '',
        chunkIndices: (Array.isArray(support?.groundingChunkIndices) ? support.groundingChunkIndices : [])
          .filter(Number.isInteger),
        confidence: (Array.isArray(support?.confidenceScores) ? support.confidenceScores : [])
          .filter(value => typeof value === 'number')
      };
    })
    .filter(support => support.chunkIndices.length > 0);
  const webSearchQueries = (Array.isArray(metadata.webSearchQueries) ? metadata.webSearchQueries : [])
    .filter(query => typeof query === 'string')
    .map(query => query.slice(0, 300));
  const html = metadata.searchEntryPoint?.renderedContent;
  return {
    chunks,
    supports,
    webSearchQueries,
    searchEntryPointHtml: typeof html === 'string' && html.length < 200000 ? html : null,
    raw: metadata
  };
}

const encoder = new TextEncoder();

export function byteLength(text) {
  return encoder.encode(text).length;
}

/**
 * Finds the evidence for one span of the response text.
 *
 * @param {{ startByte: number, endByte: number, partIndex?: number, text?: string }} span
 * @param {ReturnType<typeof parseGroundingMetadata>} grounding
 * @param {string} retrievedAt
 * @returns {import('./types.js').Evidence[]}
 */
export function evidenceForSpan(span, grounding, retrievedAt) {
  const chunkByIndex = new Map(grounding.chunks.map(chunk => [chunk.index, chunk]));
  /** @type {Map<string, import('./types.js').Evidence>} */
  const byUrl = new Map();
  for (const support of grounding.supports) {
    if ((span.partIndex ?? 0) !== support.partIndex) continue;
    const inRange = support.endByte >= 0
      ? support.startByte < span.endByte && support.endByte > span.startByte
      : Boolean(support.text && span.text?.includes(support.text));
    if (!inRange) continue;
    support.chunkIndices.forEach((chunkIndex, position) => {
      const chunk = chunkByIndex.get(chunkIndex);
      if (!chunk || byUrl.has(chunk.url)) return;
      /** @type {import('./types.js').Evidence} */
      const evidence = { url: chunk.url, retrievedAt };
      if (chunk.title) {
        evidence.title = chunk.title;
        evidence.publisher = chunk.title;
      }
      if (support.text) evidence.citedText = support.text.slice(0, 500);
      if (typeof support.confidence[position] === 'number') {
        evidence.confidence = support.confidence[position];
      }
      byUrl.set(chunk.url, evidence);
    });
  }
  return [...byUrl.values()];
}
