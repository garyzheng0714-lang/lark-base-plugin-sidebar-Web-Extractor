<!--
 * @Version    : v1.00
 * @Author     : itchaox
 * @Date       : 2023-09-26 15:10
 * @LastAuthor : Wang Chao
 * @LastTime   : 2025-02-27 06:39
 * @desc       : 主要页面
-->
<script setup>
  import { bitable } from '@lark-base-open/js-sdk';
  import { ref, reactive, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
  import { fetchHtmlWithReader, fetchMarkdownWithReader, extractTitleFromHtml } from '../services/reader.js';
  import { extractAmazonStructured } from '../utils/extractors.js';
  // 回退：不再使用结构化提取器，恢复原样输出
  import { log, error as logError, getLogs, clearLogs } from '../utils/logger.js';

  // 国际化
  import { useI18n } from 'vue-i18n';
  const { t } = useI18n();

  // 当前上下文（自动）
  const databaseId = ref();
  const viewId = ref();
  const fieldList = ref([]);

  const base = bitable.base;

  // 当前点击字段id
  const currentFieldId = ref();
  const recordId = ref();

  const currentValue = ref();

  // 提取页面相关
  const inputUrl = ref('');
  const extracting = ref(false);
  const pageTitle = ref('');
  const products = ref([]); // { name, reviews }
  const extractError = ref('');

  onMounted(async () => {
    const selection = await base.getSelection();
    databaseId.value = selection.tableId;
    viewId.value = selection.viewId;
    log('init', { tableId: databaseId.value, viewId: viewId.value });
    await initFieldList();
    await autoDetectUrlField();
  });

  // 切换数据表, 默认选择第一个视图
  async function initFieldList() {
    if (!databaseId.value) return;
    const table = await base.getTable(databaseId.value);
    const view = await table.getViewById(viewId.value);
    const metas = await view.getFieldMetaList();
    // 允许选择文本、公式、超链接等字段作为链接来源；输出字段建议文本类型
    fieldList.value = metas;
  }

  // 根据视图列表获取字段列表
  watch(viewId, async (newValue, oldValue) => {
    await initFieldList();
    await autoDetectUrlField();
  });

  // 切换选择模式时,重置选择
  // 监听选择变化，自动更新上下文
  
  // 数据表修改后，自动获取视图列表
  // 已简化，不再展示视图切换 UI

  base.onSelectionChange(async (event) => {
    databaseId.value = event.data.tableId;
    viewId.value = event.data.viewId;
    await initFieldList();
    await autoDetectUrlField();
  });

  // 批量更新：自动识别链接字段，仅让用户选择输出字段
  const outputFieldId = ref('');
  const urlFieldId = ref('');
  const running = ref(false);
  const progress = ref({ done: 0, total: 0 });
  const runError = ref('');
  const paused = ref(false);
  let abortCtrl = null;

  // 输出语言选择：auto(按域名)、ja-JP、zh-CN、en-US
  const outputLangMode = ref('auto');
  // 新增：标题字段与子榜单字段（可选，文本类型）
  const titleFieldId = ref('');
  const sublistFieldId = ref('');

  function resolveAcceptLanguage(url) {
    let host = '';
    let path = '';
    try { const u = new URL(url); host = u.hostname.toLowerCase(); path = u.pathname || ''; } catch (_) {}
    const mode = outputLangMode.value;
    const map = {
      'ja-JP': 'ja-JP,ja;q=0.9,en;q=0.8',
      'zh-CN': 'zh-CN,zh;q=0.9,en;q=0.8',
      'en-US': 'en-US,en;q=0.9'
    };
    if (mode && mode !== 'auto') return map[mode] || 'en-US,en;q=0.9';
    // 域优先：先按域名强制语言，其次再看路径显式本地化
    if (host.endsWith('.co.jp') || /amazon\.co\.jp$/.test(host)) return map['ja-JP'];
    if (host.endsWith('.cn')) return map['zh-CN'];
    if (host.endsWith('.de')) return 'de-DE,de;q=0.9,en;q=0.6';
    if (host.endsWith('.fr')) return 'fr-FR,fr;q=0.9,en;q=0.6';
    // 路径显式本地化：/-/zh|en|ja/
    if (/^\/-\/zh\//i.test(path)) return map['zh-CN'];
    if (/^\/-\/en\//i.test(path)) return map['en-US'];
    if (/^\/-\/ja\//i.test(path)) return map['ja-JP'];
    return map['en-US'];
  }

  // 将语言选择转为查询参数与 Amazon 路径所需的代码
  function resolveLocaleForUrl(url) {
    let host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch (_) {}
    const mode = (outputLangMode.value || 'auto');
    // 语言头与查询参数映射
    const langHeaderMap = {
      'ja-JP': 'ja-JP',
      'zh-CN': 'zh-CN',
      'en-US': 'en-US'
    };
    const localeParamMap = {
      'ja-JP': 'ja_JP',
      'zh-CN': 'zh_CN',
      'en-US': 'en_US'
    };
    // 货币按域名估算（尽量保守，未知域名默认 USD）
    const currencyByTld = (h) => {
      if (h.endsWith('.co.jp')) return 'JPY';
      if (h.endsWith('.cn')) return 'CNY';
      if (h.endsWith('.de')) return 'EUR';
      if (h.endsWith('.fr')) return 'EUR';
      if (h.endsWith('.it')) return 'EUR';
      if (h.endsWith('.es')) return 'EUR';
      if (h.endsWith('.nl')) return 'EUR';
      if (h.endsWith('.pl')) return 'PLN';
      if (h.endsWith('.co.uk') || h.endsWith('.uk')) return 'GBP';
      if (h.endsWith('.com.au') || h.endsWith('.au')) return 'AUD';
      if (h.endsWith('.ca')) return 'CAD';
      return 'USD';
    };
    let headerLang;
    if (mode !== 'auto') {
      headerLang = langHeaderMap[mode] || 'en-US';
    } else {
      if (host.endsWith('.co.jp')) headerLang = 'ja-JP';
      else if (host.endsWith('.cn')) headerLang = 'zh-CN';
      else headerLang = 'en-US';
    }
    const localeParam = localeParamMap[headerLang] || 'en_US';
    const currency = currencyByTld(host);
    // Amazon 路径语言代码（/-/ja|zh|en/）
    const amazonPathLang = headerLang === 'ja-JP' ? 'ja' : (headerLang === 'zh-CN' ? 'zh' : 'en');
    return { headerLang, localeParam, currency, amazonPathLang };
  }

  // 根据语言选择与域名，在 URL 上附加 language/currency，并为 Amazon 强制语言路径
  function applyLanguageToUrl(input) {
    try {
      const u = new URL(input);
      const host = (u.hostname || '').toLowerCase();
      const { headerLang, localeParam, currency, amazonPathLang } = resolveLocaleForUrl(input);
      // 查询参数：若站点支持 language/currency，将其加入以避免 Accept-Language 被忽略
      const langQ = u.searchParams.get('language');
      if (!langQ || (langQ && langQ.toLowerCase() !== localeParam.toLowerCase())) {
        u.searchParams.set('language', localeParam);
      }
      const curQ = u.searchParams.get('currency');
      if (!curQ || (curQ && curQ.toUpperCase() !== currency.toUpperCase())) {
        u.searchParams.set('currency', currency);
      }
      // Amazon 日本站：优先使用路径前缀做明确的语言选择（其他国家站点通常不使用该前缀）
      if (/amazon\.co\.jp$/i.test(host)) {
        let p = u.pathname || '';
        // 规范化已有语言前缀为目标语言
        const desired = (headerLang === 'ja-JP') ? 'ja' : 'en';
        if (/^\/-\/[a-z]{2}(?:[-_][a-z]{2})?\//i.test(p)) {
          p = p.replace(/^\/-\/[a-z]{2}(?:[-_][a-z]{2})?\//i, `/-/${desired}/`);
        } else {
          p = `/-/${desired}${p.startsWith('/') ? '' : '/'}${p}`;
        }
        u.pathname = p;
      }
      return u.toString();
    } catch (_) {
      return input;
    }
  }

  // 简单 UA 随机池，降低被识别为脚本的概率
  const UA_POOL = [
    // Desktop Chrome (stable)
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Safari/537.36',
    // Desktop Firefox
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:118.0) Gecko/20100101 Firefox/118.0',
    // Mobile Chrome (Android)
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Mobile Safari/537.36',
    // Mobile Safari (iPhone)
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.2 Mobile/15E148 Safari/604.1'
  ];
  const pickUA = () => UA_POOL[Math.floor(Math.random() * UA_POOL.length)];

  // 回退：移除语言首选项逻辑

  function buildHeadersForUrl(url) {
    let host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch (_) {}
    const isAmazon = /amazon\./i.test(host);
    // 亚马逊：只等待榜单列表，缩短超时；其他站点略等页面主体
    const waitSelector = isAmazon ? 'ol#zg-ordered-list > li, #zg-ordered-list li, .zg-grid-general-faceout, div[class*="grid-cell"], div[data-testid="grid-cell"]' : 'h1, article, main';
    const headers = {
      'x-wait-for-selector': waitSelector,
      'x-timeout-ms': isAmazon ? '8000' : '10000',
      'x-user-agent': isAmazon ? UA_POOL[0] : pickUA(),
      // 按域名/用户选择设置语言；Amazon 加Referer
      'accept-language': resolveAcceptLanguage(url),
      'x-accept-language': resolveAcceptLanguage(url),
      ...(isAmazon ? { 'referer': 'https://www.amazon.co.jp/' } : {})
    };
    log('headers-built', { url, host, isAmazon, userAgent: headers['x-user-agent'], acceptLanguage: headers['accept-language'], waitSelector });
    return headers;
  }

  function normalizeAmazonUrl(input) {
    try {
      const u = new URL(input);
      const host = (u.hostname || '').toLowerCase();
      if (!host.includes('amazon.')) return input;
      // 清洗 Amazon 的语言路径（/-/zh|en|ja/ 等），并去除追踪段；保留与语言相关的查询参数
      // 先处理查询参数：仅保留 language/currency/hl/gl/locale/lang，移除其他噪音
      try {
        const keepKeys = new Set(['language', 'currency', 'hl', 'gl', 'locale', 'lang']);
        const nextParams = new URLSearchParams();
        u.searchParams.forEach((v, k) => {
          if (keepKeys.has(k)) nextParams.set(k, v);
        });
        const nextSearch = nextParams.toString();
        u.search = nextSearch ? `?${nextSearch}` : '';
      } catch (_) {
        u.search = '';
      }
      // 清空哈希
      u.hash = '';
      // 路径中可能存在 "/ref=..." 作为追踪段，直接截断到其之前
      let p = u.pathname || '';
      const before = p;
      // 保留语言前缀（如 '/-/ja/'），以作为缓存键的语言区分；仅移除追踪段
      const refIdx = p.indexOf('/ref=');
      if (refIdx !== -1) {
        u.pathname = p.slice(0, refIdx);
      } else {
        u.pathname = p;
      }
      if (before !== u.pathname) {
        log('language:path-cleaned', { host, pathBefore: before, pathAfter: u.pathname });
      }
      // 输出包含保留的查询参数
      return `${u.origin}${u.pathname}${u.search || ''}`;
    } catch (_) {
      return input;
    }
  }

  // 强制为 Amazon 添加语言路径前缀（如 '/-/ja/'），用于语言失配时的二次抓取
  function forceAmazonLangPath(input, langCode = 'ja') {
    try {
      const u = new URL(input);
      const host = (u.hostname || '').toLowerCase();
      if (!host.includes('amazon.')) return input;
      let p = u.pathname || '';
      if (/^\/-\/[a-z]{2}(?:[-_][a-z]{2})?\//i.test(p)) {
        p = p.replace(/^\/-\/[a-z]{2}(?:[-_][a-z]{2})?\//i, `/-/${langCode}/`);
      } else {
        p = `/-/${langCode}${p.startsWith('/') ? '' : '/'}${p}`;
      }
      u.pathname = p;
      return `${u.origin}${u.pathname}`;
    } catch (_) {
      return input;
    }
  }

  function isAmazonDoorMarkdown(md) {
    if (!md) return false;
    return /CAPTCHA/i.test(md) || /下のボタンをクリックしてショッピングを続けてください/.test(md);
  }

  function isAmazonDoorHtml(html) {
    if (!html) return false;
    return /CAPTCHA/i.test(html) || /下のボタンをクリックしてショッピングを続けてください/.test(html) || /Continue shopping/i.test(html);
  }

  async function refetchAmazonHtmlIfDoor(url, headers, html, signal) {
    if (!isAmazonDoorHtml(html)) {
      const st = extractAmazonStructured(html, url);
      return { html, structured: st, refetched: false };
    }
    log('record:door-detected-html', { url });
    const altHeaders = { 'x-timeout-ms': '7000', 'x-user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:118.0) Gecko/20100101 Firefox/118.0', 'accept-language': resolveAcceptLanguage(url), 'x-accept-language': resolveAcceptLanguage(url) };
    try {
      const h2 = await fetchHtmlWithReader(url, altHeaders, { signal });
      if (isAmazonDoorHtml(h2)) {
        const altHeaders3 = {
          'x-timeout-ms': '7000',
          'x-user-agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Mobile Safari/537.36',
          'accept-language': resolveAcceptLanguage(url),
          'x-accept-language': resolveAcceptLanguage(url),
          'referer': 'https://www.amazon.co.jp/'
        };
        try {
          const h3 = await fetchHtmlWithReader(url, altHeaders3, { signal });
          if (isAmazonDoorHtml(h3)) {
            const canonical = normalizeAmazonUrl(applyLanguageToUrl(url));
            if (canonical !== url) {
              const altHeaders4 = {
                'x-timeout-ms': '7000',
                'x-user-agent': UA_POOL[0],
                'accept-language': resolveAcceptLanguage(canonical),
                'x-accept-language': resolveAcceptLanguage(canonical),
                'referer': 'https://www.amazon.co.jp/',
                'x-wait-for-selector': '#zg-ordered-list'
              };
              try {
                const h4 = await fetchHtmlWithReader(canonical, altHeaders4, { signal });
                const st4 = extractAmazonStructured(h4, canonical);
                if (!isAmazonDoorHtml(h4)) {
                  log('record:door-canonical-refetch-success-html', { url: canonical, htmlLength: (h4 || '').length });
                  return { html: h4, structured: st4, refetched: true };
                }
                log('record:door-canonical-still-door-html', { url: canonical, htmlLength: (h4 || '').length });
              } catch (e4) {
                logError('record:door-canonical-refetch-fail-html', e4, { url: canonical });
              }
            }
            const st3 = extractAmazonStructured(h3, url);
            log('record:door-refetch-3-still-door-html', { url, htmlLength: (h3 || '').length });
            return { html: h3, structured: st3, refetched: true };
          } else {
            const st3 = extractAmazonStructured(h3, url);
            log('record:door-refetch-3-success-html', { url, htmlLength: (h3 || '').length });
            return { html: h3, structured: st3, refetched: true };
          }
        } catch (e3) {
          // 若为用户中止，向上抛出以停止写入
          if (signal?.aborted || (e3 && (e3.name === 'AbortError' || /aborted/i.test(e3.message || '')))) {
            log('reader:aborted', { url, attempt: 3 });
            throw e3;
          }
          logError('record:door-refetch-3-fail-html', e3, { url });
          const st2 = extractAmazonStructured(h2, url);
          log('record:door-refetch-success-html', { url, htmlLength: (h2 || '').length });
          return { html: h2, structured: st2, refetched: true };
        }
      } else {
        const st2 = extractAmazonStructured(h2, url);
        log('record:door-refetch-success-html', { url, htmlLength: (h2 || '').length });
        return { html: h2, structured: st2, refetched: true };
      }
    } catch (e) {
      if (signal?.aborted || (e && (e.name === 'AbortError' || /aborted/i.test(e.message || '')))) {
        log('reader:aborted', { url, attempt: 1 });
        throw e;
      }
      logError('record:door-refetch-fail-html', e, { url });
      const st0 = extractAmazonStructured(html, url);
      return { html, structured: st0, refetched: false };
    }
  }

  async function refetchIfDoor(url, headers, markdown, signal) {
    const isDoor = isAmazonDoorMarkdown(markdown);
    if (!isDoor) return { markdown, title: extractTitleFromMarkdown(markdown), refetched: false };
    log('record:door-detected', { url });
    // 二次尝试：更换 UA，移除等待选择器，加快与避开门页
    const altHeaders = { 'x-timeout-ms': '7000', 'x-user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:118.0) Gecko/20100101 Firefox/118.0', 'accept-language': resolveAcceptLanguage(url), 'x-accept-language': resolveAcceptLanguage(url) };
    try {
      const md2 = await fetchMarkdownWithReader(url, altHeaders, { signal });
      // 若仍为门页，再做第三次回退：使用 Android Chrome UA + 英文语言，尝试移动页面分支
      if (isAmazonDoorMarkdown(md2)) {
        const altHeaders3 = {
          'x-timeout-ms': '7000',
          'x-user-agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Mobile Safari/537.36',
          'accept-language': resolveAcceptLanguage(url),
          'x-accept-language': resolveAcceptLanguage(url),
          'referer': 'https://www.amazon.co.jp/'
        };
        try {
          const md3 = await fetchMarkdownWithReader(url, altHeaders3, { signal });
          if (isAmazonDoorMarkdown(md3)) {
            // 仍为门页：尝试使用规范化后的 Canonical 链接做最终回退
            const canonical = normalizeAmazonUrl(applyLanguageToUrl(url));
            if (canonical !== url) {
              const altHeaders4 = {
                'x-timeout-ms': '7000',
                'x-user-agent': UA_POOL[0],
                'accept-language': resolveAcceptLanguage(canonical),
                'x-accept-language': resolveAcceptLanguage(canonical),
                'referer': 'https://www.amazon.co.jp/',
                'x-wait-for-selector': '#zg-ordered-list'
              };
              try {
                const md4 = await fetchMarkdownWithReader(canonical, altHeaders4, { signal });
                if (!isAmazonDoorMarkdown(md4)) {
                  const title4 = extractTitleFromMarkdown(md4);
                  log('record:door-canonical-refetch-success', { url: canonical, markdownLength: (md4 || '').length });
                  return { markdown: md4, title: title4, refetched: true };
                }
                log('record:door-canonical-still-door', { url: canonical, markdownLength: (md4 || '').length });
              } catch (e4) {
                logError('record:door-canonical-refetch-fail', e4, { url: canonical });
              }
            }
            // 回退到 md3 的结果（虽然仍为门页，交由上层处理是否写入）
            const title3 = extractTitleFromMarkdown(md3);
            log('record:door-refetch-3-still-door', { url, markdownLength: (md3 || '').length });
            return { markdown: md3, title: title3, refetched: true };
          } else {
            const title3 = extractTitleFromMarkdown(md3);
            log('record:door-refetch-3-success', { url, markdownLength: (md3 || '').length });
            return { markdown: md3, title: title3, refetched: true };
          }
        } catch (e3) {
          if (signal?.aborted || (e3 && (e3.name === 'AbortError' || /aborted/i.test(e3.message || '')))) {
            log('reader:aborted', { url, attempt: 3 });
            throw e3;
          }
          logError('record:door-refetch-3-fail', e3, { url });
          const title2 = extractTitleFromMarkdown(md2);
          log('record:door-refetch-success', { url, markdownLength: (md2 || '').length });
          return { markdown: md2, title: title2, refetched: true };
        }
      } else {
        const title2 = extractTitleFromMarkdown(md2);
        log('record:door-refetch-success', { url, markdownLength: (md2 || '').length });
        return { markdown: md2, title: title2, refetched: true };
      }
    } catch (e) {
      if (signal?.aborted || (e && (e.name === 'AbortError' || /aborted/i.test(e.message || '')))) {
        log('reader:aborted', { url, attempt: 1 });
        throw e;
      }
      logError('record:door-refetch-fail', e, { url });
      return { markdown, title: extractTitleFromMarkdown(markdown), refetched: false };
    }
  }

  // 运行日志面板：实时显示内存日志
  const runtimeLogs = ref([]);
  const logViewRef = ref();
  const logAutoScroll = ref(true);
  let logTimer = null;
  const formattedRuntimeText = computed(() => {
    const tail = (runtimeLogs.value || []).slice(-300);
    return tail.map((l) => {
      const level = String(l.level || 'info').toUpperCase();
      let dataStr = '';
      try { dataStr = JSON.stringify(l.data || {}); } catch (_) { dataStr = ''; }
      return `[${l.ts}] ${level} ${l.event} ${dataStr}`;
    }).join('\n');
  });
  function startLogStreaming() {
    if (logTimer) return;
    logTimer = setInterval(() => { runtimeLogs.value = getLogs(); }, 500);
  }
  function stopLogStreaming() { if (logTimer) { clearInterval(logTimer); logTimer = null; } }
  onMounted(() => { startLogStreaming(); });
  onUnmounted(() => { stopLogStreaming(); });
  watch(runtimeLogs, () => {
    if (!logAutoScroll.value) return;
    const el = logViewRef.value;
    if (el) { el.scrollTop = el.scrollHeight; }
  });

  // Fisher-Yates shuffle，避免固定顺序导致同域短时间内集中请求
  function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // 域名级节流：同域请求最小间隔，降低被动限速与门页触发
  const lastFetchAtByHost = new Map();
  async function ensureDomainInterval(url) {
    let host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch (_) {}
    const isAmazon = /amazon\./i.test(host);
    const minInterval = isAmazon ? 1200 : 300; // ms
    const now = Date.now();
    const last = lastFetchAtByHost.get(host) || 0;
    const needWait = Math.max(0, minInterval - (now - last));
    if (needWait > 0) {
      log('throttle:wait', { host, waitMs: needWait });
      await new Promise((r) => setTimeout(r, needWait));
    }
    lastFetchAtByHost.set(host, Date.now());
  }

  async function autoDetectUrlField() {
    // 批量运行中跳过自动检测，避免写入触发视图事件导致重复开销
    if (running.value) return;
    urlFieldId.value = '';
    try {
      log('auto-detect-url-field:start', { tableId: databaseId.value, viewId: viewId.value });
      const table = await base.getTable(databaseId.value);
      const view = await table.getViewById(viewId.value);
      const recordIds = (await view.getVisibleRecordIdList?.()) || [];
      const sampleIds = recordIds.slice(0, 30);
      for (const f of fieldList.value) {
        // 读取部分样本，寻找包含 http(s) 链接的文本字段
        let hit = false;
        for (const rid of sampleIds) {
          const val = await table.getCellValue(f.id, rid);
          const found = extractFirstUrl(val);
          if (found) { hit = true; break; }
        }
        if (hit) { urlFieldId.value = f.id; break; }
      }
      log('auto-detect-url-field:end', { detectedFieldId: urlFieldId.value || null });
    } catch (_) { /* 忽略 */ }
  }

  function extractFirstUrl(val) {
    if (!val) return '';
    const pickFromText = (text) => {
      if (!text) return '';
      const m = text.match(/https?:\/\/\S+/i);
      return m ? m[0] : '';
    };
    if (Array.isArray(val)) {
      for (const seg of val) {
        if (seg && typeof seg === 'object') {
          if (seg.link && /^https?:\/\//i.test(seg.link)) return seg.link;
          const url = pickFromText(seg.text || seg.value || '');
          if (url) return url;
        } else if (typeof seg === 'string') {
          const url = pickFromText(seg);
          if (url) return url;
        }
      }
      return '';
    }
    if (typeof val === 'string') return pickFromText(val);
    if (typeof val === 'object') {
      if (val.link && /^https?:\/\//i.test(val.link)) return val.link;
      if (val.url && /^https?:\/\//i.test(val.url)) return val.url;
      const fromText = pickFromText(val.text || val.value || '');
      if (fromText) return fromText;
      try {
        const json = JSON.stringify(val);
        // 从对象序列化文本中提取第一个 URL，避免复杂转义导致的解析问题
        const m = json.match(/https?:\/\/[^\s"'<>]+/i);
        return m ? m[0] : '';
      } catch (_) { return ''; }
    }
    return '';
  }

  async function runBatchUpdate() {
    runError.value = '';
    if (!outputFieldId.value) {
      runError.value = t('msg.needOutputField');
      return;
    }
    if (!urlFieldId.value) {
      runError.value = t('msg.noUrlField');
      return;
    }
    // 输出字段需为文本类型，避免写入失败
    const outputMeta = (fieldList.value || []).find(f => f.id === outputFieldId.value);
    if (outputMeta && outputMeta.type !== 1) {
      runError.value = t('msg.outputFieldTextOnly');
      return;
    }
    // 若选择了标题/子榜单字段，需为文本类型
    const titleMeta = (fieldList.value || []).find(f => f.id === titleFieldId.value);
    if (titleMeta && titleMeta.type !== 1) {
      runError.value = t('msg.titleFieldTextOnly');
      return;
    }
    const sublistMeta = (fieldList.value || []).find(f => f.id === sublistFieldId.value);
    if (sublistMeta && sublistMeta.type !== 1) {
      runError.value = t('msg.sublistFieldTextOnly');
      return;
    }
    running.value = true;
    paused.value = false;
    abortCtrl = new AbortController();
    progress.value = { done: 0, total: 0 };
    try {
      const table = await base.getTable(databaseId.value);
      const view = await table.getViewById(viewId.value);
      let recordIds = (await view.getVisibleRecordIdList?.()) || [];
      if (!recordIds.length) {
        runError.value = t('msg.noRecords');
        return;
      }
      log('batch:start', {
        tableId: databaseId.value,
        viewId: viewId.value,
        total: recordIds.length,
        urlFieldId: urlFieldId.value,
        outputFieldId: outputFieldId.value,
        outputFieldType: outputMeta?.type,
        titleFieldId: titleFieldId.value || null,
        sublistFieldId: sublistFieldId.value || null
      });
      // url 字段由用户选择或自动识别
      progress.value.total = recordIds.length;
      // 如果批次中包含大量亚马逊链接，降低并发与增加抖动，避免 429 与门页
      // 乱序处理，避免短时间内同域集中冲击
      recordIds = shuffleInPlace(recordIds);
      const sampleRecordIds = recordIds.slice(0, Math.min(10, recordIds.length));
      let amazonCount = 0;
      for (const rid of sampleRecordIds) {
        try {
          const val = await base.getTable(databaseId.value).then(t => t.getCellValue(urlFieldId.value, rid));
          const url = extractFirstUrl(val);
          if (/amazon\./i.test((new URL(url)).hostname)) amazonCount++;
        } catch (_) {}
      }
      const hasAmazon = amazonCount > 0;
      const concurrency = hasAmazon ? 1 : 4;
      let idx = 0;
      const delay = (ms) => new Promise((r) => setTimeout(r, ms));
      const field = await table.getFieldById(outputFieldId.value);
      const titleField = titleFieldId.value ? await table.getFieldById(titleFieldId.value) : null;
      const sublistField = sublistFieldId.value ? await table.getFieldById(sublistFieldId.value) : null;
      // 结果缓存：同一规范化 URL 多次出现时复用结果，提升速度并降低触发限速
      const contentCache = new Map(); // url -> { content, title, sublistText, markdownLength }
      async function worker() {
        while (idx < recordIds.length) {
          if (paused.value || (abortCtrl && abortCtrl.signal?.aborted)) { log('worker:aborted:start'); break; }
          const current = idx++;
          const rid = recordIds[current];
          try {
            const val = await table.getCellValue(urlFieldId.value, rid);
            const url = extractFirstUrl(val);
            if (!url) { log('record:skip-no-url', { recordId: rid }); progress.value.done++; continue; }
            const languageAwareUrl = applyLanguageToUrl(url);
            const normalizedUrl = normalizeAmazonUrl(languageAwareUrl);
            // 复用缓存结果
            if (contentCache.has(normalizedUrl)) {
              const cached = contentCache.get(normalizedUrl);
              // 若为日本站且缓存看起来是英文内容，则进行一次日文路径回抓修正，并更新缓存与写入
              try {
                const hostC = (new URL(normalizedUrl)).hostname.toLowerCase();
                const isAmazonC = /amazon\./i.test(hostC);
                const cachedLooksEnglish = (/best sellers/i.test(cached.title || '') || /\/\-\/en\//i.test(cached.sublistText || ''));
                if (isAmazonC && hostC.endsWith('.co.jp') && cachedLooksEnglish) {
                  const urlJaC = forceAmazonLangPath(normalizedUrl, 'ja');
                  const headersJaC = buildHeadersForUrl(urlJaC);
                  const htmlJaC0 = await fetchHtmlWithReader(urlJaC, headersJaC, { signal: abortCtrl.signal });
                  const { html: htmlJaC, structured: stJaC } = await refetchAmazonHtmlIfDoor(urlJaC, headersJaC, htmlJaC0, abortCtrl.signal);
                  const titleJaC = (stJaC?.title || '').trim();
                  const mdJaC = formatStructuredForAmazon(stJaC, urlJaC);
                  const sidebarArrJaC = Array.isArray(stJaC?.sidebar) ? stJaC.sidebar : [];
                  const sublistTextJaC = sidebarArrJaC
                    .filter(s => (s && (s.name || '').trim()))
                    .map(s => `[${(s.name || '').trim()}](${(s.url || '').trim()})`)
                    .join('\n');
                  const contentJaC = `Title: ${titleJaC || cached.title || ''}\n\nURL Source: ${normalizedUrl}\n\nMarkdown Content:\n${mdJaC || cached.content || ''}`;
                  contentCache.set(normalizedUrl, { content: contentJaC, title: titleJaC || cached.title || '', sublistText: sublistTextJaC || cached.sublistText || '', markdownLength: (contentJaC || '').length });
                  await field.setValue(rid, contentJaC);
                  log('cache:ja-corrected-write-success', { recordId: rid, url: urlJaC, contentLength: (contentJaC || '').length });
                  if (titleField) {
                    try { await titleField.setValue(rid, titleJaC || cached.title || ''); log('cache:ja-corrected-write-title-success', { recordId: rid }); } catch (wte) { logError('cache:ja-corrected-write-title-error', wte, { recordId: rid, fieldId: titleFieldId.value }); }
                  }
                  if (sublistField) {
                    try { await sublistField.setValue(rid, sublistTextJaC || cached.sublistText || ''); log('cache:ja-corrected-write-sublist-success', { recordId: rid }); } catch (wse) { logError('cache:ja-corrected-write-sublist-error', wse, { recordId: rid, fieldId: sublistFieldId.value }); }
                  }
                  const baseMinC = hasAmazon ? 900 : 200;
                  const baseSpanC = hasAmazon ? 500 : 250;
                  await delay(baseMinC + Math.floor(Math.random() * baseSpanC));
                  progress.value.done++;
                  continue;
                }
              } catch (langFixErr) {
                logError('cache:ja-corrected-error', langFixErr, { recordId: rid, url: normalizedUrl });
              }
              try {
                await field.setValue(rid, cached.content);
                log('cache:hit-write-success', { recordId: rid, url: normalizedUrl, contentLength: cached.content.length });
                if (titleField) {
                  try { await titleField.setValue(rid, cached.title || ''); log('cache:hit-write-title-success', { recordId: rid }); } catch (wte) { logError('cache:hit-write-title-error', wte, { recordId: rid, fieldId: titleFieldId.value }); }
                }
                if (sublistField) {
                  try { await sublistField.setValue(rid, cached.sublistText || ''); log('cache:hit-write-sublist-success', { recordId: rid }); } catch (wse) { logError('cache:hit-write-sublist-error', wse, { recordId: rid, fieldId: sublistFieldId.value }); }
                }
              } catch (writeErr) {
                logError('cache:hit-write-error', writeErr, { recordId: rid, fieldId: outputFieldId.value });
              }
              const baseMinC = hasAmazon ? 900 : 200;
              const baseSpanC = hasAmazon ? 500 : 250;
              await delay(baseMinC + Math.floor(Math.random() * baseSpanC));
              progress.value.done++;
              continue;
            }
            const headers = buildHeadersForUrl(normalizedUrl);
            // 域名级最小间隔，降低触发限速与门页
            await ensureDomainInterval(normalizedUrl);
            if (paused.value || (abortCtrl && abortCtrl.signal?.aborted)) { log('worker:aborted:before-fetch'); break; }
            // 根据域名选择提取路径：Amazon 走 HTML + 本地解析，其他走 Reader Markdown
            let content = '';
            let title = '';
            let sublistText = '';
            if (/amazon\./i.test((new URL(normalizedUrl)).hostname)) {
              const html0 = await fetchHtmlWithReader(normalizedUrl, headers, { signal: abortCtrl.signal });
              const { html, structured } = await refetchAmazonHtmlIfDoor(normalizedUrl, headers, html0, abortCtrl.signal);
              title = (structured?.title || '').trim();
              let mdFinal = formatStructuredForAmazon(structured, normalizedUrl);
              log('record:fetch-success-html', {
                recordId: rid,
                url: normalizedUrl,
                title: title || '',
                items: Array.isArray(structured?.items) ? structured.items.length : 0,
                sidebar: Array.isArray(structured?.sidebar) ? structured.sidebar.length : 0,
                htmlLength: (html || '').length
              });
              // 记录结构化解析结果与生成的 Markdown
              log('record:parsed-structured', { recordId: rid, url: normalizedUrl, title: title || '', structured });
              log('record:parsed-markdown', { recordId: rid, url: normalizedUrl, title: title || '', markdown: mdFinal || '' });
              // 若语言失配（仍为英文），且域为 .co.jp，则尝试强制 '/-/ja/' 路径做二次抓取
              const host = (new URL(normalizedUrl)).hostname.toLowerCase();
              const looksEnglish = (/best sellers/i.test(title) || (Array.isArray(structured?.sidebar) && structured.sidebar.some(s => /\/-\/en\//i.test(s.url))));
              if (host.endsWith('.co.jp') && looksEnglish) {
                try {
                  const urlJa = forceAmazonLangPath(normalizedUrl, 'ja');
                  const headersJa = buildHeadersForUrl(urlJa);
                  const htmlJa0 = await fetchHtmlWithReader(urlJa, headersJa, { signal: abortCtrl.signal });
                  const { html: htmlJa, structured: stJaTmp } = await refetchAmazonHtmlIfDoor(urlJa, headersJa, htmlJa0, abortCtrl.signal);
                  const titleJa = (stJaTmp?.title || '').trim();
                  const mdJa = formatStructuredForAmazon(stJaTmp, urlJa);
                  log('language:refetch-path-ja', {
                    recordId: rid,
                    url: urlJa,
                    titleBefore: title || '',
                    titleAfter: titleJa || '',
                    itemsBefore: Array.isArray(structured?.items) ? structured.items.length : 0,
                    itemsAfter: Array.isArray(stJaTmp?.items) ? stJaTmp.items.length : 0
                  });
                  title = titleJa || title;
                  mdFinal = mdJa || mdFinal;
                  log('record:parsed-markdown', { recordId: rid, url: urlJa, title: title || '', markdown: mdFinal || '' });
                  // 覆盖 structured.items / structured.sidebar 以保证后续子榜单语言一致
                  if (Array.isArray(stJaTmp?.items)) structured.items = stJaTmp.items;
                  if (Array.isArray(stJaTmp?.sidebar)) structured.sidebar = stJaTmp.sidebar;
                } catch (langErr) {
                  logError('language:refetch-path-ja-error', langErr, { recordId: rid, url: normalizedUrl });
                }
              }
              // 侧边子榜单提取为单元格文本（多个用英文逗号分隔，格式：[名称](URL)）
              const sidebarArr = Array.isArray(structured?.sidebar) ? structured.sidebar : [];
              if (sidebarArr.length) {
                sublistText = sidebarArr
                  .filter(s => (s && (s.name || '').trim()))
                  .map(s => `[${(s.name || '').trim()}](${(s.url || '').trim()})`)
                  .join('\n');
              }
              // 若结构化解析失败或商品为空，使用 Reader Markdown 保底回退（域优先语言）
              let usedFallback = false;
              if (!title || !Array.isArray(structured?.items) || structured.items.length === 0) {
                try {
                  const markdownFallback0 = await fetchMarkdownWithReader(normalizedUrl, headers, { signal: abortCtrl.signal });
                  const { markdown: markdownFallback, title: titleFallback } = await refetchIfDoor(normalizedUrl, headers, markdownFallback0, abortCtrl.signal);
                  log('record:fallback-reader-markdown', { recordId: rid, url: normalizedUrl, markdownLength: (markdownFallback || '').length });
                  log('record:parsed-markdown-fallback', { recordId: rid, url: normalizedUrl, title: titleFallback || title || '', markdown: markdownFallback || '' });
                  title = (titleFallback || title || '').trim();
                  const md2 = markdownFallback || mdFinal || '';
                  content = `Title: ${title || ''}\n\nURL Source: ${normalizedUrl}\n\nMarkdown Content:\n${md2 || ''}`;
                  usedFallback = true;
                } catch (fbErr) {
                  logError('record:fallback-reader-markdown-error', fbErr, { recordId: rid, url: normalizedUrl });
                }
              }
              if (!usedFallback) {
                content = `Title: ${title || ''}\n\nURL Source: ${normalizedUrl}\n\nMarkdown Content:\n${mdFinal || ''}`;
              }
            } else {
              const markdown0 = await fetchMarkdownWithReader(normalizedUrl, headers, { signal: abortCtrl.signal });
              const result = await refetchIfDoor(normalizedUrl, headers, markdown0, abortCtrl.signal);
              const markdown = result.markdown;
              title = result.title;
              log('record:fetch-success', {
                recordId: rid,
                url: normalizedUrl,
                title: title || '',
                markdownLength: (markdown || '').length
              });
              // 记录 Markdown 解析内容
              log('record:parsed-markdown', { recordId: rid, url: normalizedUrl, title: title || '', markdown: markdown || '' });
              content = `Title: ${title || ''}\n\nURL Source: ${normalizedUrl}\n\nMarkdown Content:\n${markdown || ''}`;
              sublistText = '';
            }
            // 写入前记录预览内容
            log('record:write-preview', { recordId: rid, url: normalizedUrl, content, contentLength: (content || '').length });
            try {
              await field.setValue(rid, content);
              log('record:write-success', { recordId: rid, contentLength: content.length, content });
              // 写入成功后，缓存结果供后续同 URL 复用
              contentCache.set(normalizedUrl, { content, title, sublistText, markdownLength: content.length });
            } catch (writeErr) {
              logError('record:write-error', writeErr, { recordId: rid, fieldId: outputFieldId.value });
            }
            // 可选写入：标题与子榜单
            if (titleField) {
              try { await titleField.setValue(rid, title || ''); log('record:write-title-success', { recordId: rid }); } catch (wte) { logError('record:write-title-error', wte, { recordId: rid, fieldId: titleFieldId.value }); }
            }
            if (sublistField) {
              try { await sublistField.setValue(rid, sublistText || ''); log('record:write-sublist-success', { recordId: rid }); } catch (wse) { logError('record:write-sublist-error', wse, { recordId: rid, fieldId: sublistFieldId.value }); }
            }
            const baseMin = hasAmazon ? 900 : 200;
            const baseSpan = hasAmazon ? 500 : 250;
            await delay(baseMin + Math.floor(Math.random() * baseSpan));
          } catch (e) {
            // 单条失败跳过，继续下一个
            if (abortCtrl && abortCtrl.signal?.aborted) {
              log('record:aborted', { recordId: rid });
              break;
            }
            logError('record:fetch-error', e, { recordId: rid });
          } finally {
            progress.value.done++;
          }
        }
      }
      await Promise.all(Array.from({ length: concurrency }, worker));
    } catch (e) {
      runError.value = (e && e.message) ? e.message : t('msg.runFailed');
      logError('batch:error', e);
    } finally {
      running.value = false;
      paused.value = false;
      abortCtrl = null;
      log('batch:end', { done: progress.value.done, total: progress.value.total });
    }
  }

  // 格式化 Amazon 结构化文本，稳定过滤页面噪音（按域语言输出）
  function formatStructuredForAmazon(structured, sourceUrl) {
    const title = (structured?.title || '').trim();
    const side = Array.isArray(structured?.sidebar) ? structured.sidebar : [];
    const items = Array.isArray(structured?.items) ? structured.items : [];

    // 语言字符串映射（可扩展）
    const langHeader = resolveAcceptLanguage(sourceUrl);
    const primaryLang = (langHeader.split(',')[0] || 'en-US').trim();
    const STR = {
      'ja-JP': {
        headingBase: '売れ筋ランキング',
        of: 'の',
        price: '価格',
        from: 'より',
      },
      'zh-CN': {
        headingBase: '销售排行榜',
        of: '的',
        price: '价格',
        from: '起',
      },
      'en-US': {
        headingBase: 'Best Sellers',
        of: 'in',
        price: 'Price',
        from: 'from',
      },
    };
    const S = STR[primaryLang] || STR['en-US'];

    // 从标题中尝试解析分类名，如 "销售排行榜: 食品 中最受欢迎的商品"
    const categoryFromTitle = (() => {
      // 尝试从标题中解析分类（中文/日文/英文常见形式）
      const zh = title.match(/销售排行榜[:：]\s*(.+?)\s*中最受欢迎的商品/);
      const ja = title.match(/売れ筋ランキング[:：]?\s*(.+)/);
      const en = title.match(/Best Sellers in\s+(.+)/i);
      const m = zh || ja || en;
      return m ? (m[1] || '').trim() : '';
    })();

    const lines = [];
    lines.push(`Title: ${title}`);
    lines.push('');
    lines.push(`URL Source: ${sourceUrl}`);
    lines.push('');

    // 侧边分类：使用示例中的列表风格 "*   [分类](url)"
    if (side.length) {
      for (const s of side) {
        const name = (s?.name || '').trim();
        const url = (s?.url || '').trim();
        if (!name) continue;
        lines.push(`*   [${name}](${url})`);
      }
    }

    lines.push('');
    const heading = categoryFromTitle ? `${categoryFromTitle}${S.of} ${S.headingBase}` : S.headingBase;
    lines.push(heading);
    lines.push('=========');

    if (items.length) {
      for (const it of items) {
        const idx = Number(it?.rank) || 0;
        const name = (it?.product_name || '').trim();
        const url = (it?.product_url || '').trim();
        const rc = it?.review_count;
        const ratingText = (it?.rating_text || '').trim();
        const reviewsUrl = (it?.reviews_url || url);
        const priceText = (it?.price_text || '').trim();
        if (!name) continue;
        const parts = [];
        parts.push(`${idx}.   #${idx}   [${name}](${url})`);
        if (ratingText || typeof rc === 'number') {
          const rcText = typeof rc === 'number' ? String(rc) : '';
          const inner = ratingText ? `_${ratingText}_ ${rcText}` : rcText;
          parts.push(`[${inner}](${reviewsUrl})`);
        }
        if (priceText) {
          parts.push(`[${S.price} ${priceText} ${S.from}](${url})`);
        }
        lines.push(parts.join(' '));
      }
    }
    return lines.join('\n');
  }

  async function handleExtract() {
    extractError.value = '';
    products.value = [];
    pageTitle.value = '';
    const url = (inputUrl.value || '').trim();
    if (!url || !/^https?:\/\//i.test(url)) {
      extractError.value = t('msg.invalidUrl');
      return;
    }
    extracting.value = true;
    log('single:start', { url });
    try {
      const languageAwareUrl = applyLanguageToUrl(url);
      const normalizedUrl = normalizeAmazonUrl(languageAwareUrl);
      const headers = buildHeadersForUrl(normalizedUrl);
      if (/amazon\./i.test((new URL(normalizedUrl)).hostname)) {
        const html0 = await fetchHtmlWithReader(normalizedUrl, headers);
        const { html, structured } = await refetchAmazonHtmlIfDoor(normalizedUrl, headers, html0);
        pageTitle.value = (structured?.title || '') || '';
        log('single:fetch-success-html', {
          url: normalizedUrl,
          title: pageTitle.value || '',
          items: Array.isArray(structured?.items) ? structured.items.length : 0,
          htmlLength: (html || '').length
        });
        // 记录结构化解析结果与生成的 Markdown 预览
        let mdFinal = formatStructuredForAmazon(structured, normalizedUrl);
        log('single:parsed-structured', { url: normalizedUrl, title: pageTitle.value || '', structured });
        log('single:parsed-markdown', { url: normalizedUrl, title: pageTitle.value || '', markdown: mdFinal || '' });
        // 若语言失配（仍为英文），且域为 .co.jp，则尝试强制 '/-/ja/' 路径做二次抓取
        const host = (new URL(normalizedUrl)).hostname.toLowerCase();
        const looksEnglish = (/best sellers/i.test(pageTitle.value || '') || (Array.isArray(structured?.sidebar) && structured.sidebar.some(s => /\/-\/en\//i.test(s.url))));
        if (host.endsWith('.co.jp') && looksEnglish) {
          try {
            const urlJa = forceAmazonLangPath(normalizedUrl, 'ja');
            const headersJa = buildHeadersForUrl(urlJa);
            const htmlJa0 = await fetchHtmlWithReader(urlJa, headersJa);
            const { html: htmlJa, structured: stJa } = await refetchAmazonHtmlIfDoor(urlJa, headersJa, htmlJa0);
            const titleJa = (stJa?.title || '').trim();
            const mdJa = formatStructuredForAmazon(stJa, urlJa);
            log('language:refetch-path-ja', {
              url: urlJa,
              titleBefore: pageTitle.value || '',
              titleAfter: titleJa || '',
              itemsBefore: Array.isArray(structured?.items) ? structured.items.length : 0,
              itemsAfter: Array.isArray(stJa?.items) ? stJa.items.length : 0
            });
            pageTitle.value = titleJa || pageTitle.value || '';
            mdFinal = mdJa || mdFinal;
            log('single:parsed-markdown', { url: urlJa, title: pageTitle.value || '', markdown: mdFinal || '' });
            // 覆盖 items / sidebar，确保子榜单语言与日文回抓一致
            if (Array.isArray(stJa?.items)) structured.items = stJa.items;
            if (Array.isArray(stJa?.sidebar)) structured.sidebar = stJa.sidebar;
          } catch (langErr) {
            logError('single:refetch-path-ja-error', langErr, { url: normalizedUrl });
          }
        }
        // 若结构化解析失败或商品为空，使用 Reader Markdown 保底回退（域优先语言）
        if (!pageTitle.value || !Array.isArray(structured?.items) || structured.items.length === 0) {
          try {
            const markdownFallback0 = await fetchMarkdownWithReader(normalizedUrl, headers);
            const { markdown: markdownFallback, title: titleFallback } = await refetchIfDoor(normalizedUrl, headers, markdownFallback0);
            const tf = (titleFallback || pageTitle.value || '').trim();
            log('single:fallback-reader-markdown', { url: normalizedUrl, title: tf || '', markdownLength: (markdownFallback || '').length });
            log('single:parsed-markdown-fallback', { url: normalizedUrl, title: tf || '', markdown: markdownFallback || '' });
            pageTitle.value = tf;
          } catch (fbErr) {
            logError('single:fallback-reader-markdown-error', fbErr, { url: normalizedUrl });
          }
        }
        products.value = [];
      } else {
        const markdown0 = await fetchMarkdownWithReader(normalizedUrl, headers);
        const { markdown, title } = await refetchIfDoor(normalizedUrl, headers, markdown0);
        pageTitle.value = title || '';
        log('single:fetch-success', {
          url: normalizedUrl,
          title: title || '',
          markdownLength: (markdown || '').length
        });
        log('single:parsed-markdown', { url: normalizedUrl, title: title || '', markdown: markdown || '' });
        products.value = [];
      }
    } catch (e) {
      extractError.value = (e && e.message) ? e.message : t('msg.fetchError');
      logError('single:fetch-error', e, { url });
    } finally {
      extracting.value = false;
      log('single:end', { url });
    }
  }

  function extractTitleFromMarkdown(md) {
    try {
      if (!md || typeof md !== 'string') return '';
      const lines = md.split(/\r?\n/);
      for (const line of lines) {
        const m = line.match(/^\s*#{1,3}\s+(.+?)\s*$/);
        if (m) return (m[1] || '').trim();
      }
      const first = (lines[0] || '').trim();
      return first.replace(/^#+\s*/, '').slice(0, 120);
    } catch (_) {
      return '';
    }
  }

  // 导出日志（JSON）
  function exportLogs() {
    try {
      const payload = {
        meta: {
          tableId: databaseId.value,
          viewId: viewId.value,
          urlFieldId: urlFieldId.value,
          outputFieldId: outputFieldId.value,
          titleFieldId: titleFieldId.value,
          sublistFieldId: sublistFieldId.value,
          // 回退：移除语言首选项
        },
        logs: getLogs(),
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      a.download = `plugin-logs-${ts}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(href);
      log('logs:export', { count: (getLogs() || []).length });
    } catch (e) {
      logError('logs:export-error', e);
    }
  }

  function pauseRun() {
    try {
      if (!running.value) return;
      paused.value = true;
      if (abortCtrl) {
        try { abortCtrl.abort(); } catch (_) {}
      }
      running.value = false;
      log('batch:paused', { done: progress.value.done, total: progress.value.total });
    } catch (e) {
      logError('batch:pause-error', e);
    }
  }
</script>

<template>
  <div class="main">
  <div class="section">
    <div class="text">{{ $t('label.linkField') }}</div>
    <el-select
      v-model="urlFieldId"
      :placeholder="$t('placeholder.linkField')"
      popper-class="selectStyle"
    >
        <el-option
          v-for="item in fieldList"
          :key="item.id"
          :label="item.name"
          :value="item.id"
        />
      </el-select>
      <div class="hint small">{{ $t('hint.urlFieldAuto') }}</div>

      <div class="text">{{ $t('label.outputField') }}</div>
      <el-select
        v-model="outputFieldId"
        :placeholder="$t('placeholder.outputField')"
        popper-class="selectStyle"
      >
        <el-option
          v-for="item in fieldList"
          :key="item.id"
          :label="item.name"
          :value="item.id"
        />
      </el-select>

      <div class="text">{{ $t('label.titleField') }}</div>
      <el-select
        v-model="titleFieldId"
        :placeholder="$t('placeholder.titleField')"
        popper-class="selectStyle"
      >
        <el-option
          v-for="item in fieldList"
          :key="item.id"
          :label="item.name"
          :value="item.id"
        />
      </el-select>

      <div class="text">{{ $t('label.sublistField') }}</div>
      <el-select
        v-model="sublistFieldId"
        :placeholder="$t('placeholder.sublistField')"
        popper-class="selectStyle"
      >
        <el-option
          v-for="item in fieldList"
          :key="item.id"
          :label="item.name"
          :value="item.id"
        />
      </el-select>
      <div class="hint small">{{ $t('hint.sublistComma') }}</div>

      <div class="text">输出语言</div>
      <el-select v-model="outputLangMode" :placeholder="'自动按域名'" popper-class="selectStyle">
        <el-option label="自动按域名" value="auto" />
        <el-option label="日语（ja-JP）" value="ja-JP" />
        <el-option label="中文（zh-CN）" value="zh-CN" />
        <el-option label="英语（en-US）" value="en-US" />
      </el-select>
      
      <div class="run-row">
        <el-button type="primary" :loading="running" @click="runBatchUpdate">
          {{ $t('btn.run') }}
        </el-button>
        <el-button type="warning" v-if="running" @click="pauseRun">暂停</el-button>
        <div v-if="running" class="progress">{{ progress.done }} / {{ progress.total }}</div>
      </div>
      <div v-if="runError" class="error">{{ runError }}</div>
    </div>
    <!-- 运行日志面板 -->
    <div class="runtime-panel">
      <div class="runtime-header">
        <div>运行日志</div>
        <div class="runtime-actions">
          <el-switch v-model="logAutoScroll" active-text="自动滚动" />
          <el-button @click="exportLogs">导出日志</el-button>
        </div>
      </div>
      <div class="runtime-body" ref="logViewRef">
        <pre class="runtime-pre">{{ formattedRuntimeText }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
  .main {
    font-weight: normal;
  }

  .label {
    display: flex;
    align-items: center;
    margin-bottom: 20px;

    .text {
      width: 70px;
      margin-right: 10px;
      white-space: nowrap;
      font-size: 14px;
    }

    :deep(.el-radio-button__original-radio:checked + .el-radio-button__inner) {
      color: #fff;
      background-color: rgb(20, 86, 240);
      border-color: rgb(20, 86, 240);
      box-shadow: 1px 0 0 0 rgb(20, 86, 240);
    }

    :deep(.el-radio-button__inner) {
      font-weight: 300;
    }

    :deep(.el-radio-button__inner:hover) {
      color: rgb(20, 86, 240);
    }

    :deep(.el-input__inner) {
      font-weight: 300;
    }
  }

  /* 移除旧展示区域样式 */

  .divider {
    height: 1px;
    background: #e5e7eb;
    margin: 24px 0;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .run-row { display: flex; gap: 8px; align-items: center; }

  .error {
    color: #e11d48;
    font-size: 13px;
  }

  .title {
    font-weight: 500;
  }

  .products-title {
    margin-top: 4px;
  }

  .hint {
    font-size: 13px;
    color: #6b7280;
  }
  .hint.small { font-size: 12px; }

  .runtime-panel {
    margin-top: 12px;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    background: #fafafa;
  }
  .runtime-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 10px;
    border-bottom: 1px solid #e5e7eb;
    font-size: 13px;
    color: #374151;
  }
  .runtime-actions { display: flex; gap: 8px; align-items: center; }
  .runtime-body {
    max-height: 220px;
    overflow: auto;
    padding: 8px 10px;
    background: #ffffff;
  }
  .runtime-pre {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    font-size: 12px;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
  }
</style>

<style>
  .selectStyle {
    .el-select-dropdown__item {
      font-weight: 300 !important;
    }

    .el-select-dropdown__item.selected {
      color: rgb(20, 86, 240);
    }
  }
</style>
