/**
 * renderer.js — 渲染进程入口
 *
 * 职责：
 * - 管理角色渲染引擎（character-renderer.js）
 * - 监听主进程事件（睡眠/惊喜/人格切换）
 * - 协调 UI 状态更新
 * - 处理用户交互（点击/双击/拖拽）
 */

// ============================================================
// 状态
// ============================================================
const state = {
  currentPersonality: null,
  sleepState: 'awake',
  isTalking: false,
  chatMode: false,
};

// ============================================================
// DOM 引用
// ============================================================
const $ = (sel) => document.querySelector(sel);
const characterEl = document.getElementById('character-container');
const surprisePanel = document.getElementById('surprise-panel');
const chatPanel = document.getElementById('chat-panel');
const chatInput = document.getElementById('chat-input');
const chatMessages = document.getElementById('chat-messages');
const personalityPicker = document.getElementById('personality-picker');
const settingsPanel = document.getElementById('settings-panel');
const settingsBtn = document.getElementById('settings-btn');
const chatClose = document.getElementById('chat-close');

// ============================================================
// 设置按钮点击
// ============================================================
if (settingsBtn) {
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openSettings();
  });
}

// ============================================================
// 聊天关闭按钮
// ============================================================
if (chatClose) {
  chatClose.addEventListener('click', (e) => {
    e.stopPropagation();
    exitChatMode();
  });
}

// ============================================================
// 点击检测
// body = drag（透明区域 OS 原生拖拽），character = no-drag（可点击）
// ============================================================

characterEl.addEventListener('click', () => {
  if (!state.chatMode) {
    handleCharacterClick();
  }
});

// ============================================================
// 窗口形状管理（配合主进程 setShape）
// ============================================================
function updateWindowShape(mode) {
  if (window.electronAPI.setWindowShape) {
    window.electronAPI.setWindowShape(mode);
  }
}

// ============================================================
// 角色交互
// ============================================================
async function handleCharacterClick() {
  try {
    const sleepState = await window.electronAPI.getSleepState();

    if (sleepState.state === 'asleep') {
      // 睡眠中点击: 迷糊回应
      showSleepyResponse();
      return;
    }

    if (sleepState.state === 'drowsy') {
      // 临时唤醒: 1 轮对话
      showDrowsyGreeting();
      return;
    }

    // 清醒: 进入聊天模式
    enterChatMode();
  } catch (err) {
    console.error('handleCharacterClick failed:', err);
    // 获取睡眠状态失败时，默认进入聊天模式
    enterChatMode();
  }
}

// ============================================================
// 进入聊天模式
// ============================================================
function enterChatMode() {
  state.chatMode = true;
  document.body.classList.add('chat-mode-active');
  chatPanel.classList.add('visible');
  chatInput.focus();

  // 展开窗口到完整尺寸（聊天面板占满窗口）
  updateWindowShape('full');

  // 通知主进程窗口调整为可交互模式
  chatMessages.innerHTML = '';

  // 开场白
  window.electronAPI.getActivePersonality().then(p => {
    if (p?.chatBehavior?.greetings) {
      const msg = p.chatBehavior.greetings[Math.floor(Math.random() * p.chatBehavior.greetings.length)];
      addChatMessage(p.name || '宠物', msg, 'bot');
    }
  }).catch(err => {
    console.error('Failed to get personality for greeting:', err);
  });
}

function exitChatMode() {
  state.chatMode = false;
  document.body.classList.remove('chat-mode-active');
  chatPanel.classList.remove('visible');

  // 恢复仅角色区域
  updateWindowShape('character');

  // 通知主进程恢复穿透模式
}

// 发送聊天消息
chatInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter' && chatInput.value.trim()) {
    const msg = chatInput.value.trim();
    addChatMessage('你', msg, 'user');
    chatInput.value = '';

    try {
      const canInteract = await checkCanInteract();
      if (!canInteract) {
        addChatMessage('宠物', '……今天说了太多话了, 有点累了……明天再聊吧。', 'bot');
        setTimeout(exitChatMode, 2000);
        return;
      }

      // 显示"思考中"气泡
      const thinkingId = addThinkingBubble();

      const response = await window.electronAPI.getChatResponse(msg);
      const personality = await window.electronAPI.getActivePersonality();

      // 替换为实际回复
      replaceThinkingBubble(thinkingId, personality?.name || '宠物', response || '……嗯？');
    } catch (err) {
      console.error('Chat response failed:', err);
      addChatMessage('宠物', '……出了点问题，等一下再试。', 'bot');
    }
  }
});

