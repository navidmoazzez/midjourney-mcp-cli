/**
 * The seam between the two surfaces.
 *
 * These assert parity rather than plumbing. The whole design rests on one
 * `ALL_TOOLS` array feeding both the MCP server and the shell, so what is worth
 * testing is that neither has drifted from it.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  FLAG_ALIASES,
  SYNONYMS,
  flagsFor,
  isCliCommand,
  parseArgs,
  selectFields,
  whichCommand,
} from "../src/cli.js";
import { ALL_TOOLS } from "../src/tools/index.js";
import { needsConfirm } from "../src/safety.js";

describe("every tool is a command", () => {
  it("routes in both the dashed and underscored spellings", () => {
    for (const tool of ALL_TOOLS) {
      expect(isCliCommand([tool.name.replace(/_/g, "-")]), tool.name).toBe(true);
      expect(isCliCommand([tool.name]), tool.name).toBe(true);
    }
  });

  it("does not treat the server's own flags as commands", () => {
    for (const flag of ["--http", "--version", "--help", "-v", "-h"]) {
      expect(isCliCommand([flag]), flag).toBe(false);
    }
    expect(isCliCommand([])).toBe(false);
  });

  it("gives every schema key a flag", () => {
    for (const tool of ALL_TOOLS) {
      const keys = Object.keys(tool.schema);
      const flags = flagsFor(tool.schema);
      expect(flags.map((flag) => flag.key).sort(), tool.name).toEqual(keys.sort());
      for (const flag of flags) {
        expect(flag.flag, `${tool.name}.${flag.key}`).toBe(`--${flag.key.replace(/_/g, "-")}`);
      }
    }
  });
});

describe("tool definitions", () => {
  it("describes every argument, because the description is the interface", () => {
    for (const tool of ALL_TOOLS) {
      for (const flag of flagsFor(tool.schema)) {
        expect(flag.help.length, `${tool.name}.${flag.key} has no description`).toBeGreaterThan(0);
      }
    }
  });

  it("gives anything that spends or destroys a confirm argument and a summary", () => {
    for (const tool of ALL_TOOLS) {
      if (!needsConfirm(tool.risk)) continue;
      expect(Object.keys(tool.schema), `${tool.name} needs a confirm argument`).toContain("confirm");
      expect(tool.summary, `${tool.name} needs a summary for the audit log`).toBeTypeOf("function");
    }
  });

  it("does not put a confirm on anything that neither spends nor destroys", () => {
    for (const tool of ALL_TOOLS) {
      if (needsConfirm(tool.risk)) continue;
      expect(Object.keys(tool.schema), `${tool.name} should not ask for confirmation`).not.toContain(
        "confirm",
      );
    }
  });

  it("names every tool uniquely, in snake_case", () => {
    const names = ALL_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name, name).toMatch(/^[a-z][a-z0-9_]*$/);
  });
});

describe("parseArgs", () => {
  const flags = flagsFor({
    prompt: z.string().describe("text"),
    aspect: z.string().optional().describe("ratio"),
    stylize: z.number().optional().describe("n"),
    raw: z.boolean().optional().describe("switch"),
    style_refs: z.array(z.string()).optional().describe("refs"),
    speed: z.enum(["fast", "relax"]).optional().describe("speed"),
  });

  it("accepts a bare argument for the first required flag", () => {
    expect(parseArgs(["a red fox"], flags)).toEqual({ prompt: "a red fox" });
  });

  it("accepts both --flag value and --flag=value", () => {
    expect(parseArgs(["--aspect", "16:9"], flags).aspect).toBe("16:9");
    expect(parseArgs(["--aspect=16:9"], flags).aspect).toBe("16:9");
  });

  it("accepts the underscored spelling too", () => {
    expect(parseArgs(["--style_refs", "1234"], flags).style_refs).toEqual(["1234"]);
  });

  it("collects a repeatable flag into an array", () => {
    expect(parseArgs(["--style-refs", "1", "--style-refs", "2"], flags).style_refs).toEqual(["1", "2"]);
  });

  it("coerces numbers and refuses ones that are not", () => {
    expect(parseArgs(["--stylize", "250"], flags).stylize).toBe(250);
    expect(() => parseArgs(["--stylize", "high"], flags)).toThrow(/expects a number/);
  });

  it("treats a bare boolean as true and honours =false", () => {
    expect(parseArgs(["--raw"], flags).raw).toBe(true);
    expect(parseArgs(["--raw=false"], flags).raw).toBe(false);
  });

  it("checks enum values against the schema", () => {
    expect(parseArgs(["--speed", "relax"], flags).speed).toBe("relax");
    expect(() => parseArgs(["--speed", "sprint"], flags)).toThrow(/expects one of/);
  });

  it("refuses an unknown option instead of ignoring it", () => {
    expect(() => parseArgs(["--nope", "1"], flags)).toThrow(/Unknown option/);
  });
});

describe("repeatable flags keep their element type", () => {
  const flags = flagsFor({
    indexes: z.array(z.number().int().min(0)).optional().describe("which"),
    names: z.array(z.string()).optional().describe("who"),
  });

  /**
   * `--indexes 0` used to reach Zod as the string "0" and fail with "expected
   * number, received string", which reads as the caller's mistake when it was
   * the parser flattening every array element to a string.
   */
  it("coerces a repeatable number flag to numbers", () => {
    expect(parseArgs(["--indexes", "0", "--indexes", "2"], flags).indexes).toEqual([0, 2]);
  });

  it("still leaves a repeatable string flag alone", () => {
    expect(parseArgs(["--names", "a"], flags).names).toEqual(["a"]);
  });

  it("parses cleanly through the schema, not just the parser", () => {
    const schema = z.object({ indexes: z.array(z.number().int().min(0)).optional() });
    expect(() => schema.parse(parseArgs(["--indexes", "0"], flags))).not.toThrow();
  });
});

