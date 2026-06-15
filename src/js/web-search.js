/**
 * web-search.js — 网络搜索模块
 *
 * 免 Key 公开 API 搜索，被 ContentFetcher（每日惊喜）和 ChatEngine（聊天搜索）共用。
 *
 * 后端池：
 *   - Wikipedia OpenSearch（事实查询，自动中英文切换）
 *   - Reddit JSON API（实时讨论/新闻 — 仅英文）
 *   - HN Algolia（科技热点 — 仅英文）
 *   - 本地知识库 + 热点兜底
 *
 * 使用方式：
 *   const ws = new WebSearch(dataDir);
 *   const results = await ws.query('人工智能 新闻');
 *   const hot = await ws.trending();
 *   const news = await ws.searchNews('AI');
 */

const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');

class WebSearch {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.cacheFile = dataDir ? path.join(dataDir, 'search-cache.json') : null;
    this.cache = {};
    this._loadCache();
  }

  // ============================================================
  // 语言检测
  // ============================================================

  _hasChinese(text) {
    return /[一-鿿]/.test(text);
  }

  // ============================================================
  // 公开方法
  // ============================================================

  /**
   * 通用搜索：并行查所有后端，合并去重后返回
   * @param {string} terms - 搜索词
   * @param {object} [opts] - { limit: 3, sources: ['wikipedia','reddit','hn'] }
   * @returns {Promise<Array<{title, snippet, url, source}>>}
   */
  async query(terms, opts = {}) {
    const limit = opts.limit || 3;
    let sources = opts.sources || ['wikipedia', 'reddit', 'hn'];

    if (!terms || !terms.trim()) {
      return this.trending({ limit });
    }

    // 中文搜索：跳过 Reddit/HN（英文内容为主），走中文 Wikipedia + 本地
    // searchNews 场景设置 skipLanguageFilter=true 则不跳过
    const isChinese = this._hasChinese(terms);
    if (isChinese && !opts.skipLanguageFilter) {
      sources = sources.filter(s => s === 'wikipedia');
    }

    // 检查缓存
    const cacheKey = `query:${terms.toLowerCase().trim()}`;
    const cached = this._getCache(cacheKey);
    if (cached) return cached;

    const promises = [];
    if (sources.includes('wikipedia')) {
      promises.push(this._searchWikipedia(terms, limit, isChinese));
    }
    if (sources.includes('reddit')) {
      promises.push(this._searchReddit(terms, limit));
    }
    if (sources.includes('hn')) {
      promises.push(this._searchHN(terms, limit));
    }

    const results = await Promise.allSettled(promises);
    const merged = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        merged.push(...r.value);
      }
    }

    // 所有远程后端失败 → 本地知识库 → 预设热点兜底
    if (merged.length === 0) {
      const local = this._searchLocal(terms);
      merged.push(...local);
      if (merged.length === 0) {
        merged.push(...this._trendingFallback());
      }
    }

    const deduped = this._dedupe(merged, limit);
    this._setCache(cacheKey, deduped, 10 * 60 * 1000);
    return deduped;
  }

  /**
   * 拉取当前热门话题（供每日惊喜无搜索词时用）
   * @param {object} [opts] - { limit: 5 }
   * @returns {Promise<Array<{title, snippet, url, source}>>}
   */
  async trending(opts = {}) {
    const limit = opts.limit || 5;

    const cached = this._getCache('trending');
    if (cached) return cached;

    const [reddit, hn] = await Promise.allSettled([
      this._trendingReddit(limit),
      this._trendingHN(limit),
    ]);

    const merged = [];
    if (reddit.status === 'fulfilled' && reddit.value) merged.push(...reddit.value);
    if (hn.status === 'fulfilled' && hn.value) merged.push(...hn.value);

    // 远程后端都失败 → 预设热点兜底
    if (merged.length === 0) {
      merged.push(...this._trendingFallback());
    }

    const deduped = this._dedupe(merged, limit);
    this._setCache('trending', deduped, 30 * 60 * 1000);
    return deduped;
  }

  /**
   * 仅搜索新闻类内容（Reddit + HN，时间倒序，不调 Wikipedia）
   *
   * 不走 query() 的通用路径，因为新闻搜索需要：
   * - 时间倒序（最新优先）而非热度排序
   * - 不经过滤（中文也搜 Reddit/HN，英文结果比没有好）
   * - 不要 Wikipedia（百科知识不是新闻）
   *
   * @param {string} terms - 搜索词
   * @param {number} [limit=3]
   * @returns {Promise<Array<{title, snippet, url, source}>>}
   */
  async searchNews(terms, limit = 3) {
    if (!terms || !terms.trim()) return this.trending({ limit });

    const cacheKey = `news:${terms.toLowerCase().trim()}`;
    const cached = this._getCache(cacheKey);
    if (cached) return cached;

    const [reddit, hn] = await Promise.allSettled([
      this._searchRedditNews(terms, limit),
      this._searchHNNew(terms, limit),
    ]);

    const merged = [];
    if (reddit.status === 'fulfilled' && reddit.value) merged.push(...reddit.value);
    if (hn.status === 'fulfilled' && hn.value) merged.push(...hn.value);

    // 没搜到 → trending 兜底
    if (merged.length === 0) {
      merged.push(...this._trendingFallback());
    }

    const deduped = this._dedupe(merged, limit);
    this._setCache(cacheKey, deduped, 3 * 60 * 1000); // 3 min cache — 新闻换得快
    return deduped;
  }

  // ============================================================
  // Wikipedia OpenSearch（支持中英文）
  // ============================================================

  async _searchWikipedia(terms, limit, isChinese) {
    const wikiDomain = isChinese ? 'zh.wikipedia.org' : 'en.wikipedia.org';
    const url = `https://${wikiDomain}/w/api.php?action=opensearch&search=${encodeURIComponent(terms)}&limit=${limit}&namespace=0&format=json&origin=*`;
    const data = await this._httpGetJSON(url);
    if (!data || !Array.isArray(data) || data.length < 3) return [];

    const titles = data[1] || [];
    const descriptions = data[2] || [];
    const urls = data[3] || [];

    return titles.slice(0, limit).map((title, i) => ({
      title,
      snippet: descriptions[i] || '',
      url: urls[i] || '',
      source: 'wikipedia',
    }));
  }

  // ============================================================
  // Reddit JSON API
  // ============================================================

  async _searchReddit(terms, limit) {
    const url = `https://www.reddit.com/r/all/search.json?q=${encodeURIComponent(terms)}&sort=top&limit=${limit}&restrict_sr=off&t=month`;
    const data = await this._httpGetJSON(url, { headers: { 'User-Agent': 'DesktopCompanion/1.0' } });
    if (!data || !data.data || !data.data.children) return [];

    return data.data.children.slice(0, limit).map(child => {
      const d = child.data || {};
      return {
        title: d.title || '',
        snippet: (d.selftext || '').substring(0, 200),
        url: `https://www.reddit.com${d.permalink || ''}`,
        source: 'reddit',
        subreddit: d.subreddit || '',
      };
    }).filter(r => r.title);
  }

  async _trendingReddit(limit) {
    const url = 'https://www.reddit.com/r/news/hot.json?limit=15';
    const data = await this._httpGetJSON(url, { headers: { 'User-Agent': 'DesktopCompanion/1.0' } });
    if (!data || !data.data || !data.data.children) return [];

    return data.data.children.slice(0, limit).map(child => {
      const d = child.data || {};
      return {
        title: d.title || '',
        snippet: (d.selftext || '').substring(0, 200),
        url: `https://www.reddit.com${d.permalink || ''}`,
        source: 'reddit',
        subreddit: d.subreddit || '',
      };
    }).filter(r => r.title);
  }

  // ============================================================
  // HN Algolia API
  // ============================================================

  async _searchHN(terms, limit) {
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(terms)}&tags=story&hitsPerPage=${limit}`;
    const data = await this._httpGetJSON(url);
    if (!data || !data.hits) return [];

    return data.hits.slice(0, limit).map(hit => ({
      title: hit.title || '',
      snippet: `♨ ${hit.points || 0} points | by ${hit.author || 'anon'} | ${hit.num_comments || 0} comments`,
      url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
      source: 'hackernews',
    })).filter(r => r.title);
  }

  async _trendingHN(limit) {
    const url = `https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${limit}`;
    const data = await this._httpGetJSON(url);
    if (!data || !data.hits) return [];

    return data.hits.slice(0, limit).map(hit => ({
      title: hit.title || '',
      snippet: `♨ ${hit.points || 0} points | by ${hit.author || 'anon'} | ${hit.num_comments || 0} comments`,
      url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
      source: 'hackernews',
    })).filter(r => r.title);
  }

  // ============================================================
  // 实时新闻搜索（时间倒序）
  // ============================================================

  /**
   * Reddit 新闻搜索 — r/news 限定 + 按新排序 + 今日
   */
  async _searchRedditNews(terms, limit) {
    const url = `https://www.reddit.com/r/news/search.json?q=${encodeURIComponent(terms)}&sort=new&limit=${limit}&restrict_sr=on&t=day`;
    const data = await this._httpGetJSON(url, { headers: { 'User-Agent': 'DesktopCompanion/1.0' } });
    if (!data || !data.data || !data.data.children) return [];

    return data.data.children.slice(0, limit).map(child => {
      const d = child.data || {};
      return {
        title: d.title || '',
        snippet: (d.selftext || '').substring(0, 200),
        url: `https://www.reddit.com${d.permalink || ''}`,
        source: 'reddit',
        subreddit: d.subreddit || '',
      };
    }).filter(r => r.title);
  }

  /**
   * HN 新闻搜索 — 最近 24h + 按日期排序
   */
  async _searchHNNew(terms, limit) {
    // 24 小时前的时间戳
    const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(terms)}&tags=story&hitsPerPage=${limit}&numericFilters=created_at_i>${oneDayAgo}`;
    const data = await this._httpGetJSON(url);
    if (!data || !data.hits) return [];

    return data.hits.slice(0, limit).map(hit => ({
      title: hit.title || '',
      snippet: `♨ ${hit.points || 0} points | by ${hit.author || 'anon'} | ${hit.num_comments || 0} comments`,
      url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
      source: 'hackernews',
    })).filter(r => r.title);
  }

  // ============================================================
  // 本地知识库（兜底）
  // ============================================================

  _searchLocal(terms) {
    const lower = terms.toLowerCase();
    // 中文和英文都匹配
    const matches = this._getLocalKnowledge().filter(item =>
      item.title.toLowerCase().includes(lower) ||
      item.snippet.toLowerCase().includes(lower) ||
      (item.keywords || []).some(k => lower.includes(k))
    );
    return matches.slice(0, 3);
  }

  _getLocalKnowledge() {
    return [
      { title: 'JavaScript', snippet: '一种高级编程语言，广泛用于网页开发。', keywords: ['js', 'javascript', '网页', '编程语言'], source: 'local' },
      { title: 'Python', snippet: '一种解释型高级编程语言，以简洁易读著称，AI和数据分析领域最流行。', keywords: ['python', 'py', '人工智能', '数据分析'], source: 'local' },
      { title: 'TypeScript', snippet: 'JavaScript 的超集，添加了静态类型检查。', keywords: ['ts', 'typescript', '类型'], source: 'local' },
      { title: 'Electron', snippet: '使用 JavaScript、HTML 和 CSS 构建跨平台桌面应用的框架。', keywords: ['electron', '跨平台', '桌面'], source: 'local' },
      { title: 'Node.js', snippet: '基于 Chrome V8 引擎的 JavaScript 运行时环境。', keywords: ['node', 'nodejs', '运行时', '后端'], source: 'local' },
      { title: 'React', snippet: '用于构建用户界面的 JavaScript 库，由 Meta 维护。', keywords: ['react', '前端', 'ui', '界面'], source: 'local' },
      { title: 'Vue.js', snippet: '一款渐进式 JavaScript 框架，用于构建用户界面。', keywords: ['vue', 'vuejs', '前端'], source: 'local' },
      { title: 'AI', snippet: 'Artificial Intelligence — 人工智能，计算机科学的重要分支。', keywords: ['ai', '人工智能', 'artificial intelligence'], source: 'local' },
      { title: 'LLM', snippet: 'Large Language Model — 大语言模型，如 GPT、Claude、DeepSeek。', keywords: ['llm', '大语言模型', '大模型', 'gpt', 'claude', 'deepseek'], source: 'local' },
      { title: '机器学习', snippet: '人工智能的子领域，让系统从数据中学习和改进。', keywords: ['机器学习', 'machine learning', 'ml'], source: 'local' },
      { title: '深度学习', snippet: '机器学习的分支，使用多层神经网络处理复杂模式。', keywords: ['深度学习', 'deep learning', '神经网络', 'neural'], source: 'local' },
      { title: '区块链', snippet: '一种分布式账本技术，以比特币等加密货币闻名。', keywords: ['区块链', 'blockchain', '比特币', 'crypto'], source: 'local' },
      { title: '云计算', snippet: '通过互联网提供计算资源（服务器、存储、数据库等）的服务模式。', keywords: ['云计算', 'cloud', '云服务', 'aws', 'azure'], source: 'local' },
      { title: 'Docker', snippet: '容器化平台，让应用程序及其依赖打包在轻量级容器中运行。', keywords: ['docker', '容器', 'container'], source: 'local' },
      { title: 'Git', snippet: '分布式版本控制系统，广泛用于源代码管理。', keywords: ['git', 'github', '版本控制', '代码管理'], source: 'local' },
    ];
  }

  // ============================================================
  // 预设热点兜底（当所有网络后端都失败时使用）
  // ============================================================

  _trendingFallback() {
    const items = [
      { title: 'SpaceX 成功上市，首日市值突破万亿', snippet: '航天商业化的里程碑时刻', url: '', source: 'local' },
      { title: 'AI 芯片竞争白热化，多家厂商发布新一代产品', snippet: '科技巨头争夺AI算力高地', url: '', source: 'local' },
      { title: '全球气温持续升高，多国加速部署可再生能源', snippet: '气候行动成为各国优先议题', url: '', source: 'local' },
      { title: '新一代大语言模型发布，推理能力跃上新台阶', snippet: 'AI 能力持续突破瓶颈', url: '', source: 'local' },
      { title: '量子计算纠错技术取得关键突破', snippet: '实用化量子计算又近一步', url: '', source: 'local' },
      { title: '数字货币监管新规出台，多国协调推进', snippet: '全球加密资产监管框架日趋完善', url: '', source: 'local' },
      { title: '苹果发布下一代可穿戴设备，健康监测成焦点', snippet: '可穿戴设备市场持续增长', url: '', source: 'local' },
    ];
    return items;
  }

  // ============================================================
  // 去重与排序
  // ============================================================

  _dedupe(results, limit) {
    const seen = new Set();
    return results
      .filter(r => {
        if (!r.title) return false;
        const key = r.title.toLowerCase().replace(/[^a-z0-9一-鿿]/g, '').substring(0, 30);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, limit);
  }

  // ============================================================
  // 缓存
  // ============================================================

  _getCache(key) {
    if (!this.cache[key]) return null;
    if (Date.now() - this.cache[key].ts > this.cache[key].ttl) {
      delete this.cache[key];
      return null;
    }
    return this.cache[key].data;
  }

  _setCache(key, data, ttl) {
    this.cache[key] = { data, ts: Date.now(), ttl };
    this._saveCache();
  }

  _loadCache() {
    if (!this.cacheFile) return;
    try {
      if (fs.existsSync(this.cacheFile)) {
        this.cache = JSON.parse(fs.readFileSync(this.cacheFile, 'utf-8'));
      }
    } catch (e) {
      this.cache = {};
    }
  }

  _saveCache() {
    if (!this.cacheFile) return;
    try {
      fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache), 'utf-8');
    } catch (e) {
      // 静默失败
    }
  }

  // ============================================================
  // HTTP 工具（与 content-fetcher 保持一致）
  // ============================================================

  _httpGetJSON(url, opts = {}) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 6000);

      const proto = url.startsWith('https') ? https : http;
      try {
        const req = proto.get(url, { headers: opts.headers || {}, timeout: 5000 }, (res) => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            clearTimeout(timeout);
            resolve(null);
            return;
          }
          let data = '';
          res.on('data', (chunk) => data += chunk);
          res.on('end', () => {
            clearTimeout(timeout);
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve(null);
            }
          });
        });
        req.on('error', () => { clearTimeout(timeout); resolve(null); });
        req.on('timeout', () => { req.destroy(); clearTimeout(timeout); resolve(null); });
      } catch {
        clearTimeout(timeout);
        resolve(null);
      }
    });
  }
}

module.exports = WebSearch;
