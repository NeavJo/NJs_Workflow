# Inline Cell Info Overlay — 月览方格悬浮信息

## 概述

月览热力图的每个方格在 hover/click 时，脱离网格布局放大到约 120–140px，内部居中显示两行文字：日期和完成情况。

---

## 触发方式

| 平台 | 悬停 (hover) | 点击 (click/tap) |
|------|-------------|-----------------|
| 桌面端 | 鼠标移入 → 放大显示；移出 → 收起 | 点击 → 锁定放大状态；再点同一格 → 收起；点其他格 → 切换 |
| 移动端 | 不适用 | 轻触 → 放大显示；再点同一格 → 收起；点其他格 → 自动收起前一个，显示新格 |

- 同一时刻最多只有一个方格处于放大状态。
- click 会锁定状态（不会因鼠标移出而收起），需再次点击才能收起。

---

## 文字内容

两行文字，居中显示在放大的方格内：

```
  9月1日
  3/5
```

- 第一行：`x月x日`（中文日期格式）
- 第二行：`x/y`（已完成任务数 / 总任务数）
- 不显示百分比

---

## 视觉表现

### 方格放大

- **脱离布局**：放大后的方格使用 `position: fixed` 或 `position: absolute` + `z-index` 脱离 grid 布局，不推挤其他方格。
- **尺寸**：放大到约 **120–140px** 正方形（宽高一致）。
- **定位**：以原始方格中心为锚点，向四周扩展。如果上方空间不足，向下扩展；左右同理做边界保护。
- **背景**：保持原有颜色（基于 `--cell-opacity` 的渐变色），但放大后背景色更明显，确保文字可读。

### 文字样式

- **字体大小**：日期行约 13–14px，数字行约 11–12px
- **颜色**：固定白色 `#fff`（加轻微 text-shadow 提升可读性），不受方格背景色影响
- **对齐**：水平居中，垂直居中，两行之间有 2–3px 间距
- **字体权重**：日期行 `font-weight: 600`，数字行 `font-weight: 500`

### 动画效果

- **弹出动画**：方格从原始尺寸平滑放大到目标尺寸，带有轻微弹性效果
- 使用 `transform: scale()` + `transform-origin: center` 实现
- 过渡时间约 `0.22s`（与项目现有的 `--md-motion-standard` 一致）
- 文字在放大完成前淡入（opacity 0→1）
- 收起时反向动画

### 边框与阴影

- 放大后添加 `box-shadow` 增加层次感（如 `0 4px 20px rgba(0,0,0,0.15)`）
- 保持原有的 border-radius

---

## 移动端适配

- 移动端方格原始尺寸较小（约 35–40px），放大到 120–140px 后视觉效果更清晰。
- 放大方格仍脱离布局，不会撑开网格容器。
- 轻触放大后，点击其他区域（非方格区域）也可收起。

---

## 文件改动范围

1. **`src/js/workflow/monthly-view.js`**
   - `createCell()`: 在方格 DOM 中增加文字元素 `<span class="monthly-view__cell-label">`
   - `render()` 后重新绑定事件
   - 新增 `bindEvents()` 方法：为每个方格绑定 mouseenter/mouseleave/click 事件
   - 新增 `showCellInfo(cell)` 方法：将方格放大并显示文字
   - 新增 `hideCellInfo(cell)` 方法：收起方格，隐藏文字
   - 新增 `isLocked` 状态变量：跟踪 click 锁定的方格

2. **`src/css/monthly-view.css`**
   - 新增 `.monthly-view__cell-label` 样式（文字层，默认隐藏）
   - 新增 `.monthly-view__cell--expanded` 修饰类（放大状态）
   - 放大状态使用 `position: fixed` 或脱离 grid 的定位方式
   - 弹出动画 keyframes 或 transition

---

## 状态机

```
[idle] --hover--> [hovered] --移出--> [idle]
[idle] --click--> [locked]
[hovered] --click--> [locked]
[locked] --click同一格--> [idle]
[locked] --click其他格--> [locked:新格] (旧格收起)
```

---

## 边界情况

- **边缘方格**：放大后如果超出视口，需做边界保护（clamp 到视口内 8px 边距）
- **滚动时**：如果页面滚动，锁定状态的方格位置应跟随更新或自动收起
- **tooltip 残留**：确保收起时 DOM 状态干净，不残留放大样式
- **aria-label**：保持原有 aria-label 不变，放大状态不影响无障碍
