# 修复计划：前置任务表单变空白与数据被覆盖

## 背景
用户在前置任务列表中出现“五天前还好，突然变成空白”的现象，并怀疑前置任务功能失效。当前需要修复表单初始化、回显和保存链路，避免前置任务数据被意外清空。

## 根因
1. `task-form.js` 中 `populatePrerequisitesSelect()` 使用 `prereqCache` 和 `prereqLastCount`，但文件内没有声明这两个变量。
   - 触发 `ReferenceError` 后，`openTaskForm()` 后续的 `openModal('taskform')` 不会执行。
   - 用户侧表现为前置任务区域/表单空白，像功能失效。
2. 编辑已有任务时，当前代码先在表单其他字段设置阶段尝试回显前置任务勾选，但此时前置任务列表尚未生成。
   - 如果列表后续生成成功，旧勾选态不会恢复。
   - 如果用户直接保存，表单收集当前已勾选项，可能把原有 `prerequisites` 覆盖为空数组。

## 修复目标
- 让前置任务列表稳定生成，不再依赖未声明变量。
- 让编辑任务时重新打开表单能正确回显已保存的前置任务。
- 让保存时始终收集“当前可见 checkbox”的勾选状态，避免因为回显失败而清空数据。
- 保持新增任务、编辑任务、任务增删后列表刷新三条路径一致。

## 修复方案
### 1. 移除未声明的前置任务缓存
位置：`src/js/settings/task-form.js`

- 删除 `prereqCache` / `prereqLastCount` 相关分支。
- `populatePrerequisitesSelect(excludeId)` 每次调用都基于 `getWorkflows()` 重建可见列表，避免跨任务编辑时复用旧 DOM 导致顺序、隐藏、勾选态混乱。
- 列表生成后调用 `applyPrerequisitesSelection(taskId)` 统一回显。

### 2. 新增 `applyPrerequisitesSelection(taskId)`
位置：`src/js/settings/task-form.js`

- 编辑模式：读取当前任务的 `task.prerequisites`，逐个匹配 `taskform-prereq-list` 中的 checkbox 并设置 `checked`。
- 新增模式：清除所有 checkbox 勾选。
- 不依赖提前设置勾选，消除时序错误。

### 3. 修正保存逻辑
位置：`src/js/settings/task-form.js` 的 `handleTaskFormSubmit()`

- 保存 `prerequisites` 时继续从 `#taskform-prereq-list input[type="checkbox"]:checked` 收集。
- 但前提是列表已正确生成并完成回显，避免用户保存时空数组覆盖旧数据。
- 若当前任务缺少 `prerequisites` 字段，规范化为 `[]`，与 `workflow-store` / `workflow-config` 保持一致。

### 4. 安全边界
- 不回写历史数据；已经覆盖成空数组的数据不在本次修复范围内，只保证未来表单不再误清空。
- 不引入外部依赖。
- 不修改 `workflow-runtime.js` 的前置任务检查逻辑，除非后续发现新的运行时缺陷。

## 验收标准
1. `npm run build` 通过。
2. 编辑带 `prerequisites` 的任务时，打开任务表单后对应 checkbox 全部勾选。
3. 新增任务时，前置任务列表正常显示，不勾选。
4. 任务增删后再次打开表单，前置任务列表数量与任务列表一致，且排除自身。
5. 代码中不再存在未声明的 `prereqCache` / `prereqLastCount` 引用。
6. 不破坏现有“前置任务未满足时锁定检查按钮/自动打卡”的运行时行为。

## 影响文件
- `src/js/settings/task-form.js`

## 预期改动
- 删除未声明缓存变量相关逻辑。
- 重写 `populatePrerequisitesSelect()` 为稳定重建 + 回显。
- 新增 `applyPrerequisitesSelection(taskId)`。
- 在 `openTaskForm()` 中先渲染列表，再回显选中状态。