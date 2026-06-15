export const THEME_IDS = [
  "light",
  "dark",
  "deep-blue",
  "cloud-mist",
  "graphite-cyan",
  "warm-paper-console",
  "carbon-amber-terminal"
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