// ESC 退出聊天
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.chatMode) {
    exitChatMode();
  }
});

async function checkCanInteract() {
  const sleepState = await window.electronAPI.getSleepState();
  if (sleepState.state !== 'awake') return false;
  // 每日限额检查由主进程处理
  return true;
}

function addChatMessage(sender, text, type) {
  const div = document.createElement('div');
  div.className = `chat-message ${type}`;
  div.innerHTML = `<span class="chat-sender">${sender}:</span> <span class="chat-text">${text}</span>`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return div;
}

let thinkingCounter = 0;

/**
 * 插入"思考中"气泡（搜索 / LLM 调用时的 loading 状态）
 * @returns {number} thinkingId — 用于后续替换
 */
function addThinkingBubble() {
  const id = ++thinkingCounter;
  const div = document.createElement('div');
  div.className = 'chat-message bot thinking';
  div.dataset.thinkingId = id;
  div.innerHTML = `
    <span class="chat-sender">宠物:</span>
    <span class="chat-text">
      <span class="typing-dots">
        <span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>
      </span>
    </span>
  `;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return id;
}

/**
 * 替换"思考中"气泡为实际回复
 * @param {number} id - addThinkingBubble 返回的 ID
 * @param {string} sender - 发送者名称
 * @param {string} text - 回复内容
 */
function replaceThinkingBubble(id, sender, text) {
  const bubbles = chatMessages.querySelectorAll('.chat-message.bot.thinking');
  for (const bubble of bubbles) {
    if (parseInt(bubble.dataset.thinkingId) === id) {
      bubble.className = 'chat-message bot';
      bubble.innerHTML = `<span class="chat-sender">${sender}:</span> <span class="chat-text">${text}</span>`;
      chatMessages.scrollTop = chatMessages.scrollHeight;
      return;
    }
  }
  // 没找到对应气泡，追加新消息
  addChatMessage(sender, text, 'bot');
}

// ============================================================
// 角色气泡（非聊天模式的简短消息）
// ============================================================
function showCharacterBubble(text, type = 'normal') {
  let bubble = document.getElementById('speech-bubble');
  if (!bubble) {
    bubble = document.createElement('div');
    bubble.id = 'speech-bubble';
    bubble.className = 'speech-bubble';
    characterEl.appendChild(bubble);
  }
  bubble.textContent = text;
  bubble.className = `speech-bubble visible ${type}`;

  setTimeout(() => {
    bubble.classList.remove('visible');
  }, 3000);
}

function showSleepyResponse() {
  const sleepyReplies = [
    '唔……我在睡觉……ZZZ',
    '……别闹……好困……',
    'Zzz……天亮再来找我……',
    '(翻了个身继续睡) ZZZ……',
  ];
  const msg = sleepyReplies[Math.floor(Math.random() * sleepyReplies.length)];
  showCharacterBubble(msg, 'sleepy');
}

function showDrowsyGreeting() {
  showCharacterBubble('……嗯？……(迷糊) 你、你好啊……Zzz', 'sleepy');
}

// ============================================================
// 主进程事件监听
// ============================================================

// 睡眠状态变更
window.electronAPI.onSleepStateChange((newState) => {
  // newState 是字符串 ('awake' | 'asleep' | 'drowsy')
  const sleepState = typeof newState === 'string' ? newState : newState.state;
  state.sleepState = sleepState;
  document.body.dataset.sleepState = sleepState;

  if (sleepState === 'asleep' && state.chatMode) {
    exitChatMode();
  }
});

// 每日惊喜推送
window.electronAPI.onDailySurprise((surprise) => {
  showSurprise(surprise);
});

// 人格切换
window.electronAPI.onPersonalityChanged((personality) => {
  state.currentPersonality = personality;
  document.body.dataset.personality = personality.id;
  // 更新角色表情/配色
  if (window.__characterRenderer) {
    window.__characterRenderer.onPersonalityChanged(personality);
  }
});

