/** Every tool, in the order they appear in the README. */

import type { AnyToolSpec } from "./kit.js";

import { profileTools } from "./profile.js";
import { createTools } from "./create.js";
import { jobTools } from "./jobs.js";
import { downloadTools } from "./download.js";
import { libraryTools } from "./library.js";
import { exploreTools } from "./explore.js";

export const ALL_TOOLS: AnyToolSpec[] = [
  ...profileTools,
  ...createTools,
  ...jobTools,
  ...downloadTools,
  ...libraryTools,
  ...exploreTools,
] as AnyToolSpec[];
