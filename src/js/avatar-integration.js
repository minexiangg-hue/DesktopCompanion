/**
 * avatar-integration.js — Avatara 用户画像集成（P1）
 *
 * 职责：
 * - 读取 Avatara 系统生成的用户画像文件
 * - 提取用户偏好（兴趣领域、时间节奏、沟通风格）
 * - 影响每日惊喜的内容选择和人格权重
 * - 用户可开关（隐私控制）
 *
 * Avatara 文件路径: <project_root>/ai_avatar_persona/
 */

const fs = require('fs');
const path = require('path');

class AvataraIntegration {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.avataraPath = null;
    this.profile = null;
    this.enabled = false;
  }

  /**
   * 初始化 — 尝试发现 Avatara 文件
   * @param {string} projectRoot - 项目根目录（用于查找 ai_avatar_persona/）
   */
  init(projectRoot) {
    const possiblePaths = [
      path.join(projectRoot, '..', 'ai_avatar_persona'),
      path.join(projectRoot, 'ai_avatar_persona'),
      path.join(projectRoot, '..', '..', 'ai_avatar_persona'),
    ];

    for (const p of possiblePaths) {
      const normalized = path.resolve(p);
      if (fs.existsSync(normalized)) {
        this.avataraPath = normalized;
        break;
      }
    }

    // 读取偏好开关
    try {
      const prefsPath = path.join(this.dataDir, 'preferences.json');
      if (fs.existsSync(prefsPath)) {
        const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
        this.enabled = prefs.avataraEnabled === true;
      }
    } catch (e) {
      this.enabled = false;
    }

    if (this.enabled && this.avataraPath) {
      this._loadProfile();
    }

    return this;
  }

  /**
   * 加载 Avatara 用户画像
   */
  _loadProfile() {
    try {
      const synthesisPath = path.join(this.avataraPath, 'persona', '07_persona_synthesis.md');
      const liveStatePath = path.join(this.avataraPath, 'business', '04_live_state.md');

      this.profile = {
        synthesis: this._readFileSafe(synthesisPath),
        liveState: this._readFileSafe(liveStatePath),
        loadedAt: Date.now(),
      };
    } catch (e) {
      this.profile = null;
    }
  }

  _readFileSafe(filePath) {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  // ============================================================
  // 公共接口
  // ============================================================

  /**
   * 是否启用了 Avatara 集成
   */
  isEnabled() {
    return this.enabled && this.avataraPath !== null;
  }

  /**
   * 启用/禁用 Avatara
   */
  setEnabled(enabled) {
    this.enabled = enabled;
    if (enabled && this.avataraPath) {
      this._loadProfile();
    }
  }

  /**
   * 获取用户偏好标签（用于影响推送内容）
   * @returns {string[]} 兴趣标签列表
   */
  getInterestTags() {
    if (!this.isEnabled() || !this.profile?.synthesis) return [];

    const synthesis = this.profile.synthesis;
    const tags = [];

    // 从 Synthesis 中提取关键词
    const keywords = ['设计', '开发', 'AI', '产品', '运营', '写作', '阅读', '音乐', '游戏',
      '运动', '美食', '旅行', '摄影', '电影', '科技', '商业', '投资', '教育'];

    for (const keyword of keywords) {
      if (synthesis.includes(keyword)) {
        tags.push(keyword);
      }
    }

    return tags;
  }

  /**
   * 获取沟通风格偏好（用于影响人格选择）
   * @returns {object} 风格偏好
   */
  getCommunicationStyle() {
    if (!this.isEnabled() || !this.profile?.synthesis) return {};

    const synthesis = this.profile.synthesis;
    const style = {};

    if (synthesis.includes('简洁') || synthesis.includes('高效')) style.concise = true;
    if (synthesis.includes('幽默') || synthesis.includes('搞笑')) style.humorous = true;
    if (synthesis.includes('严肃') || synthesis.includes('专业')) style.serious = true;
    if (synthesis.includes('温暖') || synthesis.includes('友善')) style.warm = true;

    return style;
  }

  /**
   * 获取工作节奏信息
   * @returns {object} 工作时间模式
   */
  getWorkPattern() {
    if (!this.isEnabled() || !this.profile?.liveState) return {};

    const liveState = this.profile.liveState;
    const pattern = {};

    if (liveState.includes('忙') || liveState.includes('deadline')) pattern.busy = true;
    if (liveState.includes('项目') || liveState.includes('project')) pattern.hasProject = true;
    if (liveState.includes('早') || liveState.includes('morning')) pattern.earlyBird = true;
    if (liveState.includes('晚') || liveState.includes('night')) pattern.nightOwl = true;

    return pattern;
  }

  /**
   * 获取完整画像摘要
   */
  getProfileSummary() {
    if (!this.isEnabled()) return null;

    return {
      interestTags: this.getInterestTags(),
      communicationStyle: this.getCommunicationStyle(),
      workPattern: this.getWorkPattern(),
      hasProfile: this.profile !== null,
    };
  }
}

module.exports = AvataraIntegration;
