/**
 * Decides whether a call is allowed to reach Midjourney.
 *
 * The hazard here is not the one the other servers in this family guard
 * against. Nothing posted here is public, and almost nothing is irreversible.
 * What is irreversible is the money: every generation burns GPU time off a paid
 * plan, and a model that loops over a list of forty prompt ideas can spend a
 * month of fast hours before anyone notices. There is no undo for that.
 *
 * So the risk levels are not the usual three. A generation is not destructive,
 * it destroys nothing, and annotating it `destructiveHint: true` would be a lie
 * to any client using annotations to decide what it can auto-approve. It gets
 * its own level, gated the same way but described honestly.
 *
 *   read         nothing changes
 *   write        reversible: rename a folder, favourite an image
 *   spend        costs GPU time. Needs confirmation.
 *   destructive  cannot be undone. Needs confirmation.
 *
 * MIDJOURNEY_READ_ONLY=1 removes everything but reads from the tool list. A
 * model cannot call a tool it cannot see, which is a stronger boundary than a
 * refusal it can retry.
 */

import { appendFileSync } from "node:fs";

import { WriteBlockedError } from "./api/errors.js";
import type { Config } from "./config.js";

export type Risk = "read" | "write" | "spend" | "destructive";

/**
 * How the caller reached us, so a refusal names what they can actually type.
 * A model reads `confirm: true`; a person at a terminal reads `--confirm`.
 */
export type Surface = "mcp" | "cli";

export function needsConfirm(risk: Risk): boolean {
  return risk === "spend" || risk === "destructive";
}

export class WriteGuard {
  private readonly config: Config;
  private readonly surface: Surface;

  constructor(config: Config, surface: Surface = "mcp") {
    this.config = config;
    this.surface = surface;
  }

  private get confirmFlag(): string {
    return this.surface === "cli" ? "--confirm" : "confirm: true";
  }

  get readOnly(): boolean {
    return this.config.readOnly;
  }

  check(tool: string, risk: Risk, confirm: boolean | undefined, summary: string): void {
    if (risk === "read") return;

    if (this.config.readOnly) {
      this.audit(tool, risk, summary, "blocked: read-only");
      throw new WriteBlockedError(
        `${tool} is unavailable: this server is running with MIDJOURNEY_READ_ONLY=1.`,
      );
    }

    if (needsConfirm(risk)) {
      if (!this.config.allowDestructive) {
        this.audit(tool, risk, summary, "blocked: writes disabled");
        throw new WriteBlockedError(
          `${tool} is unavailable: this server is running with MIDJOURNEY_ALLOW_DESTRUCTIVE=0.`,
        );
      }
      if (confirm !== true) {
        this.audit(tool, risk, summary, "blocked: no confirm");
        const why =
          risk === "spend"
            ? "spends GPU time off the Midjourney plan and cannot be refunded"
            : "cannot be undone";
        throw new WriteBlockedError(
          `${tool} ${why}, so it will not run without ${this.confirmFlag}. About to: ${summary}. Call again with ${this.confirmFlag} if that is what was asked for.`,
        );
      }
    }

    this.audit(tool, risk, summary, "allowed");
  }

  /** Append-only record of every attempted change, when MIDJOURNEY_AUDIT_LOG is set. */
  private audit(tool: string, risk: Risk, summary: string, outcome: string): void {
    if (!this.config.auditPath) return;
    const line = JSON.stringify({
      at: new Date().toISOString(),
      surface: this.surface,
      tool,
      risk,
      summary,
      outcome,
    });
    try {
      appendFileSync(this.config.auditPath, `${line}\n`, { mode: 0o600 });
    } catch {
      // A failing audit log must never take the tool call down with it.
    }
  }
}

/**
 * MCP annotations for a risk level.
 *
 * Clients use these to decide what to auto-approve, so they have to be honest.
 * `openWorldHint` is true throughout because every call leaves the machine, and
 * a generation is not idempotent: calling it twice makes two images and charges
 * for both.
 */
export function annotationsFor(
  risk: Risk,
  options: { idempotent?: boolean } = {},
): Record<string, boolean> {
  return {
    readOnlyHint: risk === "read",
    destructiveHint: risk === "destructive",
    idempotentHint: options.idempotent ?? risk === "read",
    openWorldHint: true,
  };
}
