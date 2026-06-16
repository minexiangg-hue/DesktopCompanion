/**
 * web-search.js — 网络搜索模块 (Brave Search API)
 *
 * 使用 Brave Search API 作为主后端，中英文通用。
 * 被 ContentFetcher（每日惊喜）和 ChatEngine（聊天搜索）共用。
 *
 * 后端：
 *   - Brave Web Search   — 通用网页搜索
 *   - Brave News Search   — 新闻实时搜索
 *   - 本地知识库           — 网络不可用时的兜底
 *
 * 使用方式：
 *   const ws = new WebSearch(dataDir, braveApiKey);
 *   const results = await ws.query('人工智能');
 *   const hot = await ws.trending();
 *   const news = await ws.searchNews('AI', 5);
 */

const https = require('https');
const path = require('path');
const fs = require('fs');

// ============================================================
// Brave Search API 常量
// ============================================================
const BRAVE_WEB_API = 'https://api.search.brave.com/res/v1/web/search';
const BRAVE_NEWS_API = 'https://api.search.brave.com/res/v1/news/search';

class WebSearch {
  constructor(dataDir, braveApiKey) {
    this.dataDir = dataDir;
    this.braveApiKey = braveApiKey || '';
    this.cacheFile = dataDir ? path.join(dataDir, 'search-cache.json') : null;
    this.cache = {};
    this._loadCache();
  }

  // ============================================================
  // 公开方法
  // ============================================================

  /**
   * 通用搜索 — Brave Web Search
   * @param {string} terms - 搜索词
   * @param {object} [opts] - { limit: 5, freshness: 'pw'|'pm'|'py' }
   * @returns {Promise<Array<{title, snippet, url, source}>>}
   */
  async query(terms, opts = {}) {
    const limit = opts.limit || 5;

    if (!terms || !terms.trim()) {
      return this.trending({ limit });
    }

    // 检查缓存
    const cacheKey = `query:${terms.toLowerCase().trim()}`;
    const cached = this._getCache(cacheKey);
    if (cached) return cached;

    let results = [];

    if (this.braveApiKey) {
      const params = new URLSearchParams({
        q: terms,
        count: String(Math.min(limit + 2, 10)),
        search_lang: this._hasChinese(terms) ? 'zh' : 'en',
      });
      if (opts.freshness) params.set('freshness', opts.freshness);

      const data = await this._braveGet(`${BRAVE_WEB_API}?${params}`);
      if (data?.web?.results) {
        results = data.web.results.map(r => ({
          title: r.title || '',
          snippet: r.description || '',
          url: r.url || '',
          source: 'brave',
        })).filter(r => r.title);
      }
    }

    // 网络不可用 → 本地知识库 → 热点兜底
    if (results.length === 0) {
      const local = this._searchLocal(terms);
      results.push(...local);
      if (results.length === 0) {
        results.push(...this._trendingFallback());
      }
    }

    const deduped = this._dedupe(results, limit);
    this._setCache(cacheKey, deduped, 10 * 60 * 1000);
    return deduped;
  }

  /**
   * 热门话题 — Brave News Search（无搜索词时）
   * @param {object} [opts] - { limit: 5 }
   */
  async trending(opts = {}) {
    const limit = opts.limit || 5;

    const cached = this._getCache('trending');
    if (cached) return cached;

    let results = [];

    if (this.braveApiKey) {
      const params = new URLSearchParams({
        q: 'top news',
        count: String(Math.min(limit + 2, 10)),
        freshness: 'pd',
      });
      const data = await this._braveGet(`${BRAVE_NEWS_API}?${params}`);
      if (data?.results) {
        results = data.results.map(r => ({
          title: r.title || '',
          snippet: r.description || '',
          url: r.url || '',
          source: 'brave-news',
        })).filter(r => r.title);
      }
    }

    if (results.length === 0) {
      results.push(...this._trendingFallback());
    }

    const deduped = this._dedupe(results, limit);
    this._setCache('trending', deduped, 30 * 60 * 1000);
    return deduped;
  }

