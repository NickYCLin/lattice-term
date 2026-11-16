import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { initialMetricsState } from "../../domain/metrics";
import { createConnectionProfile, emptyDraft } from "../../domain/connection";
import { I18nProvider } from "../../i18n";
import { ConnectionInspector } from "./ConnectionInspector";

describe("connection inspector tabs", () => {
  it("exposes one tab stop and labels the active panel", () => {
    const profile = createConnectionProfile(
      {
        ...emptyDraft("ssh"),
        name: "Example host",
        hostname: "host.example.com",
        username: "operator",
      },
      "example-host",
    );
    const markup = renderToStaticMarkup(
      <I18nProvider locale="zh-TW">
        <ConnectionInspector
          profile={profile}
          metrics={initialMetricsState}
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(markup.match(/role="tab"/g)).toHaveLength(2);
    expect(
      markup.match(/role="tab" aria-selected="true" tabindex="0"/g),
    ).toHaveLength(1);
    expect(
      markup.match(/role="tab" aria-selected="false" tabindex="-1"/g),
    ).toHaveLength(1);
    expect(markup).toContain('role="tabpanel"');
    expect(markup).toMatch(/aria-labelledby="[^"]+-info-tab"/);
  });
});

it("keeps connection management on the card while the inspector shows structured details", () => {
  const profile = createConnectionProfile({ ...emptyDraft("ssh"), name: "Example", hostname: "host.example.com", username: "operator" }, "example");
  const markup = renderToStaticMarkup(<I18nProvider locale="zh-TW"><ConnectionInspector
    profile={profile} metrics={initialMetricsState} onClose={vi.fn()} /></I18nProvider>);
  expect(markup).not.toContain('inspector__footer');
  expect(markup).not.toContain('inspector__target');
  for (const action of ["編輯", "複製", "刪除", "新增連線方式"]) expect(markup).not.toContain(`>${action}</button>`);
  expect(markup).toContain("host.example.com");
  expect(markup).toContain("operator");
});
