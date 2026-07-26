// 图表实验室专用的 echarts 增量注册（heatmap/scatter/visualMap）。
// 仅由 AnalyticsLab 导入，跟随其懒加载 chunk，不进入基础 charts-runtime。
import { HeatmapChart, ScatterChart } from "echarts/charts";
import { VisualMapComponent } from "echarts/components";
import { use as registerEChartsModules } from "echarts/core";

registerEChartsModules([HeatmapChart, ScatterChart, VisualMapComponent]);
