/*
 * Reader service: fetch processed HTML via Jina Reader
 */

/**
 * Fetch HTML of a page via r.jina.ai, with optional headers.
 * @param {string} url - Target URL to read.
 * @param {Record<string,string>} headers - Optional Reader headers.
 * @returns {Promise<string>} HTML string
 */
import { log, error as logError } from '../utils/logger.js';

async function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

export async function fetchHtmlWithReader(url, headers = {}) {
  if (!url || typeof url !== 'string') {
    throw new Error('Invalid URL');
  }
  const encoded = encodeURI(url);
  const readerUrl = `https://r.jina.ai/${encoded}`;
  const respondWith = headers['x-respond-with'] || 'html';
  let attempt = 0;
  const maxAttempts = 3;
  let lastError;
  while (attempt < maxAttempts) {
    attempt++;
    log('reader:request', { inputUrl: url, respondWith });
    try {
      const resp = await fetch(readerUrl, {
        headers: {
          'x-respond-with': respondWith,
          ...headers,
        },
      });
      if (!resp.ok) {
        const text = await safeText(resp);
        // 429：命中速率限制，尝试根据返回的 retryAfter 做退避重试
        if (resp.status === 429 && attempt < maxAttempts) {
          let retryAfterMs = 2000;
          try {
            const info = JSON.parse(text || '{}');
            if (typeof info.retryAfter === 'number') {
              retryAfterMs = Math.min(15000, Math.max(1500, info.retryAfter * 1000));
            }
          } catch (_) {}
          log('reader:rate-limit', { url: readerUrl, attempt, retryAfterMs });
          await sleep(retryAfterMs + Math.floor(Math.random() * 400));
          continue;
        }
        // 5xx：短暂故障，指数退避
        if (resp.status >= 500 && attempt < maxAttempts) {
          const backoff = 600 * attempt;
          log('reader:retry', { url: readerUrl, status: resp.status, attempt, backoffMs: backoff });
          await sleep(backoff + Math.floor(Math.random() * 300));
          continue;
        }
        const err = new Error(`Reader fetch failed: ${resp.status} ${text || ''}`);
        logError('reader:error', err, { status: resp.status, url: readerUrl });
        throw err;
      }
      log('reader:success', { url: readerUrl, status: resp.status, attempt });
      return await resp.text();
    } catch (e) {
      // 网络错误：重试
      lastError = e;
      if (attempt < maxAttempts) {
        const backoff = 700 * attempt;
        log('reader:network-retry', { url: readerUrl, attempt, backoffMs: backoff });
        await sleep(backoff + Math.floor(Math.random() * 300));
        continue;
      }
      logError('reader:error', e, { url: readerUrl });
      throw e;
    }
  }
  throw lastError || new Error('Reader fetch failed after retries');
}

async function safeText(resp) {
  try {
    return await resp.text();
  } catch (_) {
    return '';
  }
}

// 不再规范化或强制语言路径，保持用户输入链接原样

export async function fetchMarkdownWithReader(url, headers = {}) {
  return fetchHtmlWithReader(url, { ...headers, 'x-respond-with': 'markdown' });
}

export function extractTitleFromHtml(html) {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const rawTitle = (doc.querySelector('title')?.textContent || '').trim();
    if (rawTitle) return rawTitle;
    const h1 = (doc.querySelector('h1')?.textContent || '').trim();
    return h1 || '';
  } catch (_) {
    return '';
  }
}