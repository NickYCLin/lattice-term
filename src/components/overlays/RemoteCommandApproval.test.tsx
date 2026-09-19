import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../../i18n";
import type { PendingRemoteCommand } from "../../app/useRemoteCommandApprovals";

const waiting: PendingRemoteCommand[] = [];
const decide = vi.fn();
vi.mock("../../app/useRemoteCommandApprovals", () => ({
  useRemoteCommandApprovals: () => ({ pending: waiting, decide }),
}));

const { RemoteCommandApproval, remainingSeconds } = await import("./RemoteCommandApproval");

function proposal(overrides: Partial<PendingRemoteCommand> = {}): PendingRemoteCommand {
  return {
    operationId: "op-1",
    targetId: "target-1",
    targetLabel: "工作機",
    client: "codex",
    command: "systemctl restart nginx",
    timeoutMs: 60_000,
    expiresInMs: 120_000,
    ...overrides,
  };
}

function render() {
  return renderToStaticMarkup(
    <I18nProvider locale="zh-TW">
      <RemoteCommandApproval />
    </I18nProvider>,
  );
}

describe("RemoteCommandApproval", () => {
  it("stays out of the way until a command is actually waiting", () => {
    waiting.length = 0;
    expect(render()).toBe("");
  });

  it("shows the exact command and offers refusal first", () => {
    waiting.length = 0;
    waiting.push(proposal(), proposal({ operationId: "op-2" }));
    const html = render();
    expect(html).toContain("systemctl restart nginx");
    expect(html).toContain("工作機");
    expect(html).toContain("codex");
    expect(html).toContain('role="alertdialog"');
    // Refusing is the first action a keyboard reaches, and one queued
    // proposal is never decided by answering another.
    expect(html.indexOf("拒絕")).toBeLessThan(html.indexOf("允許這一次"));
    expect(html).toContain("還有 1 筆等你決定");
  });

  it("counts down to the deadline and never below zero", () => {
    const now = 1_000_000;
    expect(remainingSeconds(now + 119_400, now)).toBe(120);
    expect(remainingSeconds(now - 5_000, now)).toBe(0);
  });
});
