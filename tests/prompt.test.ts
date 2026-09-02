import { describe, expect, it } from "vitest";

import { buildPrompt, splitPrompt, validateAspect, validateRef } from "../src/content/prompt.js";
import { ValidationError } from "../src/api/errors.js";

const defaults = { version: "7" };

describe("buildPrompt", () => {
  it("puts image prompts first, then text, then parameters", () => {
    const prompt = buildPrompt(
      {
        text: "a red fox",
        imagePrompts: ["https://cdn.example.com/a.png"],
        aspect: "16:9",
        stylize: 250,
      },
      defaults,
    );
    expect(prompt).toBe("https://cdn.example.com/a.png a red fox --ar 16:9 --v 7 --stylize 250");
  });

  it("appends the default model version when none is given", () => {
    expect(buildPrompt({ text: "x" }, defaults)).toBe("x --v 7");
  });

  it("uses niji instead of a version, never both", () => {
    expect(buildPrompt({ text: "x", niji: "6" }, defaults)).toBe("x --niji 6");
    expect(() => buildPrompt({ text: "x", niji: "6", version: "7" }, defaults)).toThrow(ValidationError);
  });

  it("repeats sref and oref once per reference", () => {
    const prompt = buildPrompt({ text: "x", styleRefs: ["1234", "5678"], omniRefs: ["random"] }, defaults);
    expect(prompt).toContain("--sref 1234 --sref 5678");
    expect(prompt).toContain("--oref random");
  });

  it("refuses out-of-range values rather than letting Midjourney clamp them", () => {
    expect(() => buildPrompt({ text: "x", stylize: 5000 }, defaults)).toThrow(/--stylize must be between 0 and 1000/);
    expect(() => buildPrompt({ text: "x", chaos: 200 }, defaults)).toThrow(/--chaos/);
    expect(() => buildPrompt({ text: "x", weird: 9999 }, defaults)).toThrow(/--weird/);
  });

  it("refuses a quality Midjourney does not accept", () => {
    expect(() => buildPrompt({ text: "x", quality: 3 }, defaults)).toThrow(/--q must be one of/);
    expect(buildPrompt({ text: "x", quality: 2 }, defaults)).toContain("--q 2");
  });

  it("treats raw and style as the same parameter", () => {
    expect(buildPrompt({ text: "x", raw: true }, defaults)).toContain("--style raw");
    expect(() => buildPrompt({ text: "x", raw: true, style: "cute" }, defaults)).toThrow(/same parameter/);
  });

  it("needs text or an image", () => {
    expect(() => buildPrompt({ text: "   " }, defaults)).toThrow(/needs text/);
  });

  it("emits bare switches without a value", () => {
    const prompt = buildPrompt({ text: "x", tile: true, draft: true }, defaults);
    expect(prompt).toBe("x --v 7 --tile --draft");
  });
});

describe("validateAspect", () => {
  it("accepts w:h", () => {
    expect(() => validateAspect("16:9")).not.toThrow();
    expect(() => validateAspect("1:1")).not.toThrow();
  });

  it("rejects anything else", () => {
    for (const bad of ["16x9", "16/9", "16:", "wide", "0:1"]) {
      expect(() => validateAspect(bad), bad).toThrow(ValidationError);
    }
  });
});

describe("validateRef", () => {
  it("accepts URLs, numeric codes and random", () => {
    expect(() => validateRef("https://cdn.example.com/a.png", "--sref")).not.toThrow();
    expect(() => validateRef("1234567", "--sref")).not.toThrow();
    expect(() => validateRef("random", "--sref")).not.toThrow();
  });

  it("rejects a bare word, because Midjourney would silently use it as prompt text", () => {
    expect(() => validateRef("vintage", "--sref")).toThrow(/silently treats it as prompt text/);
  });
});

describe("splitPrompt", () => {
  it("separates text from parameters", () => {
    expect(splitPrompt("a red fox --ar 16:9 --v 7")).toEqual({ text: "a red fox", params: "--ar 16:9 --v 7" });
    expect(splitPrompt("a red fox")).toEqual({ text: "a red fox", params: "" });
  });
});

describe("Midjourney's own asset URLs", () => {
  // What the web app produces when you drag an image in. No extension, so an
  // extension check alone refuses the most common image prompt there is.
  it("accepts an s.mj.run image prompt", () => {
    expect(() =>
      buildPrompt({ text: "x", imagePrompts: ["https://s.mj.run/xE_f2o6GRl0"] }, defaults),
    ).not.toThrow();
  });

  it("accepts a cdn.midjourney.com image prompt", () => {
    expect(() =>
      buildPrompt({ text: "x", imagePrompts: ["https://cdn.midjourney.com/abc/0_0.png"] }, defaults),
    ).not.toThrow();
  });

  it("still refuses a link to a page", () => {
    expect(() =>
      buildPrompt({ text: "x", imagePrompts: ["https://example.com/gallery"] }, defaults),
    ).toThrow(/must be a direct URL/);
  });
});
