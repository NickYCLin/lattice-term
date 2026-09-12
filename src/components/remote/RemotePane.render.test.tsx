import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  RemoteApi,
  RemoteSessionSummary,
} from "../../app/useRemoteSessions";
import { I18nProvider } from "../../i18n";
import { RemotePane } from "./RemotePane";

const session: RemoteSessionSummary = {
  sessionId: "remote-test",
  profileId: "profile-test",
  host: "192.0.2.10",
  port: 44900,
  viaRelay: false,
  agentName: "Test workstation",
  width: 1280,
  height: 720,
  viewOnly: false,
  fileTransfer: false,
  fileRootLabel: "",
  terminal: false,
  frame: null,
};

const remote = {
  input: vi.fn(() => Promise.resolve()),
} as unknown as RemoteApi;

function renderRemote(viewOnly: boolean, fileTransfer = false): string {
  return renderToStaticMarkup(
    <I18nProvider locale="zh-TW">
      <RemotePane
        session={{ ...session, viewOnly, fileTransfer }}
        remote={remote}
        theme="dark"
      />
    </I18nProvider>,
  );
}

describe("Lattice Remote canvas interaction", () => {
  it("offers commands only when the host advertises a grant, including view-only screens", () => {
    expect(renderRemote(true)).not.toContain('aria-label="命令"');
    const markup = renderToStaticMarkup(<I18nProvider locale="zh-TW"><RemotePane session={{ ...session, viewOnly: true, commandShells: 3 }} remote={remote} theme="dark" /></I18nProvider>);
    expect(markup).toContain('aria-label="命令"');
    expect(markup).toContain('remote-command-pane" hidden=""');
  });
  it("exposes an interactive, focusable pointer target when control is allowed", () => {
    const markup = renderRemote(false);

    expect(markup).toContain(
      'class="remote-frame-canvas remote-frame-canvas--interactive rdp-canvas"',
    );
    expect(markup).toMatch(
      /<canvas[^>]*tabindex="0"[^>]*role="application"/,
    );
    expect(markup).toContain('aria-label="開啟軟體鍵盤"');
    expect(markup).toContain('aria-label="遠端鍵盤輸入"');
  });

  it("keeps view-only frames out of pointer and keyboard interaction", () => {
    const markup = renderRemote(true);

    expect(markup).toContain(
      'class="remote-frame-canvas remote-frame-canvas--view-only"',
    );
    expect(markup).toMatch(/<canvas[^>]*role="img"/);
    expect(markup).not.toMatch(/<canvas[^>]*tabindex=/);
    expect(markup).not.toContain('aria-label="開啟軟體鍵盤"');
  });

  it("labels the icon-only mobile file disclosure", () => {
    const markup = renderRemote(false, true);

    expect(markup).toMatch(
      /<button[^>]*aria-expanded="false"[^>]*aria-label="主機檔案"/,
    );
  });
});
