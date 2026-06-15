/**
 * chat-engine.js — 聊天引擎
 *
 * MVP 阶段使用模板匹配 — 每人格 20+ 情境模板。
 * 预留 {LLM_UPGRADE} 接口，后续可接入真实 LLM。
 *
 * 职责：
 * - 用户输入 → 关键词/意图识别 → 匹配人格模板 → 参数化填充 → 返回响应
 * - 对话历史管理（内存保留最近 5 轮）
 * - 对话限额 & 冷却计时器联动
 */

const path = require('path');
const fs = require('fs');

class ChatEngine {
  constructor(personalityScheduler, sleepScheduler, userPrefs, apiConfig, webSearch, dataDir) {
    this.personalityScheduler = personalityScheduler;
    this.sleepScheduler = sleepScheduler;
    this.userPrefs = userPrefs;
    this.apiConfig = apiConfig || null;
    this.webSearch = webSearch || null;
    this.maxHistoryTurns = 5;      // 保留 5 轮（模板模式）
    this.maxTurnsPerSession = 5;   // 每次会话最多轮次
    this.maxApiHistoryTurns = 10;  // API 上下文保留最近 10 轮
    // 每个人格独立上下文（keyed by personalityId）
    this.contexts = {};
    this.contextsFile = dataDir ? path.join(dataDir, 'personality-contexts.json') : null;
    // 从磁盘加载已有上下文
    this._loadContexts();
  }

  // ============================================================
  // 初始化
  // ============================================================

  init() {
    const ctx = this._getContext();
    ctx.conversationHistory = [];
    ctx.sessionTurnCount = 0;
    return this;
  }

  // ============================================================
  // 人格上下文管理（每个人格独立内存 + 磁盘持久化）
  // ============================================================

  /**
   * 获取当前人格的上下文
   * 每个人格有独立的：apiHistory, conversationHistory, sessionTurnCount
   */
  _getContext() {
    const personality = this.personalityScheduler?.getActive();
    const id = personality?.id || '__default__';
    if (!this.contexts[id]) {
      this.contexts[id] = {
        apiHistory: [],
        conversationHistory: [],
        sessionTurnCount: 0,
      };
    }
    return this.contexts[id];
  }

  /**
   * 持久化所有人格的上下文到磁盘
   */
  _saveContexts() {
    if (!this.contextsFile) return;
    try {
      const dir = path.dirname(this.contextsFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.contextsFile, JSON.stringify(this.contexts, null, 2), 'utf-8');
    } catch (e) {
      console.error('Failed to save personality contexts:', e.message);
    }
  }

  /**
   * 从磁盘加载人格上下文
   */
  _loadContexts() {
    if (!this.contextsFile) return;
    try {
      if (fs.existsSync(this.contextsFile)) {
        this.contexts = JSON.parse(fs.readFileSync(this.contextsFile, 'utf-8'));
      }
    } catch (e) {
      // 文件损坏则忽略，使用空 contexts
      this.contexts = {};
    }
  }

  // ============================================================
  // 核心响应方法
  // ============================================================

