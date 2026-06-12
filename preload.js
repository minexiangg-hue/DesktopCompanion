/**
 * preload.js — IPC 桥接契约
 *
 * 这是 Geek（主进程）和 Artist（渲染进程）之间的唯一共享契约。
 * API 签名冻结后，双方基于此并行开发。
 *
 * Geek 在 main.js 中实现 ipcMain.handle() 对应逻辑。
 * Artist 在 renderer.js 中通过 window.electronAPI 调用。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ========== 窗口控制 ==========

  /** 切换窗口穿透模式（true=点穿到桌面，false=正常交互） */
  setClickThrough: (ignore) => ipcRenderer.send('window:setClickThrough', ignore),

  // ========== 人格系统 ==========

  /** 返回所有人格列表（含元数据） */
  getPersonalities: () => ipcRenderer.invoke('personality:list'),

  /** 返回当前激活人格的完整配置 */
  getActivePersonality: () => ipcRenderer.invoke('personality:getActive'),

  /** 切换到指定人格 @param {string} id 人格 ID */
  switchPersonality: (id) => ipcRenderer.invoke('personality:switch', id),

  /** 获取今日惊喜内容（触发生成 + 返回） */
  getDailySurprise: () => ipcRenderer.invoke('daily:getSurprise'),

  // ========== 聊天系统 ==========

  /** 获取聊天回复 @param {string} message 用户输入 */
  getChatResponse: (message) => ipcRenderer.invoke('chat:respond', message),

  // ========== 睡眠系统 ==========

  /** 返回当前睡眠状态 { state: 'awake'|'asleep'|'drowsy', nextTransition } */
  getSleepState: () => ipcRenderer.invoke('sleep:getState'),

  /** 返回清醒/睡眠时间配置 */
  getSchedule: () => ipcRenderer.invoke('sleep:getSchedule'),

  /** 更新睡眠配置 @param {object} config { wakeUp, sleepTime } */
  setSchedule: (config) => ipcRenderer.invoke('sleep:setSchedule', config),

  // ========== 反馈系统 ==========

  /**
   * 发送用户反馈
   * @param {string} type - 'push' | 'chat'
   * @param {string} id - 内容/对话 ID
   * @param {number} vote - 1 (赞) | -1 (踩) | 0 (取消)
   */
  sendFeedback: (type, id, vote) => ipcRenderer.invoke('feedback:send', type, id, vote),

  // ========== 偏好 ==========

  /** 获取所有用户偏好 */
  getPreferences: () => ipcRenderer.invoke('prefs:get'),

  /** 更新用户偏好 @param {object} config 偏好键值对 */
  setPreferences: (config) => ipcRenderer.invoke('prefs:set', config),

  // ========== 事件监听（主进程→渲染进程） ==========

  /** 睡眠状态变更通知 */
  onSleepStateChange: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('sleep:stateChanged', handler);
    return () => ipcRenderer.removeListener('sleep:stateChanged', handler);
  },

  /** 每日惊喜已就绪通知 */
  onDailySurprise: (callback) => {
    const handler = (_event, surprise) => callback(surprise);
    ipcRenderer.on('daily:surpriseReady', handler);
    return () => ipcRenderer.removeListener('daily:surpriseReady', handler);
  },

  /** 人格切换通知 */
  onPersonalityChanged: (callback) => {
    const handler = (_event, personality) => callback(personality);
    ipcRenderer.on('personality:changed', handler);
    return () => ipcRenderer.removeListener('personality:changed', handler);
  },
});
