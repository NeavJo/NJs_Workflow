# 每日工作流勾选动效（MHW 风格）实施计划

## Repository Research

**当前交互结构**（`src/js/workflow/workflow-renderer.js` + `workflow-events.js`）：
- 每个任务卡右侧有 `<label class="checkbox-wrapper">`，内含一个隐藏 `<input type="checkbox">` 和一个视觉容器 `<span class="checkbox-mark">`。
- 勾选图标使用 Material Symbols 字体（`check` / `lock` / `pause`），通过 `input:checked + .checkbox-mark` 控制颜色与背景。
- 勾选流程：`change` 事件 → `toggleItemThrottled(id)` → `toggleCompleted(id)` → `renderWorkflow()`（**全量重渲染 `#workflow-list`**）。
- 关键约束：`renderWorkflow()` 会销毁并重建所有卡片 DOM，因此纯 `:checked` 驱动的 CSS 动画在**首次加载**时会让所有已完成任务同时播放勾选动画。必须用 JS 给「刚刚被用户操作的那张卡」打临时标记类，动画只挂在该类上。

**现有样式**（`src/css/workflow.css` L54-L67）：
- `.checkbox-mark`：40×40、2px 边框、13px 圆角，`transition` 用 `--md-motion-standard`（220ms）。
- 已完成态：`background: var(--md-primary)`，无阴影、无发光。
- `.workflow-card.is-complete` 卡片背景为 `success-container` 混合色。

**响应式**（`responsive.css` L161-L172）：
- 移动端 `.checkbox-mark` 缩小为 34×34、10px 圆角。
- `prefers-reduced-motion` 块（L429+）已将 `.workflow-card` 的 `transform` 置为 `none`，新增动效需在此块中一并降级。

## 设计方向：怪物猎人·世界 的「厚重感 + 灵动光效」

| 维度 | 厚重感（Heavy） | 灵动光效（Dynamic Light） |
|---|---|---|
| 复选框本体 | 更粗边框(2.5px)、内凹阴影(inset)、金属渐变底色 | 勾选后发光描边 + 高光扫过(shimmer) |
| 勾选动作 | 按下回弹(scale 0.85→1.12→1.0)，带轻微缓动 | 中心爆出双圈光环(ring burst)，扩散消散 |
| 对勾 | Material 图标缩放弹入 + 微小旋转 | 描边发光(color + text-shadow) |
| 取消勾选 | 对勾收缩淡出 + 边框去光 | 光环回收收缩(ring retract) |
| 卡片 | 完成态边框微亮、阴影加深 | 勾选瞬间整卡金色辉光脉冲一次 |

色彩：沿用现有 `--md-primary`（紫）作为勾选主色，发光用 `color-mix(var(--md-primary), transparent)` 叠加，不引入新色板，保证与 Material You 主题一致。

## Files and Modules

- `src/css/workflow.css`：重写 `.checkbox-mark` 基础样式（厚重感），新增 `.is-just-checked` / `.is-just-unchecked` 触发的动画关键帧（`mhw-check-pop`、`mhw-ring-burst`、`mhw-shimmer`、`mhw-uncheck-shrink`、`mhw-ring-retract`），以及卡片级 `.is-just-checked::after` 金色辉光脉冲。
- `src/js/workflow/workflow-events.js`：在 `toggleItem()` 中 `renderWorkflow()` 之后，通过 `requestAnimationFrame` 给被操作卡片追加 `is-just-checked` 或 `is-just-unchecked` 类，600ms 后移除（动画时长 + 缓冲）。
- `src/css/responsive.css`：在 `prefers-reduced-motion` 块中禁用新增的 transform / animation，确保可访问性。

## Implementation Steps

1. **CSS：复选框本体厚重化**（`workflow.css`）
   - `.checkbox-mark` 边框 2px → 2.5px，新增 `box-shadow: inset 0 1px 2px rgba(0,0,0,.18)` 内凹阴影。
   - `input:checked + .checkbox-mark` 背景改为 `linear-gradient(135deg, var(--md-primary), color-mix(in srgb, var(--md-primary) 65%, #fff))`，新增 `box-shadow` 外发光 `0 0 10px color-mix(in srgb, var(--md-primary) 55%, transparent)`。
   - 对勾图标 `.checkbox-mark .material-symbols` 在 checked 时加 `text-shadow: 0 0 6px color-mix(in srgb, var(--md-on-primary) 60%, transparent)` 增强光感。

