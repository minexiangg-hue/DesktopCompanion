/**
 * sleep-scheduler.js — 睡眠调度器
 *
 * 状态机:
 *    睡眠 ──(定时到达清醒时间)──> 清醒待机 ──(用户点击)──> 对话/互动中
 *      ↑                                                    │
 *      │                              (冷却/超时)           │
 *      └─────────────────────────────────────────────────────┘
 *
 * 职责：
 * - 管理宠物的清醒/睡眠状态机
 * - 定时检查当前时间 vs 配置时间
 * - 状态变更时回调通知
 * - 对话限额管理（默认每日 20 次免费对话）
 * - 冷却机制（对话结束后 30s 冷却）
 * - 临时唤醒（睡眠中点击 → 1 轮迷糊回应 → 继续睡）
 */
const fs = require('fs');
const path = require('path');

// ============================================================
// 默认配置
// ============================================================
const DEFAULT_CONFIG = {
  wakeUp: '08:00',        // 清醒时间
  sleepTime: '22:00',     // 睡眠时间
  maxDailyChats: 20,      // 每日免费对话限额
  cooldownSeconds: 30,    // 对话结束后冷却秒数
  drowsyResponseLimit: 1, // 睡眠中临时唤醒可回应次数
};

// ============================================================
// 内部状态
// ============================================================
let config = { ...DEFAULT_CONFIG };
let prefsFilePath = '';
let state = 'asleep';           // 'awake' | 'asleep' | 'drowsy'
let nextTransition = null;      // 下一次状态变更的时间戳
let chatCount = 0;              // 今日已用对话次数
let chatDate = '';              // 对话计数日期
let lastInteractionTime = 0;    // 上一次交互时间戳
let cooldownUntil = 0;          // 冷却结束时间戳
let drowsyUses = 0;             // 本次睡眠中已使用的迷糊回应次数
let timerHandle = null;         // 定时器句柄
let stateChangeCallbacks = [];  // 状态变更回调列表

// ============================================================
// 工具函数
// ============================================================

/**
 * 将 'HH:MM' 格式的时间转为今天的 Date 对象
 */
