/**
 * personality-scheduler.js — 人格调度引擎
 *
 * 职责：
 * - 加载 personalities/ 目录下所有人格 JSON 文件
 * - 提供人格选择算法（手动/随机/情境触发三种模式）
 * - 管理当前激活人格的切换
 * - 提供每日精选逻辑（排除昨天已用）
 */
const fs = require('fs');
const path = require('path');

// ============================================================
// 内部状态
// ============================================================
let personalities = [];        // 已加载的完整人格列表
let personalityMap = {};       // id -> personality 快速索引
let activePersonalityId = null;
let yesterdayPickId = null;    // 昨日精选人格 ID（避免连续同一天）
let yesterdayDateStr = '';     // 记录精选日期

// ============================================================
// 内置模式权重（用于 context 检测）
// ============================================================
const CONTEXT_RULES = [
  {
    name: 'monday-morning',
    check: () => {
      const now = new Date();
      const hour = now.getHours();
      const min = now.getMinutes();
      const day = now.getDay();
      return day === 1 && hour >= 7 && (hour < 9 || (hour === 9 && min <= 30));
    },
    candidates: ['joker'],
    reason: '周一早晨需要一点幽默感',
  },
  {
    name: 'late-night',
    check: () => {
      const now = new Date();
      const hour = now.getHours();
      return hour >= 22 || hour < 5;
    },
    candidates: ['big-sis'],
    reason: '深夜需要温柔陪伴',
  },
  {
    name: 'idle',
    check: () => {
      // idle 检测需要外部传入 idleDuration, 由 context 参数传递
      return false; // 实际由 selectPersonality 的 context.idleDuration 触发
    },
    candidates: ['tsundere-cat', 'joker'],
    reason: '长时间无操作',
  },
  {
    name: 'long-active',
    check: () => {
      return false; // 由 context.activeDuration 触发
    },
    candidates: ['big-sis'],
    reason: '持续活跃后需要放松',
  },
  {
    name: 'weekend',
    check: () => {
      const day = new Date().getDay();
      return day === 0 || day === 6;
    },
    candidates: ['joker', 'trump'],
    reason: '周末就是要开心',
  },
];

