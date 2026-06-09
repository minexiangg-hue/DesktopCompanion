/**
 * character-renderer.js — 角色渲染引擎
 *
 * 管理 SVG 角色的动画状态机。
 * 控制表情切换、动画状态、睡眠/清醒视觉表现。
 *
 * 架构说明：
 * SVG 通过 <object> 加载，其 DOM 与宿主页面隔离。
 * 因此动画 CSS 必须注入到 SVG 文档内部，而非依赖宿主页面的 CSS。
 * 所有 .state-* 类名应用在 SVG 根元素 <svg> 上。
 *
 * 依赖: character.svg (data-emotion 属性控制表情)
 *        animations.css (@keyframes 定义动画，注入 SVG 文档内)
 */

// ============================================================
// 状态定义
// ============================================================

// CSS 中实际使用的 state 类名映射
const STATE_CLASSES = {
  'idle': 'state-idle',
  'idle-breathing': 'state-idle',
  'blink': 'state-idle',        // 眨眼是 idle 状态的一部分
  'wake-up': 'state-wake-up',
  'talking': 'state-talking',
  'fall-asleep': 'state-fall-asleep',
  'sleeping': 'state-sleeping',
  'hide': 'state-hide',
};

const STATE_CLASS_LIST = Object.values(STATE_CLASSES).filter((v, i, a) => a.indexOf(v) === i);

const ANIMATION_STATES = {
  IDLE: 'idle',
  IDLE_BREATHING: 'idle-breathing',
  BLINK: 'blink',
  WAKE_UP: 'wake-up',
  TALKING: 'talking',
  FALL_ASLEEP: 'fall-asleep',
  SLEEPING: 'sleeping',
  HIDE: 'hide',
};

const EMOTIONS = {
  HAPPY: 'happy',
  SAD: 'sad',
  SURPRISED: 'surprised',
  SLEEPY: 'sleepy',
  TSUNDERE: 'tsundere',
  PANIC: 'panic',
  DEADPAN: 'deadpan',
};

// ============================================================
// 状态
// ============================================================

let currentAnimation = ANIMATION_STATES.IDLE;
let currentEmotion = EMOTIONS.HAPPY;
let animationFrame = null;
let isInitialized = false;

// SVG 文档引用 (通过 <object> 加载后获取)
let svgDoc = null;
let svgRoot = null;

// ============================================================
// 初始化
// ============================================================

function init(svgObjectElement) {
  if (isInitialized) return;
  isInitialized = true;

  if (!svgObjectElement) {
    svgObjectElement = document.getElementById('character-svg');
  }

  if (svgObjectElement) {
    // SVG 加载完成后注入动画 CSS
    if (svgObjectElement.contentDocument) {
      injectAnimationCSS(svgObjectElement);
    } else {
      svgObjectElement.addEventListener('load', () => {
        injectAnimationCSS(svgObjectElement);
      });
    }
  }

  // 开始待机呼吸动画和眨眼由 CSS 在 .state-idle 下自动处理
  setAnimationState(ANIMATION_STATES.IDLE_BREATHING);

  // 监听睡眠状态变化
  const body = document.body;
  const observer = new MutationObserver(() => {
    const sleepState = body.dataset.sleepState;
    if (sleepState === 'asleep') {
      goToSleep();
    } else if (sleepState === 'awake') {
      wakeUp();
    }
  });
  observer.observe(body, { attributes: true, attributeFilter: ['data-sleep-state'] });
}

/**
 * 读取 animations.css 并注入到 SVG 文档中
 * 解决 <object> 标签的 CSS 隔离问题
 */
function injectAnimationCSS(svgObjectElement) {
  try {
    svgDoc = svgObjectElement.contentDocument;
    svgRoot = svgDoc?.documentElement;
    if (!svgDoc || !svgRoot) return;

    // 查找 SVG 内已有的 <style>
    let styleEl = svgDoc.querySelector('style');
    if (!styleEl) {
      styleEl = svgDoc.createElementNS('http://www.w3.org/2000/svg', 'style');
      svgDoc.documentElement.insertBefore(styleEl, svgDoc.documentElement.firstChild);
    }

    // 读取 animations.css 内容并注入
    const link = document.querySelector('link[href*="animations"]');
    if (link) {
      fetch(link.href)
        .then(r => r.text())
        .then(css => {
          styleEl.textContent += '\n/* Injected from animations.css */\n' + css;
        })
        .catch(() => {});
    }

    // 设置默认表情
    svgRoot.setAttribute('data-emotion', currentEmotion);
    // 设置默认动画状态
    applyStateToSVG(currentAnimation);
  } catch (e) {
    console.warn('CharacterRenderer: SVG injection error', e);
  }
}

/**
 * 将 state class 应用到 SVG 根元素
 */
