// static/js/i18n.js - 零依赖国际化支持 (中 / EN)

const DICT = {
  zh: {
    // 品牌 & 基础
    'brandName': 'wsl-command',
    'brandSubtitle': 'WSL2 本地监控 · 一键查停',
    'railConnected': '已连接',
    'bannerDisconnected': '与 WSL 服务的连接已断开，正在尝试重连…',
    'refresh': '刷新',
    'stopConsole': '停止',
    'qaRefreshShort': '刷新状态',
    'qaCopyHome': '复制家目录路径',
    'qaBrowseFiles': '浏览文件',
    'qaRefresh': '刷新所有状态',
    'qaLogs': '打开日志中心',
    'tipsTitle': '小贴士',
    'tipsAction': '去设置',
    'quickTitle': '快捷操作',
    'feedTitle': '实时动态',
    'feedClear': '清空',
    'feedAlerts': '实时告警',
    'topProjTitle': '活跃项目 TOP 5',
    'topResTitle': '进程资源 TOP 5',
    'sideNavLogs': '日志中心',
    'sideNavSettings': '设置中心',
    'cmdkPlaceholder': '搜索项目、进程或输入操作…',

    // 导航
    'tabOverview': '概览',
    'tabProjects': '项目',
    'tabProcesses': '进程',
    'tabFiles': '文件浏览',

    // 视图头部
    'vhOverviewTitle': '概览',
    'vhOverviewSub': 'WSL2 本地项目、文件与进程总览',
    'vhProjectsTitle': '项目',
    'vhProjectsSub': '家目录下的文件夹与项目统计',
    'vhProcessesTitle': '进程',
    'vhProcessesSub': '实时进程监控，按项目归类',
    'vhFilesTitle': '文件浏览',
    'vhFilesSub': '浏览目录树、预览文件、复制路径',

    // 概览 KPI
    'ovProjects': '项目总数',
    'ovProjectsSub': '扫描中…',
    'ovFiles': '文件总数',
    'ovFilesSub': '已忽略依赖/缓存目录',
    'ovSize': '磁盘占用',
    'ovSizeSub': '项目目录合计',
    'ovProcesses': '运行中进程',
    'ovProcessesSub': '当前用户',
    'ovCpu': '总 CPU',
    'ovMem': '总内存',

    // 进程统计 KPI
    'statMine': '我的进程',
    'statMineSub': '当前用户',
    'statAll': '全部进程',
    'statAllSub': '当前用户',
    'statCpu': '总 CPU',
    'statCpuSub': '负载',
    'statMem': '总内存',
    'statMemSub': '占用',
    'statTime': '最后更新',
    'statTimeSub': '2 秒轮询',

    // 区块标题
    'secControl': 'Control · 项目启停',
    'secDocker': 'Docker · 容器总览',
    'secRecent': 'Recent · 最近活跃项目',
    'secProjects': 'Projects · 项目',
    'secProcesses': 'Processes · 进程',
    'secFileTree': '项目树',

    // 筛选 Chips
    'filterAll': '全部',
    'filterRunning': '运行中',
    'filterGit': '有提交',
    'filterUnlabeled': '未标注',
    'filterProjectProcs': '项目相关',
    'filterAllProcs': '全部',
    'hiddenFiles': '隐藏',

    // 搜索占位符
    'searchProjectsPh': '搜索名称 / 备注 / 路径…',
    'searchProcsPh': '过滤命令 / 项目…',
    'paletteSearchPh': '搜索项目、进程或操作…',

    // 表格列名
    'colProcess': '进程',
    'colPid': 'PID',
    'colProject': '项目',
    'colLoad': '负载',
    'colMem': '内存',
    'colUp': '启动',
    'colAct': '操作',
    'colName': '名称',
    'colSize': '大小',
    'colMtime': '修改时间',

    // 操作按钮
    'pin': '置顶',
    'unpin': '取消置顶',
    'edit': '修改',
    'copyPath': '复制路径',
    'copyWinPath': '复制 Windows 路径',
    'viewLogs': '日志',
    'browse': '浏览',
    'processing': '⋯ 处理中',
    'stop': '停止',
    'stopAll': '停止全部',
    'start': '启动',
    'cancel': '取消',
    'confirm': '确认',
    'save': '保存',
    'close': '关闭',
    'add': '添加',
    'forceKill': '强制停止',

    // 弹窗与抽屉
    'labelModalTitle': '标注与启动配置',
    'labelPath': '路径',
    'labelName': '中文名称',
    'labelNamePh': '例如：我的博客 / API 服务',
    'labelNameHint': '为项目设置更直观的别名',
    'labelCmd': '启动命令',
    'labelCmdPh': '例如：npm run dev / python3 app.py',
    'labelNote': '备注',
    'labelNotePh': '描述这个项目的用途…',
    'labelClear': '清除标注',

    'settingsTitle': 'WSL 指挥中心设置',
    'setAppearance': '外观主题',
    'setAppearanceHint': '选择控制台界面的配色方案',
    'appAuto': '跟随系统',
    'appLight': '浅色',
    'appDark': '深色',
    'setIgnore': '忽略规则',
    'setIgnoreHint': '被忽略的目录名不会出现在项目列表和统计中',
    'ignorePh': '输入文件夹名，按 Enter 添加…',
    'infoDistro': 'WSL 发行版',
    'infoVer': '内核版本',
    'infoHome': '家目录',
    'infoScan': '上次扫描',
    'infoDataDir': '配置目录',
    'infoPort': '监听端口',

    'logsCenterTitle': '实时日志中心',
    'drawerPreview': '文件预览',
    'confirmModalTitle': '操作确认',

    'paletteSelect': '选择',
    'paletteExec': '执行',
    'paletteClose': '关闭',
    'tabMem': '内存占用',

    // 状态提示
    'procEmpty': '当前没有匹配的进程',
    'fileEmpty': '空文件夹',
    'noRunningProjects': '当前没有项目在运行——去「项目」页点击 ▶ 启动',
    'noDockerContainers': '未检测到 Docker 或当前无容器运行',
    'noRecentActivity': '暂无最近活动',
    'running': '运行中',
    'stopped': '已停止',
    'copied': '已复制到剪贴板',
    'saved': '已保存',
    'deleted': '已删除',
    'pinnedToast': '已置顶',
    'unpinnedToast': '已取消置顶',
    'stoppingProcess': '正在停止…',
    'startingProject': '正在启动…',
    'stoppingProject': '正在停止项目…',
  },

  en: {
    // Brand & Basics
    'brandName': 'wsl-command',
    'brandSubtitle': 'WSL2 Telemetry & Orchestration',
    'railConnected': 'Connected',
    'bannerDisconnected': 'Connection lost to WSL service, reconnecting…',
    'refresh': 'Refresh',
    'stopConsole': 'Stop',
    'qaRefreshShort': 'Refresh',
    'qaCopyHome': 'Copy Home Path',
    'qaBrowseFiles': 'Browse Files',
    'qaRefresh': 'Refresh All Telemetry',
    'qaLogs': 'Open Log Center',
    'tipsTitle': 'Quick Tips',
    'tipsAction': 'Settings',
    'quickTitle': 'Quick Actions',
    'feedTitle': 'Live Feed',
    'feedClear': 'Clear',
    'feedAlerts': 'Live Alerts',
    'topProjTitle': 'Top 5 Active Projects',
    'topResTitle': 'Top 5 Process Usage',
    'sideNavLogs': 'Log Center',
    'sideNavSettings': 'Settings',
    'cmdkPlaceholder': 'Search projects, processes or actions…',

    // Navigation
    'tabOverview': 'Overview',
    'tabProjects': 'Launchpad',
    'tabProcesses': 'Processes',
    'tabFiles': 'Explorer',

    // View Headers
    'vhOverviewTitle': 'Dashboard',
    'vhOverviewSub': 'WSL2 local projects, filesystem and process telemetry',
    'vhProjectsTitle': 'Launchpad',
    'vhProjectsSub': 'Workspace inventory, project metrics and quick launch',
    'vhProcessesTitle': 'Processes',
    'vhProcessesSub': 'Real-time process monitor grouped by workspace projects',
    'vhFilesTitle': 'Explorer',
    'vhFilesSub': 'Browse directory tree, inspect files and copy paths',

    // Overview KPIs
    'ovProjects': 'Total Projects',
    'ovProjectsSub': 'Scanning…',
    'ovFiles': 'Total Files',
    'ovFilesSub': 'Ignored vendor / cache dirs',
    'ovSize': 'Disk Usage',
    'ovSizeSub': 'Total workspace disk space',
    'ovProcesses': 'Active Processes',
    'ovProcessesSub': 'Current user',
    'ovCpu': 'Total CPU',
    'ovMem': 'Total RAM',

    // Process Stats KPI
    'statMine': 'My Processes',
    'statMineSub': 'Current user',
    'statAll': 'All Processes',
    'statAllSub': 'Current user',
    'statCpu': 'Total CPU',
    'statCpuSub': 'System load',
    'statMem': 'Total RAM',
    'statMemSub': 'Usage',
    'statTime': 'Last Telemetry',
    'statTimeSub': '2s interval',

    // Section Titles
    'secControl': 'Control · Projects Lifecycle',
    'secDocker': 'Docker · Containers Telemetry',
    'secRecent': 'Recent · Active Projects',
    'secProjects': 'Projects · Inventory',
    'secProcesses': 'Processes · Monitored',
    'secFileTree': 'Project Tree',

    // Filter Chips
    'filterAll': 'All',
    'filterRunning': 'Running',
    'filterGit': 'With Git',
    'filterUnlabeled': 'Unlabeled',
    'filterProjectProcs': 'Project Related',
    'filterAllProcs': 'All',
    'hiddenFiles': 'Hidden',

    // Search Placeholders
    'searchProjectsPh': 'Search name / note / path…',
    'searchProcsPh': 'Filter command / project…',
    'paletteSearchPh': 'Search projects, processes or actions…',

    // Table Column Headers
    'colProcess': 'Process',
    'colPid': 'PID',
    'colProject': 'Project',
    'colLoad': 'Load',
    'colMem': 'Memory',
    'colUp': 'Uptime',
    'colAct': 'Action',
    'colName': 'Name',
    'colSize': 'Size',
    'colMtime': 'Modified',

    // Action Buttons
    'pin': 'Pin',
    'unpin': 'Unpin',
    'edit': 'Edit',
    'copyPath': 'Copy Path',
    'copyWinPath': 'Copy Windows Path',
    'viewLogs': 'Logs',
    'browse': 'Browse',
    'processing': '⋯ Working',
    'stop': 'Stop',
    'stopAll': 'Stop All',
    'start': 'Start',
    'cancel': 'Cancel',
    'confirm': 'Confirm',
    'save': 'Save',
    'close': 'Close',
    'add': 'Add',
    'forceKill': 'Force Kill',

    // Modals & Drawers
    'labelModalTitle': 'Project Annotation & Startup',
    'labelPath': 'Path',
    'labelName': 'Display Name',
    'labelNamePh': 'e.g. My Blog / API Service',
    'labelNameHint': 'Set a friendly alias for this project',
    'labelCmd': 'Start Command',
    'labelCmdPh': 'e.g. npm run dev / python3 app.py',
    'labelNote': 'Notes',
    'labelNotePh': 'Describe what this project does…',
    'labelClear': 'Reset Labels',

    'settingsTitle': 'WSL Command Center Settings',
    'setAppearance': 'Theme Appearance',
    'setAppearanceHint': 'Choose color palette for the dashboard',
    'appAuto': 'Auto (System)',
    'appLight': 'Light',
    'appDark': 'Dark',
    'setIgnore': 'Ignore Rules',
    'setIgnoreHint': 'Ignored directories will be excluded from scanning',
    'ignorePh': 'Type folder name and press Enter…',
    'infoDistro': 'WSL Distro',
    'infoVer': 'Kernel Version',
    'infoHome': 'Home Directory',
    'infoScan': 'Last Scan',
    'infoDataDir': 'Config Directory',
    'infoPort': 'Listen Port',

    'logsCenterTitle': 'Real-time Log Viewer',
    'drawerPreview': 'File Preview',
    'confirmModalTitle': 'Confirmation',

    'paletteSelect': 'Select',
    'paletteExec': 'Run',
    'paletteClose': 'Close',
    'tabMem': 'Memory Usage',

    // Empty & Notification States
    'procEmpty': 'No matching processes found',
    'fileEmpty': 'Empty directory',
    'noRunningProjects': 'No projects currently running — Go to Launchpad to start',
    'noDockerContainers': 'Docker not running or no active containers found',
    'noRecentActivity': 'No recent activities',
    'running': 'Running',
    'stopped': 'Stopped',
    'copied': 'Copied to clipboard',
    'saved': 'Saved successfully',
    'deleted': 'Removed',
    'pinnedToast': 'Pinned to top',
    'unpinnedToast': 'Unpinned from top',
    'stoppingProcess': 'Stopping process…',
    'startingProject': 'Starting project…',
    'stoppingProject': 'Stopping all processes…',
  }
};