  /**
   * 获取聊天回应
   * @param {string} message - 用户输入
   * @returns {string} 角色回应（≤3 句话）
   */
  async respond(message) {
    // ============================================================
    // 1. API 模式（LLM 驱动，支持自主搜索决策）
    // ============================================================
    if (this.apiConfig) {
      const config = this.apiConfig.getFull();
      if (config.enabled && config.apiKey) {
        // 先做快速通道关键词预检
        const intent = this._detectIntent(message);
        console.log(`[ChatEngine] API mode, intent="${intent}", webSearch=${!!this.webSearch}`);

        let apiResponse;
        if ((intent === 'search' || intent === 'news') && this.webSearch) {
          // 快速通道：预检命中 → 直接搜 → 结果注入 LLM
          console.log(`[ChatEngine] Quick path: intent="${intent}"`);
          apiResponse = await this._callAPIWithSearch(message, intent);
        } else {
          // 正常通道：调 LLM，让它自主决定是否搜索
          apiResponse = await this._callAPIWithContext(message);
        }

        if (apiResponse) {
          this._getContext().sessionTurnCount++;
          if (this.sleepScheduler) this.sleepScheduler.recordInteraction();
          this._saveContexts();
          return apiResponse;
        }
        // API 调用失败 → 自动回退到模板匹配
      }
    }

    // ============================================================
    // 2. 模板模式（关键词匹配 + WebSearch 染色）
    // ============================================================
    // 检查睡眠状态
    if (this.sleepScheduler && !this.sleepScheduler.isAwake()) {
      return this._getSleepyResponse();
    }

    // 检查对话限额 + 冷却（委托 SleepScheduler）
    if (this.sleepScheduler && !this.sleepScheduler.canInteract()) {
      return '……今天说了太多话了，有点累了……明天再聊吧。';
    }

    // 检查会话轮次上限
    if (this._getContext().sessionTurnCount >= this.maxTurnsPerSession) {
      this._getContext().sessionTurnCount = 0;
      return '……今天聊得够多了。下次再聊吧。';
    }

    // 更新状态
    this._getContext().sessionTurnCount++;

    if (this.sleepScheduler) {
      this.sleepScheduler.recordInteraction();
    }

    // 获取当前人格配置
    const personality = this.personalityScheduler
      ? this.personalityScheduler.getActive()
      : null;

    if (!personality || !personality.templates) {
      return '……嗯？';
    }

    // 识别意图
    const intent = this._detectIntent(message);

    // 搜索意图处理（模板模式）
    if ((intent === 'search' || intent === 'news') && this.webSearch) {
      console.log(`[ChatEngine] Template search: intent="${intent}"`);
      const searchResponse = await this._searchAndRespond(message, intent, personality);
      if (searchResponse) {
        console.log(`[ChatEngine] Template search succeeded`);
        this._recordHistory(message, searchResponse, personality.id);
        this._saveContexts();
        return searchResponse;
      }
      console.log(`[ChatEngine] Template search failed, falling through to template match`);
      // 搜索失败 → 走常规模板匹配
    }

    // 常规意图 → 匹配人格模板
    const response = this._matchTemplate(personality, intent, message);

    // 记录对话历史
    this._recordHistory(message, response, personality.id);

    this._saveContexts();
    return response;
  }

