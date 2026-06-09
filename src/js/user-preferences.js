/**
 * user-preferences.js — 用户偏好 & 反馈记录模块
 *
 * 职责：
 * - 读写用户偏好配置（睡眠时间、活跃频率等）
 * - 记录点赞/点踩反馈
 * - 推送权重管理（根据反馈调整人格/内容类型权重）
 */

const fs = require('fs');
const path = require('path');

class UserPreferences {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.prefsFile = path.join(dataDir, 'preferences.json');
    this.feedbackFile = path.join(dataDir, 'feedback.json');
    this.prefs = null;
    this.feedback = null;
    this.contentWeights = null;
  }

  // ============================================================
  // 初始化 & 加载
  // ============================================================

  init() {
    this.prefs = this._loadJSON(this.prefsFile, {
      wakeUp: '08:00',
      sleepTime: '22:00',
      dailyChatLimit: 20,
      activeFrequency: 'normal',
      avataraEnabled: false,
      theme: 'light',
    });

    this.feedback = this._loadJSON(this.feedbackFile, {
      pushes: {},
      chats: {},
      personalityVotes: {},
      contentTypeVotes: {},
    });

    this.contentWeights = {
      meme: 0.25,
      scenery: 0.15,
      history: 0.15,
      quote: 0.15,
      news: 0.20,
      trivia: 0.10,
    };

    return this;
  }

  _loadJSON(filePath, defaults) {
    try {
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, 'utf-8');
        return { ...defaults, ...JSON.parse(data) };
      }
    } catch (e) {
      // 文件损坏时使用默认值
    }
    this._saveJSON(filePath, defaults);
    return { ...defaults };
  }

  _saveJSON(filePath, data) {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
      console.error('Failed to save:', filePath, e);
    }
  }

  // ============================================================
  // 偏好操作
  // ============================================================

  getAll() {
    return { ...this.prefs };
  }

  get(key) {
    return this.prefs[key];
  }

  update(config) {
    Object.assign(this.prefs, config);
    this._saveJSON(this.prefsFile, this.prefs);
  }

  // ============================================================
  // 反馈记录
  // ============================================================

  /**
   * 记录用户反馈
   * @param {string} type - 'push' | 'chat'
   * @param {string} id - 内容/对话标识
   * @param {number} vote - 1 (赞) | -1 (踩) | 0 (取消)
   * @param {object} meta - { personalityId, contentType, ... }
   */
  recordFeedback(type, id, vote, meta = {}) {
    if (!this.feedback[type]) {
      this.feedback[type] = {};
    }
    this.feedback[type][id] = {
      vote,
      timestamp: Date.now(),
      ...meta,
    };

    // 更新人格权重
    if (meta.personalityId) {
      if (!this.feedback.personalityVotes) this.feedback.personalityVotes = {};
      if (!this.feedback.personalityVotes[meta.personalityId]) {
        this.feedback.personalityVotes[meta.personalityId] = { likes: 0, dislikes: 0 };
      }
      if (vote > 0) this.feedback.personalityVotes[meta.personalityId].likes++;
      if (vote < 0) this.feedback.personalityVotes[meta.personalityId].dislikes++;
    }

    // 更新内容类型权重
    if (meta.contentType) {
      if (!this.feedback.contentTypeVotes) this.feedback.contentTypeVotes = {};
      if (!this.feedback.contentTypeVotes[meta.contentType]) {
        this.feedback.contentTypeVotes[meta.contentType] = { likes: 0, dislikes: 0 };
      }
      if (vote > 0) this.feedback.contentTypeVotes[meta.contentType].likes++;
      if (vote < 0) this.feedback.contentTypeVotes[meta.contentType].dislikes++;
    }

    this._saveJSON(this.feedbackFile, this.feedback);
    return true;
  }

  // ============================================================
  // 权重计算
  // ============================================================

  /**
   * 获取人格权重分（用于 ε-greedy 选择算法）
   * 基础分 1.0 + 点赞/点踩 调整
   */
  getPersonalityWeight(personalityId) {
    let weight = 1.0;
    const votes = this.feedback.personalityVotes?.[personalityId];
    if (votes) {
      // 每个赞 +0.15, 每个踩 -0.2
      weight += votes.likes * 0.15;
      weight -= votes.dislikes * 0.2;
    }
    return Math.max(0.3, Math.min(3.0, weight));
  }

  /**
   * 获取所有人格的权重映射
   */
  getAllPersonalityWeights(personalityIds) {
    const weights = {};
    for (const id of personalityIds) {
      weights[id] = this.getPersonalityWeight(id);
    }
    return weights;
  }

  /**
   * 获取内容类型权重
   */
  getContentTypeWeights() {
    const weights = { ...this.contentWeights };
    const votes = this.feedback.contentTypeVotes || {};

    for (const [type, v] of Object.entries(votes)) {
      if (weights[type] !== undefined) {
        const adjustment = v.likes * 0.03 - v.dislikes * 0.04;
        weights[type] = Math.max(0.05, Math.min(0.5, weights[type] + adjustment));
      }
    }

    return weights;
  }

  // ============================================================
  // 保存全部
  // ============================================================

  saveAll() {
    this._saveJSON(this.prefsFile, this.prefs);
    this._saveJSON(this.feedbackFile, this.feedback);
  }
}

module.exports = UserPreferences;
