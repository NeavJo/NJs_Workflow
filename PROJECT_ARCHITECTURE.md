# NJsWorkflow 项目架构与维护指南

> 本文是 NJsWorkflow 的项目级架构说明、编码约定和维护指南，供开发者与后续 AI 模型在新增功能、修复问题和重构代码时参考。除非经过明确评估，不要为了短期方便破坏本文约定。

## 1. 文档目的

本文用于统一以下事项：

- 让维护者快速理解项目目录、启动流程和模块边界。
- 让后续 AI 模型按照现有架构修改代码，而不是重新形成单体实现。
- 统一状态管理、渲染、事件绑定、持久化和备份处理方式。
- 降低跨模块修改、数据迁移和 UI 回归的风险。

本文描述的是当前代码的实际组织方式。若代码发生结构性变化，应同步更新本文和 [README.md](./README.md)。

## 2. 项目概览

NJsWorkflow 是一个浏览器端个人工作流与 Memo 管理 SPA，主要能力包括：

- 工作流任务展示、完成状态记录和每日重置。
- 按轮换规则展示不同日期或分类的任务。
- Memo 快速记录、标签管理、分类解析和过期清理。
- JSON 备份导出、导入和数据恢复。
- GitHub Gist 数据上传与拉取。
- 三套并列的顶级视图（每日工作流 / 生词记事本 / 设置与数据），由侧边导航切换。
- Material You 风格的响应式界面。

设置是第三个顶级页面，而不是从主页齿轮按钮打开的模态框。原主页齿轮按钮已移除；设置内的功能（数据备份、工作流管理、生词本标签管理）以子页面形式呈现，子页面仍由 `navigation.js` 内的 `switchSettingsView()` 控制。

项目是前端本地应用，主要数据保存在浏览器 LocalStorage 中，不依赖后端服务。Gist 是可选的云端同步渠道，不应被视为所有功能的必需依赖。

## 3. 技术栈与常用命令

### 技术栈

- Vite 7.x
- 原生 HTML
- 原生 CSS
- 原生 JavaScript ES Modules
- 浏览器 LocalStorage
- GitHub Gist API
- CSS Custom Properties

项目使用 ES module 语法，`package.json` 设置了 `"type": "module"`。除非确有必要，不要引入新的框架或第三方依赖；引入依赖前必须先检查其必要性、维护成本和构建影响。

### 常用命令

```bash
npm install
npm run dev
npm run build
npm run preview
```

当前没有自动化测试脚本，因此生产构建和浏览器冒烟测试是主要验证方式。涉及界面、事件或持久化逻辑时，应在构建后使用独立端口启动开发服务器进行检查：

```bash
npx vite --host 127.0.0.1 --port 5180
```

## 4. 目录结构

```text
project/
├── index.html
├── package.json
├── package-lock.json
├── vite.config.js
├── README.md
├── PROJECT_ARCHITECTURE.md
├── src/
│   ├── css/
│   │   ├── index.css
│   │   ├── material.css
│   │   ├── base.css
│   │   ├── layout.css
│   │   ├── button.css
│   │   ├── modal.css
│   │   ├── workflow.css
│   │   ├── memo.css
│   │   ├── rotation.css
│   │   ├── settings.css
│   │   ├── backup.css
│   │   ├── editor.css
│   │   ├── task-form.css
│   │   ├── toast.css
│   │   └── responsive.css
│   └── js/
│       ├── app.js
│       ├── ui.js
│       ├── config.js
│       ├── core/
│       ├── config/
│       ├── workflow/
│       ├── memo/
│       ├── settings/
│       └── backup/
└── dist/
```

`dist/` 是构建产物，不是业务源码。新增业务代码应放在 `src/` 中，不要直接修改构建产物。

## 5. 启动入口与初始化顺序

`index.html` 通过以下入口启动应用：

```html
<script type="module" src="/src/js/app.js"></script>
```

`src/js/app.js` 是 bootstrap，只负责模块装配和启动流程，不负责承载业务领域实现。

当前启动流程大致如下：