2. **CSS：勾选动画关键帧**（`workflow.css`）
   - `.workflow-card.is-just-checked .checkbox-mark` → `animation: mhw-check-pop 0.5s var(--md-ease-emphasized-decelerate)`（0.85→1.12→0.97→1.0）。
   - `.workflow-card.is-just-checked .checkbox-mark::after`（光扫）：绝对定位、渐变条，`animation: mhw-shimmer 0.6s ease-out forwards`，从左扫到右。
   - `.workflow-card.is-just-checked .checkbox-wrapper::before`（光环）：绝对定位圆形，`animation: mhw-ring-burst 0.65s ease-out forwards`，scale 0.4→2.2，opacity 0.7→0。
   - `.workflow-card.is-just-checked::after`（卡片辉光）：`box-shadow` 脉冲，`animation: mhw-card-glow 0.6s ease-out forwards`。

3. **CSS：取消勾选动画**（`workflow.css`）
   - `.workflow-card.is-just-unchecked .checkbox-mark` → `animation: mhw-uncheck-shrink 0.35s ease-in`（scale 1→0.8, opacity 1→0.4→1，颜色回退）。
   - `.workflow-card.is-just-unchecked .checkbox-wrapper::before` → `animation: mhw-ring-retract 0.35s ease-in forwards`（scale 1.8→0.4，回收）。
   - 注意：取消勾选时 `:checked` 已移除，对勾图标内容变回空字符串，所以收缩动画主要作用于容器本身。

4. **JS：临时动画类注入**（`workflow-events.js`）
   - 在 `toggleItem()` 内，`after = toggleCompleted(id)` 并 `renderWorkflow()` 之后：
     ```js
     const card = document.querySelector(`[data-item-id="${id}"]`)?.closest('.workflow-card')
     if (card) {
       const cls = after ? 'is-just-checked' : 'is-just-unchecked'
       card.classList.add(cls)
       setTimeout(() => card.classList.remove(cls), 650)
     }
     ```
   - 用 `requestAnimationFrame` 包裹确保类在重渲染后的下一帧添加（让浏览器先应用基础样式，再触发动画）。

5. **CSS：可访问性降级**（`responsive.css`）
   - 在已有 `prefers-reduced-motion` 媒体块中，对 `.is-just-checked .checkbox-mark`、`.is-just-checked .checkbox-wrapper::before`、`.is-just-unchecked .checkbox-mark` 等设置 `animation: none !important`，保留状态切换但不播放运动。

## Dependencies and Considerations

- `renderWorkflow()` 全量重渲染是核心约束——动画类必须在重渲染**之后**由 JS 添加，且只加给被操作的单张卡。已完成任务首次加载时不会有 `is-just-checked` 类，因此不会误播动画。
- `checkbox-wrapper` 是 `label`，新增 `::before` 光环需设 `position: relative` 给 `.checkbox-wrapper` 作为定位上下文，并设 `pointer-events: none` 避免拦截点击。
- 移动端 `.checkbox-mark` 34px，光环尺寸需用 `em` 或百分比相对单位，避免写死像素导致错位。
- `.workflow-card` 已有 `overflow: hidden`（L15），卡片辉光 `::after` 不会溢出；光环 `::before` 在 `.checkbox-wrapper` 内，若超出卡片需确认不被裁剪——给 `.checkbox-wrapper` 设 `overflow: visible`。
- 节流 `toggleItemThrottled` 300ms 内重复点击只放行一次，动画类的 `setTimeout(650ms)` 不会与节流冲突。

## Validation

- `npm run build` 构建通过。
- 手动验证（dev server）：
  - 勾选一个未完成任务 → 复选框按下回弹、光环爆出、对勾弹入、卡片金色辉光一闪。
  - 取消勾选 → 对勾收缩、光环回收、边框去光。
  - 首次加载页面 → 已完成任务**不**播放勾选动画。
  - 已搁置 / 已锁定 / 前置未解锁任务点击 → 无动画（因为走 `renderWorkflow()` 前的拦截分支，不进入 toggle 成功路径）。
  - 移动端（≤680px）→ 动效正常，光环尺寸与 34px 复选框匹配。
  - `prefers-reduced-motion` → 动画禁用，状态切换即时。

## Risks

- **光环被 `overflow: hidden` 裁剪**：`.workflow-card` 有 `overflow: hidden`，但光环挂在 `.checkbox-wrapper::before` 上，`.checkbox-wrapper` 在卡片内部网格中。若光环扩散超出卡片右边界会被裁。处理：光环 `scale` 上限控制在 2.0 以内，或给卡片右侧留 padding（已有 20px padding）。实测验证后调整。
- **动画类残留**：若 `renderWorkflow()` 在 650ms 内被其它事件再次触发（如批量操作），卡片 DOM 被重建，类自动消失，无残留风险。
- **Material Symbols 图标无法描边动画**：对勾是字体图标，不能做 stroke-dashoffset 描边动画。用 scale + rotate + text-shadow 发光替代，效果足够灵动。若后续追求描边绘制，可单独替换为内联 SVG `<path>`，本次不做。
