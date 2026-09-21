/**
 * locales.js · 全局文案配置文件（i18n 单一数据源）
 * -----------------------------------------------------------------------------
 * 项目中所有写死的界面文字统一集中在这里，按功能模块组织：
 *   common    通用按钮 / 导航 / 常用词
 *   workflow  每日工作流：卡片、任务编辑器、任务表单、轮换规则
 *   memo      生词记事本：输入区、卡片流、标签选择
 *   anki      Anki 处理机：处理区、按钮、设置标签
 *   settings  设置与数据：备份 / Gist / 每日重置 / 标签管理 / Anki API 表单
 *   defaults  出厂种子数据（默认任务 / 默认轮换规则 / 周几）
 *   toast     所有系统提示与错误消息（按业务域再分一层）
 *
 * 用法：
 *   import { I18N, t, applyI18nToDom } from './locales.js'
 *   showToast(t(I18N.toast.workflow.completed))                  // 无占位
 *   showToast(t(I18N.toast.memo.appendedTo, { tag, category }))  // 带占位 {xxx}
 *   applyI18nToDom()                                              // 初始化时应用 HTML data-i18n
 */

export const I18N = {
  /* ========================================================================
   * common · 通用
   * ====================================================================== */
  common: {
    brandTitle: "NJ's Workflow",
    metaDescription: "NJ's Workflow 个人工作流聚合站",
    tagline: 'Daily flow, clearly done.',
    loading: '正在加载工作流',

    save: '保存',
    cancel: '取消',
    close: '关闭',
    confirm: '确认',
    back: '返回',
    delete: '删除',
    edit: '编辑',
    done: '完成',
    add: '新增',
    copy: '复制',

    today: '今天',
    restDay: '休息日',
    untitled: '未命名',
    systemDefault: '系统默认',

    confirmTitle: '确认操作',
    confirmMessage: '是否继续？',
    restoreDefault: '恢复默认',

    weekdays: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],

    navRailAria: '侧边导航',
    nav: {
      flow: '每日工作流',
      memo: '生词记事本',
      anki: 'Anki 处理机',
      monthly: '月览',
      german: '德语助手',
      settings: '设置与数据'
    },

    backHomeAria: '返回首页',
    globalProgressAria: '全局进度',
    carouselAria: '切换任务卡片',
    selectTagAria: '选择标签',
    tagSelectorAria: '标签选择器',
    tagListAria: '标签列表',

    backToSettingsAria: '返回设置主菜单',
    backToWorkflowAria: '返回工作流管理',
    backToEditorAria: '返回编辑器',
    backToTaskFormAria: '返回任务表单',
    closeEditorAria: '关闭编辑器',
    closeFormAria: '关闭表单'
  },

  /* ========================================================================
   * workflow · 每日工作流（含任务编辑器 / 任务表单 / 轮换规则）
   * ====================================================================== */
  workflow: {
    eyebrow: 'YOUR PERSONAL FLOW',
    title: '把今天的节奏，<span>交给流程。</span>',
    heroCopy: '沿着你的每日流水线前进，专注完成眼前的一步。',
    timelineEyebrow: "TODAY'S TIMELINE",
    sectionTitle: '每日工作流',

    checkBtn: '检查',
    comingSoon: 'Coming Soon',
    jumpAria: '跳转：{title}',
    checkAria: '检查并打卡：{title}',
    descFallback: '校验今日 {category} 分类生词数 (≥{count} 自动打卡)',
    defaultCategory: '常规',

    jump: '跳转',
    rotation: '轮换',
    pureCheck: '纯打卡',
    checkMeta: '检查 {cat}≥{count}',
    noDesc: '（无描述）',
    untitledTask: '未命名任务',
    prerequisiteBadgeLocked: '需先完成 {list}',
    prerequisiteBadgeUnlocked: '前置已完成',
    prerequisiteEditorLabel: '前置任务（完成这些任务后才能打卡此任务）',
    prerequisiteEditorEmpty: '暂无其他任务可选',
    prerequisiteSectionTitle: '前置任务',
    prerequisiteHelper: '可勾选多个，所有勾选的任务完成后此任务才可打卡。',

    // 任务编辑器
    editorEyebrow: 'WORKFLOW LIST',
    editorTitle: '编辑工作流',
    editorSubtitle: '点击任务右侧菜单调整顺序、编辑或删除。',
    taskCount: '共 {count} 条任务',
    addTask: '添加任务',
    addTaskSub: '创建一条新的工作流卡片。',
    editWorkflowTile: '编辑当前工作流',
    editWorkflowTileSub: '调整顺序、编辑字段或删除任务。',
    workflowPageHeroTitle: '管理每日任务的顺序与轮换。',
    workflowPageHeroSub: '编辑工作流会实时反映到主页面卡片。',
    editorEmpty: '任务列表为空，点击下方按钮创建第一条。',
    createFirstTask: '创建第一个任务',
    taskOpsTitle: '任务操作',
    taskOpsSubtitle: '选择下方动作以调整任务。',
    editTask: '编辑任务',
    moveUp: '上移',
    moveDown: '下移',
    deleteTask: '删除任务',
    taskOpAria: '任务操作',
    moveUpAria: '上移',
    moveDownAria: '下移',
    editAria: '编辑',
    deleteAria: '删除',
    deleteConfirmTitle: '删除任务？',
    deleteConfirmMsg: '「{title}」将从工作流中移除，此操作无法撤销。',

    // 任务表单
    taskFormAddTitle: '添加新任务',
    taskFormEditTitle: '编辑任务',
    taskFormAddSubtitle: '填写下方字段以创建一条新的工作流卡片。',
    taskFormEditSubtitle: '修改当前任务的字段与属性，点击保存即可生效。',
    titleRequired: '任务名称不能为空。',
    urlInvalid: 'URL 格式不合法，请检查开头是否为 http:// 或 https://。',
    titleHelper: '必填，最多 64 字。',
    basicSection: '基本信息',
    taskNameLabel: '任务名称',
    taskNamePlaceholder: '例如：Tageschau in einfacher Sprache',
    descLabel: '描述',
    descPlaceholder: '描述会显示在卡片标题下方。',
    descHelper: '简短说明，显示在卡片标题下方。',
    behaviorSection: '任务行为',
    jumpUrlLabel: '跳转 URL',
    jumpUrlHelper: '填写后卡片会显示“跳转”按钮，新标签页打开。',
    placeholderTask: '占位任务',
    placeholderTaskHelper: 'Coming Soon：勾选后卡片灰化，不参与进度统计。',
    rotationSection: '轮换规则',
    enableRotation: '启用轮换',
    enableRotationHelper: '关闭后该任务回到静态标题。开启后可选择预设。',
    rotationNotEnabled: '未启用轮换',
    rotationNotEnabledDesc: '开启上方开关后，从预设中选择一项。',
    rotationNoPreset: '未选择预设',
    rotationNoPresetDesc: '点按下方按钮，从预设中选择一项。',
    rotationPresetDeleted: '所选预设已被删除',
    rotationPresetDeletedDesc: '点按下方按钮，重新选择。',
    rotationUntitled: '未命名轮换规则',
    rotationSummary: '共 7 天配置 · 点按可编辑标题、图标与休息日。',
    checkSection: '自动检查',
    memoLinkCheck: '生词本联动检查',
    memoLinkCheckHelper: '开启后卡片右侧显示「检查」按钮，点击自动校验今日指定分类生词数并打卡。',
    checkCategory: '检查分类',
    checkCategoryPlaceholder: '留空默认为常规',
    targetCount: '达标数量',

    // 轮换规则编辑器
    rotationPageTitle: '轮换规则',
    rotationPageSubtitle: '为每一天设置标题、图标与休息日。',
    presetSection: '预设',
    newPreset: '新建预设',
    newPresetAria: '新建预设',
    presetListAria: '轮换预设',
    ruleName: '规则名称',
    ruleNamePlaceholder: '例如：CET-6 每日专项',
    ruleNameHelper: '预设名用于在任务中显示。',
    dailyConfig: '每日配置',
    dailyConfigAria: '每日配置',
    notConfigured: '未配置',
    emptyRule: '空规则',
    noPresetYet: '还没有任何预设，点击右上角「新建预设」开始。',
    newRotationRule: '新的轮换规则',
    newPresetCount: '新预设 {count}',
    deletePresetTitle: '删除轮换预设？',
    deletePresetMsg: '「{name}」将从预设库移除，使用此预设的任务将回到静态标题。',
    deletePresetBtn: '删除预设'
  },

  /* ========================================================================
   * monthly · 月览
   * ====================================================================== */
  monthly: {
    eyebrow: 'RETROSPECT · PAST 30 DAYS',
    title: '月览<span>·热力图</span>',
    heroCopy: '查看过去30天的任务完成情况，保持连续打卡习惯。'
  },

  /* ========================================================================
   * german · 德语助手（词典查询）
   * ====================================================================== */
  german: {
    eyebrow: 'GERMAN · DICTIONARY',
    title: '德语助手<span>·查词即记</span>',
    heroCopy: '输入德语表达，查询释义、音标、例句，并快速加入生词本。支持中文反查。',
    searchAria: '德语单词搜索',
    searchPlaceholder: '例: "Apfel", "香蕉", "fröhlich的反义词是什么"',
    clearAria: '清空搜索',
    suggestionsAria: '搜索候选词',
    loadingSuggestions: '正在匹配候选词…',
    noSuggestions: '没有匹配到候选词',
    resultsTitle: '词典结果',
    loadingResult: '正在查询单词…',
    noResult: '未找到该词或公开词典源暂无数据。',
    retry: '重试',
    missingData: '暂无公开数据',
    partOfSpeechLabel: '词性',
    inflectionLabel: '变格',
    examplesLabel: '双语例句',
    addMemo: '添加到生词本',
    refetchAria: '重新获取该词的最新释义（忽略本地缓存）',
    speakAria: '朗读德语单词',
    sourceLabel: '数据源',
    collocationsLabel: '搭配：',
    godicLabel: '德语助手',
    sourceLabels: {
      godic: 'godic 代理',
      freeDictionary: 'Free Dictionary API',
      wiktionary: 'Wiktionary API',
      input: '当前输入'
    },
    toasts: {
      searchEmpty: '请先输入一个德语单词。',
      searchFailed: '词典查询失败，请稍后重试。',
      noData: '公开数据源未返回该词信息。',
      memoAdded: '「{word}」已加入生词本（{tag} / {category}）。',
      memoFailed: '添加生词本失败，请检查本地存储。',
      speakNetworkFailed: '网络发音加载失败',
      refetchDone: '「{word}」已重新获取最新释义。'
    }
  },

  /* ========================================================================
   * memo · 生词记事本
   * ====================================================================== */
  memo: {
    eyebrow: 'WORDS · CAPTURE LIGHT',
    title: '生词，<span>随手一记。</span>',
    heroCopy: '把今天遇到的新词扔进卡片流。',
    inputAria: '新建生词笔记',
    quickAppendTitle: '新笔记 · 快速追加模式',
    categoryPlaceholder: '常规',
    categoryAria: '分类（留空即常规）',
    wordPlaceholder: '输入生词（回车即追加到今日卡片）',
    append: '追加',
    appendAria: '追加',
    recordsCount: '{count} 条记录',
    streamEyebrow: 'MEMORY STREAM',
    streamTitle: '笔记卡片流',
    empty: '还没有笔记。把今天的生词丢进这里吧。',
    wordSuffix: '词',
    wordCount: '{count} 词',
    editAria: '编辑笔记',
    saveAria: '保存修改',
    cancelAria: '取消编辑',
    deleteAria: '删除笔记',
    copyAria: '复制笔记内容',
    copyBtn: '复制',
    defaultCategory: '常规',
    pickerTitle: '选择标签',
    pickerSubtitle: '点选下方标签快速切换；当前选中会高亮。',
    pickerListAria: '可用标签',
    expandAria: '展开全部内容',
    collapseAria: '收起全部内容',
    expandBtn: '展开全部',
    collapseBtn: '收起'
  },

  /* ========================================================================
   * anki · Anki 处理机
   * ====================================================================== */
  anki: {
    eyebrow: 'ANKI · WORD PROCESSOR',
    title: '生词，<span>批量造卡。</span>',
    heroCopy: '一键调用 AI 生成 Anki 导入格式，复制或下载即可入库。',
    inputTitle: '输入区',
    inputHint: '每行一个生词，或用逗号 / 空格分隔',
    inputPlaceholder: 'Apfel\nSchule\nlernen\n...',
    readToday: '读取今日生词',
    startProcess: '开始 AI 处理',
    processing: '处理中…',
    outputTitle: '输出区',
    outputHint: 'AI 结果按分类分卡展示，可直接编辑后复制 / 导出',
    cardsEmpty: '处理完成后，分类结果会显示在这里。',
    uncategorized: '未分类',
    copyAll: '复制全部',
    exportAllTxt: '导出全部 .txt',
    copyCategory: '复制此分类',
    exportCategory: '导出此分类 .txt',
    categoryTextareaLabel: '「{name}」分类文本',
    processInAnki: 'Anki处理',
    abnormalTitle: '⚠️ 发现拼写/语法异常词汇',
    abnormalTip: '以下词汇未通过校验，请在上方【原始单词】输入框中修正后重新生成',
    geminiLabel: 'Google Gemini 原生 API',
    openaiLabel: '通用 OpenAI 兼容接口'
  },

  /* ========================================================================
   * settings · 设置与数据
   * ====================================================================== */
  settings: {
    eyebrow: 'SETTINGS · DATA',
    title: '设置与数据',
    heroCopy: '管理你的工作流与同步方式。',

    backupMenu: '数据备份与恢复',
    backupMenuSub: '导出当前数据，或从 JSON 备份还原。',
    ankiApiMenu: 'Anki 处理机设置',
    ankiApiMenuSub: '配置 LLM 接口和处理提示词',
    workflowMenu: '工作流管理',
    workflowMenuSub: '添加任务，编辑现有工作流及其排序。',
    tagsMenu: '生词本标签管理',
    tagsMenuSub: '维护生词本分类标签，管理自定义标签。',
    germanMenu: '德语助手设置',
    germanMenuSub: '字体大小，TTS配置相关。',

    germanTitle: '德语助手设置',
    germanSub: '调节德语助手查词结果的字号。',
    germanFontSizeLabel: '结果页字号',
    germanFontSizeHint: '拖动滑块切换 5 档字号，第 3 档为默认基准；实时作用于结果页所有文本。',
    germanFontSizeLevel: '第 {level} 档（{label}）',
    germanFontLabels: '最小,较小,正常,较大,最大',
    ankiLlmReminderTitle: '使用 Anki 处理机的 LLM 配置',
    ankiLlmReminderSub: '德语助手的词典生成复用 Anki 处理机的 LLM 配置（Base URL / 模型 / API Key）',
    ankiLlmReminderGo: '去配置',

    ttsKeyTitle: '德语发音（TTS）',
    ttsKeyLabel: 'TTS API Key',
    ttsKeyHint: '填写 tts.ai 的 Key 启用 Kokoro 高音质德语；留空则用匿名 Piper 免费引擎兜底。仅存本地，不写入日志、不随 Gist 同步。',
    ttsKeyPlaceholder: 'sk-tts-***',
    ttsKeyClear: '清空',
    ttsKeySaveSuccess: 'TTS API Key 已保存',
    ttsKeySaveFailed: 'TTS API Key 保存失败，请重试',
    ttsKeyCleared: 'TTS API Key 已清空',

    exportTitle: '导出备份',
    exportSub: '打包当前的配置数据，下载为 JSON 文件。',
    exportBtn: '导出 JSON',
    workflowsChip: 'Workflows 任务配置',
    memosChip: 'Memos 生词笔记',

    restoreTitle: '从备份还原',
    restoreSub: '选择之前导出的 JSON 文件，解析成功后将覆盖当前的配置数据。',
    clickSelectJson: '点击选择 JSON 文件',
    dropHint: '或拖到此处 · 识别 NJW v1.0~1.3',
    restoreDefaultTasks: '恢复默认任务',

    gistTitle: 'GitHub Gist 云端数据同步',
    gistSub: '把当前数据上传到 GitHub Gist 实现跨设备同步；支持启动时自动拉取 / 改动后自动推送。',
    tokenLabel: 'GitHub Token',
    tokenHint: 'Personal Access Token',
    tokenPlaceholder: 'ghp_*** 或 github_pat_***',
    gistIdLabel: 'Gist ID',
    gistIdHint: 'URL 中 /gist/{id} 那段 32 位哈希',
    gistIdPlaceholder: '例如：a1b2c3d4e5f6789...',
    gistStatusConfigured: '已配置：启动时自动拉取，数据变更后自动推送。',
    gistStatusNotConfigured: '未配置：请填写 GitHub Token 与 Gist ID。',
    lastUpload: '最近上传',
    lastPull: '最近拉取',
    lastSync: '最近同步',
    noSyncRecord: '暂无同步记录',
    saveConfig: '保存配置',
    uploadToGist: '上传到 Gist',
    pullFromGist: '从 Gist 拉取',

    dailyResetTitle: '每日任务重置',
    dailyResetSub: '每天 00:00 自动初始化今日任务打卡状态，并归档昨日已完成的任务到历史记录。',
    triggerTiming: '触发时机',
    triggerTimingValue: '打开应用 · 切回前台 · Gist 同步后',
    lastReset: '最近一次',
    historyLabel: '跨天历史',
    neverReset: '尚未执行过自动重置',
    resetHint: '每天 00:00 自动初始化今日任务打卡状态。',
    resetToday: '重置今日打卡状态',

    ankiApiTitle: 'Anki 处理机 API 配置',
    ankiApiSub: '配置 LLM 接口用于生成 Anki 卡片文本；配置随系统数据一并同步至 Gist。',
    apiType: 'API 类型',
    apiTypeHint: '选择 Gemini 原生或通用 OpenAI 兼容接口',
    baseUrl: 'Base URL',
    baseUrlHint: 'API 根地址，可填代理或兼容服务地址',
    baseUrlPlaceholder: 'https://...',
    modelId: '模型 ID',
    modelIdHint: '如 gemini-3.5-flash-lite / gpt-4o-mini',
    modelIdPlaceholder: 'model-id',
    apiKey: 'API Key',
    apiKeyHint: '本地保存，不写入日志；上传 Gist / 导出备份时以密文形式同步',
    apiKeyPlaceholder: 'sk-*** 或 AIza***',

    passphraseTitle: 'Anki API Key 加密',
    passphraseSub: '设置加密口令，API Key 将以密文形式上传 Gist / 导出备份；拉取或导入时用口令解密还原。',
    passphraseLabel: '加密口令',
    passphraseHint: '仅保存在本设备；口令不会上传 Gist 或写入备份',
    passphrasePlaceholder: '输入口令，用于加密 / 解密 API Key',
    passphraseRemember: '在本设备记住口令（每次打开自动解锁）',
    savePassphrase: '保存口令',
    clearPassphrase: '清除口令',
    passphraseStatusNone: '未设置口令',
    passphraseSyncHintNoPassphrase: 'API Key 将不会上传到 Gist / 写入备份（其他数据正常同步）',
    passphraseStatusSession: '当前会话已解锁：可加密上传 / 解密拉取（未在本设备记住）',
    passphraseStatusRemembered: '口令已保存并记住：每次打开自动解锁',
    passphraseStatusLockedRemembered: '口令已记住但当前会话未解锁',

    promptTitle: 'Anki 处理机提示词',
    promptSub: '内置默认提示词；可修改并保存自定义提示词，随 Gist 一并上传与拉取。',
    systemPrompt: 'System Prompt',
    systemPromptHint: '留空则使用默认提示词',
    promptPlaceholder: '在此输入自定义提示词，留空则使用内置默认提示词。',
    promptStatusDefault: '当前使用：内置默认提示词',
    promptStatusCustom: '当前使用：自定义提示词（随 Gist 一并同步）',
    savePrompt: '保存提示词',

    tagsTitle: '生词本标签管理',
    tagsSub: '自定义生词本顶部的分类标签。Deutsch/Anki 为系统默认，不可删除或改名。',
    addTagBtn: '添加标签',
    newTagPlaceholder: '新标签名称',
    renameAria: '重命名',
    deleteAria: '删除',
    renameTagAria: '重命名 {name}',
    deleteTagAria: '删除 {name}'
  },

  /* ========================================================================
   * defaults · 出厂种子数据
   * ====================================================================== */
  defaults: {
    untitledTask: '未命名任务',
    untitledRule: '未命名轮换规则',
    defaultCategory: '常规',

    cet6RuleName: 'CET-6 每日专项',
    cet6Days: [
      '今日专项：听力',
      '今日专项：写作',
      '今日专项：翻译',
      '今日专项：选词填空',
      '今日专项：长篇阅读',
      '今日专项：仔细阅读',
      '周六：休息日（不计入今日进度）'
    ],

    workflow1Title: 'Tageschau in einfacher Sprache',
    workflow1Desc: '观看最新一期',
    workflow2Title: '输入视频中的生词（至少7个）',
    workflow2Desc: '校验今日 tgs 分类生词数（≥7 自动打卡）',
    workflow3Title: '复习 CET-6',
    workflow4Title: 'Anki - Deutsch',
    workflow5Title: 'Anki - English',
    workflow6Title: 'Anki - 导入',
    workflow6Desc: '确认将今天生成的德语生词与英语生词批量导入 Anki',
    workflow7Title: 'Anki - 清理旗标'
  },

  /* ========================================================================
   * toast · 系统提示与错误消息（按业务域分组）
   * ====================================================================== */
  toast: {
    workflow: {
      checkSuccess: '校验成功！今日 {category} 分类已记录 {count} 个生词，已为你完成打卡！',
      checkFail: '检查未通过：今天 {category} 分类下仅有 {count} 个生词（还需要 {remaining} 个才达标哦）',
      systemCheckOnly: '此任务由系统自动校验，不可手动打卡，请点击「检查」按钮。',
      updateStorageFail: '任务已更新，但本地存储写入失败。',
      completed: '任务已完成，继续保持节奏。',
      reopened: '任务已重新开放。',
      taskDeleted: '任务已删除。',
      taskUpdated: '任务已更新。',
      taskNotFound: '找不到该任务，可能已被删除。',
      editFailed: '编辑失败：任务已不存在。',
      taskAdded: '已添加新任务。',
      presetCreated: '已新建预设：{name}',
      presetSaved: '已保存预设：{name}',
      presetDeleted: '已删除预设。',
      prerequisitesLocked: '需先完成前置任务：{list}'
    },

    memo: {
      contentEmpty: '内容不能为空，如需删除请用删除按钮。',
      updated: '笔记已更新。',
      deleted: '笔记已删除。',
      copied: '已复制笔记内容。',
      copyFailed: '复制失败，请手动选中内容后复制。',
      inputEmpty: '先在输入框里写下一个单词吧～',
      appendedTo: '已追加到今日 {tag} · {category}。',
      createdToday: '已新建今日 {tag} · {category} 卡片。',
      deleteNoteConfirm: '确认删除这条笔记？',
      tagNameEmpty: '标签名称不能为空。',
      tagExists: '该标签已存在，请勿重复添加。',
      tagAdded: '已添加标签「{name}」。',
      tagRenamed: '标签已重命名为「{name}」。',
      tagDeleted: '已删除标签「{name}」。',
      deleteTagConfirm: '确认删除标签「{name}」？已有笔记不受影响，但标签栏将不再显示该分类。'
    },

    anki: {
      noWordsToday: '今日暂无 Anki 生词记录。',
      wordsLoaded: '已读取今日笔记全文，共 {length} 字符。',
      noWordsInput: '请先输入或读取需要处理的单词。',
      noApiConfig: '请先在设置中配置 API Key 与模型。',
      ankiInputNotFound: '未找到 Anki 处理机输入框。',
      ankiCopied: '已复制到 Anki 处理机。',
      ankiCopyFailed: '复制到 Anki 处理机失败。',
      promptLoadFailed: 'Prompt 模板加载失败，已中止处理。',
      aiFailed: 'AI 处理失败，请稍后重试。',
      aiDone: 'AI 处理完成。',
      aiError: 'AI 处理异常，请稍后重试。',
      outputEmptyCopy: '输出区为空，无可复制内容。',
      copied: '已复制到剪贴板。',
      copyFailed: '复制失败，请手动选中输出区文本复制。',
      outputEmptyDownload: '输出区为空，无可下载内容。',
      downloadStarted: '已开始下载 Anki 导入文件。',
      categoryCopied: '已复制「{name}」分类。',
      categoryDownloadStarted: '已开始下载「{name}」.txt。',
      promptSaveFailed: '提示词保存失败，请检查浏览器存储权限。',
      promptSaved: '提示词已保存，后续处理将使用自定义提示词。',
      promptRestored: '已恢复默认提示词。',
      promptRestoreFailed: '恢复默认提示词失败，请检查浏览器存储权限。',
      promptRestoredDefault: '已恢复默认提示词，后续处理将使用内置默认提示词。',
      configSaveFailed: 'Anki API 配置保存失败，请检查浏览器存储权限。',
      configSaved: 'Anki API 配置已保存。',
      defaultPromptEmpty: '默认提示词为空，请检查项目配置。',
      defaultPromptLoadFailed: '无法加载默认提示词，请稍后重试。',
      passphraseEmpty: '口令不能为空。',
      passphraseSaved: '加密口令已保存（仅当前会话有效）。',
      passphraseSavedRemembered: '加密口令已保存，并已记住在本设备。',
      passphraseSaveFailed: '加密口令保存失败，请检查浏览器存储权限。',
      passphraseCleared: '已清除加密口令。',
      passphraseClearConfirm: '确认清除加密口令？\n\n清除后无法再加密上传，也无法解密已加密的 Gist / 备份数据（本地明文 API Key 仍可继续使用）。',
      decryptFailed: '解密失败：口令错误或备份数据已损坏。',
      plainApiKeyWarning: '备份包含明文 API Key（旧版本格式）。为安全起见，建议设置加密口令后重新上传。',
      cryptoUnavailable: '当前环境不支持加密（Web Crypto API 不可用）。加密需在安全上下文下运行，请通过 https:// 或 http://localhost 访问本应用（直接用 file:// 打开、或经局域网 IP 的 http:// 访问均不支持）。',
      keyOmittedUpload: '已上传 Gist：API Key 未包含（{reason}），其他数据已同步。',
      keyOmittedExport: '已导出备份：API Key 未包含（{reason}），其他数据已写入文件。',
      keyOmittedPull: '已拉取 Gist：API Key 未还原（{reason}），已保留本地 API Key，其他数据已同步。',
      keyOmitReasonNoPass: '未设置加密口令',
      keyOmitReasonCrypto: '当前环境不支持加密',
      keyOmitReasonError: '加密 / 解密失败',
      importPassphrasePrompt: '该备份中的 API Key 已加密，请输入加密口令以解密：'
    },

    backup: {
      importCancelled: '已取消导入。',
      storageWriteFailed: '写入 LocalStorage 失败，请检查浏览器存储权限。',
      importSuccess: '导入成功：{tasks} 任务 / {rules} 规则 / {notes} 笔记。',
      fileRecognized: '已识别：{name}',
      fileSelected: '已选择：{name}',
      jsonOnly: '请选择 .json 格式的备份文件。',
      jsonParseFailed: 'JSON 解析失败，文件可能损坏。',
      exportDone: '已生成备份文件（{tasks} 条任务 / {rules} 条轮换规则 / {notes} 条笔记）并开始下载。',
      exportFailed: '导出失败，请稍后重试。',
      resetToDefaultConfirm: '确认把任务列表恢复为出厂默认？\n\n* 仅重置 workflows 配置；\n* 轮换规则、打卡勾选与生词笔记不会被改动。',
      resetToDefaultDone: '已恢复默认任务列表。',
      importConfirmMsg: '导入将覆盖当前设备的：\n  · 任务配置列表（{tasks} 条）\n  · 轮换规则（{rules} 条）\n  · 生词笔记（{notes} 条）\n{historyLine}{ankiLine}\n注意：今日打卡勾选状态将从备份中恢复（如存在）。\n\n导出时间：{time}\n版本：{version}\n\n确定继续吗？',
      historyLine: '  · 跨天打卡历史（{days} 天）\n',
      ankiLine: '  · Anki API 配置（API Key 以密文形式存储）\n',
      unknown: '未知',
      validateEmpty: '备份文件结构为空或格式不合法。',
      validateVersion: '不兼容的备份版本：{version}，需要 1.0 / 1.1 / 1.2 / 1.3 系列。',
      validateMissingData: '备份文件缺少 data 字段。',
      validateWorkflows: 'data.workflows 应为任务数组。',
      validateMemos: 'data.memos 应为笔记数组。',
      validateHistory: 'data.completionHistory 应为对象。',
      validateUserSettings: 'data.userSettings 应为对象。',
      validateAnkiSettings: 'data.ankiSettings 应为对象。'
    },

    gist: {
      needCredentials: '请先填写 GitHub Token 与 Gist ID。',
      uploading: '正在上传到 Gist…',
      uploaded: '已上传到 Gist。',
      pulling: '正在从 Gist 拉取备份…',
      pullingBusy: '正在从 Gist 拉取…',
      noBackup: 'Gist 中找不到备份文件。',
      invalidJson: 'Gist 文件不是合法的 JSON。',
      pulled: '已从 Gist 拉取并覆盖本地数据。',
      configSaveFailed: 'Gist 配置保存失败，请检查浏览器存储权限。',
      configSaved: 'Gist 同步配置已保存。',
      uploadFailed: 'Gist 上传失败：{msg}',
      pullFailed: 'Gist 拉取失败：{msg}',
      unknownError: '发生未知错误',
      authFailed: '认证失败：Token 无效或已过期。',
      notFound: '找不到该 Gist，请检查 Gist ID。',
      networkUploadFailed: '网络异常，上传失败。',
      networkPullFailed: '网络异常，拉取失败。',
      uploadHttp: '上传失败（HTTP {status}）',
      pullHttp: '拉取失败（HTTP {status}）',
      conflictResolved: '检测到云端有新数据，已自动拉取并刷新。'
    },

    reset: {
      confirmReset: '确认要立即清空今日所有已打卡任务？\n\n清空前会自动把当前已完成状态归档到昨日的历史记录里。',
      manualResetDone: '已手动重置今日打卡状态。',
      resetAt: '上次自动重置于 {date} · 今天 {today}',
      neverReset: '尚未执行过自动重置 · 今天 {today}',
      historyDays: '{count} 天历史已留存'
    },

    system: {
      networkError: '网络异常，请求失败。',
      apiEmpty: 'API 返回为空，请检查模型或重试。',
      timeout: '请求超时，请稍后重试。',
      gemini400: '请求参数有误（400），请检查模型 ID 与 Base URL。',
      gemini401: 'API Key 无效或无权限（{status}）。',
      gemini404: '找不到该模型（404），请检查 Base URL 与模型 ID。',
      gemini429: '请求过于频繁或额度不足（429），请稍后重试。',
      geminiHttp: 'Gemini 请求失败（HTTP {status}）。',
      openai401: 'API Key 无效（401）。',
      openai404: '接口或模型不存在（404），请检查 Base URL 与模型 ID。',
      openai429: '请求过于频繁或额度不足（429），请稍后重试。',
      openaiHttp: 'OpenAI 请求失败（HTTP {status}）。',
      startupSyncFailed: '启动同步失败：{reason}'
    }
  }
}