function timeToTodayDate(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

/**
 * 获取今天的日期字符串 (YYYY-MM-DD)
 */
function getTodayStr() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 重置今日对话计数（如果日期变更）
 */
function resetDailyIfNeeded() {
  const today = getTodayStr();
  if (today !== chatDate) {
    chatDate = today;
    chatCount = 0;
  }
}

/**
 * 计算下一次状态切换的时间
 * @returns {{ next: Date, targetState: string }}
 */
function computeNextTransition() {
  const now = new Date();
  const wakeTime = timeToTodayDate(config.wakeUp);
  const sleepTime = timeToTodayDate(config.sleepTime);

  let nextTime, targetState;

  if (state === 'asleep') {
    // 睡眠中 → 下次清醒时间
    if (now < wakeTime) {
      nextTime = wakeTime;
    } else {
      // 如果当前时间已过今天的清醒点，设为明天
      nextTime = new Date(wakeTime.getTime() + 24 * 60 * 60 * 1000);
    }
    targetState = 'awake';
  } else if (state === 'awake' || state === 'drowsy') {
    // 清醒中 → 下次睡眠时间
    if (now < sleepTime) {
      nextTime = sleepTime;
    } else {
      nextTime = new Date(sleepTime.getTime() + 24 * 60 * 60 * 1000);
    }
    targetState = 'asleep';
  }

  return { next: nextTime, targetState };
}

// ============================================================
// 模块导出
// ============================================================
module.exports = {
  /**
   * 初始化：加载睡眠配置（使用独立文件避免与 user-preferences 冲突）
   * @param {string} directory 数据目录路径
   */
  init(directory) {
    prefsFilePath = path.join(directory, 'sleep-config.json');
    chatDate = getTodayStr();
    chatCount = 0;

    // 确保 data 目录存在
    const dir = path.dirname(prefsFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 加载已有配置
    if (fs.existsSync(prefsFilePath)) {
      try {
        const raw = fs.readFileSync(prefsFilePath, 'utf-8');
        const savedConfig = JSON.parse(raw);
        if (savedConfig.wakeUp) config.wakeUp = savedConfig.wakeUp;
        if (savedConfig.sleepTime) config.sleepTime = savedConfig.sleepTime;
        if (savedConfig.maxDailyChats !== undefined) config.maxDailyChats = savedConfig.maxDailyChats;
        if (savedConfig.cooldownSeconds !== undefined) config.cooldownSeconds = savedConfig.cooldownSeconds;
        if (savedConfig.drowsyResponseLimit !== undefined) config.drowsyResponseLimit = savedConfig.drowsyResponseLimit;
        if (savedConfig.chatCount !== undefined && savedConfig.chatDate === getTodayStr()) {
          chatCount = savedConfig.chatCount;
        }
        console.log('[SleepScheduler] 配置已加载');
      } catch (err) {
        console.warn('[SleepScheduler] 配置加载失败，使用默认配置:', err.message);
      }
    }

    // 根据当前时间初始化状态
    this._syncStateWithClock();
  },

  /**
   * 返回当前状态
   * @returns {{ state: string, nextTransition: number|null }}
   */
  getState() {
    return {
      state: state,
      nextTransition: nextTransition ? nextTransition.getTime() : null,
    };
  },

  /**
   * 返回清醒/睡眠时间配置
   * @returns {{ wakeUp: string, sleepTime: string, maxDailyChats: number, cooldownSeconds: number }}
   */
  getSchedule() {
    return {
      wakeUp: config.wakeUp,
      sleepTime: config.sleepTime,
      maxDailyChats: config.maxDailyChats,
      cooldownSeconds: config.cooldownSeconds,
    };
  },

  /**
   * 更新清醒/睡眠时间配置
   * @param {object} newConfig { wakeUp?, sleepTime?, maxDailyChats?, cooldownSeconds? }
   */
  setSchedule(newConfig) {
    if (newConfig.wakeUp) config.wakeUp = newConfig.wakeUp;
    if (newConfig.sleepTime) config.sleepTime = newConfig.sleepTime;
    if (newConfig.maxDailyChats !== undefined) config.maxDailyChats = newConfig.maxDailyChats;
    if (newConfig.cooldownSeconds !== undefined) config.cooldownSeconds = newConfig.cooldownSeconds;
    if (newConfig.drowsyResponseLimit !== undefined) config.drowsyResponseLimit = newConfig.drowsyResponseLimit;

    // 保存到文件
    this._saveConfig();

    // 重新同步状态
    this._syncStateWithClock();
  },

  /**
   * 当前是否清醒
   * @returns {boolean}
   */
  isAwake() {
    // 确保状态与时钟同步
    this._syncStateWithClock();
    return state === 'awake';
  },

  /**
   * 记录一次交互（用于限额和冷却）
   * @returns {boolean} 交互是否被允许
   */
  recordInteraction() {
    resetDailyIfNeeded();

    const now = Date.now();

    // 检查冷却
    if (now < cooldownUntil) {
      return false;
    }

    // 检查限额
    if (chatCount >= config.maxDailyChats) {
      return false;
    }

    // 检查睡眠状态
    if (state === 'asleep') {
      // 睡眠中 → 进入迷糊状态
      if (drowsyUses >= config.drowsyResponseLimit) {
        return false;
      }
      state = 'drowsy';
      drowsyUses++;
      this._notifyStateChange(state);
      chatCount++;
      lastInteractionTime = now;
      this._saveConfig();
      return true;
    }

    if (state === 'drowsy') {
      if (drowsyUses >= config.drowsyResponseLimit) {
        return false;
      }
      drowsyUses++;
      chatCount++;
      lastInteractionTime = now;
      this._saveConfig();
      return true;
    }

    // 清醒状态
    state = 'awake';
    chatCount++;
    lastInteractionTime = now;
    this._saveConfig();
    return true;
  },

  /**
   * 是否允许交互
   * @returns {boolean}
   */
  canInteract() {
    resetDailyIfNeeded();

    const now = Date.now();

    // 检查冷却
    if (now < cooldownUntil) {
      return false;
    }

    // 检查限额
    if (chatCount >= config.maxDailyChats) {
      return false;
    }

    // 睡眠状态检查
    if (state === 'asleep') {
      return drowsyUses < config.drowsyResponseLimit;
    }

    if (state === 'drowsy') {
      return drowsyUses < config.drowsyResponseLimit;
    }

    return true;
  },

  /**
   * 获取剩余免费对话次数
   * @returns {number}
   */
  getRemainingChats() {
    resetDailyIfNeeded();
    return Math.max(0, config.maxDailyChats - chatCount);
  },

  /**
   * 对话结束：开始冷却
   * 如果将状态从 drowsy 切换回 asleep
   */
  endInteraction() {
    const now = Date.now();
    cooldownUntil = now + config.cooldownSeconds * 1000;

    if (state === 'drowsy') {
      state = 'asleep';
      this._notifyStateChange(state);
    }

    this._saveConfig();
  },

  /**
   * 启动定时检查循环（每分钟检查一次）
   * @param {number} [intervalMs=60000] 检查间隔（毫秒）
   */
  startTimer(intervalMs = 60000) {
    if (timerHandle) {
      clearInterval(timerHandle);
    }

    // 立即执行一次同步
    this._syncStateWithClock();

    timerHandle = setInterval(() => {
      this._syncStateWithClock();
    }, intervalMs);

    console.log(`[SleepScheduler] 定时器已启动（间隔 ${intervalMs / 1000}s)`);
  },

  /**
   * 停止定时器
   */
  stopTimer() {
    if (timerHandle) {
      clearInterval(timerHandle);
      timerHandle = null;
      console.log('[SleepScheduler] 定时器已停止');
    }
  },

  /**
   * 注册状态变更回调
   * @param {function} callback 接收新状态字符串
   */
  onStateChange(callback) {
    if (typeof callback === 'function') {
      stateChangeCallbacks.push(callback);
    }
  },

  /**
   * 移除状态变更回调
   * @param {function} callback
   */
  offStateChange(callback) {
    stateChangeCallbacks = stateChangeCallbacks.filter(cb => cb !== callback);
  },

  // ============================================================
  // 内部方法
  // ============================================================

  /**
   * 根据当前时钟检查并同步状态
   */
  _syncStateWithClock() {
    const now = new Date();
    const wakeTime = timeToTodayDate(config.wakeUp);
    const sleepTime = timeToTodayDate(config.sleepTime);

    let newState = state;
    let didTransition = false;

    if (state === 'asleep') {
      // 检查是否该清醒了
      if (now >= wakeTime && now < sleepTime) {
        newState = 'awake';
        drowsyUses = 0;
        didTransition = true;
      }
    } else if (state === 'awake' || state === 'drowsy') {
      // 检查是否该睡觉了
      if (now >= sleepTime || now < wakeTime) {
        // 跨夜处理：如果当前时间在 00:00~wakeUp 之间，也视为睡眠
        newState = 'asleep';
        didTransition = true;
      }
    }

    if (newState !== state) {
      state = newState;
      this._notifyStateChange(state);
    }

    // 更新下次切换时间
    const transition = computeNextTransition();
    nextTransition = transition.next;
  },

  /**
   * 通知所有回调
   */
  _notifyStateChange(newState) {
    for (const cb of stateChangeCallbacks) {
      try {
        cb(newState);
      } catch (err) {
        console.error('[SleepScheduler] 状态变更回调出错:', err.message);
      }
    }
  },

  /**
   * 保存配置到文件
   */
  _saveConfig() {
    if (!prefsFilePath) return;
    try {
      const saveData = {
        wakeUp: config.wakeUp,
        sleepTime: config.sleepTime,
        maxDailyChats: config.maxDailyChats,
        cooldownSeconds: config.cooldownSeconds,
        drowsyResponseLimit: config.drowsyResponseLimit,
        chatCount: chatCount,
        chatDate: chatDate,
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(prefsFilePath, JSON.stringify(saveData, null, 2), 'utf-8');
    } catch (err) {
      console.error('[SleepScheduler] 配置保存失败:', err.message);
    }
  },
};
