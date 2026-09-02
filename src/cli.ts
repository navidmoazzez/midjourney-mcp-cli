/**
 * The CLI adapter.
 *
 * `register()` in tools/kit.ts turns a `ToolSpec` into an MCP tool. This turns
 * the same spec into a shell command, from the same `ALL_TOOLS` array, through
 * the same handler and the same `WriteGuard`. Nothing is described twice, so a
 * tool added tomorrow is a command tomorrow and the two surfaces cannot drift.
 *
 * The command IS the tool name. `submit_imagine` runs as `submit-imagine`, and
 * the underscore form works too. Inventing a prettier command tree would mean a
 * hand-written mapping, which is exactly the drift this avoids, and it would
 * force anyone reading the SKILL.md to learn two vocabularies for one action.
 *
 * Zod is the only schema: every flag, its placeholder, its help text and its
 * validation come from the shape the MCP tool already declares.
 */

import { z, type ZodRawShape, type ZodTypeAny } from "zod";

import { MidjourneyClient } from "./api/client.js";
import { MidjourneyError } from "./api/errors.js";
import { loadConfig } from "./config.js";
import { WriteGuard } from "./safety.js";
import { ALL_TOOLS } from "./tools/index.js";
import { makeContext, type AnyToolSpec, type ToolContext } from "./tools/kit.js";

/** How a value reaches the parser, once the Zod wrappers are peeled off. */
type FlagKind = "string" | "number" | "boolean" | "enum" | "json";

type Flag = {
  key: string;
  flag: string;
  kind: FlagKind;
  required: boolean;
  repeatable: boolean;
  choices?: string[];
  help: string;
};

/**
 * Peel `.optional()`, `.default()` and `.nullable()` to reach the real type.
 *
 * A description can sit on either the wrapper or the inner type depending on
 * the order the tool author chained them, so both are collected on the way down
 * and the outermost one wins.
 */
function unwrap(schema: ZodTypeAny): { inner: ZodTypeAny; optional: boolean; description?: string } {
  let inner = schema;
  let optional = false;
  let description = schema.description;

  for (;;) {
    const typeName = (inner as { _def: { typeName?: string } })._def.typeName;
    if (typeName === "ZodOptional" || typeName === "ZodDefault" || typeName === "ZodNullable") {
      if (typeName !== "ZodNullable") optional = true;
      inner = (inner as unknown as { _def: { innerType: ZodTypeAny } })._def.innerType;
      description ??= inner.description;
      continue;
    }
    return { inner, optional, description };
  }
}

function kindOf(schema: ZodTypeAny): { kind: FlagKind; choices?: string[]; repeatable: boolean } {
  const typeName = (schema as { _def: { typeName?: string } })._def.typeName;

  switch (typeName) {
    case "ZodString":
      return { kind: "string", repeatable: false };
    case "ZodNumber":
      return { kind: "number", repeatable: false };
    case "ZodBoolean":
      return { kind: "boolean", repeatable: false };
    case "ZodEnum":
      return {
        kind: "enum",
        choices: (schema as unknown as { _def: { values: string[] } })._def.values,
        repeatable: false,
      };
    case "ZodArray": {
      // An array of scalars is repeatable (`--style-refs a --style-refs b`). An
      // array of objects is not worth flattening, so it takes JSON.
      //
      // The element kind has to be carried through, not flattened to a string:
      // an array of numbers coerced as strings passes the parser and then fails
      // Zod with "expected number, received string", which reads as the caller's
      // mistake when it was ours.
      const element = unwrap((schema as unknown as { _def: { type: ZodTypeAny } })._def.type).inner;
      const elementKind = (element as { _def: { typeName?: string } })._def.typeName;
      if (elementKind === "ZodNumber") return { kind: "number", repeatable: true };
      if (elementKind === "ZodString") return { kind: "string", repeatable: true };
      if (elementKind === "ZodEnum") {
        return {
          kind: "enum",
          choices: (element as unknown as { _def: { values: string[] } })._def.values,
          repeatable: true,
        };
      }
      return { kind: "json", repeatable: true };
    }
    default:
      // Objects, unions, records and anything else take a JSON literal.
      return { kind: "json", repeatable: false };
  }
}

