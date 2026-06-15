# 拖拽 + 点击 问题记录

> 最后更新: 2026-06-15

## 当前状态

| 功能 | 状态 | 说明 |
|------|------|------|
| 点击角色进聊天 | ✅ 可用 | `#character-container` 设为 `-webkit-app-region: no-drag` |
| 透明区域拖拽 | ❌ 拖不动 | `body` 设为 `-webkit-app-region: drag`，光标变移动样式但窗口不动 |

## 问题根因

Windows 上 Electron frameless + transparent 窗口的拖拽和点击互斥：

1. **`-webkit-app-region: drag`**：OS 原生拖拽，坐标完美，但吞掉所有 DOM 事件（click/mousedown/mouseup 全无效）
2. **`-webkit-app-region: no-drag`**：DOM 事件正常，但只能用 JS 算坐标拖拽
3. **JS 拖拽的坐标问题**：Windows 上 `setPosition(N)` 实际落到 `getPosition() = N-1`，每帧 -1px 累积偏移
4. **hookWindowMessage 不可用**：`WM_NCLBUTTONDOWN` (0x00A1) 被 Electron 内部消费，hook 根本触发不到
5. **透明像素不响应 drag**：`transparent: true` 窗口的透明区域，`WM_NCHITTEST` 可能返回 `HTNOWHERE` 而非 `HTCAPTION`，导致 body 的 drag 区域拖不动

## 已尝试的方案

### 方案 1: JS 坐标拖拽（e.clientX/Y delta）
- 结果：TypeError → 修复后偏移
- 失败原因：clientX/Y 是 CSS 像素，与 getPosition()/setPosition() 坐标系不一致

### 方案 2: JS 坐标拖拽（e.screenX/Y delta）
- 结果：偏移
- 失败原因：e.screenX 返回浮点数（如 -2.4000244140625），Math.round 累积误差

### 方案 3: screen.getCursorScreenPoint() + 总 delta
- 结果：偏移
- 失败原因：setPosition(N) 实际 N-1，常数偏移 + 误差累积

### 方案 4: screen.getCursorScreenPoint() + 增量模式
- 结果：偏移
- 失败原因：setPosition 的 -1px 误差在增量模式下也累积

### 方案 5: setBounds 替代 setPosition
- 结果：未测试（切换到了方案 6）
- 备注：setBounds 是原子操作，可能没有 -1px 偏差，值得后续测试

### 方案 6: -webkit-app-region: drag（角色本体）
- 结果：拖拽完美，点击完全失效
- 失败原因：Windows 上 drag 区域吞掉所有 DOM 事件

### 方案 7: hookWindowMessage(WM_NCLBUTTONUP) 检测点击
- 结果：点击检测不到
- 失败原因：WM_NCLBUTTONDOWN 被 Electron 内部消费，hook 触发不到；OS 拖拽模态循环也吞掉 NCLBUTTONUP

### 方案 8: hookWindowMessage(WM_ENTERSIZEMOVE) + 定时器
- 结果：点击检测不到
- 失败原因：同上，WM_NCLBUTTONDOWN 触发不到，定时器无法启动

### 方案 9（当前）: 分区 — body=drag, character=no-drag
- 结果：点击可用，透明区域拖不动
- 失败原因：transparent 窗口的透明像素不响应 HTCAPTION

## 后续修复方向

### 方向 A: 让透明区域可拖拽
- 在透明区域放一个带极微透明背景的 drag 层（`background: rgba(0,0,0,0.01)`）
- 让 WM_NCHITTEST 返回 HTCAPTION 而非 HTNOWHERE
- **优先级：高**（改动最小，最可能生效）

### 方向 B: 回到 JS 拖拽，用 setBounds
- `-webkit-app-region: no-drag` 全局，用 screen.getCursorScreenPoint() + setBounds
- setBounds 可能没有 setPosition 的 -1px 偏差
- **优先级：中**

### 方向 C: 原生 Node addon
- 用 node-ffi-napi 或类似方案直接调用 Win32 MoveWindow
- 可以精确控制窗口位置，绕过 Electron 的 setPosition 偏差
- **优先级：低**（复杂度高，依赖多）

## 关键诊断数据

系统 DPI = 96（100% 缩放），排除 DPI 坐标系不一致的可能。

setPosition 偏差示例（来自 debuglog）：
```
setPosition(1234, 463) → getPosition() = (1233, 462)  // -1,-1
setPosition(1226, 462) → getPosition() = (1225, 461)  // -1,-1
setPosition(1202, 455) → getPosition() = (1201, 454)  // -1,-1
```

e.screenX 浮点数示例：
```
dx=-2.4000244140625  dy=-0.800048828125
dx=-99.199951171875  dy=-25.60003662109375
```

hookWindowMessage 测试结果：
- 点击角色：无任何 [HOOK] 日志（WM_NCLBUTTONDOWN 未触发）
- 拖动角色：[HOOK] WM_ENTERSIZEMOVE / WM_EXITSIZEMOVE 正常触发