// ============================================================
// 默认权重（当人格 JSON 中未定义时使用）
// ============================================================
function getDefaultWeight(personality) {
  const { suitability } = personality;
  if (!suitability) return 0.5;
  const scores = Object.values(suitability);
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

// ============================================================
// 模块导出
// ============================================================
module.exports = {
  /**
   * 初始化：扫描 personalitiesDir 加载所有人格 JSON 文件
   * @param {string} personalitiesDir
   */
  init(personalitiesDir) {
    personalities = [];
    personalityMap = {};
    activePersonalityId = null;

    if (!fs.existsSync(personalitiesDir)) {
      console.warn(`[PersonalityScheduler] 目录不存在: ${personalitiesDir}`);
      return;
    }

    const files = fs.readdirSync(personalitiesDir)
      .filter(f => f.endsWith('.json'))
      .sort();

    for (const file of files) {
      const filePath = path.join(personalitiesDir, file);
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const personality = JSON.parse(raw);
        if (!personality.id) {
          console.warn(`[PersonalityScheduler] 跳过无 ID 的文件: ${file}`);
          continue;
        }
        personalities.push(personality);
        personalityMap[personality.id] = personality;
      } catch (err) {
        console.error(`[PersonalityScheduler] 加载失败: ${file}`, err.message);
      }
    }

    console.log(`[PersonalityScheduler] 已加载 ${personalities.length} 个人格`);
  },

  /**
   * 返回所有人格的元数据列表（不含完整模板，节省传输）
   * @returns {Array<{id,name,type,tags,style,iconColor}>}
   */
  getAll() {
    return personalities.map(p => ({
      id: p.id,
      name: p.name,
      type: p.type,
      tags: p.tags,
      style: p.style,
      iconColor: p.iconColor,
      catchphrases: p.catchphrases ? p.catchphrases.slice(0, 3) : [],
    }));
  },

  /**
   * 返回当前激活人格的完整配置
   * @returns {object|null}
   */
  getActive() {
    if (!activePersonalityId) return null;
    return personalityMap[activePersonalityId] || null;
  },

  /**
   * 切换到指定人格
   * @param {string} id 人格 ID
   * @returns {boolean} 切换是否成功
   */
  switchTo(id) {
    if (!id || !personalityMap[id]) {
      console.warn(`[PersonalityScheduler] 切换失败: 未找到人格 "${id}"`);
      return false;
    }
    activePersonalityId = id;
    console.log(`[PersonalityScheduler] 切换到人格: ${id} (${personalityMap[id].name})`);
    return true;
  },

  /**
   * 根据上下文选择人格（不切换，仅推荐）
   * @param {object} context 上下文对象
   * @param {string} context.mode 选择模式: 'manual' | 'random' | 'context'
   * @param {string} [context.manualId] manual 模式下指定的人格 ID
   * @param {number} [context.idleDuration] 用户无操作时长（秒）
   * @param {number} [context.activeDuration] 用户持续活跃时长（分钟）
   * @returns {object|null} 选择的人格对象
   */
  selectPersonality(context) {
    if (!context || !context.mode) {
      return this.getActive();
    }

    const mode = context.mode || 'random';

    if (mode === 'manual') {
      // 手动模式：直接返回指定人格
      const target = context.manualId ? personalityMap[context.manualId] : null;
      return target || this.getActive();
    }

    if (mode === 'context') {
      return this._contextSelect(context);
    }

    // 默认: 随机模式（ε-greedy）
    return this._randomSelect(context);
  },

  /**
   * 每日精选人格（排除昨日已用）
   * @param {object} [context] 可选上下文，传给 selectPersonality
   * @returns {object|null} 精选的人格对象
   */
  getDailyPick(context) {
    const today = new Date().toISOString().slice(0, 10);

    // 日期变更时重置排除记录
    if (today !== yesterdayDateStr) {
      yesterdayPickId = null;
      yesterdayDateStr = today;
    }

    // 获取可用人格列表（排除昨日已用的）
    const available = yesterdayPickId
      ? personalities.filter(p => p.id !== yesterdayPickId)
      : [...personalities];

    if (available.length === 0) {
      // 如果只有一个人格，就返回它
      return personalities.length > 0 ? personalities[0] : null;
    }

    let pick;

    if (context && context.mode === 'manual') {
      // 手动模式：指定人格
      pick = context.manualId ? personalityMap[context.manualId] : null;
    } else if (context && context.mode === 'context') {
      // 情境模式
      const ctxResult = this._contextSelect(context);
      pick = ctxResult;
    } else {
      // 随机模式（默认）
      pick = this._randomSelect({ ...context, _pool: available });
    }

    // 如果选择的结果是昨日已用的，换一个
    if (pick && pick.id === yesterdayPickId && available.length > 0) {
      const fallbackPool = available.filter(p => p.id !== pick.id);
      if (fallbackPool.length > 0) {
        pick = fallbackPool[Math.floor(Math.random() * fallbackPool.length)];
      }
    }

    yesterdayPickId = pick ? pick.id : null;
    return pick || null;
  },

  // ============================================================
  // 内部方法
  // ============================================================

  /**
   * ε-greedy 随机选择
   * ε=0.3 纯随机探索，0.7 从高权重人格中选择
   */
  _randomSelect(context) {
    const pool = (context && context._pool) || personalities;
    if (pool.length === 0) return null;
    if (pool.length === 1) return pool[0];

    const epsilon = 0.3;

    if (Math.random() < epsilon) {
      // 探索：纯随机
      return pool[Math.floor(Math.random() * pool.length)];
    }

    // 利用：从高权重人格中选择（轮盘赌）
    const weights = pool.map(p => {
      if (p.suitability) {
        const scores = Object.values(p.suitability);
        return scores.reduce((a, b) => a + b, 0) / scores.length;
      }
      return 0.5;
    });

    const totalWeight = weights.reduce((a, b) => a + b, 0);
    if (totalWeight <= 0) {
      return pool[Math.floor(Math.random() * pool.length)];
    }

    let random = Math.random() * totalWeight;
    for (let i = 0; i < pool.length; i++) {
      random -= weights[i];
      if (random <= 0) {
        return pool[i];
      }
    }

    return pool[pool.length - 1];
  },

  /**
   * 情境触发选择
   */
  _contextSelect(context) {
    const now = new Date();
    const hour = now.getHours();
    const day = now.getDay();
    const matchScores = {};

    // 初始化所有人格的匹配分数
    for (const p of personalities) {
      matchScores[p.id] = 0;
    }

    // 1. 周一早晨 7-9:30 → joker 优先
    if (day === 1 && hour >= 7 && (hour < 9 || (hour === 9 && now.getMinutes() <= 30))) {
      matchScores['joker'] = (matchScores['joker'] || 0) + 3;
    }

    // 2. 深夜 ≥22:00 或凌晨 <5:00 → big-sis 优先
    if (hour >= 22 || hour < 5) {
      matchScores['big-sis'] = (matchScores['big-sis'] || 0) + 3;
    }

    // 3. 无操作 > 10min (需要 context.idleDuration)
    if (context && context.idleDuration !== undefined && context.idleDuration > 600) {
      matchScores['tsundere-cat'] = (matchScores['tsundere-cat'] || 0) + 2;
      matchScores['joker'] = (matchScores['joker'] || 0) + 2;
    }

    // 4. 连续活跃 > 2h (需要 context.activeDuration)
    if (context && context.activeDuration !== undefined && context.activeDuration > 120) {
      matchScores['big-sis'] = (matchScores['big-sis'] || 0) + 3;
    }

    // 5. 周末 → joker / trump
    if (day === 0 || day === 6) {
      matchScores['joker'] = (matchScores['joker'] || 0) + 2;
      matchScores['trump'] = (matchScores['trump'] || 0) + 2;
    }

    // 6. 上午 (5-12) → 倾向晨间类型
    if (hour >= 5 && hour < 12) {
      for (const p of personalities) {
        if (p.suitability && p.suitability.morning >= 0.7) {
          matchScores[p.id] = (matchScores[p.id] || 0) + 1;
        }
      }
    }

    // 7. 工作时间 (9-18, 非周末) → snarky-ai 或 professor
    if (hour >= 9 && hour < 18 && day >= 1 && day <= 5) {
      matchScores['snarky-ai'] = (matchScores['snarky-ai'] || 0) + 1;
      matchScores['professor'] = (matchScores['professor'] || 0) + 1;
    }

    // 8. 傍晚 (18-22) → 休闲向
    if (hour >= 18 && hour < 22) {
      for (const p of personalities) {
        if (p.suitability && p.suitability.casual >= 0.8) {
          matchScores[p.id] = (matchScores[p.id] || 0) + 1;
        }
      }
    }

    // 找出最高分
    let maxScore = -1;
    let candidates = [];

    for (const [id, score] of Object.entries(matchScores)) {
      if (score > maxScore) {
        maxScore = score;
        candidates = [id];
      } else if (score === maxScore && score > 0) {
        candidates.push(id);
      }
    }

    // 如果有匹配的情境
    if (candidates.length > 0 && maxScore > 0) {
      const pickId = candidates[Math.floor(Math.random() * candidates.length)];
      return personalityMap[pickId] || null;
    }

    // 没有匹配的情境时，使用 suitability 综合评分
    return this._randomSelect({ ...context });
  },
};
