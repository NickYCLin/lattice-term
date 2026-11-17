import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { navigationItems, navigationItemsFor } from "../../app/navigation";
import { I18nProvider } from "../../i18n";
import { NavRail } from "./NavRail";

describe("navigation activity badge", () => {
  it("shows schedules as a separate navigation entry with its own unread count", () => {
    const markup = renderToStaticMarkup(<I18nProvider locale="zh-TW"><NavRail
      current="automations" onSelect={vi.fn()} automationUnreadCount={2} /></I18nProvider>);
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('>2</span>');
    expect(markup).toContain('aria-label="排程，2 個未讀結果"');
    expect(markup).toContain("排程");
  });
  it("shows an accessible unread count on the Activity bell", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider locale="zh-TW">
        <NavRail
          current="connections"
          onSelect={vi.fn()}
          items={navigationItems}
          activityUnreadCount={3}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('aria-label="活動，3 個未讀"');
    expect(markup).toContain('class="rail__badge"');
    expect(markup).toContain(">3</span>");
  });

  it("caps the visual badge while retaining the full accessible count", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider locale="en">
        <NavRail
          current="activity"
          onSelect={vi.fn()}
          items={navigationItems}
          activityUnreadCount={120}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('aria-label="Activity, 120 unread"');
    expect(markup).toContain(">99+</span>");
  });
});

it.each([true,false])("partitions mobile navigation only below the compact breakpoint: %s", narrow => {
  vi.stubGlobal("window",{matchMedia:()=>({matches:narrow})});
  try {
    const html=renderToStaticMarkup(<I18nProvider locale="zh-TW"><NavRail mobile current="settings" items={navigationItemsFor("ios")} onSelect={vi.fn()} /></I18nProvider>);
    const count=(html.match(/class="rail__item(?: is-active)?"/g)??[]).length;
    expect(count).toBe(narrow?5:7);
    for (const label of ["我的連線","工作階段","設定"]) expect(html).toContain(label);
    expect(html.includes('>更多</span>')).toBe(narrow);
    if(narrow){expect(html).toContain("遠端助理");expect(html).not.toContain('aria-label="通道"');}
    else {expect(html).toContain("遠端 Agent Fleet");expect(html).toContain("金鑰保管庫");}
  } finally {vi.unstubAllGlobals();}
});
it("keeps hidden-page selection and the activity unread badge visible on More",()=>{
  vi.stubGlobal("window",{matchMedia:()=>({matches:true})});
  try {
    const html=renderToStaticMarkup(<I18nProvider locale="zh-TW"><NavRail mobile current="vault" items={navigationItemsFor("ios")} activityUnreadCount={3} onSelect={vi.fn()} /></I18nProvider>);
    expect(html).toContain('aria-label="更多，活動有 3 個未讀"');expect(html).toContain('aria-current="page"');expect(html).toContain('>3</span>');
  } finally {vi.unstubAllGlobals();}
});
