import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../../i18n";
import { elicitationAnswer, McpElicitation, parseElicitation } from "./McpElicitation";

const form = JSON.stringify({
  mode: "form",
  serverName: "github",
  message: "Which repository?",
  requestedSchema: {
    type: "object",
    properties: {
      repo: { type: "string", title: "Repository" },
      branch: { type: "string", enum: ["main", "dev"], enumNames: ["Main", "Development"] },
      depth: { type: "integer", default: 5 },
      force: { type: "boolean" },
    },
    required: ["repo"],
  },
});

const multi = JSON.stringify({
  mode: "form",
  serverName: "github",
  message: "Which labels?",
  requestedSchema: {
    type: "object",
    properties: {
      labels: {
        type: "array",
        title: "Labels",
        items: { type: "string", enum: ["bug", "chore"], enumNames: ["Bug", "Chore"] },
        maxItems: 1,
      },
    },
  },
});

describe("MCP elicitation", () => {
  it("shows the titles of titled choices and answers with the values behind them", () => {
    const titled = JSON.stringify({
      mode: "form",
      serverName: "paint",
      requestedSchema: {
        type: "object",
        properties: {
          color: {
            type: "string",
            title: "Color",
            oneOf: [
              { const: "#FF0000", title: "Red" },
              { const: "#00FF00", title: "Green" },
            ],
            default: "#00FF00",
          },
          extras: {
            type: "array",
            items: { anyOf: [{ const: "#0000FF", title: "Blue" }, { const: "#FFFFFF" }] },
          },
          size: { type: "integer", enum: [1, 2] },
        },
        required: ["color"],
      },
    });
    const request = parseElicitation(titled)!;
    const [color, extras, size] = request.fields;
    expect(color.choices).toEqual([
      { value: "#FF0000", label: "Red" },
      { value: "#00FF00", label: "Green" },
    ]);
    // An entry without a title falls back to its value.
    expect([extras.kind, extras.choices.map((choice) => choice.label)]).toEqual(["choices", ["Blue", "#FFFFFF"]]);
    // A numeric enum is still a plain number field, as before.
    expect([size.kind, size.choices]).toEqual(["integer", []]);
    expect(
      elicitationAnswer(request.fields, { color: "#00FF00", extras: JSON.stringify(["#0000FF"]), size: "2" }),
    ).toEqual({ content: { color: "#00FF00", extras: ["#0000FF"], size: 2 } });

    const markup = renderToStaticMarkup(
      <I18nProvider locale="zh-TW">
        <McpElicitation request={request} onAnswer={async () => {}} />
      </I18nProvider>,
    );
    expect(markup).toContain(">Green</option>");
    expect(markup).toContain('value="#00FF00" selected=""');
    expect(markup).toContain("Blue");
  });

  it("keeps choice lists it cannot check declinable only", () => {
    for (const color of [
      { type: "string", oneOf: [] },
      { type: "string", oneOf: [{ const: 1, title: "One" }] },
      { type: "string", oneOf: [{ const: "a", title: "A", pattern: ".*" }] },
      { type: "string", enum: ["a", 2] },
      { type: "array", items: { anyOf: [{ type: "string" }] } },
    ]) {
      const input = JSON.stringify({ mode: "form", requestedSchema: { type: "object", properties: { color } } });
      expect(parseElicitation(input), JSON.stringify(color)).toBeNull();
    }
  });

  it("draws a list of choices as checkboxes and answers with an array", () => {
    const request = parseElicitation(multi)!;
    const field = request.fields[0];
    expect([field.kind, field.maxItems]).toEqual(["choices", 1]);
    expect(field.choices.map((choice) => choice.label)).toEqual(["Bug", "Chore"]);

    expect(elicitationAnswer(request.fields, { labels: JSON.stringify(["bug"]) })).toEqual({
      content: { labels: ["bug"] },
    });
    // Nothing chosen is still an answer while the field is optional.
    expect(elicitationAnswer(request.fields, { labels: "[]" })).toEqual({ content: { labels: [] } });
    // More than the server allows must not be submittable.
    expect(elicitationAnswer(request.fields, { labels: JSON.stringify(["bug", "chore"]) })).toEqual({
      invalid: "labels",
    });

    const markup = renderToStaticMarkup(
      <I18nProvider locale="zh-TW">
        <McpElicitation request={request} onAnswer={async () => {}} />
      </I18nProvider>,
    );
    expect(markup.match(/type="checkbox"/g)).toHaveLength(2);
    expect(markup).toContain("Bug");
  });

  it("leaves a list of free text declinable", () => {
    expect(
      parseElicitation(
        JSON.stringify({
          mode: "form",
          requestedSchema: { type: "object", properties: { files: { type: "array", items: { type: "string" } } } },
        }),
      ),
    ).toBeNull();
  });

  it("reads a form into typed fields", () => {
    const request = parseElicitation(form)!;
    expect(request.serverName).toBe("github");
    expect(request.fields.map((field) => [field.name, field.kind, field.required])).toEqual([
      ["repo", "string", true],
      ["branch", "string", false],
      ["depth", "integer", false],
      ["force", "boolean", false],
    ]);
    expect(request.fields[1].choices).toEqual([
      { value: "main", label: "Main" },
      { value: "dev", label: "Development" },
    ]);
  });

  it("turns drafts into typed answers and holds back an incomplete one", () => {
    const { fields } = parseElicitation(form)!;
    expect(elicitationAnswer(fields, { repo: "", depth: "5", force: "false" })).toEqual({
      invalid: "repo",
    });
    expect(elicitationAnswer(fields, { repo: "x", depth: "2.5", force: "false" })).toEqual({
      invalid: "depth",
    });
    expect(
      JSON.parse(
        JSON.stringify(
          (elicitationAnswer(fields, { repo: "lattice", branch: "dev", depth: "3", force: "true" }) as {
            content: object;
          }).content,
        ),
      ),
    ).toEqual({ repo: "lattice", branch: "dev", depth: 3, force: true });
  });

  it("keeps a server's odd field name as a plain key", () => {
    const { fields } = parseElicitation(
      JSON.stringify({
        mode: "form",
        requestedSchema: { type: "object", properties: { __proto__: { type: "string" } }, required: ["__proto__"] },
      }).replace('"properties":{}', '"properties":{"__proto__":{"type":"string"}}'),
    )!;
    const answer = elicitationAnswer(fields, JSON.parse('{"__proto__":"value"}')) as { content: object };
    expect(JSON.stringify(answer.content)).toBe('{"__proto__":"value"}');
  });

  it("only offers http(s) pages and shows where they lead", () => {
    expect(parseElicitation(JSON.stringify({ mode: "url", url: "javascript:alert(1)" }))).toBeNull();
    const request = parseElicitation(
      JSON.stringify({ mode: "url", url: "https://auth.example.com/login", message: "Sign in" }),
    )!;
    const markup = renderToStaticMarkup(
      <I18nProvider locale="en">
        <McpElicitation request={request} onAnswer={async () => {}} />
      </I18nProvider>,
    );
    expect(markup).toContain("auth.example.com");
    expect(markup).toContain("Open page and continue");
  });

  it("refuses shapes it cannot draw", () => {
    expect(
      parseElicitation(
        JSON.stringify({
          mode: "form",
          requestedSchema: { type: "object", properties: { nested: { type: "object" } } },
        }),
      ),
    ).toBeNull();
    expect(parseElicitation("{not json")).toBeNull();
  });
});