1. 导入 `src/css/index.css`，加载完整样式入口。
2. 加载轮换规则、工作流、完成状态、完成历史和最后重置日期。
3. 加载 Memo 和 Memo 标签状态。
4. 注入跨领域运行时依赖，例如 Memo 数量检查所需的查询函数。
5. 渲染日期、工作流、Memo 和标签选择器。
6. 清理已过期 Memo。
7. 绑定导航、工作流、Memo、设置、编辑器、任务表单和全局键盘事件。设置模块在装配阶段通过 `registerViewHook()` 向导航层注册渲染钩子，避免导航模块反向依赖业务渲染。
8. 执行跨日重置检查。
9. 若存在 Gist 凭证，执行启动时静默拉取。
10. 调用 `switchView('flow')` 切换到默认顶级视图；首次进入设置页时由 hook 渲染默认子页面（主菜单）。
11. 注册 `window.debugNJ()` 调试探针。
12. 监听页面重新回到前台，以便执行相关同步或日期检查。

`loadWorkflows()` 必须先于 `loadCompleted()`，因为完成状态需要依据当前工作流任务 ID 进行归一化和校验。调整初始化顺序前，必须检查模块之间的数据前置条件。

## 6. JavaScript 分层与依赖方向

项目遵循以下逻辑链路：

```text
state/store → runtime/service → renderer → events
```

实际维护时可以理解为四类职责：

- **Store / State**：保存领域状态、读取和持久化数据、提供状态变更接口。
- **Runtime / Service**：执行跨领域规则、计算、同步和数据处理，不负责具体 DOM 结构。
- **Renderer**：将状态转换为 HTML 或 DOM 更新，不直接负责数据持久化。
- **Event**：接收用户操作，校验输入，调用 store/service，再触发渲染或状态通知。

推荐依赖方向：

```text
core ← config ← domain store ← runtime/service ← renderer ← events
                                      ↘ settings/backup orchestration
```

实际依赖不必机械套用上图，但应遵守以下原则：

- `core` 不依赖业务页面模块。
- `config` 提供默认值、归一化和结构定义，不放置页面事件。
- Store 不直接操作 DOM。
- Renderer 不直接读写 LocalStorage。
- Event 模块不复制 Store 的数据修改逻辑。
- 跨领域模块通过显式 import、函数参数或依赖注入连接。
- 不要通过全局变量隐藏模块依赖；调试探针是例外。

### `config.js` 兼容层

`src/js/config.js` 主要用于重新导出拆分后的配置，以兼容旧的 import 路径。它不是新的业务实现位置。

新增配置时，优先放入对应的 `src/js/config/` 文件，例如：

- 日期和轮换规则：`config/rotation-rules.js`
- 工作流结构和默认任务：`config/workflow-config.js`
- LocalStorage key 和备份相关常量：`config/storage-config.js`

只有在需要兼容旧模块时，才在 `config.js` 中增加转发导出。

## 7. 主要模块职责

### `core/`

核心基础设施，不应包含具体页面业务：

- `storage.js`：安全封装 LocalStorage 读写和删除。
- `date.js`：日期、时间戳和格式化工具。
- `debug.js`：调试开关、日志和调试 hook。
- `settings-store.js`：用户设置和 Gist 设置的状态、归一化与持久化。

涉及敏感信息时，必须避免将 token 或完整凭证写入日志、Toast 或异常信息。

### `workflow/`

工作流领域：

- `workflow-store.js`：工作流任务数组的加载、归一化、增删改、排序和监听。
- `rotation-store.js`：轮换规则状态和持久化。
- `completion-store.js`：每日完成任务 ID 状态。
- `history-store.js`：完成历史、跨日归档和每日重置。
- `workflow-runtime.js`：任务完成判断及 Memo 数量检查等运行时规则。
- `workflow-renderer.js`：日期和工作流视图渲染。
- `workflow-events.js`：工作流列表事件委托。

Store 接口应返回清晰、可预测的结果，并通过监听器通知变化。工作流 Store 不应直接查询页面按钮或修改 DOM。

### `memo/`

Memo 领域：

- `memo-store.js`：Memo、Memo 标签和当前选中标签的状态及修改接口。
- `memo-parser.js`：Memo 内容解析和分类逻辑。
- `memo-renderer.js`：Memo 列表、计数器和标签选择器渲染。
- `memo-events.js`：输入、标签和 Memo 卡片交互。
- `memo-retention.js`：过期 Memo 清理。

新增 Memo 业务规则时，应优先放到 Store、Parser 或 Retention 中，不要直接塞入事件处理器。

### `settings/`

设置、编辑器与导航领域：

