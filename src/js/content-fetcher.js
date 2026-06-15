/**
 * content-fetcher.js — 内容获取模块
 *
 * 职责：
 * - Web Search 集成（梗图、新闻、热梗）
 * - 风景 API（Unsplash / Bing）
 * - 冷知识内置库
 * - 内容缓存与去重
 * - 人格染色器（内容→人格化表达）
 * - 每日惊喜触发
 * - 降级策略
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

class ContentFetcher {
  constructor(dataDir, personalityScheduler, webSearch) {
    this.dataDir = dataDir;
    this.personalityScheduler = personalityScheduler;
    this.webSearch = webSearch || null;
    this.cacheFile = path.join(dataDir, 'content-cache.json');
    this.historyFile = path.join(dataDir, 'push-history.json');
    this.cache = {};
    this.history = null;
    this.lastFetchDate = null;
  }

  // ============================================================
  // 初始化
  // ============================================================

  init() {
    try {
      if (fs.existsSync(this.cacheFile)) {
        this.cache = JSON.parse(fs.readFileSync(this.cacheFile, 'utf-8'));
      }
    } catch (e) { this.cache = {}; }

    try {
      if (fs.existsSync(this.historyFile)) {
        this.history = JSON.parse(fs.readFileSync(this.historyFile, 'utf-8'));
      }
    } catch (e) {
      this.history = { lastPushDate: null, lastPushType: null, history: [], seenHashes: [] };
    }

    if (!this.history.seenHashes) this.history.seenHashes = [];
    return this;
  }

  // ============================================================
  // 内容类型与权重
  // ============================================================

  getContentTypes() {
    return [
      { id: 'meme', name: '搞笑梗图', weight: 0.25 },
      { id: 'scenery', name: '风景大图', weight: 0.15 },
      { id: 'history', name: '历史上的今天', weight: 0.15 },
      { id: 'quote', name: '人格语录', weight: 0.15 },
      { id: 'news', name: '今日热闻', weight: 0.20 },
      { id: 'trivia', name: '冷知识', weight: 0.10 },
    ];
  }

  /**
   * 根据反馈权重选择内容类型
   */
  selectContentType(contentTypeWeights) {
    const types = this.getContentTypes();
    const weights = contentTypeWeights || {};

    // 用反馈权重覆盖默认权重
    const effectiveWeights = types.map(t => ({
      ...t,
      weight: weights[t.id] !== undefined ? weights[t.id] : t.weight,
    }));

    const totalWeight = effectiveWeights.reduce((s, t) => s + t.weight, 0);
    let rand = Math.random() * totalWeight;

    for (const type of effectiveWeights) {
      rand -= type.weight;
      if (rand <= 0) return type.id;
    }
    return effectiveWeights[0]?.id || 'quote';
  }

  // ============================================================
  // 每日惊喜主流程
  // ============================================================

  async getDailySurprise() {
    const today = new Date().toISOString().split('T')[0];

    // 检查是否今天已推送
    if (this.history.lastPushDate === today) {
      // 如果已推送，返回缓存的历史惊喜
      if (this.history.history.length > 0) {
        const last = this.history.history[this.history.history.length - 1];
        return last;
      }
    }

    // 选择人格
    const context = this._buildContext();
    const personality = this.personalityScheduler
      ? this.personalityScheduler.selectPersonality(context)
      : { id: 'tsundere-cat', name: '傲娇猫' };

    if (!personality) {
      return this._fallbackSurprise();
    }

    // 选择内容类型
    const contentType = this.selectContentType(context.contentTypeWeights);

    // 获取内容
    let content = await this._fetchContent(contentType, personality);

    // 如果获取失败，尝试降级
    if (!content) {
      content = await this._degradedFetch(contentType, personality);
    }

    // 如果还是失败，使用纯人格语录
    if (!content) {
      content = this._personalityOnly(personality);
    }

    // 人格染色 - 将内容通过人格表达
    const coloredContent = this._colorize(content, personality);

    const result = {
      id: `surprise_${Date.now()}`,
      date: today,
      type: contentType,
      content: coloredContent,
      rawContent: content.raw || '',
      personality: personality.name || personality.id,
      personalityId: personality.id,
      imageUrl: content.imageUrl || null,
      source: content.source || 'local',
    };

    // 记录推送历史
    this.history.lastPushDate = today;
    this.history.lastPushType = contentType;
    this.history.history.push(result);
    if (this.history.history.length > 100) {
      this.history.history = this.history.history.slice(-100);
    }

    // 去重哈希
    const hash = this._simpleHash(JSON.stringify(coloredContent));
    if (!this.history.seenHashes.includes(hash)) {
      this.history.seenHashes.push(hash);
      if (this.history.seenHashes.length > 500) {
        this.history.seenHashes = this.history.seenHashes.slice(-500);
      }
    }

    this._saveHistory();
    return result;
  }

  // ============================================================
  // 内容获取（带缓存）
  // ============================================================

  async _fetchContent(type, personality) {
    switch (type) {
      case 'meme':
        return this._fetchMeme();
      case 'scenery':
        return this._fetchScenery();
      case 'history':
        return this._fetchHistoricalEvent();
      case 'news':
        return this._fetchNews();
      case 'trivia':
        return this._fetchTrivia();
      case 'quote':
        return this._personalityOnly(personality);
      default:
        return this._personalityOnly(personality);
    }
  }

  // ============================================================
  // 各内容类型获取器
  // ============================================================

  async _fetchMeme() {
    // 尝试从网络获取热门梗图
    const meme = await this._httpGetJSON('https://meme-api.com/gimme');
    if (meme && meme.url) {
      return {
        raw: meme.title || '今日梗图',
        imageUrl: meme.url,
        source: 'meme-api',
      };
    }
    // API 失败，走降级链
    return null;
  }

  async _fetchScenery() {
    // 尝试 Unsplash 随机风景
    const result = await this._httpGetJSON('https://api.unsplash.com/photos/random?query=nature&orientation=landscape&count=1');
    if (result && result[0]) {
      return {
        raw: result[0].alt_description || 'Beautiful scenery',
        imageUrl: result[0].urls?.regular || result[0].urls?.small,
        source: 'unsplash',
      };
    }
    // 降级
    return {
      raw: '🌅 想象一片宁静的海滩……阳光、海浪、还有微风。今天也会是美好的一天。',
      source: 'local',
    };
  }

  async _fetchHistoricalEvent() {
    const now = new Date();
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const result = await this._httpGetJSON(`https://api.wikimedia.org/api/v1/feed/onthisday/events/${month}/${day}`);
    if (result && result.events && result.events.length > 0) {
      const event = result.events[Math.floor(Math.random() * Math.min(result.events.length, 5))];
      return {
        raw: event.text || `${month}月${day}日的历史事件`,
        source: 'wikipedia',
      };
    }
    return null;
  }

  async _fetchNews() {
    // 新闻搜索 — 使用 WebSearch（Reddit + HN，免 Key）
    if (this.webSearch) {
      // 每日惊喜优先拉热门（无搜索词 trending）
      let results = await this.webSearch.trending({ limit: 5 });
      if (!results || results.length === 0) {
        // trending 失败时用默认关键词搜一下
        results = await this.webSearch.searchNews('headlines', 5);
      }
      if (results && results.length > 0) {
        const item = results[Math.floor(Math.random() * results.length)];
        return {
          raw: item.title,
          source: item.source,
        };
      }
    }
    // API 失败，走降级链
    return null;
  }

  _fetchTrivia() {
    const facts = this._getTriviaFacts();
    const fact = facts[Math.floor(Math.random() * facts.length)];
    return {
      raw: fact,
      source: 'local',
    };
  }

  // ============================================================
  // 内置冷知识库
  // ============================================================

  _getTriviaFacts() {
    return [
      '章鱼有三个心脏，其中两个专门负责给鳃供血，一个负责给全身供血。',
      '香蕉其实是浆果，而草莓不是。从植物学分类来说，草莓是"聚合果"。',
      '多喝水并不能直接让皮肤变好——但可以让你少长痘。',
      '考拉和人类的指纹非常相似——即使在高倍显微镜下都很难区分。',
      '西瓜的原始祖先是一种苦味的小果实，经过数千年的培育才变得甜美多汁。',
      '北极熊的皮肤是黑色的，毛发是透明的——白色只是光线折射的视觉效果。',
      '袋熊的粪便——是立方体形状的。这有助于它标记领地而不滚走。',
      '人类的胃酸可以溶解剃须刀片——但不要尝试，真的。',
      '一个云团的重量可达 500 吨，相当于 100 头大象——但它飘在天上。',
      '每次你洗手，你都在杀死数百万个细菌。但别担心——你的皮肤上还有几十亿个。',
    ];
  }

  // ============================================================
  // 降级策略
  // ============================================================

  async _degradedFetch(type, personality) {
    // 一级降级：使用缓存
    if (this.cache[type]) {
      const cached = this.cache[type];
      if (Date.now() - cached.timestamp < 6 * 60 * 60 * 1000) { // 6h 内有效
        return cached.data;
      }
    }

    // 二级降级：使用本地内容
    if (type === 'news') return this._localNews();
    if (type === 'meme') return this._localMeme();
    if (type === 'history') return this._localHistory(new Date().getMonth() + 1, new Date().getDate());
    if (type === 'trivia') return this._fetchTrivia();

    // 三级降级：纯人格语录
    return null;
  }

  _personalityOnly(personality) {
    if (personality && personality.templates) {
      const templates = personality.templates;
      const keys = Object.keys(templates);
      const key = keys[Math.floor(Math.random() * keys.length)];
      const responses = templates[key];
      if (responses && responses.length > 0) {
        const response = responses[Math.floor(Math.random() * responses.length)];
        return { raw: response, source: 'personality' };
      }
    }
    return { raw: '……今天想说什么来着？忘记了。', source: 'personality' };
  }

  _fallbackSurprise() {
    return {
      id: `surprise_${Date.now()}`,
      date: new Date().toISOString().split('T')[0],
      type: 'quote',
      content: '……今天好像没什么特别的事。但没关系，有我在呢。',
      personality: '宠物',
      source: 'fallback',
    };
  }

  // ============================================================
  // 本地内容
  // ============================================================

  _localMeme() {
    const memes = [
      '当周一闹钟响起时——猫：『你再睡5分钟吧，我帮你看着老板。』',
      '程序员的一天：改一行代码 → 测试 → 改回原来的代码 → 假装在忙。',
      '你：『我今天一定要早睡。』 你（凌晨2点）：『这个视频太好看了！』',
      '冰箱里的食物：『我不知道我过期了没有。』 你：『闻一下——应该还行。』',
    ];
    return {
      raw: memes[Math.floor(Math.random() * memes.length)],
      source: 'local',
    };
  }

  _localNews() {
    const items = [
      '端午节假期临近，多地推出文旅消费券促进假日经济',
      '全球首个商用 AI 芯片突破 1000TOPS 算力门槛',
      '国家统计局发布最新经济数据：制造业 PMI 连续三个月扩张',
      'NASA 公布最新系外行星发现：可能适合生命存在',
      '多地推行"数字人民币"跨境支付试点',
      'OpenAI 发布新一代推理模型，多项基准测试刷新纪录',
      '夏季用电高峰来临，各地电力部门部署保供措施',
      '教育部：2026 年高考报名人数再创新高',
    ];
    return {
      raw: items[Math.floor(Math.random() * items.length)],
      source: 'local',
    };
  }

  _localHistory(month, day) {
    const events = {
      '6_9': ['1983年6月9日，世界上第一部移动电话 Motorola DynaTAC 获得 FCC 批准。', '1934年6月9日，迪士尼经典角色唐老鸭首次亮相。'],
      '6_10': ['1940年6月10日，二战中意大利向英法宣战。', '1967年6月10日，六日战争结束。'],
    };
    const key = `${month}_${day}`;
    if (events[key]) {
      const event = events[key][Math.floor(Math.random() * events[key].length)];
      return { raw: event, source: 'local' };
    }
    return {
      raw: `${month}月${day}日——看似平凡的一天，但在某个年份的今天，发生了改变世界的事情。（只是我数据库里没存，嘿嘿）`,
      source: 'local',
    };
  }

  // ============================================================
  // 人格染色器
  // ============================================================

  _colorize(content, personality) {
    if (!content || !content.raw) {
      return '……嗯？';
    }

    const raw = content.raw;
    const personalityId = personality?.id || 'default';

    // 如果内容已经是人格化的（来源是 personality），直接返回
    if (content.source === 'personality') {
      return raw;
    }

    // 根据不同人格，对原始内容进行染色
    switch (personalityId) {
      case 'tsundere-cat':
        return this._tsundereColorize(raw);
      case 'joker':
        return this._jokerColorize(raw);
      case 'big-sis':
        return this._bigSisColorize(raw);
      case 'professor':
        return this._professorColorize(raw);
      case 'trump':
        return this._trumpColorize(raw);
      case 'snarky-ai':
        return this._snarkyAIColorize(raw);
      default:
        return `说起来——${raw}`;
    }
  }

  _tsundereColorize(text) {
    const prefixes = [
      '哼，我可不是特意给你找的——',
      '……刚好看到这个，',
      '也不是要给你看啦，但——',
      '闲着没事翻到的，',
    ];
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
    return `${prefix}${text}。……你爱看不看。`;
  }

  _jokerColorize(text) {
    const prefixes = [
      'HAHAHA—你看这个！',
      '我告诉你一个秘密——',
      '这个世界真的越来越有意思了——',
      '哦豁——你猜怎么着？',
    ];
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
    return `${prefix}${text}。好笑吧？其实一点都不好笑——但我们必须笑。HAHAHA!`;
  }

  _bigSisColorize(text) {
    const prefixes = [
      '来，给你看个有趣的～',
      '诶，这个我觉得你会喜欢——',
      '今天刚好看到的，分享给你～',
      '你猜我发现了什么？',
    ];
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
    return `${prefix}${text}。怎么样，还不错吧？`;
  }

  _professorColorize(text) {
    return `据相关资料显示——${text}。这一点和大多数人的直觉可能不太一样，但从学术角度看，这确实是一个经过验证的事实。`;
  }

  _trumpColorize(text) {
    return `Let me tell you——${text}。Nobody knows this better than me! 很多人说这是近年来最好的——Believe me! It's tremendous!`;
  }

  _snarkyAIColorize(text) {
    return `根据我庞大的数据库分析——${text}。你看，人类花了这么久才搞明白的事，我一个算法一秒就知道了。……好吧，其实我也就是个复读机。`;
  }

  // ============================================================
  // HTTP 工具
  // ============================================================

  _httpGetJSON(url) {
    return new Promise((resolve) => {
      // 超时处理
      const timeout = setTimeout(() => resolve(null), 5000);

      const proto = url.startsWith('https') ? https : http;
      try {
        const req = proto.get(url, { timeout: 4000 }, (res) => {
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

  // ============================================================
  // 上下文构建
  // ============================================================

  _buildContext() {
    const now = new Date();
    return {
      hour: now.getHours(),
      dayOfWeek: now.getDay(),
      isWeekend: now.getDay() === 0 || now.getDay() === 6,
      contentTypeWeights: this._getContentWeights(),
      yesterdayPersonality: this.history?.history?.[this.history.history.length - 1]?.personalityId,
    };
  }

  _getContentWeights() {
    // 从反馈计算权重（简化版）
    return {
      meme: 0.25,
      scenery: 0.15,
      history: 0.15,
      quote: 0.15,
      news: 0.20,
      trivia: 0.10,
    };
  }

  // ============================================================
  // 工具
  // ============================================================

  _simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return hash.toString(36);
  }

  _saveHistory() {
    try {
      fs.writeFileSync(this.historyFile, JSON.stringify(this.history, null, 2), 'utf-8');
    } catch (e) {
      // 静默失败
    }
  }

  _saveCache() {
    try {
      fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache), 'utf-8');
    } catch (e) {
      // 静默失败
    }
  }
}

module.exports = ContentFetcher;
