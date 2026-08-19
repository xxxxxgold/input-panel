export type WorkspacePageLoadKind =
  | "overview"
  | "systemSettings"
  | "usage"
  | "keys"
  | "subscriptions"
  | "serviceStatus"
  | "modelStats";

type PageLoadPresentation = {
  title: string;
  detail: string;
  metricCount: number;
  rowCount: number;
};

const PAGE_LOAD_PRESENTATIONS: Record<WorkspacePageLoadKind, PageLoadPresentation> = {
  overview: {
    title: "正在准备总览",
    detail: "正在读取当前工作台的概览数据。",
    metricCount: 4,
    rowCount: 5
  },
  systemSettings: {
    title: "正在准备系统设置",
    detail: "正在读取当前设备的窗口与刷新偏好。",
    metricCount: 0,
    rowCount: 4
  },
  usage: {
    title: "正在准备用量数据",
    detail: "正在读取当前账号的用量摘要与明细。",
    metricCount: 4,
    rowCount: 6
  },
  keys: {
    title: "正在准备密钥",
    detail: "正在读取当前账号的可用分组与 API 密钥。",
    metricCount: 3,
    rowCount: 5
  },
  subscriptions: {
    title: "正在准备订阅",
    detail: "正在读取当前账号的订阅摘要与额度信息。",
    metricCount: 3,
    rowCount: 4
  },
  serviceStatus: {
    title: "正在准备服务状态",
    detail: "正在连接本地服务状态读取链路。",
    metricCount: 3,
    rowCount: 4
  },
  modelStats: {
    title: "正在准备模型统计",
    detail: "正在读取当前账号的模型聚合结果。",
    metricCount: 4,
    rowCount: 5
  }
};

export function WorkspaceLoadingState({
  title = "正在加载工作台",
  detail = "当前页面内容还在准备中",
  staticBackdrop = false,
  page,
  error = null,
  onRetry
}: {
  title?: string;
  detail?: string;
  staticBackdrop?: boolean;
  page?: WorkspacePageLoadKind;
  error?: string | null;
  onRetry?: () => void;
}) {
  if (page) {
    return <WorkspacePageLoadState page={page} error={error} onRetry={onRetry} />;
  }

  return (
    <div
      className={`loading-state-backdrop ${staticBackdrop ? "loading-state-backdrop-static" : ""}`.trim()}
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="loading-state" role="status">
        <span className="loading-state-spinner spin" aria-hidden="true" />
        <div className="loading-state-copy">
          <strong>{title}</strong>
          <span>{detail}</span>
        </div>
      </div>
    </div>
  );
}

function WorkspacePageLoadState({
  page,
  error,
  onRetry
}: {
  page: WorkspacePageLoadKind;
  error: string | null;
  onRetry?: () => void;
}) {
  const presentation = PAGE_LOAD_PRESENTATIONS[page];
  const pageLabel = page === "keys" ? "密钥" : presentation.title.replace(/^正在准备/, "");

  if (error) {
    return (
      <section
        className={`workspace-page-load-state workspace-page-load-state-${page} workspace-page-load-state-error`}
        data-page-loading={page}
        role="alert"
      >
        <div className="workspace-page-load-copy">
          <strong>无法加载{pageLabel}</strong>
          <span>{error}</span>
        </div>
        {onRetry ? (
          <button type="button" className="ghost-button workspace-page-load-retry" onClick={onRetry}>
            重新加载
          </button>
        ) : null}
      </section>
    );
  }

  return (
    <section
      className={`workspace-page-load-state workspace-page-load-state-${page}`}
      data-page-loading={page}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="workspace-page-load-copy">
        <span className="loading-state-spinner spin" aria-hidden="true" />
        <div>
          <strong>{presentation.title}</strong>
          <span>{presentation.detail}</span>
        </div>
      </div>
      {presentation.metricCount > 0 ? (
        <div className="workspace-page-skeleton-metrics" aria-hidden="true">
          {Array.from({ length: presentation.metricCount }, (_, index) => (
            <span key={index} className="workspace-page-skeleton-metric" />
          ))}
        </div>
      ) : null}
      <div className="workspace-page-skeleton-card" aria-hidden="true">
        <span className="workspace-page-skeleton-line long" />
        <span className="workspace-page-skeleton-line medium" />
        <div className="workspace-page-skeleton-rows">
          {Array.from({ length: presentation.rowCount }, (_, index) => (
            <span key={index} className="workspace-page-skeleton-row" />
          ))}
        </div>
      </div>
    </section>
  );
}