// ============================================================
// 每日惊喜展示
// ============================================================
function showSurprise(surprise) {
  if (!surprise) return;

  surprisePanel.innerHTML = '';
  surprisePanel.className = 'surprise-panel visible';

  const type = surprise.type || 'quote';
  const content = surprise.content || '';
  const personality = surprise.personality || '';

  // 人格标签
  if (personality) {
    const tag = document.createElement('div');
    tag.className = 'personality-tag';
    tag.textContent = `🎭 ${personality}`;
    surprisePanel.appendChild(tag);
  }

  // 内容容器
  const container = document.createElement('div');
  container.className = 'surprise-content';

  if (type === 'image' && surprise.imageUrl) {
    const img = document.createElement('img');
    img.src = surprise.imageUrl;
    img.alt = 'Daily Surprise';
    img.className = 'surprise-image';
    container.appendChild(img);
  } else if (type === 'news') {
    container.innerHTML = `<div class="surprise-news">📰 ${content}</div>`;
  } else {
    container.innerHTML = `<div class="surprise-text">${content}</div>`;
  }

  surprisePanel.appendChild(container);

  // 反馈按钮
  const feedback = document.createElement('div');
  feedback.className = 'surprise-feedback';
  feedback.innerHTML = `
    <button class="fb-btn fb-like" data-vote="1">👍</button>
    <button class="fb-btn fb-dislike" data-vote="-1">👎</button>
  `;
  feedback.addEventListener('click', (e) => {
    const btn = e.target.closest('.fb-btn');
    if (!btn) return;
    const vote = parseInt(btn.dataset.vote);
    window.electronAPI.sendFeedback('push', surprise.id || Date.now().toString(), vote);
    btn.classList.add('active');
    setTimeout(() => {
      surprisePanel.classList.remove('visible');
      updateWindowShape('character');
    }, 500);
  });
  surprisePanel.appendChild(feedback);

  // 惊喜面板展开到全窗口
  updateWindowShape('full');

  // 自动隐藏
  setTimeout(() => {
    surprisePanel.classList.remove('visible');
    updateWindowShape('character');
  }, 15000);
}

// 点击空白处关闭面板
document.addEventListener('click', (e) => {
  if (surprisePanel.classList.contains('visible') && !surprisePanel.contains(e.target) && e.target !== characterEl) {
    // 不关闭（让面板自然超时消失）
  }
});

// ============================================================
// 人格选择器
// ============================================================
async function openPersonalityPicker() {
  const personalities = await window.electronAPI.getPersonalities();
  const active = await window.electronAPI.getActivePersonality();

  personalityPicker.innerHTML = '<div class="picker-header">🎭 切换人格</div>';
  personalityPicker.classList.add('visible');
  updateWindowShape('full');

  personalities.forEach(p => {
    const card = document.createElement('div');
    card.className = `personality-card ${p.id === active?.id ? 'active' : ''}`;
    card.style.setProperty('--accent', p.iconColor || '#E8D5F5');
    card.innerHTML = `
      <div class="personality-name">${p.name}</div>
      <div class="personality-tags">${(p.tags || []).join(' · ')}</div>
    `;
    card.addEventListener('click', async () => {
      await window.electronAPI.switchPersonality(p.id);
      personalityPicker.classList.remove('visible');
      updateWindowShape('character');
    });
    personalityPicker.appendChild(card);
  });

  const closeBtn = document.createElement('button');
  closeBtn.className = 'picker-close';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => {
    personalityPicker.classList.remove('visible');
    updateWindowShape('character');
  });
  personalityPicker.appendChild(closeBtn);
}

// 右键打开人格选择器
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (characterEl.contains(e.target)) {
    openPersonalityPicker();
  }
});

