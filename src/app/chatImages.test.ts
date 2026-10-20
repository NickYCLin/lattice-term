import { describe, expect, it } from "vitest";
import { imageFileName, mentionedImagePaths, orderedImagePaths } from "./chatImages";

it("shows only the file name for Windows and Unix image paths", () => {
  expect(imageFileName("C:\\private\\photo.png")).toBe("photo.png");
  expect(imageFileName("/private/photo.png")).toBe("photo.png");
  expect(imageFileName("photo.png")).toBe("photo.png");
});

it("keeps first-seen image order without duplicates or empty records", () => {
  expect(orderedImagePaths(["z.png", "", "a.png", "z.png", " ", "b.png"])).toEqual(["z.png", "a.png", "b.png"]);
});

describe("images a reply mentions", () => {
  it("finds Markdown images and bare paths, once each", () => {
    expect(
      mentionedImagePaths(
        "Saved the chart to `out/chart.png`. See ![plot](docs/plot.jpeg) and /tmp/shot.webp, also out/chart.png again.",
      ),
    ).toEqual(["out/chart.png", "docs/plot.jpeg", "/tmp/shot.webp"]);
  });

  it("ignores web addresses, home shortcuts and other files", () => {
    expect(mentionedImagePaths("https://example.com/a.png ~/b.png notes.txt image.pngx")).toEqual([]);
  });

  it("stops after a handful", () => {
    const text = Array.from({ length: 10 }, (_, index) => `f${index}.png`).join(" ");
    expect(mentionedImagePaths(text)).toHaveLength(6);
  });
});
