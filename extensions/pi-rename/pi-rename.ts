import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Rename the current session, or prompt for a name when none is provided. */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("rename", {
    description: "Rename the current session (alias for /name)",
    handler: async (args, ctx) => {
      const requestedName = args.trim() || (await ctx.ui.input("Rename session", "Enter a session name"))?.trim();
      if (!requestedName) return;

      pi.setSessionName(requestedName);
      ctx.ui.notify(`Session name set: ${requestedName}`, "info");
    },
  });
}
