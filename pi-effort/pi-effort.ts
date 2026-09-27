import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ThinkingLevel } from "@earendil-works/pi-coding-agent";

/** Model-aware alias for Pi's /thinking command. */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("effort", {
    description: "Alias for /thinking (set the model's thinking level)",
    handler: async (args, ctx) => {
      const model = ctx.model;
      if (!model?.reasoning) {
        ctx.ui.notify("The current model does not support thinking", "warning");
        return;
      }

      // Match Pi's supported-level filtering and retain its native level names.
      const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
      const available = levels.filter((level) => model.thinkingLevelMap?.[level] !== null);
      const requested = args.trim();
      let level = requested
        ? available.find((candidate) => candidate.toLowerCase() === requested.toLowerCase())
        : await ctx.ui.select("Select thinking level:", available.map((candidate) =>
            candidate === ctx.thinkingLevel ? `${candidate} (selected)` : candidate,
          ));

      if (!level) return;
      if (!requested) level = level.replace(/ \\(selected\\)$/, "") as ThinkingLevel;
      if (!available.includes(level as ThinkingLevel)) {
        ctx.ui.notify(`Unknown or unsupported thinking level: ${requested}`, "error");
        return;
      }
      pi.setThinkingLevel(level as ThinkingLevel);
    },
  });
}
