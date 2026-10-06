import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import registerLayaExtension, {
  extractTargetPath,
  calculateProposedLines,
  triageMarkdown,
  checkHealth,
  resolveVaultRoot,
} from "./pi-laya-obsidian.ts";

describe("pi-laya-obsidian", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-laya-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("extractTargetPath", () => {
    it("extracts path from various tool input formats", () => {
      expect(extractTargetPath({ path: "Vaults/AI/State_Test.md" })).toBe("Vaults/AI/State_Test.md");
      expect(extractTargetPath({ TargetFile: "D:/Vaults/State_App.md" })).toBe("D:/Vaults/State_App.md");
      expect(extractTargetPath({ file: "notes/State_Foo.md" })).toBe("notes/State_Foo.md");
      expect(extractTargetPath({ filePath: "State_Bar.md" })).toBe("State_Bar.md");
      expect(extractTargetPath({})).toBeNull();
      expect(extractTargetPath(undefined)).toBeNull();
    });
  });

  describe("calculateProposedLines", () => {
    it("calculates lines from full content", () => {
      const content = "Line 1\nLine 2\nLine 3";
      const lines = calculateProposedLines("State_Test.md", tempDir, "write", { content });
      expect(lines).toBe(3);
    });

    it("calculates lines from CodeContent (Antigravity)", () => {
      const CodeContent = "Line 1\nLine 2\nLine 3\nLine 4";
      const lines = calculateProposedLines("State_Test.md", tempDir, "write_to_file", { CodeContent });
      expect(lines).toBe(4);
    });

    it("simulates edits on existing file", () => {
      const testFile = path.join(tempDir, "State_Test.md");
      fs.writeFileSync(testFile, "Line 1\nTarget\nLine 3\n", "utf8");

      const edits = [{ oldText: "Target", newText: "Sub1\nSub2\nSub3" }];
      const lines = calculateProposedLines(testFile, tempDir, "edit", { edits });
      expect(lines).toBe(6);
    });

    it("simulates replace_file_content on existing file", () => {
      const testFile = path.join(tempDir, "State_Test.md");
      fs.writeFileSync(testFile, "Hello\nWorld\n", "utf8");

      const lines = calculateProposedLines(testFile, tempDir, "replace_file_content", {
        TargetContent: "World",
        ReplacementContent: "Universe\nMultiverse",
      });
      expect(lines).toBe(4);
    });
  });

  describe("CQRS State Barrier hook", () => {
    it("blocks writes to State note if lines exceed 150", async () => {
      let toolCallHandler: any;
      const fakePi: any = {
        on: (event: string, handler: any) => {
          if (event === "tool_call") toolCallHandler = handler;
        },
        registerCommand: () => {},
        registerTool: () => {},
      };

      registerLayaExtension(fakePi);
      expect(toolCallHandler).toBeDefined();

      const bigContent = new Array(155).fill("line item").join("\n");
      const ctx: any = { cwd: tempDir };

      // Test write tool exceeding limit
      const result = await toolCallHandler(
        {
          toolName: "write",
          input: { path: "State_MyProject.md", content: bigContent },
        },
        ctx
      );

      expect(result).toBeDefined();
      expect(result.block).toBe(true);
      expect(result.reason).toContain("[CQRS Write Barrier]");
      expect(result.reason).toContain("155 lines");
    });

    it("allows writes to State note if lines <= 150", async () => {
      let toolCallHandler: any;
      const fakePi: any = {
        on: (event: string, handler: any) => {
          if (event === "tool_call") toolCallHandler = handler;
        },
        registerCommand: () => {},
        registerTool: () => {},
      };

      registerLayaExtension(fakePi);
      const smallContent = new Array(50).fill("line item").join("\n");
      const ctx: any = { cwd: tempDir };

      const result = await toolCallHandler(
        {
          toolName: "write",
          input: { path: "State_MyProject.md", content: smallContent },
        },
        ctx
      );

      expect(result).toBeUndefined();
    });

    it("ignores non-state files even if long", async () => {
      let toolCallHandler: any;
      const fakePi: any = {
        on: (event: string, handler: any) => {
          if (event === "tool_call") toolCallHandler = handler;
        },
        registerCommand: () => {},
        registerTool: () => {},
      };

      registerLayaExtension(fakePi);
      const bigContent = new Array(500).fill("long document").join("\n");
      const ctx: any = { cwd: tempDir };

      const result = await toolCallHandler(
        {
          toolName: "write",
          input: { path: "Sessions/Active/session.md", content: bigContent },
        },
        ctx
      );

      expect(result).toBeUndefined();
    });
  });

  describe("Automatic Sidecar Generation hook", () => {
    it("generates sidecar on active session writes", async () => {
      let toolResultHandler: any;
      const fakePi: any = {
        on: (event: string, handler: any) => {
          if (event === "tool_result") toolResultHandler = handler;
        },
        registerCommand: () => {},
        registerTool: () => {},
      };

      registerLayaExtension(fakePi);
      expect(toolResultHandler).toBeDefined();

      const activeDir = path.join(tempDir, "Sessions", "Active");
      fs.mkdirSync(activeDir, { recursive: true });
      const sessionFile = path.join(activeDir, "2026-10-05_test.md");
      fs.writeFileSync(
        sessionFile,
        "---\ntitle: test\n---\n# 1. Context & Objective\nTest session\n# 3. Discovered Knowledge\nNone\nstate_mutations: []\n",
        "utf8"
      );

      let notified = false;
      const ctx: any = {
        cwd: tempDir,
        ui: {
          notify: (msg: string) => {
            if (msg.includes("Triage sidecar generated")) notified = true;
          },
        },
      };

      await toolResultHandler(
        {
          isError: false,
          toolName: "write",
          input: { path: sessionFile },
        },
        ctx
      );

      const sidecarFile = `${sessionFile}.triage.json`;
      // Verify sidecar was created and is valid JSON
      expect(fs.existsSync(sidecarFile)).toBe(true);
      const data = JSON.parse(fs.readFileSync(sidecarFile, "utf8"));
      expect(data.compliance_score).toBeDefined();
      expect(data.p_needs_adr).toBeDefined();
      expect(notified).toBe(true);
    });
  });
});
