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

class ChatEngine {
  constructor(personalityScheduler, sleepScheduler, userPrefs) {
    this.personalityScheduler = personalityScheduler;
    this.sleepScheduler = sleepScheduler;
    this.userPrefs = userPrefs;
    this.conversationHistory = []; // 当前会话历史（内存中）
    this.maxHistoryTurns = 5;      // 保留 5 轮
    this.sessionTurnCount = 0;
    this.maxTurnsPerSession = 5;
  }

  // ============================================================
  // 初始化
  // ============================================================

  init() {
    this.conversationHistory = [];
    this.sessionTurnCount = 0;
    return this;
  }

  // ============================================================
  // 核心响应方法
  // ============================================================

  /**
   * 获取聊天回应
   * @param {string} message - 用户输入
   * @returns {string} 角色回应（≤3 句话）
   */
  respond(message) {
    // 检查睡眠状态
    if (this.sleepScheduler && !this.sleepScheduler.isAwake()) {
      return this._getSleepyResponse();
    }

    // 检查对话限额 + 冷却（委托 SleepScheduler）
    if (this.sleepScheduler && !this.sleepScheduler.canInteract()) {
      return '……今天说了太多话了，有点累了……明天再聊吧。';
    }

    // 检查会话轮次上限
    if (this.sessionTurnCount >= this.maxTurnsPerSession) {
      this.sessionTurnCount = 0;
      return '……今天聊得够多了。下次再聊吧。';
    }

    // 更新状态
    this.sessionTurnCount++;

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

    // 查找匹配的人格模板
    const response = this._matchTemplate(personality, intent, message);

    // 记录对话历史
    this._recordHistory(message, response, personality.id);

    return response;
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
    this.conversationHistory.push({
      user: userMessage,
      bot: botResponse,
      personalityId,
      timestamp: Date.now(),
    });

    // 保留最近 N 轮
    if (this.conversationHistory.length > this.maxHistoryTurns) {
      this.conversationHistory = this.conversationHistory.slice(-this.maxHistoryTurns);
    }
  }

  /**
   * 获取压缩后的对话历史（给 LLM 升级用）
   */
  getCompressedHistory() {
    return this.conversationHistory.map(h => ({
      u: h.user.substring(0, 100),
      b: h.bot.substring(0, 100),
    }));
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
    this.conversationHistory = [];
    this.sessionTurnCount = 0;
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