  /**
   * 新闻搜索 — Brave News Search（时间优先）
   * @param {string} terms - 搜索词
   * @param {number} [limit=5]
   */
  async searchNews(terms, limit = 5) {
    if (!terms || !terms.trim()) return this.trending({ limit });

    const cacheKey = `news:${terms.toLowerCase().trim()}`;
    const cached = this._getCache(cacheKey);
    if (cached) return cached;

    let results = [];

    if (this.braveApiKey) {
      const params = new URLSearchParams({
        q: terms,
        count: String(Math.min(limit + 2, 10)),
        freshness: 'pd',  // past day
      });
      const data = await this._braveGet(`${BRAVE_NEWS_API}?${params}`);
      if (data?.results) {
        results = data.results.map(r => ({
          title: r.title || '',
          snippet: r.description || '',
          url: r.url || '',
          source: 'brave-news',
        })).filter(r => r.title);
      }
    }

    if (results.length === 0) {
      // 新闻无本地知识库，直接热点兜底
      results.push(...this._trendingFallback());
    }

    const deduped = this._dedupe(results, limit);
    this._setCache(cacheKey, deduped, 3 * 60 * 1000);
    return deduped;
  }

  // ============================================================
  // Brave Search HTTP 调用
  // ============================================================

  async _braveGet(url) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 8000);

      try {
        const parsed = new URL(url);
        const options = {
          hostname: parsed.hostname,
          port: 443,
          path: parsed.pathname + parsed.search,
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'X-Subscription-Token': this.braveApiKey,
          },
          timeout: 6000,
        };

        const req = https.request(options, (res) => {
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
        req.end();
      } catch {
        clearTimeout(timeout);
        resolve(null);
      }
    });
  }

  // ============================================================
  // 本地知识库（兜底 — 网络完全不可用时）
  // ============================================================

  _searchLocal(terms) {
    const lower = terms.toLowerCase();
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
      { title: 'AI', snippet: 'Artificial Intelligence — 人工智能，计算机科学的重要分支。', keywords: ['ai', '人工智能', 'artificial intelligence'], source: 'local' },
      { title: 'LLM', snippet: 'Large Language Model — 大语言模型，如 GPT、Claude、DeepSeek。', keywords: ['llm', '大语言模型', '大模型', 'gpt', 'claude', 'deepseek'], source: 'local' },
      { title: '机器学习', snippet: '人工智能的子领域，让系统从数据中学习和改进。', keywords: ['机器学习', 'machine learning', 'ml'], source: 'local' },
      { title: '深度学习', snippet: '机器学习的分支，使用多层神经网络处理复杂模式。', keywords: ['深度学习', 'deep learning', '神经网络', 'neural'], source: 'local' },
      { title: '区块链', snippet: '一种分布式账本技术，以比特币等加密货币闻名。', keywords: ['区块链', 'blockchain', '比特币', 'crypto'], source: 'local' },
      { title: '云计算', snippet: '通过互联网提供计算资源（服务器、存储、数据库等）的服务模式。', keywords: ['云计算', 'cloud', '云服务', 'aws', 'azure'], source: 'local' },
      { title: 'Docker', snippet: '容器化平台，让应用程序及其依赖打包在轻量级容器中运行。', keywords: ['docker', '容器', 'container'], source: 'local' },
      { title: 'Git', snippet: '分布式版本控制系统，广泛用于源代码管理。', keywords: ['git', 'github', '版本控制', '代码管理'], source: 'local' },
      { title: '量子计算', snippet: '利用量子力学原理进行计算的新型计算范式，有望在特定问题上超越经典计算机。', keywords: ['量子', 'quantum', '量子计算机', '量子比特', 'qubit'], source: 'local' },
    ];
  }

  // ============================================================
  // 兜底热点
  // ============================================================

  _trendingFallback() {
    const items = [
      { title: 'SpaceX 成功发射新一代星舰', snippet: '航天商业化的里程碑时刻', url: '', source: 'local' },
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
  // 工具方法
  // ============================================================

  _hasChinese(text) {
    return /[一-鿿]/.test(text);
  }

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
}

module.exports = WebSearch;