- `navigation.js`：顶级视图与设置子视图切换、导航状态、视图渲染钩子（`TOP_LEVEL_VIEWS` / `SETTINGS_VIEWS` / `registerViewHook` / `getCurrentView` / `getCurrentSettingsView`）。
- `modal.js`：模态框打开、关闭和模态状态管理。设置模态已下线，仅承载编辑器、任务表单、轮换规则编辑器等其他模态。
- `tag-settings.js`：设置页生词本标签 CRUD。
- `workflow-editor.js`：任务列表编辑、排序和删除。
- `task-form.js`：新增或编辑任务、检查配置和轮换规则表单。
- `index.js`：设置视图渲染入口、相关事件装配中心，以及全局 Esc 优先级处理。

#### 顶级视图与视图钩子

侧边导航控制三个并列顶级视图：`flow` / `memo` / `settings`。`switchView()` 会切换 `[data-view]` 容器和对应 `.nav-item` 的激活态，并触发已经通过 `registerViewHook()` 注册的渲染钩子，例如设置页首次进入时刷新 Gist 输入、生词本标签列表和编辑器入口。视图钩子模式让 `navigation.js` 无需了解每个领域的渲染细节。

设置页内部仍保留 `switchSettingsView()`，用于在主菜单、数据备份、工作流管理、生词本标签管理四个子页面之间切换。`data-settings-view` 是子页面选择器，根选择器从原来的 `#settings-modal` 改为 `.view--settings[data-view="settings"]`。

#### Esc 关闭优先级

设置已不再是模态框，因此全局 Esc 关闭优先级调整为：任务表单（保存/取消确认） → 工作流编辑器（保存/取消确认） → 设置子页面返回主菜单。其他模态关闭沿用 `closeModal()`。

#### 备份事件装配

设置模块通过 `bindSettingsEvents()` 在 `.view--settings` 根容器上装配事件，并把 `bindBackupEvents` 等回调直接挂到根容器的子元素上。这意味着设置页面必须在装配时存在于 DOM 中；如果未来需要按需插入，请同步检查备份事件订阅路径。

### `backup/`

备份和同步领域：

- `json.js`：备份校验、归一化、导入和原子写入。
- `snapshot.js`：构建备份快照和 JSON 导出。
- `gist-api.js`：Gist API 请求、超时和错误映射。
- `gist-sync.js`：Gist 上传、拉取、自动上传和设置渲染。
- `daily-reset.js`：每日重置状态 UI 和手动重置事件。
- `events.js`：备份、导入、拖放、Gist 和每日重置事件装配。

备份导入必须遵循“校验 → 归一化 → 原子写入”的顺序。写入多个 LocalStorage key 时，应保留失败回滚能力。

### `ui.js`

共享 UI 工具目前主要提供：

- Toast 队列和去重。
- Toast 状态样式。
- 敏感信息脱敏。
- 全局进度条更新。

新增提示消息时使用 `showToast()`，不要绕过它直接操作 Toast DOM。

## 8. Store、监听器与状态约定

Store 通常采用以下模式：

```js
let state = initialValue
const changeListeners = new Set()

export function loadState() {}
export function getState() {}
export function setState(next) {}
export function persistState() {}
export function onStateChange(fn) {}
```

实现 Store 时应遵循：

- 加载入口负责从存储读取并归一化。
- `getState()` 提供当前内存状态。
- 修改函数负责维护合法结构，并在需要时触发监听器。
- 持久化函数明确返回成功或失败结果。
- 监听器使用 `Set` 管理，避免重复注册。
- 单个监听器异常不应阻断其他监听器。
- 不要让 Store 保存 DOM 节点或页面状态。

监听器用于通知渲染和跨模块逻辑，但不应被用来形成难以追踪的循环更新。若一次操作会触发多个 Store 变化，应明确更新顺序和最终渲染时机。

## 9. UI、Renderer 与 Event 约定

`index.html` 是稳定的页面骨架，动态内容主要由 Renderer 注入。HTML 中的 DOM `id`、class 和 `data-*` 属性是 Renderer 与 Event 之间的隐式契约。

每个顶级视图对应一个 `<section class="view" data-view="...">`。`switchView()` 只切换这些容器的 `hidden` 属性和侧边导航 `.nav-item` 的 `aria-current`，不会重建 DOM。设置页内部的子页面通过 `.view--settings [data-settings-view]` 区分，子页面切换由 `switchSettingsView()` 完成。

修改以下内容时必须全局搜索确认调用方：

- DOM `id`。
- `data-view` / `data-settings-view` 选择器。
- 其余 `data-*` 属性名称和值。
- 事件委托选择器。
- Renderer 生成的按钮或表单结构。
- 模态框和视图的隐藏状态。