let currentLang = 'zh';

export function getLang() {
  return currentLang;
}

export function t(key, vars = {}) {
  const dict = DICT[currentLang] || DICT.zh;
  let val = dict[key] || DICT.en[key] || DICT.zh[key] || key;
  if (typeof val === 'string' && vars && Object.keys(vars).length > 0) {
    for (const [k, v] of Object.entries(vars)) {
      val = val.replaceAll(`{${k}}`, v);
    }
  }
  return val;
}

export function applyI18n(lang) {
  if (lang && DICT[lang]) {
    currentLang = lang;
  }
  document.documentElement.lang = currentLang;

  // 1. 静态 data-i18n 文本替换
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });

  // 2. data-i18n-placeholder 属性替换
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    el.placeholder = t(key);
  });

  // 3. 语言切换按钮文案
  const btn = document.getElementById('langBtn');
  if (btn) {
    btn.textContent = currentLang === 'zh' ? 'EN' : '中';
    btn.title = currentLang === 'zh' ? 'Switch to English' : '切换为中文';
  }
}

export function setLang(lang) {
  if (!DICT[lang]) return;
  currentLang = lang;
  localStorage.setItem('wsl-cmd-lang', lang);
  applyI18n(lang);

  // 触发全局页面重绘，使动态卡片文案即刻更新
  if (window.__refreshAllViews) {
    window.__refreshAllViews();
  }
}

export function toggleLang() {
  setLang(currentLang === 'zh' ? 'en' : 'zh');
}

export function initI18n() {
  const stored = localStorage.getItem('wsl-cmd-lang');
  if (stored && DICT[stored]) {
    currentLang = stored;
  } else {
    // 默认如果系统语言是英文，自动以英文展示
    const navLang = (navigator.language || '').toLowerCase();
    currentLang = navLang.startsWith('zh') ? 'zh' : 'en';
  }

  const btn = document.getElementById('langBtn');
  if (btn) {
    btn.addEventListener('click', toggleLang);
  }

  applyI18n(currentLang);
}
