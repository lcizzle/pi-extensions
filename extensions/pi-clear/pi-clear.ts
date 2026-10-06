import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Start a fresh session, matching Pi's built-in /new command. */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("clear", {
    description: "Alias for /new (start a fresh session)",
    handler: async (_args, ctx) => {
      await ctx.newSession();
    },
  });
}
