import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WorkspaceFrame } from "../src/app/WorkspaceFrame";
import { readBundledStyles } from "./helpers/styles";

const styles = readBundledStyles().replace(/\r\n/g, "\n");

const defaultProps = {
  topbar: createElement("div", null, "topbar"),
  title: "总览",
  subtitle: "这里会显示工作台内容",
  loading: false,
  ready: true,
  navKey: "overview",
  children: createElement("section", null, "page-content")
};

function renderFrame(overrides: Partial<Parameters<typeof WorkspaceFrame>[0]> = {}) {
  return renderToStaticMarkup(createElement(WorkspaceFrame, { ...defaultProps, ...overrides }));
}

function findElement(node: ReactNode, predicate: (element: ReactElement) => boolean): ReactElement | null {
  if (!isValidElement(node)) return null;
  if (predicate(node)) return node;

  for (const child of Children.toArray(node.props.children)) {
    const match = findElement(child, predicate);
    if (match) return match;
  }

  return null;
}

describe("WorkspaceFrame loading behavior", () => {
  it("blocks a cold shell load while keeping its page container mounted", () => {
    const html = renderFrame({ loading: true, ready: false, pageMotionPhase: "enter" });

    expect(html).toContain("workspace-window-shell");
    expect(html).not.toContain("workspace-header-summary");
    expect(html).toContain("aria-busy=\"true\"");
    expect(html).toContain("workspace-page-shell is-loading");
    expect(html).toContain("workspace-scroll workspace-page page-motion-enter");
    expect(html).toContain("inert=\"\"");
    expect(html).toContain("page-content");
    expect(html).toContain("loading-state-backdrop");
    expect(html).toContain("loading-state-spinner spin");
    expect(html).toContain("正在加载工作台");
    expect(html).toContain("当前页面内容还在准备中");
  });

  it("keeps an existing shell snapshot visible while loading refreshes", () => {
    const html = renderFrame({ loading: true, ready: true });

    expect(html).toContain("aria-busy=\"false\"");
    expect(html).toContain("page-content");
    expect(html).not.toContain("inert=\"\"");
    expect(html).not.toContain("workspace-page-shell is-loading");
    expect(html).not.toContain("loading-state-backdrop");
  });

  it("keeps the workspace shell available while the explicit current target scope has no snapshot", () => {
    const html = renderFrame({ scopeLoading: true });

    expect(html).toContain("aria-busy=\"false\"");
    expect(html).toContain("workspace-page-shell");
    expect(html).not.toContain("workspace-page-shell is-loading");
    expect(html).not.toContain("loading-state-backdrop");
    expect(html).toContain("page-content");
  });

  it("does not render a header banner for normal background refreshes", () => {
    const html = renderFrame();

    expect(html).toContain("aria-busy=\"false\"");
    expect(html).not.toContain("workspace-refresh-status");
    expect(html).not.toContain("正在后台刷新, 当前内容保持可用");
    expect(html).toContain("page-content");
    expect(html).not.toContain("loading-state-backdrop");
  });

  it("shows a retained-snapshot error and wires an actionable retry", () => {
    const onRetry = () => undefined;
    const html = renderFrame({ refreshError: "网络暂时不可用", onRetry });
    const tree = WorkspaceFrame({ ...defaultProps, refreshError: "网络暂时不可用", onRetry });
    const retryButton = findElement(
      tree,
      (element) => element.type === "button" && element.props.className === "ghost-button workspace-refresh-retry"
    );

    expect(html).toContain("role=\"alert\"");
    expect(html).toContain("aria-live=\"assertive\"");
    expect(html).toContain("刷新失败, 当前仍显示上次成功数据: 网络暂时不可用");
    expect(html).toContain("重新刷新");
    expect(html).not.toContain("loading-state-backdrop");
    expect(retryButton?.props.type).toBe("button");
    expect(retryButton?.props.onClick).toBe(onRetry);
  });

  it("keeps page content in a bounded scroll container", () => {
    expect(styles).toContain(`html,
body,
#root {
  margin: 0;
  height: 100%;
  min-height: 100%;
}`);
    expect(styles).toContain(`.workspace-page-shell {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;`);
    expect(styles).toContain(`.loading-state-backdrop {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: grid;
  place-items: center;
  padding: 24px;
  pointer-events: auto;
  cursor: progress;`);
    expect(styles).toContain(`.workspace-scroll {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;`);
  });

  it("keeps header actions on the same row as the overview title copy", () => {
    const html = renderFrame({
      subtitle: "AI INPUT / 主账号",
      headerActions: createElement("div", null, "当前账号", "全部账号")
    });

    expect(html).toContain("workspace-header-copy has-header-actions");
    expect(styles).toContain(`.workspace-header-copy.has-header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}`);
    expect(styles).toContain(`.workspace-header-copy.has-header-actions .workspace-header-actions {
  margin-top: 0;
}`);
  });

  it("keeps every workspace title and contextual hint compact", () => {
    const html = renderFrame({ title: "密钥", subtitle: "AI INPUT / 主账号", navKey: "keys" });

    expect(html).toContain("workspace-header-main");
    expect(html).toContain('<div class="title-with-hint"><h2>密钥</h2>');
    expect(html).toContain('aria-label="查看密钥说明"');
    expect(html).not.toContain('<p class="workspace-subtitle">');
    expect(styles).toContain(`.workspace-header-main > .title-with-hint {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: nowrap;`);
    expect(styles).toContain(`.workspace-header h2 {
  flex: 0 0 auto;
  line-height: 1.1;
  white-space: nowrap;
}`);
  });

  it("keeps refresh feedback compact and responsive on narrow screens", () => {
    expect(styles).toContain(`.workspace-refresh-status {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;`);
    expect(styles).toContain(`.workspace-refresh-status > span {
  min-width: 0;
  overflow-wrap: anywhere;
}`);
    expect(styles).toContain(`@media (max-width: 560px) {
  .workspace-refresh-status {
    grid-template-columns: auto minmax(0, 1fr);`);
    expect(styles).toContain(`.workspace-refresh-retry.ghost-button {
    grid-column: 2;
    justify-self: start;`);
  });
});