function toFlag(key: string, schema: ZodTypeAny): Flag {
  const { inner, optional, description } = unwrap(schema);
  const { kind, choices, repeatable } = kindOf(inner);
  return {
    key,
    flag: `--${key.replace(/_/g, "-")}`,
    kind,
    required: !optional,
    repeatable,
    choices,
    help: description ?? "",
  };
}

export function flagsFor(shape: ZodRawShape): Flag[] {
  return Object.entries(shape).map(([key, schema]) => toFlag(key, schema as ZodTypeAny));
}

/**
 * Midjourney's own parameter spellings, accepted as flags.
 *
 * The schema names things in full because a tool description is read by a model
 * that has never seen a Midjourney prompt. A person at a terminal has, and they
 * will type `--ar 16:9`, because that is what the parameter is called
 * everywhere Midjourney documents it. Refusing the name the whole ecosystem
 * uses, to protect a naming convention nobody outside this repo can see, would
 * be the wrong trade.
 */
export const FLAG_ALIASES: Record<string, string> = {
  ar: "aspect",
  v: "version",
  s: "stylize",
  c: "chaos",
  sref: "style_refs",
  sw: "style_weight",
  oref: "omni_refs",
  ow: "omni_weight",
  iw: "image_weight",
  q: "quality",
  no: "negative",
  p: "profile",
  r: "repeat",
  id: "job_id",
  job: "job_id",
};

class UsageError extends Error {}

/** Accept a flag as `--foo-bar`, `--foo_bar`, or `foo_bar`. */
function normalize(token: string): string {
  return token.replace(/^--/, "").replace(/-/g, "_");
}

function coerce(flag: Flag, raw: string): unknown {
  switch (flag.kind) {
    case "number": {
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new UsageError(`${flag.flag} expects a number, got '${raw}'.`);
      return value;
    }
    case "enum":
      if (flag.choices && !flag.choices.includes(raw)) {
        throw new UsageError(`${flag.flag} expects one of: ${flag.choices.join(", ")}. Got '${raw}'.`);
      }
      return raw;
    case "json":
      try {
        return JSON.parse(raw);
      } catch {
        throw new UsageError(`${flag.flag} expects JSON, got '${raw}'.`);
      }
    default:
      return raw;
  }
}

/**
 * Parse argv against a tool's flags.
 *
 * Zod does the real validation afterwards, so this only has to get values into
 * the right JavaScript types and catch the mistakes Zod would otherwise report
 * in terms of a schema the person at the terminal never sees.
 */
export function parseArgs(argv: string[], flags: Flag[]): Record<string, unknown> {
  const byKey = new Map(flags.map((flag) => [flag.key, flag]));
  const out: Record<string, unknown> = {};
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] as string;

    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const equals = token.indexOf("=");
    const name = normalize(equals === -1 ? token : token.slice(0, equals));
    const flag = byKey.get(name) ?? byKey.get(FLAG_ALIASES[name] ?? "");
    if (!flag) throw new UsageError(`Unknown option ${token}.`);

    if (flag.kind === "boolean") {
      if (equals !== -1) {
        const value = token.slice(equals + 1);
        out[flag.key] = value !== "false" && value !== "0";
      } else {
        out[flag.key] = true;
      }
      continue;
    }

    const raw = equals === -1 ? argv[++index] : token.slice(equals + 1);
    if (raw === undefined) throw new UsageError(`${flag.flag} expects a value.`);
    const value = coerce(flag, raw);

    if (flag.repeatable) {
      (out[flag.key] as unknown[]) = [...((out[flag.key] as unknown[]) ?? []), value];
    } else {
      out[flag.key] = value;
    }
  }

  // One bare argument fills the first required flag, so `imagine "a red fox"`
  // works the way anyone would expect before reading any help.
  if (positional.length > 0) {
    const target = flags.find((flag) => flag.required && out[flag.key] === undefined);
    if (!target) throw new UsageError(`Unexpected argument '${positional[0]}'.`);
    if (positional.length > 1) throw new UsageError(`Unexpected argument '${positional[1]}'.`);
    const value = coerce(target, positional[0] as string);
    out[target.key] = target.repeatable ? [value] : value;
  }

  return out;
}

