/**
 * web-search.js — 网络搜索模块 (Brave + Tavily 双后端)
 *
 * 后端策略：
 *   - Brave Search API   — Web + News，GET 请求
 *   - Tavily Search API  — AI-optimized，POST JSON
 *   - 两者并行调用，结果合并去重
 *   - 任一失败不影响另一后端；双失败回退本地知识库
 *
 * 使用方式：
 *   const ws = new WebSearch(dataDir, braveKey, tavilyKey);
 *   const r = await ws.query('人工智能');
 */

const https = require('https');
const path = require('path');
const fs = require('fs');

const BRAVE_WEB   = 'https://api.search.brave.com/res/v1/web/search';
const BRAVE_NEWS  = 'https://api.search.brave.com/res/v1/news/search';
const TAVILY_API  = 'https://api.tavily.com/search';
const DEFAULT_LIMIT = 10;

class WebSearch {
  constructor(dataDir, braveApiKey, tavilyApiKey) {
    this.dataDir = dataDir;
    this.braveKey = braveApiKey || '';
    this.tavilyKey = tavilyApiKey || '';
    this.cacheFile = dataDir ? path.join(dataDir, 'search-cache.json') : null;
    this.cache = {};
    this._loadCache();
  }

  // ============================================================
  // query — 通用搜索 (Brave Web + Tavily 并行)
  // ============================================================
  async query(terms, opts = {}) {
    const limit = opts.limit || DEFAULT_LIMIT;
    if (!terms || !terms.trim()) return this.trending({ limit });

    const ck = `q:${terms.toLowerCase().trim()}`;
    const cached = this._cacheGet(ck, 10 * 60 * 1000);
    if (cached) return cached;

    const isChinese = this._hasChinese(terms);
    const merged = await this._dual(
      // Brave
      this.braveKey ? (() => {
        const p = new URLSearchParams({ q: terms, count: String(limit), search_lang: isChinese ? 'zh' : 'en' });
        if (opts.freshness) p.set('freshness', opts.freshness);
        return this._braveGet(`${BRAVE_WEB}?${p}`, 'brave');
      })() : null,
      // Tavily
      this.tavilyKey ? this._tavilySearch(terms, { max_results: limit }) : null,
    );

    const deduped = this._dedupe(merged, limit);
    this._cacheSet(ck, deduped, 10 * 60 * 1000);
    return deduped;
  }

  // ============================================================
  // trending — 热门话题 (Brave News + Tavily 并行)
  // ============================================================
  async trending(opts = {}) {
    const limit = opts.limit || DEFAULT_LIMIT;
    const cached = this._cacheGet('trending', 30 * 60 * 1000);
    if (cached) return cached;

    const merged = await this._dual(
      this.braveKey ? (() => {
        const p = new URLSearchParams({ q: 'top news', count: String(limit), freshness: 'pd' });
        return this._braveGet(`${BRAVE_NEWS}?${p}`, 'brave-news');
      })() : null,
      this.tavilyKey ? this._tavilySearch('top news headlines', { max_results: limit, search_depth: 'advanced' }) : null,
    );

    const deduped = this._dedupe(merged, limit);
    this._cacheSet('trending', deduped, 30 * 60 * 1000);
    return deduped;
  }

  // ============================================================
  // searchNews — 新闻搜索 (Brave News + Tavily 并行, freshness=pd)
  // ============================================================
  async searchNews(terms, limit = DEFAULT_LIMIT) {
    if (!terms || !terms.trim()) return this.trending({ limit });

    const ck = `news:${terms.toLowerCase().trim()}`;
    const cached = this._cacheGet(ck, 3 * 60 * 1000);
    if (cached) return cached;

    const merged = await this._dual(
      this.braveKey ? (() => {
        const p = new URLSearchParams({ q: terms, count: String(limit), freshness: 'pd' });
        return this._braveGet(`${BRAVE_NEWS}?${p}`, 'brave-news');
      })() : null,
      this.tavilyKey ? this._tavilySearch(`${terms} news today`, { max_results: limit, search_depth: 'advanced' }) : null,
    );

    const deduped = this._dedupe(merged, limit);
    this._cacheSet(ck, deduped, 3 * 60 * 1000);
    return deduped;
  }

