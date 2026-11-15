import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n";
import { ChatMarkdown } from "./ChatMarkdown";
import { highlightCode } from "./highlightCode";

const render = (source: string) => renderToStaticMarkup(<I18nProvider locale="zh-TW"><ChatMarkdown source={source} /></I18nProvider>);
describe("assistant Markdown", () => {
  it("renders linked, emphasized, quoted and nested content with GFM tables", () => {
    const html = render('[來源](https://example.com) *重點* ~~舊版~~\n\n> 引言\n\n- 第一層\n  - 第二層\n\n| 欄位 | 值 |\n| --- | ---: |\n| 模型 | 2 |\n\n- [x] 已完成');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('<em>重點</em>');
    expect(html).toContain('<del>舊版</del>');
    expect(html).toContain('<blockquote>');
    expect(html.match(/<ul/g)).toHaveLength(3);
    expect(html).toContain('<table>');
    expect(html).toContain('<th>欄位</th>');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked=""');
  });
  it("does not execute HTML, unsafe URLs or fetch remote images", () => {
    const html = render('<script>alert(1)</script>\n\n[click](javascript:alert%281%29)\n\n![tracker](https://tracker.example/pixel)');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('<img');
    expect(html).toContain('click');
  });
  it("keeps unfinished streaming code and provides an exact-code copy action", () => {
    const html = render('```ts\nconst text = "<img onerror=attack>";');
    expect(html).toContain('data-language="ts"');
    expect(html).toContain('複製');
    expect(html).toContain('&lt;img onerror=attack&gt;');
    expect(html).not.toContain('<img');
  });
  it("highlights declared languages without trusting code as HTML", () => {
    const html = renderToStaticMarkup(<code>{highlightCode('const x = "<script>";', 'typescript')}</code>);
    expect(html).toContain('hljs-keyword');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(highlightCode('plain <x>', 'unknown-language')).toBe('plain <x>');
  });
});