推荐事件处理流程：

```text
读取事件目标 → 校验输入 → 调用 store/service → 持久化 → 触发渲染或通知
```

不要在 HTML onclick 属性中新增业务逻辑。优先使用现有事件模块和事件委托模式。

渲染函数应尽量保持幂等：给定相同状态，多次调用应产生相同视图结果。Renderer 不应偷偷修改业务数据；如果需要清理或归一化，应由 Store 或专门的 Service 完成。

## 10. 持久化、备份与 Gist 同步

### LocalStorage

LocalStorage 是主要本地数据源。所有读写优先使用 `core/storage.js` 提供的安全封装，不要在业务模块中散落直接的 `localStorage.getItem`、`setItem` 和 `removeItem`。

新增持久化数据必须同时定义：

1. Storage key。
2. 默认值。
3. 归一化函数。
4. 加载函数。
5. 修改和持久化接口。
6. 备份导出字段。
7. 备份导入与兼容策略。

### JSON 备份

当前支持 1.0、1.1、1.2 系列备份版本。若修改备份结构，必须同步检查：

- `backup/json.js` 的 `validateBackupPayload()`。
- `backup/json.js` 的 `normalizeBackupPayload()`。
- `backup/json.js` 的 `persistBackupToStorage()`。
- `backup/snapshot.js`。
- 备份版本兼容和迁移逻辑。

任何多 key 写入都应考虑部分失败和回滚，不能只验证单个 `setItem` 的成功路径。

### Gist

Gist 同步是可选能力。Gist API 细节集中在 `backup/gist-api.js`，上传、拉取和调度集中在 `backup/gist-sync.js`。

新增 Gist 字段或同步内容时，需要同时考虑：

- 上传快照。
- 拉取后的校验和归一化。
- 旧数据兼容。
- 错误提示和超时。
- token 脱敏。
- 启动自动拉取对现有本地数据的影响。

不得在日志、DOM、异常文本或提交内容中暴露完整 GitHub token。

## 11. CSS 架构

CSS 通过 `src/css/index.css` 聚合，JavaScript 入口只需导入该入口文件：

```js
import '../css/index.css'
```

当前 CSS 大致按以下顺序组织：

1. `material.css`：主题变量和设计 token。
2. `base.css`：重置、字体和基础元素。
3. `layout.css`：页面布局和导航。
4. `button.css`、`modal.css`：通用控件。
5. `workflow.css`、`memo.css`、`rotation.css`：领域组件。
6. `settings.css`、`backup.css`、`editor.css`、`task-form.css`：设置和表单区域。
7. `toast.css`、`responsive.css`：反馈、响应式和 reduced-motion。

新增样式应放入最接近其职责的 CSS 文件。不要重新创建单体 `style.css`，也不要在 JavaScript 中大段写内联样式。

颜色、圆角、间距、阴影和动效优先复用 Material 变量和现有 token。新增断点或动效时，要检查窄屏布局和 `prefers-reduced-motion` 行为。

## 12. 编码风格与命名规范

- 使用原生 ES module 的 `import` 和 `export`。
- 优先使用具名导出，保持依赖关系清晰。
- 函数和变量使用 `camelCase`。
- 常量使用 `UPPER_SNAKE_CASE`，尤其是 Storage key 和默认配置。
- Store 文件使用 `*-store.js`。
- Renderer 文件使用 `*-renderer.js`。
- Event 文件使用 `*-events.js`。
- 基础工具放在 `core/`，领域代码放在对应领域目录。
- 保持函数短小，单个文件原则上不超过 500 行。
- 修改前先阅读目标文件的 import、导出和邻近实现，遵循现有风格。
- 不要新增无必要的注释；代码结构和命名应尽量自解释。
- 不要为了绕过类型或运行时问题使用无依据的全局变量。
- 不要引入未在项目中确认存在的库。
- 不记录 token、密码或其他敏感数据。

## 13. 新增功能的标准流程

### 第一步：明确功能归属

先判断功能属于 workflow、memo、settings、backup 还是 core/config。避免把跨领域逻辑直接放进 `app.js`。

### 第二步：检查现有契约

搜索相关的：

- Storage key。
- 状态字段和归一化函数。
- DOM id、class 和 `data-*` 属性。
- 现有 Store、Renderer 和 Event 接口。
- 备份和同步字段。

### 第三步：按层实现

