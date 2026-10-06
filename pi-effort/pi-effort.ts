import type { ExtensionAPI, ThinkingLevel } from "@earendil-works/pi-coding-agent";

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
      const available = levels.filter((level) => {
        const mapped = model.thinkingLevelMap?.[level];
        if (mapped === null) return false;
        if (level === "xhigh" || level === "max") return mapped !== undefined;
        return true;
      });

      const requested = args.trim();
      let level: ThinkingLevel | undefined;

      if (requested) {
        level = available.find((candidate) => candidate.toLowerCase() === requested.toLowerCase());
        if (!level) {
          ctx.ui.notify(`Unknown or unsupported thinking level: ${requested}`, "error");
          return;
        }
      } else {
        const currentLevel = ctx.thinkingLevel ?? pi.getThinkingLevel();
        const selected = await ctx.ui.select(
          "Select thinking level:",
          available.map((candidate) => (candidate === currentLevel ? `${candidate} (selected)` : candidate)),
        );
        if (!selected) return;
        level = selected.replace(/ \(selected\)$/, "") as ThinkingLevel;
      }

      if (level) {
        pi.setThinkingLevel(level);
      }
    },
  });
}
