import { SectionCard } from "../shared/ui/SectionCard";

export function ServiceStatusPage() {
  return (
    <section className="content-grid status-page-grid">
      <SectionCard
        title="AI.INPUT.IM 服务状态"
        subtitle="直接内嵌官方状态页, 保持内容和远端展示一致。"
        actions={
          <a
            className="inline-text-button"
            href="https://status.input.im"
            target="_blank"
            rel="noreferrer"
          >
            打开原页面
          </a>
        }
      >
        <div className="status-embed-shell">
          <div className="status-embed-toolbar">
            <div>
              <strong>status.input.im</strong>
              <p>终端风格监控、历史条形状态和实时刷新均由远端页面维护。</p>
            </div>
            <span className="status-pill neutral">Live</span>
          </div>
          <iframe
            className="status-embed-frame"
            src="https://status.input.im"
            title="AI.INPUT.IM 服务状态"
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        </div>
      </SectionCard>
    </section>
  );
}
