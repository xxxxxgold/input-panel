/** 主窗口保存动作完成后的短暂 Toast 反馈。 */
export interface SaveFeedback {
  tone: "success" | "error";
  title: string;
  message: string;
}

/** 保存终态反馈回调。 */
export type SaveFeedbackHandler = (feedback: SaveFeedback) => void;