/* ------------------------------------------------------------------ output */

type Format = "text" | "json" | "compact";

/**
 * Keep only the named fields.
 *
 * These endpoints are verbose: one explore page is tens of kilobytes of JSON,
 * most of it layout hints. An agent piping that into its own context pays for
 * every byte. `--select id,status,images` cuts it to what was asked for.
 * Dotted paths descend, and arrays are traversed element-wise.
 */
export function selectFields(data: unknown, paths: string[]): unknown {
  if (paths.length === 0) return data;

  const pick = (value: unknown, segments: string[]): unknown => {
    if (segments.length === 0) return value;
    if (Array.isArray(value)) return value.map((item) => pick(item, segments));
    if (value === null || typeof value !== "object") return undefined;
    const [head, ...tail] = segments;
    return pick((value as Record<string, unknown>)[head as string], tail);
  };

  const apply = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(apply);
    if (value === null || typeof value !== "object") return value;

    const out: Record<string, unknown> = {};
    for (const path of paths) {
      const segments = path.split(".");
      const picked = pick(value, segments);
      if (picked !== undefined) out[path] = picked;
    }
    return out;
  };

  // A top-level object holding one array of RESULTS is the common shape, so
  // select into the array rather than flattening the envelope away.
  //
  // The array has to hold objects to count. A single job carries an `images`
  // array of plain URL strings, and treating that as the result set meant
  // `--select id,status` returned the whole job untouched: the envelope was
  // preserved, and the only thing selected was a list of strings that have no
  // fields to select.
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    const arrayKey = Object.keys(record).find((key) => {
      const value = record[key];
      return (
        Array.isArray(value) &&
        value.length > 0 &&
        value.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))
      );
    });
    if (arrayKey) return { ...record, [arrayKey]: apply(record[arrayKey]) };
  }
  return apply(data);
}

function emit(data: unknown, format: Format, select: string[]): void {
  const shaped = selectFields(data, select);
  if (format === "text" && typeof shaped === "string") {
    process.stdout.write(shaped.endsWith("\n") ? shaped : `${shaped}\n`);
    return;
  }
  const json = format === "compact" ? JSON.stringify(shaped) : JSON.stringify(shaped, null, 2);
  process.stdout.write(`${json}\n`);
}

/** Errors are JSON on stderr, always, so a caller parses one shape. */
export function emitError(error: unknown): void {
  const payload =
    error instanceof MidjourneyError
      ? error.toJSON()
      : { error: (error as Error)?.message ?? String(error) };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
}

/* -------------------------------------------------------------------- help */

function commandName(tool: string): string {
  return tool.replace(/_/g, "-");
}

const COLUMN = 34;

/**
 * The name this was invoked as, so examples are copy-pasteable.
 *
 * The package puts two binaries on the same file. Printing `midjourney-mcp` at
 * someone who typed `midjourney-cli` hands them a command that works but is not
 * the one in their fingers.
 */
export function binName(): string {
  const name = (process.argv[1] ?? "").split("/").pop() ?? "";
  return name.startsWith("midjourney-cli") ? "midjourney-cli" : "midjourney-mcp";
}

