# NJ's Workflow

基于 Vite 的原生 HTML、CSS、JavaScript 工作流页面，采用 Material You 设计语言。

## 快速开始

```bash
npm install
npm run dev
```

Windows 用户可以双击 `start-dev.bat` 自动安装依赖并启动开发服务器。

## 常用命令

- `npm run dev`：启动开发服务器并开启热更新
- `npm run build`：构建生产文件
- `npm run preview`：预览生产构建

## 目录

- `src/css/material.css`：Material You 主题变量（颜色、间距、字体、动效曲线）
- `src/css/index.css`：样式入口，按依赖顺序聚合 `base / layout / button / toast / modal / workflow / memo / rotation / settings / backup / editor / task-form / responsive` 等 13 个模块
- `src/js/app.js`：启动入口（bootstrap），仅做装配：装载持久化状态 → 注入运行时依赖 → 渲染初始 UI → 绑定事件 → 跨天校验 → 启动 Gist 自动同步 → 注册可见性 + Debug 钩子
- `src/js/ui.js`：进度条与 toast 提示
- `src/js/config.js`：对 `config/*.js` 的转发层，向后兼容
- `src/js/core/`：`debug / storage / date / settings-store` 这类与领域无关的工具
- `src/js/config/`：默认数据（工作流 / 轮换规则 / 标签 / 存储 key 归一化）
- `src/js/workflow/`：工作流领域 stores（rotation / workflow / completion / history） + renderer + events + runtime
- `src/js/memo/`：生词本 stores（memo / parser / retention） + renderer + events
- `src/css/settings.css`：`设置与数据`顶级视图的布局、英雄区与子页面切换样式
- `src/js/settings/`：顶级设置视图 + 子页面导航 + 编辑器与任务表单模态（`navigation` / `modal` / `tag-settings` / `workflow-editor` / `task-form` / `rotation-editor`），由 `index.js` 统一绑定并通过 `registerViewHook()` 向 `navigation.js` 注册渲染钩子
- `src/js/backup/`：本地文件导出 / 导入、原子写入、GitHub Gist 双向同步、每日重置 UI

## 页面与导航

应用侧边导航控制三个并列顶级视图，由 `src/js/settings/navigation.js` 统一调度：

- `每日工作流`（`data-view="flow"`）：默认视图，展示当天工作流、完成进度与轮换规则入口
- `生词记事本`（`data-view="memo"`）：当日生词快速记录、标签切换与卡片流
- `设置与数据`（`data-view="settings"`）：数据备份、Gist 同步、工作流编辑、生词本标签管理的入口

设置页内部仍保留子页面切换（`data-settings-view`，由 `switchSettingsView()` 驱动），子页面包括主菜单、数据备份、工作流管理、生词本标签管理。子页面 Esc 行为默认为返回主菜单；其他模态（编辑器、任务表单、轮换规则编辑器）继续沿用 `closeModal()`。

## 模块化约束

- 每个 JS / CSS 模块均控制在 500 行以内，便于单独理解与重构
- 业务逻辑按 `state → service → render → event` 四层分文件
- 跨模块依赖通过显式 import + 暴露函数，副作用靠 ES 模块自身机制统一触发；顶级视图渲染与导航之间通过 `registerViewHook()` 解耦
- 调试探针：浏览器控制台执行 `window.debugNJ()` 可拿到内存实时快照
