/**
 * main.js — Electron 主进程入口
 *
 * 职责：
 * - 窗口管理（frameless/alwaysOnTop/click-through/拖拽）
 * - 系统托盘 + 开机自启
 * - IPC handlers（所有 preload.js 定义接口的后端实现）
 * - 模块加载（人格调度/睡眠调度/内容获取/聊天引擎）
 */

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');

// ============================================================
// 路径常量
// ============================================================
const DATA_DIR = path.join(__dirname, 'data');
const PERSONALITIES_DIR = path.join(__dirname, 'src', 'personalities');
const ASSETS_DIR = path.join(__dirname, 'src', 'assets');

// ============================================================
// 模块加载
// ============================================================
const PersonalityScheduler = require('./src/js/personality-scheduler');
const SleepScheduler = require('./src/js/sleep-scheduler');
const ContentFetcher = require('./src/js/content-fetcher');
const ChatEngine = require('./src/js/chat-engine');
const UserPreferences = require('./src/js/user-preferences');
const AvataraIntegration = require('./src/js/avatar-integration');

// ============================================================
// 模块引用
// ============================================================
let personalityScheduler = null;
let sleepScheduler = null;
let contentFetcher = null;
let chatEngine = null;
let userPrefs = null;
let avataraIntegration = null;

// ============================================================
// 窗口状态
// ============================================================
let mainWindow = null;
let tray = null;
let isQuitting = false;

// ============================================================
// 窗口管理器
// ============================================================
function createWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: 280,
    height: 320,
    x: screenWidth - 300,
    y: screenHeight - 360,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // 默认不穿透点击（让用户可以点击角色）
  // 渲染进程通过 IPC 请求切换穿透模式时再调 setIgnoreMouseEvents
  mainWindow.setIgnoreMouseEvents(false);

  // IPC handler: 切换窗口穿透模式
  ipcMain.on('window:setClickThrough', (_event, ignore) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setIgnoreMouseEvents(ignore, { forward: true });
    }
  });

  // 防止关闭时退出（隐藏到托盘）
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

// ============================================================
// 系统托盘
// ============================================================
function createTray() {
  const iconPath = path.join(ASSETS_DIR, 'icons', 'tray-awake.svg');
  let trayIcon;
  try {
    const svgContent = fs.readFileSync(iconPath, 'utf-8');
    trayIcon = nativeImage.createFromBuffer(Buffer.from(svgContent), { width: 16, height: 16 });
    if (trayIcon.isEmpty()) trayIcon = nativeImage.createEmpty();
  } catch {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('DesktopCompanion');

  const contextMenu = Menu.buildFromTemplate([
    { label: '显示', click: () => mainWindow?.show() },
    { label: '今日惊喜', click: async () => {
      const surprise = contentFetcher ? await contentFetcher.getDailySurprise() : null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('daily:surpriseReady', surprise);
      }
    } },
    { type: 'separator' },
    { label: '切换人格', submenu: [] }, // 动态填充
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } },
  ]);

  tray.setContextMenu(contextMenu);
  tray.setIgnoreDoubleClickEvents(true);

  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    }
  });
}

/**
 * 更新托盘菜单中的人格子菜单
 */
function updateTrayPersonalityMenu() {
  if (!tray || !personalityScheduler) return;

  const personalities = personalityScheduler.getAll();
  const activePersonality = personalityScheduler.getActive();

  const personalitySubmenu = personalities.map(p => ({
    label: p.id === activePersonality?.id ? `✓ ${p.name}` : p.name,
    click: () => {
      if (personalityScheduler.switchTo(p.id)) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('personality:changed', personalityScheduler.getActive());
        }
        updateTrayPersonalityMenu();
      }
    },
  }));

  // 重建菜单
  const contextMenu = Menu.buildFromTemplate([
    { label: '显示', click: () => mainWindow?.show() },
    { label: '今日惊喜', click: async () => {
      const surprise = contentFetcher ? await contentFetcher.getDailySurprise() : null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('daily:surpriseReady', surprise);
      }
    } },
    { type: 'separator' },
    { label: '切换人格', submenu: personalitySubmenu },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } },
  ]);

  tray.setContextMenu(contextMenu);
}

/**
 * 根据睡眠状态更新托盘图标
 */
function updateTrayIcon(state) {
  if (!tray) return;

  const iconName = state === 'asleep' ? 'tray-asleep.svg' : 'tray-awake.svg';
  const iconPath = path.join(ASSETS_DIR, 'icons', iconName);
  let trayIcon;
  try {
    const svgContent = fs.readFileSync(iconPath, 'utf-8');
    trayIcon = nativeImage.createFromBuffer(Buffer.from(svgContent), { width: 16, height: 16 });
    if (trayIcon.isEmpty()) trayIcon = nativeImage.createEmpty();
  } catch {
    trayIcon = nativeImage.createEmpty();
  }
  tray.setImage(trayIcon);

  const label = state === 'asleep' ? '💤 睡着了' : '✨ 清醒中';
  tray.setToolTip(`DesktopCompanion — ${label}`);
}