function renderToolHelp(spec: AnyToolSpec): string {
  const flags = flagsFor(spec.schema);
  const required = flags.filter((flag) => flag.required);
  const optional = flags.filter((flag) => !flag.required);

  const usage = [
    `${binName()} ${commandName(spec.name)}`,
    ...required.map((flag) => `${flag.flag} <${flag.kind}>`),
    optional.length > 0 ? "[options]" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const lines = [``, spec.description.trim(), ``, `Usage:`, `  ${usage}`, ``];

  const describe = (list: Flag[], heading: string): void => {
    if (list.length === 0) return;
    lines.push(`${heading}:`);
    for (const flag of list) {
      const placeholder =
        flag.kind === "boolean" ? "" : ` <${flag.choices ? flag.choices.join("|") : flag.kind}>`;
      const alias = Object.entries(FLAG_ALIASES).find(([, key]) => key === flag.key)?.[0];
      const left = `  ${flag.flag}${alias ? `, --${alias}` : ""}${placeholder}`;
      const help = flag.repeatable ? `${flag.help} Repeatable.` : flag.help;
      if (!help) {
        lines.push(left);
      } else if (left.length < COLUMN) {
        lines.push(`${left.padEnd(COLUMN)}${help}`);
      } else {
        lines.push(left, `${" ".repeat(COLUMN)}${help}`);
      }
    }
    lines.push(``);
  };

  describe(required, "Required");
  describe(optional, "Options");

  lines.push(`Output:`);
  lines.push(`  --json                          force JSON`);
  lines.push(`  --compact                       force single-line JSON`);
  lines.push(`  --select <a,b.c>                keep only these fields`);
  lines.push(`  --agent                         compact JSON. Never implies --confirm.`);
  lines.push(``);
  lines.push(`Risk: ${spec.risk}`);
  lines.push(``);
  return lines.join("\n");
}

function renderToolList(tools: AnyToolSpec[]): string {
  const width = Math.max(...tools.map((tool) => commandName(tool.name).length)) + 2;
  const bin = binName();
  const lines = [``, `${bin} commands (${tools.length})`, ``];
  for (const tool of tools) {
    const mark =
      tool.risk === "read" ? " " : tool.risk === "spend" ? "$" : tool.risk === "destructive" ? "!" : "*";
    lines.push(`  ${mark} ${commandName(tool.name).padEnd(width)}${tool.title}`);
  }
  lines.push(``);
  lines.push(`  * writes locally   $ spends GPU time, needs --confirm   ! irreversible, needs --confirm`);
  lines.push(``);
  lines.push(`  ${bin} which "<what you want>"  find the right command`);
  lines.push(`  ${bin} <command> --help    what it takes`);
  lines.push(`  ${bin} schema <command>    the JSON schema an MCP client sees`);
  lines.push(`  ${bin} doctor              check the setup`);
  lines.push(`  ${bin} login               open the controlled window to sign in`);
  lines.push(`  ${bin} capture             record what the web app calls, to extend this tool`);
  lines.push(``);
  return lines.join("\n");
}

/* ------------------------------------------------------------------- which */

const STOP_WORDS = new Set([
  "a", "an", "the", "my", "me", "i", "to", "of", "for", "in", "on", "and", "or",
  "how", "do", "does", "can", "get", "want", "with", "from", "is", "are", "it",
  "that", "this", "what", "which", "all", "any", "some", "please",
]);

/**
 * Words people use mapped onto words the tools use.
 *
 * Without this, "make a picture" matches nothing, because every tool says
 * "generate" and "image". A lookup that only works when you already know the
 * vocabulary is not a lookup.
 */
export const SYNONYMS: Record<string, string[]> = {
  picture: ["image"],
  pictures: ["image"],
  photo: ["image"],
  photos: ["image"],
  pic: ["image"],
  pics: ["image"],
  art: ["image"],
  artwork: ["image"],
  render: ["generate", "imagine"],
  renders: ["image"],
  make: ["generate", "imagine"],
  create: ["generate", "imagine"],
  draw: ["generate", "imagine"],
  generation: ["generate"],
  imagining: ["imagine"],
  save: ["download"],
  saving: ["download"],
  fetch: ["download"],
  grab: ["download"],
  disk: ["download"],
  history: ["jobs"],
  past: ["jobs"],
  previous: ["jobs"],
  recent: ["jobs"],
  running: ["queue"],
  rendering: ["queue"],
  pending: ["queue"],
  progress: ["queue"],
  redo: ["rerun"],
  again: ["rerun"],
  reroll: ["rerun"],
  retry: ["rerun"],
  account: ["whoami"],
  login: ["whoami"],
  logged: ["whoami"],
  signed: ["whoami"],
  auth: ["whoami"],
  session: ["whoami"],
  who: ["whoami"],
  style: ["explore"],
  styles: ["explore"],
  inspiration: ["explore"],
  browse: ["explore"],
  folder: ["folders"],
  moodboard: ["moodboards"],
  quota: ["storage"],
  space: ["storage"],
};

function terms(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));

  const out = new Set<string>();
  for (const word of words) {
    out.add(word);
    for (const mapped of SYNONYMS[word] ?? []) out.add(mapped);
  }
  return [...out];
}