  // ============================================================
  // 双后端并行引擎
  // ============================================================
  async _dual(bravePromise, tavilyPromise) {
    const jobs = [];
    if (bravePromise) jobs.push(bravePromise);
    if (tavilyPromise) jobs.push(tavilyPromise);
    if (jobs.length === 0) {
      return this._trendingFallback();
    }

    const settled = await Promise.allSettled(jobs);
    const merged = [];
    for (const r of settled) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        merged.push(...r.value);
      }
    }

    if (merged.length === 0) {
      // Both failed → local fallback
      return this._trendingFallback();
    }
    return merged;
  }

  // ============================================================
  // Brave Search (GET)
  // ============================================================
  _braveGet(url, source) {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve([]), 8000);
      try {
        const u = new URL(url);
        const req = https.request({
          hostname: u.hostname, port: 443, path: u.pathname + u.search,
          method: 'GET', timeout: 6000,
          headers: { 'Accept': 'application/json', 'X-Subscription-Token': this.braveKey },
        }, (res) => {
          if (res.statusCode < 200 || res.statusCode >= 300) { clearTimeout(t); resolve([]); return; }
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => {
            clearTimeout(t);
            try {
              const data = JSON.parse(d);
              const items = data?.web?.results || data?.results || [];
              resolve(items.map(r => ({ title: r.title || '', snippet: r.description || '', url: r.url || '', source })));
            } catch { resolve([]); }
          });
        });
        req.on('error', () => { clearTimeout(t); resolve([]); });
        req.on('timeout', () => { req.destroy(); clearTimeout(t); resolve([]); });
        req.end();
      } catch { clearTimeout(t); resolve([]); }
    });
  }

  // ============================================================
  // Tavily Search (POST)
  // ============================================================
  _tavilySearch(query, opts = {}) {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve([]), 10000);
      try {
        const body = JSON.stringify({
          api_key: this.tavilyKey,
          query,
          search_depth: opts.search_depth || 'basic',
          max_results: opts.max_results || DEFAULT_LIMIT,
          include_answer: false,
        });
        const u = new URL(TAVILY_API);
        const req = https.request({
          hostname: u.hostname, port: 443, path: u.pathname,
          method: 'POST', timeout: 8000,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
          if (res.statusCode < 200 || res.statusCode >= 300) { clearTimeout(t); resolve([]); return; }
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => {
            clearTimeout(t);
            try {
              const data = JSON.parse(d);
              const items = data?.results || [];
              resolve(items.map(r => ({ title: r.title || '', snippet: r.content || r.description || '', url: r.url || '', source: 'tavily' })));
            } catch { resolve([]); }
          });
        });
        req.on('error', () => { clearTimeout(t); resolve([]); });
        req.on('timeout', () => { req.destroy(); clearTimeout(t); resolve([]); });
        req.write(body);
        req.end();
      } catch { clearTimeout(t); resolve([]); }
    });
  }

  // ============================================================
  // 本地兜底
  // ============================================================
  _trendingFallback() {
    return [
      { title: 'SpaceX 成功发射新一代星舰', snippet: '航天商业化里程碑', url: '', source: 'local' },
      { title: 'AI 芯片竞争白热化，多家厂商发布新一代产品', snippet: '科技巨头争夺AI算力高地', url: '', source: 'local' },
      { title: '全球加速部署可再生能源应对气候变化', snippet: '气候行动优先议题', url: '', source: 'local' },
      { title: '新一代大语言模型发布，推理能力跃升', snippet: 'AI 能力持续突破', url: '', source: 'local' },
      { title: '量子计算纠错技术取得关键突破', snippet: '实用化量子计算更进一步', url: '', source: 'local' },
      { title: '多国协调推进数字货币监管新规', snippet: '加密资产监管框架完善', url: '', source: 'local' },
      { title: '苹果发布下一代可穿戴设备', snippet: '健康监测成焦点', url: '', source: 'local' },
      { title: '全球半导体供应链重组加速', snippet: '芯片制造格局变化', url: '', source: 'local' },
      { title: '自动驾驶商业化落地提速', snippet: '多城开放无人出租车服务', url: '', source: 'local' },
      { title: '核聚变能源研究取得新进展', snippet: '清洁能源未来可期', url: '', source: 'local' },
    ];
  }

  // ============================================================
  // 工具
  // ============================================================
  _hasChinese(text) { return /[一-鿿]/.test(text); }

  _dedupe(results, limit) {
    const seen = new Set();
    return results
      .filter(r => {
        if (!r.title) return false;
        const key = r.title.toLowerCase().replace(/[^a-z0-9一-鿿]/g, '').substring(0, 40);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, limit);
  }

  // ============================================================
  // 缓存
  // ============================================================
  _cacheGet(key, ttl) {
    const entry = this.cache[key];
    if (!entry) return null;
    if (Date.now() - entry.ts > ttl) { delete this.cache[key]; return null; }
    return entry.data;
  }
  _cacheSet(key, data, ttl) {
    this.cache[key] = { data, ts: Date.now(), ttl };
    this._saveCache();
  }
  _loadCache() {
    if (!this.cacheFile) return;
    try { if (fs.existsSync(this.cacheFile)) this.cache = JSON.parse(fs.readFileSync(this.cacheFile, 'utf-8')); }
    catch { this.cache = {}; }
  }
  _saveCache() {
    if (!this.cacheFile) return;
    try { fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache), 'utf-8'); } catch {}
  }
}

module.exports = WebSearch;