// ============================================================
// IPC Handlers — 人格系统
// ============================================================
ipcMain.handle('personality:list', async () => {
  if (!personalityScheduler) return [];
  return personalityScheduler.getAll();
});

ipcMain.handle('personality:getActive', async () => {
  if (!personalityScheduler) return null;
  return personalityScheduler.getActive();
});

ipcMain.handle('personality:switch', async (_event, id) => {
  if (!personalityScheduler) return false;
  const result = personalityScheduler.switchTo(id);
  if (result && mainWindow) {
    mainWindow.webContents.send('personality:changed', personalityScheduler.getActive());
    updateTrayPersonalityMenu();
  }
  return result;
});

// ============================================================
// IPC Handlers — 每日惊喜
// ============================================================
ipcMain.handle('daily:getSurprise', async () => {
  if (!contentFetcher) return null;
  const surprise = await contentFetcher.getDailySurprise();
  return surprise;
});

// ============================================================
// IPC Handlers — 聊天系统
// ============================================================
ipcMain.handle('chat:respond', async (_event, message) => {
  if (!chatEngine) return '（暂时无法回应）';
  return chatEngine.respond(message);
});

// ============================================================
// IPC Handlers — 睡眠系统
// ============================================================
ipcMain.handle('sleep:getState', async () => {
  if (!sleepScheduler) return { state: 'awake' };
  return sleepScheduler.getState();
});

ipcMain.handle('sleep:getSchedule', async () => {
  if (!sleepScheduler) return { wakeUp: '08:00', sleepTime: '22:00' };
  return sleepScheduler.getSchedule();
});

ipcMain.handle('sleep:setSchedule', async (_event, config) => {
  if (!sleepScheduler) return false;
  sleepScheduler.setSchedule(config);
  return true;
});

// ============================================================
// IPC Handlers — 反馈系统
// ============================================================
ipcMain.handle('feedback:send', async (_event, type, id, vote) => {
  if (!userPrefs) return false;
  return userPrefs.recordFeedback(type, id, vote);
});

// ============================================================
// IPC Handlers — 偏好
// ============================================================
ipcMain.handle('prefs:get', async () => {
  if (!userPrefs) return {};
  return userPrefs.getAll();
});

ipcMain.handle('prefs:set', async (_event, config) => {
  if (!userPrefs) return false;
  userPrefs.update(config);
  return true;
});

// ============================================================
// 应用生命周期
// ============================================================
app.whenReady().then(() => {
  createWindow();
  createTray();

  // ============================================================
  // 人格调度引擎初始化
  // ============================================================
  personalityScheduler = PersonalityScheduler;
  personalityScheduler.init(PERSONALITIES_DIR);

  // 加载默认人格（第一个人格）
  const allPersonalities = personalityScheduler.getAll();
  if (allPersonalities.length > 0) {
    personalityScheduler.switchTo(allPersonalities[0].id);
  }

  // 动态填充托盘菜单中的人格列表
  updateTrayPersonalityMenu();

  // ============================================================
  // 睡眠调度器初始化
  // ============================================================
  sleepScheduler = SleepScheduler;
  sleepScheduler.init(DATA_DIR);
  sleepScheduler.onStateChange((newState) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sleep:stateChanged', newState);
    }
    // 根据状态更新托盘图标
    updateTrayIcon(newState);
  });
  sleepScheduler.startTimer();

  // 设置开机自启
  app.setLoginItemSettings({
    openAtLogin: true,
    path: app.getPath('exe'),
  });

  // ============================================================
  // 用户偏好初始化
  // ============================================================
  userPrefs = new UserPreferences(DATA_DIR);
  userPrefs.init();

  // ============================================================
  // Avatara 用户画像集成
  // ============================================================
  avataraIntegration = new AvataraIntegration(DATA_DIR);
  avataraIntegration.init(__dirname);

  // ============================================================
  // 内容抓取器初始化（依赖人格调度器）
  // ============================================================
  contentFetcher = new ContentFetcher(DATA_DIR, personalityScheduler);
  contentFetcher.init();

  // ============================================================
  // 聊天引擎初始化（依赖人格调度器 + 睡眠调度器 + 偏好）
  // ============================================================
  chatEngine = new ChatEngine(personalityScheduler, sleepScheduler, userPrefs);
  chatEngine.init();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});