通常按照以下顺序实现：

1. 配置、默认值和归一化。
2. Store 状态和持久化接口。
3. Runtime 或 Service 业务规则。
4. Renderer 视图输出。
5. Event 用户交互。
6. CSS 样式。
7. 在 `app.js` 中进行最少量的初始化装配。

### 第四步：处理兼容性

如果功能改变数据结构，必须设计旧数据归一化或迁移；如果功能改变备份结构，必须更新版本检查和导入逻辑。

### 第五步：验证

至少执行：

```bash
npm run build
```

涉及界面时，还应检查：

- 页面能正常启动。
- 控制台没有新增异常。
- 初始工作流和日期正常渲染。
- 目标交互可完成。
- 刷新页面后数据仍然正确。
- 导出、导入或 Gist 相关功能没有破坏原有数据。

## 14. 数据结构修改规范

修改工作流、Memo、轮换规则、完成历史或设置结构时，不要只修改写入路径。必须同时检查：

- 默认值。
- 归一化函数。
- 旧数据读取。
- Store 的增删改接口。
- Renderer 使用的字段。
- Event 提交的字段。
- JSON 备份快照。
- JSON 备份校验和导入。
- Gist 同步内容。
- 跨日重置和历史归档。

迁移逻辑应尽量在加载或归一化阶段集中处理，避免将版本判断散落到多个 Renderer 和 Event 文件中。

## 15. 调试与故障排查

项目提供：

```js
window.debugNJ()
```

该函数用于取得当前内存快照，通常包括：

- `workflows`
- `rotationRules`
- `memos`
- `memoTags`
- `selectedTag`
- `history`

建议排查顺序：

1. 先检查浏览器控制台是否有模块加载或运行时异常。
2. 再检查 `window.debugNJ()` 中的内存状态。
3. 检查 LocalStorage 中对应 key 是否存在且结构正确。
4. 检查 Store 是否正确触发监听器。
5. 检查 Renderer 是否读取了正确字段。
6. 检查 Event 的选择器和 DOM 契约是否仍然匹配。
7. 最后检查 Gist 或备份边界，而不是先修改 UI。

常见错误包括：

- 从错误的 config 子模块导入常量。
- 使用函数却忘记显式导入。
- 把业务逻辑重新放回 `app.js`。
- Store 直接操作 DOM。
- 修改 DOM id 后遗漏事件模块。
- 增加数据字段却遗漏归一化和备份逻辑。
- 启动多个开发服务器导致访问到错误端口。

## 16. 明确禁止事项

除非有经过审查的重构计划，不要：

- 将所有新逻辑重新写入 `app.js`。
- 恢复单体 `style.css`。
- 在 Store 中直接查询或修改 DOM。
- 在 Renderer 中直接写 LocalStorage。
- 在 Event 文件中复制数据迁移或持久化细节。
- 直接修改 `dist/` 作为源码修复。
- 绕过 `core/storage.js` 形成新的 LocalStorage 读写方式。
- 在日志、Toast 或 Gist 内容中暴露完整 token。
- 未检查已有依赖就引入新库。
- 未运行构建就结束涉及模块导入的修改。
- 未检查移动端和刷新恢复就结束涉及 UI 或持久化的修改。
- 重新引入 `#settings-modal` 这类与顶级视图并行的设置入口；设置必须始终通过 `data-view="settings"` 进入。
- 让 `navigation.js` 直接 import 设置业务模块；新增顶级视图渲染逻辑应通过 `registerViewHook()` 注册。

## 17. 后续维护建议

优先级较高的维护方向：

1. 为 Store 的归一化、备份导入和日期重置补充自动化测试。
2. 为核心 DOM 交互建立稳定的浏览器冒烟测试。
3. 为备份格式建立明确的版本迁移策略。
4. 逐步减少兼容层中的历史导出，并在确认无调用方后清理。
5. 将跨领域运行时依赖继续保持为显式依赖注入。
6. 在不引入过度复杂框架的前提下，持续保持领域模块小而独立。
7. 维护每个模块的单一职责，发现文件接近 500 行时优先拆分职责，而不是继续堆叠。
8. 对涉及数据格式、Gist 同步和跨日逻辑的变更进行重点回归验证。

任何结构性重构都应遵循“小步修改、立即构建、再做浏览器验证”的节奏。若本文与实际代码不一致，应先确认代码的真实行为，再更新本文，而不是让后续维护者继续依赖过时描述。
