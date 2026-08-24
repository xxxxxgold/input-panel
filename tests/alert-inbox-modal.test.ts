import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AlertInboxModal
} from "../src/features/overview/components/AlertInboxModal";
import { readBundledStyles } from "./helpers/styles";

const styles = readBundledStyles();

describe("AlertInboxModal", () => {
  it("renders alert rows and inbox copy", () => {
    const items = [
      {
        notificationKey: "overview-alert:alert-1",
        source: "overview-alert" as const,
        id: "alert-1",
        accountLabel: "主账号",
        siteName: "AI INPUT",
        severity: "critical",
        title: "主账号 余额已耗尽",
        detail: "AI INPUT 当前余额为 0, 请尽快充值。",
        createdAt: "2026-06-11T22:53:00.000Z"
      }
    ];

    const html = renderToStaticMarkup(
      createElement(AlertInboxModal, {
        items,
        onClose: () => {},
        onAcknowledge: () => {}
      })
    );

    expect(html).toContain("消息盒子");
    expect(html).not.toContain('class="modal-close-button"');
    expect(html).not.toContain('aria-label="关闭"');
    expect(html).not.toContain('aria-label="消息概览"');
    expect(html).not.toContain("1 条待处理消息");
    expect(html).toContain("主账号 余额已耗尽");
    expect(html).toContain("AI INPUT");
    expect(html).toContain("主账号");
    expect(html).toContain("标记已处理");
    expect(html).toContain('aria-label="消息来源"');
  });

  it("renders service status records in the shared inbox", () => {
    const items = [
      {
        notificationKey: "service-status:status-1",
        source: "service-status" as const,
        id: "status-1",
        severity: "success" as const,
        title: "检测到服务状态恢复正常",
        detail: "服务状态自动刷新检测到 3 个模型当前均已恢复正常。",
        createdAt: "2026-06-15T12:00:00.000Z",
        models: ["gpt-5.5", "gpt-5.4", "gpt-4.1"]
      }
    ];

    const html = renderToStaticMarkup(
      createElement(AlertInboxModal, {
        items,
        onClose: () => {},
        onAcknowledge: () => {}
      })
    );

    expect(html).toContain("检测到服务状态恢复正常");
    expect(html).toContain("服务状态");
    expect(html).toContain("自动监控");
    expect(html).toContain("涉及模型: gpt-5.5, gpt-5.4, gpt-4.1");
  });

  it("renders empty state when there are no alerts", () => {
    const html = renderToStaticMarkup(
      createElement(AlertInboxModal, {
        items: [],
        onClose: () => {},
        onAcknowledge: () => {}
      })
    );

    expect(html).toContain("没有待处理消息");
    expect(html).toContain("当前没有新的提醒需要处理。");
  });

  it("keeps the inbox compact and scrollable inside short viewports", () => {
    expect(styles).toMatch(
      /\.modal-card\.wide\.alert-inbox-modal\s*\{[\s\S]*?max-height: min\(720px, var\(--modal-card-max-height\)\);[\s\S]*?display: flex;[\s\S]*?overflow: hidden;/
    );
    expect(styles).toMatch(
      /\.alert-inbox-modal-body\s*\{[\s\S]*?min-height: 0;[\s\S]*?flex: 1 1 auto;[\s\S]*?overflow-y: auto;/
    );
    expect(styles).toMatch(
      /\.alert-inbox-item\s*\{[\s\S]*?grid-template-columns: auto minmax\(0, 1fr\) auto;[\s\S]*?border-radius: 8px;/
    );
  });
});