/**
 * Resolve a capability described in words to the command that does it.
 *
 * An agent that knows what it wants but not what this tool calls it would
 * otherwise read the full tool list to find out, which is the cost the CLI
 * exists to avoid. Scoring is deliberately dumb: name and title carry the most
 * weight, because a tool called `download_job` should win "download my images"
 * without any cleverness.
 */
export function whichCommand(query: string): { tool: AnyToolSpec; score: number }[] {
  const wanted = terms(query);
  if (wanted.length === 0) return [];

  return ALL_TOOLS.map((tool) => {
    const name = terms(tool.name);
    const whole = tool.name.replace(/_/g, "");
    const title = terms(tool.title);
    const body = terms(tool.description);
    let score = 0;
    for (const word of wanted) {
      // A term that IS the tool's name is not a hint, it is the answer.
      // Without this, "make a picture" scores vary_image over imagine purely
      // because `vary_image` contains the word "image".
      if (word === tool.name || word === whole) score += 20;
      if (name.includes(word)) score += 6;
      else if (name.some((part) => part.startsWith(word) || word.startsWith(part))) score += 4;
      if (title.includes(word)) score += 3;
      if (body.includes(word)) score += 1;
    }
    return { tool, score };
  })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

/* ---------------------------------------------------------------- dispatch */

/** The tools this process exposes, with READ_ONLY applied exactly as the server applies it. */
function visibleTools(guard: WriteGuard): AnyToolSpec[] {
  return ALL_TOOLS.filter((tool) => !guard.readOnly || tool.risk === "read");
}

export function isCliCommand(argv: string[]): boolean {
  const first = argv[0];
  if (!first || first.startsWith("-")) return false;
  if (first === "tools" || first === "schema" || first === "which") return true;
  const name = normalize(first);
  return ALL_TOOLS.some((tool) => tool.name === name);
}

export async function runCli(argv: string[]): Promise<number> {
  const config = loadConfig();
  const guard = new WriteGuard(config, "cli");
  const tools = visibleTools(guard);

  const command = argv[0] as string;
  const rest = argv.slice(1);

  if (command === "tools") {
    process.stdout.write(renderToolList(tools));
    return 0;
  }

  if (command === "which") {
    const query = rest.filter((token) => !token.startsWith("-")).join(" ");
    const matches = whichCommand(query).filter((entry) =>
      tools.some((tool) => tool.name === entry.tool.name),
    );
    if (rest.includes("--json") || rest.includes("--agent")) {
      emit(matches.map((entry) => ({ command: commandName(entry.tool.name), title: entry.tool.title, risk: entry.tool.risk, score: entry.score })), "json", []);
    } else if (matches.length === 0) {
      process.stderr.write(`No command matches "${query}". Run \`${binName()} tools\` for the full list.\n`);
    } else {
      for (const entry of matches) {
        process.stdout.write(`  ${commandName(entry.tool.name).padEnd(22)}${entry.tool.title}\n`);
      }
    }
    // 2 means no confident match, so a script can branch on it.
    return matches.length > 0 ? 0 : 2;
  }

  if (command === "schema") {
    const wanted = normalize(rest[0] ?? "");
    const spec = tools.find((tool) => tool.name === wanted);
    if (!spec) {
      emitError(new Error(`Unknown command '${rest[0] ?? ""}'. Run \`${binName()} tools\`.`));
      return 1;
    }
    // The same shape an MCP client receives, so the two surfaces are provably one.
    emit(z.object(spec.schema).describe(spec.description), "json", []);
    return 0;
  }

  const name = normalize(command);
  const spec = tools.find((tool) => tool.name === name);
  if (!spec) {
    const hidden = ALL_TOOLS.find((tool) => tool.name === name);
    emitError(
      new Error(
        hidden
          ? `${name} is unavailable: this server is running with MIDJOURNEY_READ_ONLY=1.`
          : `Unknown command '${command}'. Run \`${binName()} tools\`.`,
      ),
    );
    return 1;
  }

  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(renderToolHelp(spec));
    return 0;
  }

  // `--agent` is one flag for "a program is reading this". It implies compact
  // JSON and nothing else.
  //
  // The equivalent in the reference CLI for this API also implies `--yes`,
  // which is right for a read-only tool and wrong here: this one can spend
  // money, and a flag an agent passes by habit must never be what authorises a
  // charge. Confirmation stays explicit, always.
  const agentMode = rest.includes("--agent");
  const format: Format = agentMode || rest.includes("--compact")
    ? "compact"
    : rest.includes("--json")
      ? "json"
      : "text";

  // `--select` is pulled out here rather than declared as a flag, because it is
  // an output concern shared by every command, not part of any tool's schema.
  const select: string[] = [];
  const toolArgv: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index] as string;
    if (token === "--json" || token === "--compact" || token === "--agent") continue;
    if (token === "--select") {
      const value = rest[++index];
      if (value === undefined) {
        emitError(new UsageError("--select expects a comma-separated list of fields."));
        return 2;
      }
      select.push(...value.split(",").map((part) => part.trim()).filter(Boolean));
      continue;
    }
    if (token.startsWith("--select=")) {
      select.push(
        ...token
          .slice("--select=".length)
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean),
      );
      continue;
    }
    toolArgv.push(token);
  }

  let client: MidjourneyClient | undefined;
  try {
    const parsed = parseArgs(toolArgv, flagsFor(spec.schema));
    // Zod is the authority on validity, exactly as it is for an MCP call.
    const args = z.object(spec.schema).parse(parsed);

    client = new MidjourneyClient(config);
    const ctx: ToolContext = makeContext(client, config, guard);

    // The same gate the MCP path applies, so --confirm, READ_ONLY,
    // ALLOW_DESTRUCTIVE and the audit log all behave identically here.
    if (spec.risk !== "read") {
      const summary = spec.summary?.(args as never) ?? spec.name;
      guard.check(spec.name, spec.risk, (args as { confirm?: boolean }).confirm, summary);
    }

    emit(await spec.handler(args as never, ctx), format, select);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      emitError(error);
      return 2;
    }
    // A bad --ar or --sref is the caller typing it wrong, the same class of
    // mistake as a missing flag, so it exits 2 rather than 1.
    if (error instanceof MidjourneyError && error.name === "ValidationError") {
      emitError(error);
      return 2;
    }
    if (error instanceof z.ZodError) {
      const first = error.issues[0];
      emitError(
        new Error(
          first
            ? `--${String(first.path.join(".")).replace(/_/g, "-")}: ${first.message}`
            : error.message,
        ),
      );
      return 2;
    }
    emitError(error);
    return 1;
  } finally {
    client?.close();
  }
}