// ============================================================
// 设置面板
// ============================================================
async function openSettings() {
  const prefs = await window.electronAPI.getPreferences();
  const schedule = await window.electronAPI.getSchedule();
  const apiConfig = await window.electronAPI.getApiConfig();

  settingsPanel.innerHTML = `
    <div class="settings-header">⚙️ 设置</div>
    <div class="settings-body">
      <label>清醒时间 <input type="time" id="s-wake" value="${schedule.wakeUp || '08:00'}"></label>
      <label>睡眠时间 <input type="time" id="s-sleep" value="${schedule.sleepTime || '22:00'}"></label>
      <label>活跃频率
        <select id="s-frequency">
          <option value="high" ${prefs.activeFrequency === 'high' ? 'selected' : ''}>话痨</option>
          <option value="normal" ${prefs.activeFrequency === 'normal' ? 'selected' : ''}>正常</option>
          <option value="low" ${prefs.activeFrequency === 'low' ? 'selected' : ''}>高冷</option>
          <option value="quiet" ${prefs.activeFrequency === 'quiet' ? 'selected' : ''}>安静</option>
        </select>
      </label>
      <label>每日对话限额 <input type="number" id="s-chat-limit" value="${prefs.dailyChatLimit || 20}" min="1" max="100"></label>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">🤖 AI 对话设置</div>
      <label class="settings-toggle">
        <span>启用 AI 对话</span>
        <input type="checkbox" id="s-api-enabled" ${apiConfig.enabled ? 'checked' : ''}>
      </label>
      <div id="api-config-fields" class="api-config-fields" style="${apiConfig.enabled ? '' : 'display:none;'}">
        <label>
          <span>API 地址</span>
          <input type="text" id="s-api-endpoint" value="${apiConfig.endpoint || 'https://api.deepseek.com/v1/chat/completions'}" placeholder="https://api.deepseek.com/v1/chat/completions">
        </label>
        <label>
          <span>API Key</span>
          <input type="password" id="s-api-key" value="${apiConfig.apiKey || ''}" placeholder="sk-...">
        </label>
        <label>
          <span>模型</span>
          <input type="text" id="s-api-model" value="${apiConfig.model || 'deepseek-chat'}" placeholder="deepseek-chat">
        </label>
        <label>
          <span>温度 (0-2)</span>
          <input type="range" id="s-api-temperature" min="0" max="2" step="0.1" value="${apiConfig.temperature || 0.8}">
          <span id="s-api-temp-value" class="range-value">${apiConfig.temperature || 0.8}</span>
        </label>
        <label>
          <span>最大 Token</span>
          <input type="number" id="s-api-max-tokens" value="${apiConfig.maxTokens || 200}" min="50" max="2000" step="50">
        </label>
      </div>
    </div>
    <div class="settings-footer">
      <button id="s-save">保存</button>
      <button id="s-close">关闭</button>
    </div>
  `;
  settingsPanel.classList.add('visible');
  updateWindowShape('full');

  // Toggle API config fields visibility
  document.getElementById('s-api-enabled').addEventListener('change', (e) => {
    const fields = document.getElementById('api-config-fields');
    fields.style.display = e.target.checked ? '' : 'none';
  });

  // Update temperature display
  document.getElementById('s-api-temperature').addEventListener('input', (e) => {
    document.getElementById('s-api-temp-value').textContent = parseFloat(e.target.value).toFixed(1);
  });

  document.getElementById('s-save').addEventListener('click', async () => {
    await window.electronAPI.setSchedule({
      wakeUp: document.getElementById('s-wake').value,
      sleepTime: document.getElementById('s-sleep').value,
    });
    await window.electronAPI.setPreferences({
      activeFrequency: document.getElementById('s-frequency').value,
      dailyChatLimit: parseInt(document.getElementById('s-chat-limit').value),
    });
    // Save API config
    await window.electronAPI.setApiConfig({
      enabled: document.getElementById('s-api-enabled').checked,
      endpoint: document.getElementById('s-api-endpoint').value,
      apiKey: document.getElementById('s-api-key').value,
      model: document.getElementById('s-api-model').value,
      temperature: parseFloat(document.getElementById('s-api-temperature').value),
      maxTokens: parseInt(document.getElementById('s-api-max-tokens').value),
    });
    settingsPanel.classList.remove('visible');
    updateWindowShape('character');
    showCharacterBubble('设置已保存！', 'normal');
  });

  document.getElementById('s-close').addEventListener('click', () => {
    settingsPanel.classList.remove('visible');
    updateWindowShape('character');
  });
}

// ============================================================
// 初始化
// ============================================================
async function init() {
  // 加载状态
  try {
    const sleepState = await window.electronAPI.getSleepState();
    state.sleepState = sleepState.state;
    document.body.dataset.sleepState = sleepState.state;
  } catch (err) {
    console.error('Failed to get sleep state:', err);
  }

  try {
    const personality = await window.electronAPI.getActivePersonality();
    if (personality) {
      state.currentPersonality = personality;
      document.body.dataset.personality = personality.id;
    }
  } catch (err) {
    console.error('Failed to get personality:', err);
  }

  try {
    // 获取今日惊喜
    const surprise = await window.electronAPI.getDailySurprise();
    if (surprise) {
      setTimeout(() => showSurprise(surprise), 1000);
    }
  } catch (err) {
    console.error('Failed to get daily surprise:', err);
  }

  // 窗口初始设为角色区域裁剪（面板关闭时只显示角色）
  // 延迟执行确保 DOM 布局已完成
  setTimeout(() => updateWindowShape('character'), 500);

  // 监听托盘菜单"设置"按钮
  window.electronAPI.onOpenSettings(() => {
    openSettings();
  });
}

// 暴露给其他模块
window.__desktopCompanion = {
  state,
  showCharacterBubble,
  showSurprise,
  enterChatMode,
  exitChatMode,
  openPersonalityPicker,
  openSettings,
};

// 启动
document.addEventListener('DOMContentLoaded', init);
