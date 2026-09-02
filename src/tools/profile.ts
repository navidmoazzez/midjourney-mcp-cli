/** Who the session is, and the personalisation attached to it. */

import { ENDPOINTS } from "../api/jobs.js";
import { listProfiles } from "../api/moodboards.js";
import { defineTool } from "./kit.js";

export const profileTools = [
  defineTool({
    name: "whoami",
    title: "Show the signed-in account",
    description:
      "Report which Midjourney account the controlled browser is signed in as, and whether the browser is reachable at all.\n\nThe first thing to call when something is not working: it separates 'the browser is not running', 'the browser is running but signed out' and 'the account is fine, the request was wrong', which fail in very different ways.",
    schema: {},
    risk: "read",
    handler: async (_args, ctx) => {
      const running = await ctx.client.transport.isRunning();
      if (!running) {
        return {
          browser_running: false,
          signed_in: false,
          next: "The controlled Chrome is not running. It starts on demand, or run `midjourney-cli login` to open it and sign in.",
        };
      }

      const version = await ctx.client.transport.version();
      try {
        const userId = await ctx.client.userId();
        return {
          browser_running: true,
          signed_in: true,
          user_id: userId,
          channel_id: `singleplayer_${userId.replace(/^singleplayer_/, "")}`,
          browser: version?.Browser,
          profile_dir: ctx.config.profileDir,
        };
      } catch (error) {
        return {
          browser_running: true,
          signed_in: false,
          browser: version?.Browser,
          profile_dir: ctx.config.profileDir,
          reason: (error as Error).message,
          next: "Run `midjourney-cli login` to open the controlled window and sign in. The session then persists across restarts.",
        };
      }
    },
  }),

  defineTool({
    name: "list_personalized_profiles",
    title: "List personalisation profiles",
    description:
      "List the account's personalisation profiles, with how many images each was trained on.\n\nA profile is built from the images the account has rated, and biases generations toward that taste. Pass one to imagine as `profile: \"<id>\"`. A profile with a low ranking count has little to go on, so it will barely change the result.",
    schema: {},
    risk: "read",
    handler: async (_args, ctx) => {
      const profiles = await listProfiles(ctx.client);
      return {
        count: profiles.length,
        profiles: profiles.map((profile) => ({
          id: profile.id,
          title: profile.title,
          ...(profile.rankingCount !== undefined ? { images_rated: profile.rankingCount } : {}),
          ...(profile.majorVersion ? { model_version: profile.majorVersion } : {}),
        })),
      };
    },
  }),

  defineTool({
    name: "list_following",
    title: "List who this account follows",
    description: "List the Midjourney creators this account follows.",
    schema: {},
    risk: "read",
    handler: async (_args, ctx) => ctx.client.request(ENDPOINTS.following),
  }),

  defineTool({
    name: "list_model_ratings",
    title: "List pending rating tasks",
    description:
      "List the image-rating tasks Midjourney is offering this account. Rating images earns fast hours and feeds the account's personalisation profile.",
    schema: {},
    risk: "read",
    handler: async (_args, ctx) => ctx.client.request(ENDPOINTS.modelRatings),
  }),

  defineTool({
    name: "get_contest_ranking_count",
    title: "Show contest ranking counts",
    description: "Show how many contest ranking rounds this account has completed.",
    schema: {},
    risk: "read",
    handler: async (_args, ctx) => ctx.client.request(ENDPOINTS.contestsRankingCount),
  }),
];
