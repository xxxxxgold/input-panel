import {
  Activity,
  BadgeDollarSign,
  ChartColumn,
  KeyRound,
  LayoutDashboard,
  MonitorDot,
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
  { key: "keys", label: "密钥", icon: KeyRound },
  { key: "usage", label: "用量", icon: ChartColumn },
  { key: "subscriptions", label: "订阅", icon: BadgeDollarSign },
  { key: "keyUsage", label: "单 Key", icon: MonitorDot },
  { key: "trends", label: "图表实验室", icon: ChartColumn },
  { key: "settings", label: "站点账号配置", icon: Server },
  { key: "systemSettings", label: "系统设置", icon: Settings2 }
];

export function navTitle(key: NavKey) {
  switch (key) {
    case "overview":
      return "总览";
    case "serviceStatus":
      return "服务状态";
    case "keys":
      return "密钥";
    case "usage":
      return "用量";
    case "subscriptions":
      return "订阅";
    case "keyUsage":
      return "单 Key 用量";
    case "trends":
      return "图表实验室";
    case "alerts":
      return "告警";
    case "settings":
      return "站点账号配置";
    case "systemSettings":
      return "系统设置";
    case "sites":
      return "站点";
    case "accounts":
      return "账号";
    case "profile":
      return "个人中心";
    case "orders":
      return "订单";
    default:
      return "工作台";
  }
}
