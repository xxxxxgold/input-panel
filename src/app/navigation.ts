import {
  Activity,
  BadgeDollarSign,
  ChartColumn,
  ChartPie,
  KeyRound,
  LayoutDashboard,
  Radar,
  Server,
  Settings2
} from "lucide-react";

import type { NavKey } from "../types";

export const NAV_ITEMS: Array<{
  key: NavKey;
  label: string;
  icon: typeof LayoutDashboard;
}> = [
  { key: "overview", label: "总览", icon: LayoutDashboard },
  { key: "serviceStatus", label: "服务状态", icon: Activity },
  { key: "codexRadar", label: "降智雷达", icon: Radar },
  { key: "keys", label: "密钥", icon: KeyRound },
  { key: "usage", label: "用量", icon: ChartColumn },
  { key: "modelStats", label: "模型统计", icon: ChartPie },
  { key: "subscriptions", label: "订阅", icon: BadgeDollarSign },
  { key: "trends", label: "数据分析", icon: ChartColumn },
  { key: "settings", label: "账号与站点", icon: Server },
  { key: "systemSettings", label: "系统设置", icon: Settings2 }
];

export function navTitle(key: NavKey) {
  switch (key) {
    case "overview":
      return "总览";
    case "serviceStatus":
      return "服务状态";
    case "codexRadar":
      return "降智雷达";
    case "keys":
      return "密钥";
    case "usage":
      return "用量";
    case "modelStats":
      return "模型统计";
    case "subscriptions":
      return "订阅";
    case "trends":
      return "数据分析";
    case "alerts":
      return "告警";
    case "settings":
      return "账号与站点";
    case "systemSettings":
      return "系统设置";
    case "sites":
      return "站点";
    case "accounts":
      return "账号";
    case "profile":
      return "个人中心";
    default:
      return "工作台";
  }
}