/**
 * 模板渲染：把 {key} 占位符替换为传入变量的值。
 * @param {string} template 含 {key} 占位符的文案
 * @param {object} vars     占位符取值，如 { name: 'CET-6' }
 * @returns {string}
 */
export function t(template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) =>
    key in vars ? String(vars[key]) : match
  )
}

/**
 * 把 index.html 中静态文案一次性应用到 DOM。
 * 支持以下 data-* 指令：
 *   data-i18n            → 文本内容（textContent）
 *   data-i18n-html       → HTML 内容（innerHTML，用于含 <span> 的标题）
 *   data-i18n-placeholder→ placeholder 属性
 *   data-i18n-aria       → aria-label 属性
 *   data-i18n-title      → <title> 标签（document.title）
 *   data-i18n-meta-content → <meta name="description"> 的 content
 * 页面初始化时调用一次即可，动态渲染的文案由各模块直接引用 I18N。
 */
function resolveI18nPath(key) {
  // 支持两种写法：'common.nav.flow' 点路径；或裸键（自动归入 common 模块）
  if (key.includes('.')) {
    return key.split('.').reduce((acc, k) => (acc ? acc[k] : undefined), I18N)
  }
  return I18N.common[key]
}

export function applyI18nToDom(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    const value = resolveI18nPath(el.dataset.i18n)
    if (typeof value === 'string') el.textContent = value
  })

  root.querySelectorAll('[data-i18n-html]').forEach((el) => {
    const value = resolveI18nPath(el.dataset.i18nHtml)
    if (typeof value === 'string') el.innerHTML = value
  })

  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const value = resolveI18nPath(el.dataset.i18nPlaceholder)
    if (typeof value === 'string') el.setAttribute('placeholder', value)
  })

  root.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    const value = resolveI18nPath(el.dataset.i18nAria)
    if (typeof value === 'string') el.setAttribute('aria-label', value)
  })

  const titleEl = root.querySelector('title[data-i18n-title]')
  if (titleEl && I18N.common.brandTitle !== undefined) {
    document.title = I18N.common.brandTitle
  }

  const metaEl = root.querySelector('meta[name="description"][data-i18n-meta-content]')
  if (metaEl && I18N.common.metaDescription !== undefined) {
    metaEl.setAttribute('content', I18N.common.metaDescription)
  }
}