describe("Midjourney's own flag spellings", () => {
  const flags = flagsFor({
    prompt: z.string().describe("text"),
    aspect: z.string().optional().describe("ratio"),
    style_refs: z.array(z.string()).optional().describe("refs"),
    quality: z.number().optional().describe("q"),
  });

  it("accepts --ar, --sref and --q", () => {
    expect(parseArgs(["x", "--ar", "16:9"], flags).aspect).toBe("16:9");
    expect(parseArgs(["x", "--sref", "1234"], flags).style_refs).toEqual(["1234"]);
    expect(parseArgs(["x", "--q", "2"], flags).quality).toBe(2);
  });

  it("only aliases onto keys some tool actually declares", () => {
    const known = new Set(ALL_TOOLS.flatMap((tool) => Object.keys(tool.schema)));
    for (const [alias, key] of Object.entries(FLAG_ALIASES)) {
      expect(known.has(key), `--${alias} points at '${key}', which no tool declares`).toBe(true);
    }
  });
});

describe("selectFields", () => {
  it("keeps only the named fields", () => {
    expect(selectFields({ a: 1, b: 2, c: 3 }, ["a", "c"])).toEqual({ a: 1, c: 3 });
  });

  it("descends dotted paths", () => {
    expect(selectFields({ job: { id: "x", noise: 1 } }, ["job.id"])).toEqual({ "job.id": "x" });
  });

  it("selects into the results array, keeping the envelope", () => {
    const data = { count: 2, jobs: [{ id: "a", noise: 1 }, { id: "b", noise: 2 }] };
    expect(selectFields(data, ["id"])).toEqual({ count: 2, jobs: [{ id: "a" }, { id: "b" }] });
  });

  /**
   * A single job carries `images`, an array of URL strings. Treating that as
   * the result set meant the envelope was kept and nothing was actually
   * filtered, so `--select id,status` returned the entire job.
   */
  it("does not mistake an array of strings for a result set", () => {
    const job = { id: "a", status: "completed", prompt: "x", images: ["u1", "u2"] };
    expect(selectFields(job, ["id", "status"])).toEqual({ id: "a", status: "completed" });
  });

  it("still selects into an array of objects", () => {
    const data = { count: 1, jobs: [{ id: "a", noise: 1 }], images: ["u1"] };
    expect(selectFields(data, ["id"])).toEqual({ count: 1, jobs: [{ id: "a" }], images: ["u1"] });
  });

  it("is a no-op with no paths", () => {
    const data = { a: 1 };
    expect(selectFields(data, [])).toBe(data);
  });
});

describe("which", () => {
  const top = (query: string): string | undefined => whichCommand(query)[0]?.tool.name;

  it("resolves what someone would actually type", () => {
    expect(top("make a picture")).toBe("imagine");
    expect(top("vary that image")).toBe("vary_image");
    expect(top("save my pictures to disk")).toBe("download_job");
    expect(top("what is rendering right now")).toBe("get_queue");
    expect(top("redo that one again")).toBe("rerun_job");
    expect(top("am i logged in")).toBe("whoami");
    expect(top("how much space am i using")).toBe("get_storage");
  });

  it("returns nothing rather than a bad guess", () => {
    expect(whichCommand("")).toEqual([]);
    expect(whichCommand("the a of and")).toEqual([]);
  });

  it("never suggests more than a screenful", () => {
    expect(whichCommand("image job download generate").length).toBeLessThanOrEqual(5);
  });

  /**
   * Every synonym has to point at vocabulary some tool actually uses, or it is
   * a redirect to nowhere that silently stops matching.
   */
  it("maps synonyms onto words the tools really contain", () => {
    const vocabulary = new Set(
      ALL_TOOLS.flatMap((tool) =>
        `${tool.name} ${tool.title} ${tool.description}`.toLowerCase().split(/[^a-z0-9]+/),
      ),
    );
    for (const target of new Set(Object.values(SYNONYMS).flat())) {
      expect(vocabulary.has(target), `synonym target '${target}' appears in no tool`).toBe(true);
    }
  });
});
