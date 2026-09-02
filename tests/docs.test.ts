/**
 * Documentation tests.
 *
 * These exist because the failures they catch look complete from every side
 * except the reader's: a variable the code reads that no page mentions, a
 * contents link pointing at a heading that was renamed, a tool that ships
 * without appearing in the table people scan to decide whether to install.
 * Each is invisible in review and obvious on the rendered page.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ENV_VARS } from "../src/config.js";
import { ALL_TOOLS } from "../src/tools/index.js";

const root = join(import.meta.dirname, "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const help = readFileSync(join(root, "src", "index.ts"), "utf8");
const skill = readFileSync(join(root, "SKILL.md"), "utf8");

describe("environment variables", () => {
  it("are all documented in the README", () => {
    for (const name of ENV_VARS) {
      expect(readme.includes(name), `${name} is missing from README.md`).toBe(true);
    }
  });

  it("are all listed in --help", () => {
    for (const name of ENV_VARS) {
      expect(help.includes(name), `${name} is missing from the --help text`).toBe(true);
    }
  });

  it("has no variable in the help text that the code does not read", () => {
    const mentioned = help.match(/MIDJOURNEY_[A-Z_]+/g) ?? [];
    for (const name of new Set(mentioned)) {
      expect(ENV_VARS as readonly string[], `--help mentions ${name}, which config.ts never reads`).toContain(
        name,
      );
    }
  });
});

describe("README", () => {
  it("links only to headings that exist", () => {
    const headings = new Set(
      [...readme.matchAll(/^#{1,6} (.+)$/gm)].map(([, text]) =>
        // GitHub's own slug rule: lowercase, drop anything that is not a word
        // character, space or hyphen, then turn each remaining space into a
        // hyphen. It does not trim, so a heading ending in an emoji keeps the
        // trailing hyphen where the space before the emoji was.
        (text as string)
          .toLowerCase()
          .replace(/[^\w\s-]/g, "")
          .replace(/\s/g, "-"),
      ),
    );

    for (const [, anchor] of readme.matchAll(/\]\(#([a-z0-9-]+)\)/g)) {
      expect(headings.has(anchor as string), `README links to #${anchor}, which is not a heading`).toBe(true);
    }
  });

  it("names every tool", () => {
    for (const tool of ALL_TOOLS) {
      expect(readme.includes(tool.name), `${tool.name} is missing from README.md`).toBe(true);
    }
  });

  it("claims the number of tools that actually ship", () => {
    expect(readme, `README should say "${ALL_TOOLS.length} tools"`).toContain(`${ALL_TOOLS.length} tools`);
  });

  it("carries exactly one horizontal rule, above the footer", () => {
    expect((readme.match(/^---$/gm) ?? []).length).toBe(1);
  });
});

describe("SKILL.md", () => {
  it("has the frontmatter that makes it loadable as a skill", () => {
    expect(skill.startsWith("---\n")).toBe(true);
    expect(skill).toMatch(/^name: \S+$/m);
    expect(skill).toMatch(/^description: \S/m);
  });

  it("ships inside the published package", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).toContain("SKILL.md");
  });
});

describe("version", () => {
  it("is the same in package.json and the desktop manifest", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
    const manifest = JSON.parse(
      readFileSync(join(root, "desktop-extension", "manifest.json"), "utf8"),
    ) as { version: string };

    // Two places bumped by hand. A mismatch only shows up as a Desktop
    // extension reporting the wrong version, long after anyone would connect
    // that to the release.
    expect(manifest.version).toBe(pkg.version);
  });

  it("is read from package.json rather than written into the source", () => {
    const server = readFileSync(join(root, "src", "server.ts"), "utf8");
    // A hardcoded copy drifts on the next bump and the server then lies to
    // every client it handshakes with.
    expect(server).not.toMatch(/VERSION = "\d/);
    expect(server).toContain("pkg.version");
  });

  it("says the same tool count in the manifest as ships", () => {
    const manifest = JSON.parse(
      readFileSync(join(root, "desktop-extension", "manifest.json"), "utf8"),
    ) as { description: string };
    expect(manifest.description).toContain(`${ALL_TOOLS.length} tools`);
  });
});
