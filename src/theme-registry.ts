export const THEME_IDS = [
  "sakura-signal",
  "arctic-relay",
  "ember-circuit",
  "verdant-core",
  "titan-noir"
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

export const DEFAULT_THEME_ID: ThemeId = "sakura-signal";

export const THEME_OPTIONS: ThemeOption[] = [
  {
    id: "sakura-signal",
    label: "樱雾信标",
    summary: "雾白底上的樱花粉与淡紫信号, 是更轻盈的浅色工作台。",
    family: "light",
    accent: "#ef78b0",
    preview: "linear-gradient(135deg, #fff8fc 0%, #f8edf6 54%, #efe7fb 100%)"
  },
  {
    id: "arctic-relay",
    label: "极地中继",
    summary: "冰白与冷青构成的清晰中继台, 适合日间核对。",
    family: "light",
    accent: "#35a9bf",
    preview: "linear-gradient(135deg, #f7fbff 0%, #eaf4ff 54%, #d9f1f0 100%)"
  },
  {
    id: "ember-circuit",
    label: "余烬回路",
    summary: "炭黑底上的琥珀与赤焰信号, 更适合高热分析场景。",
    family: "dark",
    accent: "#ff9863",
    preview: "linear-gradient(135deg, #130d10 0%, #241518 52%, #4a281c 100%)"
  },
  {
    id: "verdant-core",
    label: "青核中枢",
    summary: "深绿机核与荧芯高光, 适合基础设施值守。",
    family: "dark",
    accent: "#62d488",
    preview: "linear-gradient(135deg, #07100c 0%, #112019 50%, #1d4031 100%)"
  },
  {
    id: "titan-noir",
    label: "钛夜主控",
    summary: "冷黑钛灰工作台, 适合长期主控和值守。",
    family: "dark",
    accent: "#7ec6ff",
    preview: "linear-gradient(135deg, #070d16 0%, #0f1621 52%, #1a2737 100%)"
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