function applyStateToSVG(state) {
  if (!svgRoot) return;

  // 移除所有 state class
  STATE_CLASS_LIST.forEach(cls => svgRoot.classList.remove(cls));

  // 添加当前 state class
  const className = STATE_CLASSES[state];
  if (className) {
    svgRoot.classList.add(className);
  }
}

// ============================================================
// 表情控制
// ============================================================

function setEmotion(emotion) {
  currentEmotion = emotion;

  // 通过 CSS 控制 SVG 表情 (data-emotion 属性)
  if (svgRoot) {
    svgRoot.setAttribute('data-emotion', emotion);
  }

  // 也通过 body 的 data 属性控制（备选方案）
  document.body.dataset.emotion = emotion;
}

/**
 * 根据人格 ID 映射默认表情
 */
function getEmotionForPersonality(personalityId) {
  const map = {
    'tsundere-cat': EMOTIONS.TSUNDERE,
    'joker': EMOTIONS.HAPPY,
    'big-sis': EMOTIONS.HAPPY,
    'professor': EMOTIONS.DEADPAN,
    'trump': EMOTIONS.HAPPY,
    'snarky-ai': EMOTIONS.DEADPAN,
  };
  return map[personalityId] || EMOTIONS.HAPPY;
}

// ============================================================
// 动画状态控制
// ============================================================

function setAnimationState(state) {
  currentAnimation = state;

  // 将 state class 应用到 SVG 根元素（CSS 注入后自动生效）
  applyStateToSVG(state);
}

// ============================================================
// 待机呼吸 — CSS 在 .state-idle 下自动驱动
// ============================================================

function startIdleBreathing() {
  if (currentAnimation === ANIMATION_STATES.SLEEPING ||
      currentAnimation === ANIMATION_STATES.FALL_ASLEEP) return;

  setAnimationState(ANIMATION_STATES.IDLE_BREATHING);
}

// ============================================================
// 眨眼 — CSS 在 .state-idle 下通过 @keyframes blinkAction 自动处理
// ============================================================

function stopBlinkCycle() {
  // 不再需要 JS 眨眼循环，.state-idle 下的 CSS @keyframes blinkAction 自动处理
}

// ============================================================
// 说话动画
// ============================================================

let talkingTimer = null;

function startTalking(duration = 2000) {
  if (talkingTimer) {
    clearTimeout(talkingTimer);
  }

  setAnimationState(ANIMATION_STATES.TALKING);
  setEmotion(EMOTIONS.HAPPY);

  // 说话期间嘴型切换由 SVG 注入的 CSS animation 自动处理
  talkingTimer = setTimeout(() => {
    stopTalking();
  }, duration);
}

function stopTalking() {
  if (talkingTimer) {
    clearTimeout(talkingTimer);
    talkingTimer = null;
  }
  setAnimationState(ANIMATION_STATES.IDLE_BREATHING);
}

// ============================================================
// 睡眠/唤醒动画
// ============================================================

function goToSleep() {
  // 停止眨眼
  stopBlinkCycle();

  // 播放入睡动画 (3s)
  setAnimationState(ANIMATION_STATES.FALL_ASLEEP);
  setEmotion(EMOTIONS.SLEEPY);

  // 3s 后切换到睡眠状态
  setTimeout(() => {
    setAnimationState(ANIMATION_STATES.SLEEPING);
    setEmotion(EMOTIONS.SLEEPY);
  }, 3000);
}

function wakeUp() {
  // 播放唤醒动画 (1.5s)
  setAnimationState(ANIMATION_STATES.WAKE_UP);

  // 1.5s 后切换到待机（CSS 自动处理呼吸和眨眼）
  setTimeout(() => {
    setEmotion(EMOTIONS.HAPPY);
    startIdleBreathing();
  }, 1500);
}

// ============================================================
// 展示惊喜时的表情
// ============================================================

function showSurpriseEmotion() {
  setEmotion(EMOTIONS.SURPRISED);
  setTimeout(() => {
    setEmotion(EMOTIONS.HAPPY);
  }, 2000);
}

// ============================================================
// 人格切换时更新角色外观
// ============================================================

function onPersonalityChanged(personality) {
  if (!personality) return;
  const emotion = getEmotionForPersonality(personality.id);
  setEmotion(emotion);
}

// ============================================================
// 公共接口
// ============================================================

const CharacterRenderer = {
  init,
  setEmotion,
  getEmotionForPersonality,
  setAnimationState,
  startTalking,
  stopTalking,
  goToSleep,
  wakeUp,
  showSurpriseEmotion,
  onPersonalityChanged,
  ANIMATION_STATES,
  EMOTIONS,
};

// 自动初始化
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => init());
} else {
  init();
}

// 暴露给 renderer.js 和其他模块
window.__characterRenderer = CharacterRenderer;