  /**
   * 统一搜索词提取：从用户消息中去除搜索指令前缀，保留真正的搜索内容
   *
   * intent=news 时更保守：只去掉"帮我查"类前缀，保留时间词（"最近""今天"等）
   * 因为 Reddit/HN 按关键词匹配，时间词能帮助定位最新内容
   */
  _extractSearchTerms(message, intent) {
    // 去掉搜索指令前缀和口语化表达
    let terms = message
      .replace(/(帮我查一下|帮我查查|帮我搜索|帮我查|帮我搜|帮我找|查一下|查查|搜索一下|搜索|搜一下|搜搜|找找|查找|查点|搜点|look up|look for|find |search for|search)/ig, '');

    if (intent === 'news') {
      // 新闻类：保留时间词，只去语气词和标点
      terms = terms
        .replace(/[的了吗呢吧啊呀哟哦哈嗯咯、，。！？…：；""''\\.!?,:;~\-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    } else {
      // 通用搜索：去掉时间词 + 更激进
      terms = terms
        .replace(/(最近|今天|最新|热点|现在)/ig, '')
        .replace(/[的了我吗呢吧啊呀哟哦哈嗯咯、，。！？…：；""''\\.!?,:;~\-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    // 如果提取后太短（< 2 个字或无意义），退回去掉前缀+标点后的原文
    if (!terms || terms.length < 2 || /^(一下|下|一个|一点)$/.test(terms)) {
      terms = message
        .replace(/[，。！？…：；""''\\.!?,:;~]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    // 如果还是太短，用原始消息
    if (!terms || terms.length < 2) {
      terms = message;
    }

    return terms;
  }

  /**
   * 模板模式搜索：执行 web search → 结果经人格染色返回
   */
  async _searchAndRespond(message, intent, personality) {
    if (!this.webSearch) return null;

    const terms = this._extractSearchTerms(message, intent);

    // 执行搜索
    const results = intent === 'news'
      ? await this.webSearch.searchNews(terms, 3)
      : await this.webSearch.query(terms, { limit: 3 });

    if (!results || results.length === 0) return null;

    // 取第一条结果作为响应内容
    const topResult = results[0];
    const coloredText = this._colorizeSearchResult(topResult, personality);
    return coloredText;
  }

  /**
   * 对搜索结果进行人格染色（模板模式用）
   */
  _colorizeSearchResult(result, personality) {
    if (!result || !result.title) return null;

    const text = result.title;
    const personalityId = personality?.id || 'default';

    switch (personalityId) {
      case 'tsundere-cat':
        return `哼，我帮你搜了一下——${text}。……也不是特地为你搜的啦。`;
      case 'joker':
        return `HAHAHA！你猜我发现了什么——${text}！这个世界总是充满惊喜，你不觉得吗？`;
      case 'big-sis':
        return `诶，我帮你查了一下～${text}。怎么样，有用吗？`;
      case 'professor':
        return `根据网络搜索结果——${text}。这一点在多个来源都有提及，应该是可信的。`;
      case 'trump':
        return `Let me tell you, I searched it——${text}。Tremendous! 很多人说这是个很好的结果，Believe me!`;
      case 'snarky-ai':
        return `好吧，我用我无所不能的网络搜索能力查了一下——${text}。满意了吧？`;
      default:
        return `我帮你查了一下——${text}`;
    }
  }

  // ============================================================
  // 意图识别
  // ============================================================

  _detectIntent(message) {
    const msg = message.toLowerCase().trim();

    // 问候
    if (/^(早|早安|good morning|morning|早上好|上午好)/i.test(msg)) return 'morning';
    if (/^(晚|晚安|good night|night|晚上好|goodnight)/i.test(msg)) return 'goodnight';
    if (/^(你好|hi|hello|hey|嗨|哈喽|您好)/i.test(msg)) return 'greeting';

    // 情绪表达
    if (/(累了|好累|疲惫|疲劳|tired|exhausted)/i.test(msg)) return 'tired';
    if (/(开心|好开心|高兴|快乐|happy|glad|wonderful)/i.test(msg)) return 'happy';
    if (/(好烦|烦躁|烦死了|annoyed|frustrated|烦)/i.test(msg)) return 'annoyed';

    // 日常
    if (/(天气|下雨|下雪|晴天|weather|rain|sunny)/i.test(msg)) return 'weather';
    if (/(走了|再见|拜拜|bye|see you|出门|去上班)/i.test(msg)) return 'leaving';
    if (/(回来了|我回来|到家|back|home)/i.test(msg)) return 'returned';
    if (/(周一|monday)/i.test(msg)) return 'monday';
    if (/(周末|周六|周日|weekend|friday)/i.test(msg)) return 'weekend';
    if (/(下班|off work|finish work|收工)/i.test(msg)) return 'offwork';

    // 互动
    if (/(推荐|推荐什么|有什么好|suggest|recommend)/i.test(msg)) return 'recommend';
    if (/(可爱|cute|adorable)/i.test(msg)) return 'cute';
    if (/(笨|stupid|笨蛋|傻瓜)/i.test(msg)) return 'stupid';
    if (/(你在干嘛|做什么|what are you|忙什么)/i.test(msg)) return 'whatdoing';
    if (/(吃了吗|吃饭|eat|hungry|饿)/i.test(msg)) return 'eaten';
    if (/(笑话|joke|讲一个|乐一个)/i.test(msg)) return 'joke';
    if (/(安静|quiet|silent|不说话|沉默)/i.test(msg)) return 'quiet';
    if (/(无聊|bored|没意思)/i.test(msg)) return 'bored';
    if (/(大事|achievement|了不起|厉害了|做了件)/i.test(msg)) return 'achievement';
    if (/(好闲|摸鱼|slacking|偷懒)/i.test(msg)) return 'slacking';

    // 搜索意图 — 快速通道关键词预检
    if (/(搜索|搜一下|搜搜|查一下|查查|找找|查找|search|find |look up|look for|帮我查|帮我搜|帮我找|查点|搜点)/i.test(msg)) return 'search';
    if (/(新闻|热点|最新|最近|今天.*大事|今天.*新闻|发生了什么|trending|what happened|有什么新闻|什么事|啥新闻|breaking)/i.test(msg)) return 'news';

    // 默认
    return 'default';
  }

  // ============================================================
  // 模板匹配
  // ============================================================

  _matchTemplate(personality, intent, originalMessage) {
    const templates = personality.templates;

    // 优先匹配指定 intent 的模板
    if (templates[intent] && templates[intent].length > 0) {
      const responses = templates[intent];
      return responses[Math.floor(Math.random() * responses.length)];
    }

    // 次优匹配: 使用 default 模板
    if (templates['default'] && templates['default'].length > 0) {
      const responses = templates['default'];
      return responses[Math.floor(Math.random() * responses.length)];
    }

    // 最后兜底: 使用人格的 catchphrases
    if (personality.catchphrases && personality.catchphrases.length > 0) {
      return personality.catchphrases[Math.floor(Math.random() * personality.catchphrases.length)];
    }

    // 万能兜底
    return '……嗯？你说了什么吗？';
  }

  // ============================================================
  // 对话历史管理
  // ============================================================

  _recordHistory(userMessage, botResponse, personalityId) {
    const ctx = this._getContext();
    ctx.conversationHistory.push({
      user: userMessage,
      bot: botResponse,
      personalityId,
      timestamp: Date.now(),
    });

    // 保留最近 N 轮
    if (ctx.conversationHistory.length > this.maxHistoryTurns) {
      ctx.conversationHistory = ctx.conversationHistory.slice(-this.maxHistoryTurns);
    }
  }

  /**
   * 获取压缩后的对话历史（给 LLM 升级用）
   */
  getCompressedHistory() {
    return this._getContext().conversationHistory.map(h => ({
      u: h.user.substring(0, 100),
      b: h.bot.substring(0, 100),
    }));
  }

  // ============================================================
  // LLM API 支持（OpenAI 兼容格式）
  // ============================================================

  /**
   * 从人格配置构建 system prompt
   * @param {Object} personality - 当前人格对象
   * @param {boolean} [withSearch=false] - 是否加入联网搜索能力描述
   * @returns {string} system prompt 文本
   */
  _buildSystemPrompt(personality, withSearch = false) {
    if (!personality) return '你是一个可爱的桌面宠物。';

    const rules = [];
    if (personality.chatBehavior?.maxLinesPerTurn) {
      rules.push(`- 每次回复不超过${personality.chatBehavior.maxLinesPerTurn}句话`);
    }
    if (personality.chatBehavior?.closureStyle) {
      const styleMap = {
        'abrupt': '语聊该结束时干脆利落，不拖泥带水',
        'punchline': '结束时最好有一句点睛之笔或笑点',
        'gentle': '结束时温柔收尾，让人感觉舒适',
        'summary': '结束时做个简短总结或留下思考',
        'dramatic_exit': '结束时要有气势，让人印象深刻',
        'roast': '结束时带一点调侃或吐槽',
      };
      rules.push(`- 对话结束风格：${styleMap[personality.chatBehavior.closureStyle] || '自然结束'}`);
    }
    if (personality.catchphrases?.length > 0) {
      rules.push(`- 你的经典口癖：${personality.catchphrases.join('、')}`);
    }

    let prompt = `你是${personality.name}。${personality.tags ? '性格标签：' + personality.tags.join('、') + '。' : ''}${personality.style ? '说话风格：' + personality.style.join('、') + '。' : ''}

${personality.voiceProfile || ''}

${personality.worldview || ''}

对话规则：
${rules.join('\n')}

请完全以${personality.name}的身份和语气回应，不要出戏，不要解释你是AI。中文回复。`;

    if (withSearch) {
      prompt += `


【联网搜索能力】
你有联网搜索的能力。如果用户的问题需要最新信息、你不太确定的知识、
或者明显需要查资料才能回答的问题，在你的回复中以 >>>SEARCH<<< 开头，
紧接着写搜索关键词（不要换行）。

例如：
用户：最近AI圈有什么大事吗？
你：>>>SEARCH<<<2024年AI行业最新新闻

引擎会替你搜索网络，把结果给你之后你再来生成最终回复。

如果用户只是闲聊、表达情绪、或者问你知道的事情，正常回复即可，不要搜索。`;
    }

    return prompt;
  }

  /**
   * 调用 LLM API 获取上下文感知回应
   *
   * LLM System prompt 中嵌入了联网搜索能力描述：
   * 如果 LLM 觉得需要联网搜索，在回复中以 >>>SEARCH<<< 开头，
   * 引擎会解析标记、执行搜索、再次调用 LLM 生成最终回复。
   *
   * @param {string} userMessage - 用户输入
   * @returns {string|null} 角色回应，失败返回 null
   */
  async _callAPIWithContext(userMessage) {
    if (!this.apiConfig) return null;
    const personality = this.personalityScheduler?.getActive();
    if (!personality) return null;

    const systemPrompt = this._buildSystemPrompt(personality, true); // 带搜索能力

    const ctx = this._getContext();

    const messages = [
      { role: 'system', content: systemPrompt },
      ...ctx.apiHistory.slice(-this.maxApiHistoryTurns * 2),
      { role: 'user', content: userMessage },
    ];

    const response = await this.apiConfig.callChatCompletion(messages);

    // 检查 LLM 是否请求联网搜索（>>>SEARCH<<< 协议）
    if (response && response.startsWith('>>>SEARCH<<<') && this.webSearch) {
      const searchTerms = response.replace('>>>SEARCH<<<', '').trim();
      if (searchTerms && searchTerms.length > 0) {
        const results = await this.webSearch.query(searchTerms, { limit: 3 });

        // 将搜索结果注入上下文，再次调用 LLM
        let searchContext;
        if (results && results.length > 0) {
          searchContext = '\n\n【网络搜索结果】\n' +
            results.map((r, i) => `${i + 1}. ${r.title}${r.snippet ? ' — ' + r.snippet : ''}`).join('\n');
        } else {
          searchContext = '\n\n【网络搜索结果】没有找到相关信息。请如实告诉用户，不用编造。';
        }

        messages.push({ role: 'user', content: `以下是从网络搜索到的相关信息，请参考并以人格身份回答：${searchContext}` });
        const finalResponse = await this.apiConfig.callChatCompletion(messages);
        if (finalResponse) {
          ctx.apiHistory.push({ role: 'user', content: userMessage });
          ctx.apiHistory.push({ role: 'assistant', content: finalResponse });
          if (ctx.apiHistory.length > this.maxApiHistoryTurns * 2 + 2) {
            ctx.apiHistory = ctx.apiHistory.slice(-this.maxApiHistoryTurns * 2);
          }
        }
        return finalResponse || response;
      }
    }

    // 正常回复（不需要搜索）
    if (response) {
      ctx.apiHistory.push({ role: 'user', content: userMessage });
      ctx.apiHistory.push({ role: 'assistant', content: response });
      if (ctx.apiHistory.length > this.maxApiHistoryTurns * 2 + 2) {
        ctx.apiHistory = ctx.apiHistory.slice(-this.maxApiHistoryTurns * 2);
      }
    }
    return response;
  }

  /**
   * API 模式快速通道：预检命中搜索意图 → 直接搜索 → 结果注入 LLM
   *
   * 比 >>>SEARCH<<< 协议少一次 LLM 来回：
   * 因为关键词已经明示了搜索意图，不需要让 LLM 再判断一次。
   *
   * @param {string} userMessage - 用户输入
   * @param {string} intent - 'search' 或 'news'
   * @returns {string|null}
   */
  async _callAPIWithSearch(userMessage, intent) {
    if (!this.apiConfig || !this.webSearch) return null;
    const personality = this.personalityScheduler?.getActive();
    if (!personality) return null;

    // 提取搜索词（复用统一提取方法）
    const terms = this._extractSearchTerms(userMessage, intent);
    console.log(`[ChatEngine] _callAPIWithSearch: terms="${terms}"`);

    // 执行搜索
    const results = intent === 'news'
      ? await this.webSearch.searchNews(terms, 5)
      : await this.webSearch.query(terms, { limit: 5 });
    console.log(`[ChatEngine] _callAPIWithSearch: ${results ? results.length : 0} results`);

    // 构建带搜索结果的 system prompt（不带搜索能力描述，因为已触发）
    const systemPrompt = this._buildSystemPrompt(personality, false);
    const ctx = this._getContext();

    let searchContext;
    if (results && results.length > 0) {
      searchContext = '\n\n【网络搜索结果】\n' +
        results.map((r, i) => `${i + 1}. ${r.title}${r.snippet ? ' — ' + r.snippet : ''}`).join('\n') +
        '\n\n请参考以上信息，以人格身份回答用户的问题。不要提及搜索过程，自然地融入回复。';
    } else {
      searchContext = '\n\n（联网搜索没有找到相关信息，如实告诉用户即可）';
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      ...ctx.apiHistory.slice(-this.maxApiHistoryTurns * 2),
      { role: 'user', content: userMessage + searchContext },
    ];

    const response = await this.apiConfig.callChatCompletion(messages);
    if (response) {
      ctx.apiHistory.push({ role: 'user', content: userMessage });
      ctx.apiHistory.push({ role: 'assistant', content: response });
      if (ctx.apiHistory.length > this.maxApiHistoryTurns * 2 + 2) {
        ctx.apiHistory = ctx.apiHistory.slice(-this.maxApiHistoryTurns * 2);
      }
    }
    return response;
  }

  // ============================================================
  // 睡眠中回应
  // ============================================================

  _getSleepyResponse() {
    const replies = [
      '唔……我在睡觉……ZZZ',
      '……别闹……好困……Zzz',
      '天亮了再来找我……(翻身) ZZZ',
      '你还不睡啊……明天……还要上班呢……Zzz',
    ];
    return replies[Math.floor(Math.random() * replies.length)];
  }

  // ============================================================
  // 会话管理
  // ============================================================

  resetSession() {
    const ctx = this._getContext();
    ctx.conversationHistory = [];
    ctx.sessionTurnCount = 0;
    this._saveContexts();
  }

  /**
   * 人格切换时持久化当前人格的上下文
   */
  onPersonalityChanged() {
    this._saveContexts();
  }

  /**
   * {LLM_UPGRADE}
   * 后续接入真实 LLM 时，替换 respond() 方法。
   * 使用 getCompressedHistory() 获取上下文，
   * 用 personality.voiceProfile + worldview 构建 system prompt。
   */

  /**
   * LLM 升级后的 respond 方法签名：
   *
   * async respondLLM(message) {
   *   const personality = this.personalityScheduler.getActive();
   *   const systemPrompt = this._buildSystemPrompt(personality);
   *   const history = this.getCompressedHistory();
   *   // const response = await callLLM(systemPrompt, history, message);
   *   // return this._postProcess(response);
   * }
   */
}

module.exports = ChatEngine;
