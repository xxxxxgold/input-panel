// 静态具名导入才能让 Rollup 对 echarts 摇树；禁止动态 import barrel
// （import("echarts/charts") 会把全部图表系列打进 chunk）。
// heatmap/scatter/visualMap 仅图表实验室使用，由 AnalyticsLab 自行追加注册。
import { BarChart, LineChart, PieChart } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  TooltipComponent
} from "echarts/components";
import { init, use as registerEChartsModules } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

registerEChartsModules([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer
]);

export { init };
