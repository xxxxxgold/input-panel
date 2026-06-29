export const THEME_IDS = [
  "light",
  "dark",
  "deep-blue",
  "cloud-mist",
  "graphite-cyan",
  "warm-paper-console",
  "carbon-amber-terminal",
  "spruce-server-room",
  "polar-lab",
  "spectral-lab",
  "clinical-monitor-bay",
  "audit-archive-room",
  "system-follow"
] as const;

export type ThemeId = (typeof THEME_IDS)[number];

export interface ThemeOption {
  id: ThemeId;
  label: string;
  summary: string;
  family: "light" | "dark";
  accent: string;
  preview: string;
}

export const DEFAULT_THEME_ID: ThemeId = "light";

export const THEME_OPTIONS: ThemeOption[] = [
  {
    id: "light",
    label: "浅色经典",
    summary: "明亮轻盈, 适合通用浏览与基础管理。",
    family: "light",
    accent: "#68c4ba",
    preview: "linear-gradient(135deg, #ffffff 0%, #edf4fb 50%, #d5efe9 100%)"
  },
  {
    id: "dark",
    label: "深色经典",
    summary: "低干扰深色盘, 适合夜间与通用工作台。",
    family: "dark",
    accent: "#77d8ca",
    preview: "linear-gradient(135deg, #0f141d 0%, #1a2433 52%, #203447 100%)"
  },
  {
    id: "deep-blue",
    label: "深蓝护眼",
    summary: "现有控制台风格, 保留原始深蓝工作模式。",
    family: "dark",
    accent: "#7fd2c8",
    preview: "linear-gradient(135deg, #0a1321 0%, #0e1d32 48%, #1d3b62 100%)"
  },
  {
    id: "cloud-mist",
    label: "中性运营灰",
    summary: "雾灰浅底, 强调高密度列表与指标判读。",
    family: "light",
    accent: "#4fa8b8",
    preview: "linear-gradient(135deg, #fbfcfe 0%, #eef3f8 46%, #d9e9f3 100%)"
  },
  {
    id: "graphite-cyan",
    label: "石墨青夜班",
    summary: "石墨夜盘配冷青信号色, 适合持续值守。",
    family: "dark",
    accent: "#4fd0d9",
    preview: "linear-gradient(135deg, #0d1117 0%, #14202d 46%, #14394a 100%)"
  },
  {
    id: "warm-paper-console",
    label: "暖纸控制台",
    summary: "暖白纸感台账, 适合长时间核对与配置处理。",
    family: "light",
    accent: "#2e8c88",
    preview: "linear-gradient(135deg, #fcfaf4 0%, #f4eee2 46%, #e7dcc7 100%)"
  },
  {
    id: "carbon-amber-terminal",
    label: "琥珀交易台",
    summary: "炭黑底配琥珀高亮, 突出高频数据与风险感知。",
    family: "dark",
    accent: "#ffb24d",
    preview: "linear-gradient(135deg, #121012 0%, #21181a 48%, #4c2d18 100%)"
  },
  {
    id: "spruce-server-room",
    label: "冷杉机房",
    summary: "深绿机房夜盘, 强调基础设施值守与稳定运行。",
    family: "dark",
    accent: "#6fcca0",
    preview: "linear-gradient(135deg, #0d1210 0%, #16201b 48%, #284135 100%)"
  },
  {
    id: "polar-lab",
    label: "极地实验台",
    summary: "冷亮实验底盘, 适合高精度核对与低刺激阅读。",
    family: "light",
    accent: "#3b90c9",
    preview: "linear-gradient(135deg, #ffffff 0%, #f1f7fd 44%, #dcecf8 100%)"
  },
  {
    id: "spectral-lab",
    label: "光谱实验台",
    summary: "深靛光谱面板, 突出图表比较与信号分析。",
    family: "dark",
    accent: "#8a7dff",
    preview: "linear-gradient(135deg, #10111a 0%, #1a1b2a 46%, #2f2a4f 100%)"
  },
  {
    id: "clinical-monitor-bay",
    label: "医护监测舱",
    summary: "无菌白监测面, 强化状态信号与连续监护节奏。",
    family: "light",
    accent: "#35b39c",
    preview: "linear-gradient(135deg, #fdfffe 0%, #eef8f4 44%, #d7efe8 100%)"
  },
  {
    id: "audit-archive-room",
    label: "审计档案室",
    summary: "冷纸档案语气, 适合台账核查与证据链阅读。",
    family: "light",
    accent: "#6a7e8f",
    preview: "linear-gradient(135deg, #faf7f1 0%, #f0ebe2 44%, #ddd6ca 100%)"
  },
  {
    id: "system-follow",
    label: "跟随系统",
    summary: "自动跟随系统深色/浅色设置, 无缝适配环境。",
    family: "light",
    accent: "#68c4ba",
    preview: "linear-gradient(135deg, #ffffff 0%, #e2e8f0 50%, #cbd5e1 100%)"
  }
];

const THEME_ID_SET = new Set<string>(THEME_IDS);

export function isThemeId(value: string): value is ThemeId {
  return THEME_ID_SET.has(value);
}

export function normalizeThemeId(value?: string | null): ThemeId {
  if (value && isThemeId(value)) {
    return value;
  }
  return DEFAULT_THEME_ID;
}

export function getNextThemeId(current: ThemeId): ThemeId {
  const index = THEME_IDS.indexOf(current);
  if (index < 0) {
    return DEFAULT_THEME_ID;
  }
  return THEME_IDS[(index + 1) % THEME_IDS.length];
}
