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
  import { fetchHtmlWithReader, fetchMarkdownWithReader, extractTitleFromHtml } from '../services/reader.js';
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
    const waitSelector = isAmazon ? '#zg-ordered-list' : 'h1, article, main';
    const headers = {
      'x-wait-for-selector': waitSelector,
      'x-timeout-ms': isAmazon ? '8000' : '10000',
      'x-user-agent': isAmazon ? UA_POOL[0] : pickUA(),
      // 提升可信度：附加语言与来源
      ...(isAmazon ? {
        'accept-language': 'ja-JP,ja;q=0.9,en;q=0.8',
        'referer': 'https://www.amazon.co.jp/'
      } : {})
    };
    log('headers-built', { url, host, isAmazon, userAgent: headers['x-user-agent'] });
    return headers;
  }

  function normalizeAmazonUrl(input) {
    try {
      const u = new URL(input);
      const host = (u.hostname || '').toLowerCase();
      if (!host.includes('amazon.')) return input;
      // 去除语言与 ref 等追踪参数，降低重定向与门页概率
      const parts = u.pathname.split('/');
      const hasLocalization = parts.length > 3 && parts[1] === '-' && parts[2];
      // 清空查询与哈希
      u.search = '';
      u.hash = '';
      if (hasLocalization) {
        u.pathname = '/' + parts.slice(3).join('/');
      }
      // 路径中可能存在 "/ref=..." 作为追踪段，直接截断到其之前
      const p = u.pathname || '';
      const refIdx = p.indexOf('/ref=');
      if (refIdx !== -1) {
        u.pathname = p.slice(0, refIdx);
      }
      // 规范输出为 origin + pathname，避免意外带回查询参数
      return `${u.origin}${u.pathname}`;
    } catch (_) {
      return input;
    }
  }

  function isAmazonDoorMarkdown(md) {
    if (!md) return false;
    return /CAPTCHA/i.test(md) || /下のボタンをクリックしてショッピングを続けてください/.test(md);
  }

  async function refetchIfDoor(url, headers, markdown) {
    const isDoor = isAmazonDoorMarkdown(markdown);
    if (!isDoor) return { markdown, title: extractTitleFromMarkdown(markdown), refetched: false };
    log('record:door-detected', { url });
    // 二次尝试：更换 UA，移除等待选择器，加快与避开门页
    const altHeaders = { 'x-timeout-ms': '7000', 'x-user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:118.0) Gecko/20100101 Firefox/118.0' };
    try {
      const md2 = await fetchMarkdownWithReader(url, altHeaders);
      // 若仍为门页，再做第三次回退：使用 Android Chrome UA + 英文语言，尝试移动页面分支
      if (isAmazonDoorMarkdown(md2)) {
        const altHeaders3 = {
          'x-timeout-ms': '7000',
          'x-user-agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Mobile Safari/537.36',
          'accept-language': 'en-US,en;q=0.9',
          'referer': 'https://www.amazon.co.jp/'
        };
        try {
          const md3 = await fetchMarkdownWithReader(url, altHeaders3);
          if (isAmazonDoorMarkdown(md3)) {
            // 仍为门页：尝试使用规范化后的 Canonical 链接做最终回退
            const canonical = normalizeAmazonUrl(url);
            if (canonical !== url) {
              const altHeaders4 = {
                'x-timeout-ms': '7000',
                'x-user-agent': UA_POOL[0],
                'accept-language': 'ja-JP,ja;q=0.9,en;q=0.8',
                'referer': 'https://www.amazon.co.jp/',
                'x-wait-for-selector': '#zg-ordered-list'
              };
              try {
                const md4 = await fetchMarkdownWithReader(canonical, altHeaders4);
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
      logError('record:door-refetch-fail', e, { url });
      return { markdown, title: extractTitleFromMarkdown(markdown), refetched: false };
    }
  }

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
    running.value = true;
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
        outputFieldType: outputMeta?.type
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
      const concurrency = hasAmazon ? 1 : 2;
      let idx = 0;
      const delay = (ms) => new Promise((r) => setTimeout(r, ms));
      const field = await table.getFieldById(outputFieldId.value);
      async function worker() {
        while (idx < recordIds.length) {
          const current = idx++;
          const rid = recordIds[current];
          try {
            const val = await table.getCellValue(urlFieldId.value, rid);
            const url = extractFirstUrl(val);
            if (!url) { log('record:skip-no-url', { recordId: rid }); progress.value.done++; continue; }
            const normalizedUrl = normalizeAmazonUrl(url);
            const headers = buildHeadersForUrl(normalizedUrl);
            // 域名级最小间隔，降低触发限速与门页
            await ensureDomainInterval(normalizedUrl);
            const markdown0 = await fetchMarkdownWithReader(normalizedUrl, headers);
            const { markdown, title, refetched } = await refetchIfDoor(normalizedUrl, headers, markdown0);
            log('record:fetch-success', {
              recordId: rid,
              url: normalizedUrl,
              title: title || '',
              markdownLength: (markdown || '').length
            });
            const content = `Title: ${title || ''}\n\nURL Source: ${normalizedUrl}\n\nMarkdown Content:\n${markdown || ''}`;
            try {
              await field.setValue(rid, content);
              log('record:write-success', { recordId: rid, contentLength: content.length });
            } catch (writeErr) {
              logError('record:write-error', writeErr, { recordId: rid, fieldId: outputFieldId.value });
            }
            const baseMin = hasAmazon ? 900 : 200;
            const baseSpan = hasAmazon ? 500 : 250;
            await delay(baseMin + Math.floor(Math.random() * baseSpan));
          } catch (e) {
            // 单条失败跳过，继续下一个
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
      log('batch:end', { done: progress.value.done, total: progress.value.total });
    }
  }

  // 格式化 Amazon 结构化文本，稳定过滤页面噪音
  function formatStructuredForAmazon(structured, sourceUrl) {
    const title = (structured?.title || '').trim();
    const side = Array.isArray(structured?.sidebar) ? structured.sidebar : [];
    const items = Array.isArray(structured?.items) ? structured.items : [];

    // 从标题中尝试解析分类名，如 "销售排行榜: 食品 中最受欢迎的商品"
    const categoryFromTitle = (() => {
      const m = title.match(/销售排行榜[:：]\s*(.+?)\s*中最受欢迎的商品/);
      return m ? m[1].trim() : '';
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
    const heading = categoryFromTitle ? `${categoryFromTitle}的 销售排行榜` : '销售排行榜';
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
          parts.push(`[价格 ${priceText} 起](${url})`);
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
      const normalizedUrl = normalizeAmazonUrl(url);
      const headers = buildHeadersForUrl(normalizedUrl);
      const markdown0 = await fetchMarkdownWithReader(normalizedUrl, headers);
      const { markdown, title } = await refetchIfDoor(normalizedUrl, headers, markdown0);
      pageTitle.value = title || '';
      log('single:fetch-success', {
        url: normalizedUrl,
        title: title || '',
        markdownLength: (markdown || '').length
      });
      products.value = []; // 页面仅预览标题，批量写入结构化文本
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
      
      <div class="run-row">
        <el-button type="primary" :loading="running" @click="runBatchUpdate">
          {{ $t('btn.run') }}
        </el-button>
        <el-button @click="exportLogs">导出日志</el-button>
        <div v-if="running" class="progress">{{ progress.done }} / {{ progress.total }}</div>
      </div>
      <div v-if="runError" class="error">{{ runError }}</div>
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
