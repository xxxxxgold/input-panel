import { describe, expect, it } from "vitest";

import { readBundledStyles } from "./helpers/styles";

const styles = readBundledStyles();

describe("motion style hooks", () => {
  it("keeps shell page transition classes and reduced-motion fallback", () => {
    expect(styles).toContain(".workspace-page.page-motion-enter");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toContain(".topbar-reload-button .spin");
    expect(styles).toContain(".floating-command-actions .floating-menu-refresh .spin");
    expect(styles).toContain(".sync-task-center .spin");
    expect(styles).toContain(".sync-task-progress-track.is-indeterminate");
    expect(styles).toContain(".toast-progress-bar {");
    expect(styles).toContain("animation-duration: var(--toast-duration) !important;");
  });

  it("keeps rail active pill motion without animating the floating image", () => {
    expect(styles).toContain(".rail-item-active-pill");
    expect(styles).not.toContain(".floating-orb-button.menu-open");
    expect(styles).not.toContain("@keyframes floating-orb-breathe");
  });

  it("keeps composition hints on active motion instead of ordinary static cards", () => {
    expect(styles).toContain(".floating-menu-card.visible:hover,");
    expect(styles).toContain(".modal-backdrop.modal-visible .modal-card:focus-within,");
    expect(styles).toContain(".toast-card:hover,");
    expect(styles).toContain(".motion-surface-card:hover,");
    expect(styles).toContain(".table-row-motion:hover {");
    expect(styles).not.toMatch(/\.metric-card,\s*\.section-card,\s*\.context-card\s*\{\s*will-change:/);
    expect(styles).not.toMatch(/\.motion-surface-card,\s*\.theme-card,\s*\.context-card\s*\{\s*will-change:/);
    expect(styles).not.toContain(".modal-backdrop.modal-visible .modal-card,\n.toast-card,");
    expect(styles).toContain("will-change: auto !important;");
  });

  it("keeps task status motion functional and scopes reduced-motion overrides", () => {
    expect(styles).toMatch(/\.floating-command-actions \.floating-menu-refresh \.spin\s*\{[^}]*animation-duration: 0\.9s !important;[^}]*animation-iteration-count: infinite !important;/s);
    expect(styles).toMatch(/\.sync-task-center \.spin\s*\{[^}]*animation-duration: 0\.9s !important;[^}]*animation-iteration-count: infinite !important;/s);
    expect(styles).toMatch(/\.sync-task-center \.sync-task-progress-track\.is-indeterminate \.sync-task-progress-fill\s*\{[^}]*animation: none !important;[^}]*transform: none !important;/s);
  });
});
