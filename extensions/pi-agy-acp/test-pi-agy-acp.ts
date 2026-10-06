import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  ThoughtStreamParser,
  savePersistedSession,
  loadPersistedSession,
  clearPersistedSession,
  getSessionCachePath,
  listProfiles,
  formatAcpStatusBar,
  selectAcpPermissionOption,
  selectAcpRejectOption,
  type PersistedAcpSession,
} from "./pi-agy-acp";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const oldHome = process.env.MGWCLI_HOME;
const testHome = mkdtempSync(join(tmpdir(), "acp-regression-"));
beforeAll(() => {
  process.env.MGWCLI_HOME = testHome;
  const profile = join(testHome, "profiles", "shared-profile-01");
  mkdirSync(join(profile, "acp-home", "antigravity-acp"), { recursive: true });
  writeFileSync(join(profile, "profile.json"), JSON.stringify({ type: "shared" }));
  writeFileSync(join(profile, "acp-home", "antigravity-acp", "acp_token.json"), "{}");
});
afterAll(() => { if (oldHome === undefined) delete process.env.MGWCLI_HOME; else process.env.MGWCLI_HOME = oldHome; rmSync(testHome, { recursive: true, force: true }); });

describe("ThoughtStreamParser", () => {
  test("processes plain text without tags directly into text stream", () => {
    const thoughts: string[] = [];
    const texts: string[] = [];
    const parser = new ThoughtStreamParser(
      (t) => thoughts.push(t),
      (x) => texts.push(x),
    );

    parser.feed("Hello ");
    parser.feed("world! ");
    parser.feed("How can I help you?");
    parser.flush();

    expect(thoughts).toEqual([]);
    expect(texts.join("")).toBe("Hello world! How can I help you?");
  });

  test("extracts <thought> reasoning into thought stream and remainder into text", () => {
    const thoughts: string[] = [];
    const texts: string[] = [];
    const parser = new ThoughtStreamParser(
      (t) => thoughts.push(t),
      (x) => texts.push(x),
    );

    parser.feed("<thought>Analyzing the problem carefully.</thought>Here is the solution.");
    parser.flush();

    expect(thoughts.join("")).toBe("Analyzing the problem carefully.");
    expect(texts.join("")).toBe("Here is the solution.");
  });

  test("handles tags split across streaming chunk boundaries", () => {
    const thoughts: string[] = [];
    const texts: string[] = [];
    const parser = new ThoughtStreamParser(
      (t) => thoughts.push(t),
      (x) => texts.push(x),
    );

    parser.feed("<th");
    parser.feed("ought>Thinking step 1. ");
    parser.feed("Thinking step 2.</tho");
    parser.feed("ught>Final response.");
    parser.flush();

    expect(thoughts.join("")).toBe("Thinking step 1. Thinking step 2.");
    expect(texts.join("")).toBe("Final response.");
  });

  test("supports alternative <thinking> tags", () => {
    const thoughts: string[] = [];
    const texts: string[] = [];
    const parser = new ThoughtStreamParser(
      (t) => thoughts.push(t),
      (x) => texts.push(x),
    );

    parser.feed("<thinking>Deep reasoning trace</thinking>Answer.");
    parser.flush();

    expect(thoughts.join("")).toBe("Deep reasoning trace");
    expect(texts.join("")).toBe("Answer.");
  });
});

describe("Session Persistence Across CLI Restarts", () => {
  const testCwd = "D:\\Projects\\TestWorkspace-Persistence";

  test("persists session to disk and reloads accurately", () => {
    const sessionData: PersistedAcpSession = {
      sessionId: "session-test-uuid-12345",
      profile: "shared-profile-01",
      modelId: "gemini-3.8-flash-high",
      modeId: "auto_edit",
      cwd: testCwd,
      sessionTurnCount: 4,
      cumulativeInputTokens: 1540,
      cumulativeOutputTokens: 820,
      lastUsed: Date.now(),
    };

    savePersistedSession(testCwd, sessionData);

    const cachePath = getSessionCachePath(testCwd);
    expect(existsSync(cachePath)).toBe(true);

    const loaded = loadPersistedSession(testCwd);
    expect(loaded).toBeDefined();
    expect(loaded?.sessionId).toBe("session-test-uuid-12345");
    expect(loaded?.profile).toBe("shared-profile-01");
    expect(loaded?.sessionTurnCount).toBe(4);
    expect(loaded?.cumulativeInputTokens).toBe(1540);
    expect(loaded?.cumulativeOutputTokens).toBe(820);

    clearPersistedSession(testCwd);
    expect(existsSync(cachePath)).toBe(false);
    expect(loadPersistedSession(testCwd)).toBeUndefined();
  });
});

describe("Command Registration & Status Bar Formatting", () => {
  test("formatAcpStatusBar conforms strictly to 0T/0↓/0↑/0.00% (Profile) format", () => {
    const formatted = formatAcpStatusBar({
      profile: "shared-profile-01",
      turns: 3,
      promptTokens: 1250,
      completionTokens: 380,
      consumedTokens: 1630,
      maxContext: 1048576,
    });

    expect(formatted).toBe("3T/1.3k↓/380↑/0.16% (shared-profile-01)");
  });

  test("listProfiles returns profiles with authentication status", () => {
    const profiles = listProfiles();
    expect(profiles.length).toBeGreaterThan(0);
    const p1 = profiles.find((p) => p.name === "shared-profile-01");
    expect(p1).toBeDefined();
    expect(p1?.authenticated).toBe(true);
  });

  test("registers all 13 /agy-acp-* commands including /agy-acp-auth and provider", () => {
    const registeredCommands = new Map<string, any>();
    let registeredProvider: any;
    let registeredTool: any;
    const registeredEvents = new Map<string, Function>();

    const mockPi: any = {
      registerProvider: (id: string, provider: any) => {
        registeredProvider = { id, provider };
      },
      registerCommand: (name: string, config: any) => {
        registeredCommands.set(name, config);
      },
      registerTool: (tool: any) => {
        registeredTool = tool;
      },
      on: (event: string, handler: Function) => {
        registeredEvents.set(event, handler);
      },
    };

    // Import default extension entry
    const ext = require("./pi-agy-acp").default;
    ext(mockPi);

    expect(registeredProvider?.id).toBe("antigravity");
    expect(registeredTool?.name).toBe("agy_acp_task");

    const expectedCommands = [
      "agy-acp",
      "agy-acp-profile",
      "agy-acp-mode",
      "agy-acp-restart",
      "agy-acp-reset",
      "agy-acp-recover",
      "agy-acp-auth",
      "agy-acp-usage",
      "agy-acp-status",
      "agy-acp-bar",
      "agy-acp-limits",
      "agy-acp-quota",
      "agy-acp-autoswitch",
    ];

    for (const cmd of expectedCommands) {
      expect(registeredCommands.has(cmd)).toBe(true);
    }

    // Verify none of the old collision-prone commands exist
    const forbiddenCommands = [
      "acp",
      "acp-profile",
      "acp-mode",
      "acp-restart",
      "acp-reset",
      "acp-recover",
      "acp-auth",
      "acp-usage",
      "acp-status",
      "acp-bar",
      "acp-limits",
      "acp-quota",
      "acp-autoswitch",
    ];

    for (const cmd of forbiddenCommands) {
      expect(registeredCommands.has(cmd)).toBe(false);
    }

    // Verify session_start and turn_end hooks
    expect(registeredEvents.has("session_start")).toBe(true);
    expect(registeredEvents.has("turn_end")).toBe(true);
  });
});

describe("ACP Permission Request & Decision Handling", () => {
  const standardOptions = [
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  ];

  test("selectAcpPermissionOption prioritizes allow_always when allowAlways is true", () => {
    const selected = selectAcpPermissionOption(standardOptions, true);
    expect(selected).toBe("allow-always");
  });

  test("selectAcpPermissionOption selects allow_once when allowAlways is false", () => {
    const selected = selectAcpPermissionOption(standardOptions, false);
    expect(selected).toBe("allow-once");
  });

  test("selectAcpPermissionOption rejects display-label-only approval options", () => {
    const customOptions = [
      { optionId: "custom-reject", name: "No, deny this action" },
      { optionId: "custom-approve", name: "Yes, approve execution" },
    ];
    const selected = selectAcpPermissionOption(customOptions, false);
    expect(selected).toBeUndefined();
  });

  test("selectAcpPermissionOption rejects ambiguous non-reject options", () => {
    const fallbackOptions = [
      { optionId: "reject-opt", name: "Reject" },
      { optionId: "proceed-opt", name: "Proceed with caution" },
    ];
    const selected = selectAcpPermissionOption(fallbackOptions, false);
    expect(selected).toBeUndefined();
  });

  test("selectAcpRejectOption locates reject_once or reject optionId", () => {
    const selected = selectAcpRejectOption(standardOptions);
    expect(selected).toBe("reject-once");

    const customReject = [
      { optionId: "allow-1", name: "Allow" },
      { optionId: "deny-request", name: "Deny action" },
    ];
    expect(selectAcpRejectOption(customReject)).toBe("deny-request");
  });

  test("handles empty options gracefully", () => {
    expect(selectAcpPermissionOption([])).toBeUndefined();
    expect(selectAcpRejectOption([])).toBeUndefined();
  });

  test("PersistentAcpManager responds to incoming session/request_permission via sendResponse", async () => {
    const { PersistentAcpManager } = require("./pi-agy-acp");
    const mgr = new PersistentAcpManager("shared-profile-01", "D:\\Projects\\TestWorkspace-Persistence");
    
    const writtenLines: string[] = [];
    (mgr as any).child = {
      stdin: {
        writable: true,
        write: (str: string) => {
          writtenLines.push(str.trim());
          return true;
        },
      },
      killed: false,
      exitCode: null,
    };
    mgr.currentModeId = "auto_edit";
    (mgr as any).activeMode = "auto_edit";
    (mgr as any).activeSessionId = "sess-123";
    (mgr as any).activePromptRpcId = "test-prompt";
    mgr.isBusy = true;

    const permissionRpc = {
      jsonrpc: "2.0",
      id: 42,
      method: "session/request_permission",
      params: {
        sessionId: "sess-123",
        toolCall: {
          toolCallId: "call-web-search",
          name: "read_url_content",
          title: "Edit file?",
          kind: "edit",
        },
        options: standardOptions,
      },
    };

    await (mgr as any).handleIncomingPermissionRequest(permissionRpc);

    expect(writtenLines.length).toBe(1);
    const parsed = JSON.parse(writtenLines[0]);
    expect(parsed.jsonrpc).toBe("2.0");
    expect(parsed.id).toBe(42);
    expect(parsed.result).toEqual({
      outcome: {
        outcome: "selected",
        optionId: "allow-once",
      },
    });
  });

  test("incoming server requests never resolve client RPC callbacks even with identical IDs", async () => {
    const { PersistentAcpManager } = require("./pi-agy-acp");
    const mgr = new PersistentAcpManager("shared-profile-01", "D:\\Projects\\TestWorkspace-Persistence");

    const writtenLines: string[] = [];
    (mgr as any).child = {
      stdin: {
        writable: true,
        write: (str: string) => {
          writtenLines.push(str.trim());
          return true;
        },
      },
      killed: false,
      exitCode: null,
    };
    mgr.currentModeId = "auto_edit";

    // Simulate a pending client RPC with ID "test-id-100" and another with numeric ID 42
    let resolvedValue: any = undefined;
    (mgr as any).responses.set(42, (res: any) => {
      resolvedValue = res;
    });

    // Simulate incoming server request (has method and id: 42)
    const serverRequestLine = JSON.stringify({
      jsonrpc: "2.0",
      id: 42,
      method: "session/request_permission",
      params: {
        sessionId: "sess-123",
        toolCall: { name: "test_tool" },
        options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }],
      },
    });

    // Feed to the line-reader handler logic
    const msg = JSON.parse(serverRequestLine);
    if (msg.method === "session/request_permission" || msg.method === "session/requestPermission") {
      await (mgr as any).handleIncomingPermissionRequest(msg);
    }
    if (msg.method === undefined && msg.id !== undefined && (mgr as any).responses.has(msg.id)) {
      (mgr as any).responses.get(msg.id)!(msg);
      (mgr as any).responses.delete(msg.id);
    }

    // Verify:
    // 1. Server permission was answered via stdin
    expect(writtenLines.length).toBe(1);
    // 2. But the pending client response was NOT resolved prematurely!
    expect(resolvedValue).toBeUndefined();
    expect((mgr as any).responses.has(42)).toBe(true);

    // Now simulate the real response arriving from the server (method === undefined)
    const realResponse = {
      jsonrpc: "2.0",
      id: 42,
      result: { stopReason: "completed" },
    };
    if (realResponse.method === undefined && realResponse.id !== undefined && (mgr as any).responses.has(realResponse.id)) {
      (mgr as any).responses.get(realResponse.id)!(realResponse);
      (mgr as any).responses.delete(realResponse.id);
    }

    // Verify it resolved now!
    expect(resolvedValue).toEqual(realResponse);
    expect((mgr as any).responses.has(42)).toBe(false);
  });

  test("PersistentAcpManager.sendRpc generates unique 'pi-' prefixed string IDs", async () => {
    const { PersistentAcpManager } = require("./pi-agy-acp");
    const mgr = new PersistentAcpManager("shared-profile-01", "D:\\Projects\\TestWorkspace-Persistence");

    const writtenLines: string[] = [];
    (mgr as any).child = {
      stdin: {
        writable: true,
        write: (str: string) => {
          writtenLines.push(str.trim());
          return true;
        },
      },
      killed: false,
      exitCode: null,
    };

    // Launch RPC (don't await so we can inspect what was written)
    const rpcPromise = mgr.sendRpc("test/method", { foo: "bar" }, 5000);

    expect(writtenLines.length).toBe(1);
    const sent = JSON.parse(writtenLines[0]);
    expect(typeof sent.id).toBe("string");
    expect(sent.id.startsWith("pi-")).toBe(true);
    expect((mgr as any).responses.has(sent.id)).toBe(true);

    // Provide response
    const resPayload = { jsonrpc: "2.0", id: sent.id, result: { success: true } };
    (mgr as any).responses.get(sent.id)!(resPayload);

    const result = await rpcPromise;
    expect(result).toEqual({ success: true });
  });

  test("Silence after text emission cannot fabricate successful completion", async () => {
    const { PersistentAcpManager } = require("./pi-agy-acp");
    const mgr = new PersistentAcpManager("shared-profile-01", "D:\\Projects\\TestWorkspace-Persistence");

    const writtenLines: string[] = [];
    (mgr as any).child = {
      stdin: {
        writable: true,
        write: (str: string) => {
          writtenLines.push(str.trim());
          return true;
        },
      },
      killed: false,
      exitCode: null,
    };
    mgr.currentSessionId = "sess-quiescence-test";

    // Simulate starting prompt
    const promptPromise = mgr.prompt([{ type: "text", text: "Explain puzzle" }]);

    // Emulate incoming text chunk from server
    mgr.hasEmittedTextInTurn = true;
    mgr.activeCollectedOutput = "The solution is Box B.";

    // Trigger scheduleQuiescenceCheck with a short delay (e.g. 50ms)
    mgr.scheduleQuiescenceCheck(50);

    let settled = false;
    promptPromise.then(() => { settled = true; });
    await new Promise(r => setTimeout(r, 75));
    expect(settled).toBe(false);
    expect(writtenLines.some(l => l.includes("session/cancel"))).toBe(false);
    const rpcId = (mgr as any).activePromptRpcId;
    (mgr as any).responses.get(rpcId)({ result: { stopReason: "end_turn", usage: { total: 20 } } });
    const result = await promptPromise;
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage.total).toBe(20);
  });

  test("Active tool calls prevent quiescence timer from resolving early", async () => {
    const { PersistentAcpManager } = require("./pi-agy-acp");
    const mgr = new PersistentAcpManager("shared-profile-01", "D:\\Projects\\TestWorkspace-Persistence");

    (mgr as any).child = {
      stdin: {
        writable: true,
        write: () => true,
      },
      killed: false,
      exitCode: null,
    };
    mgr.currentSessionId = "sess-tool-quiescence";

    const promptPromise = mgr.prompt([{ type: "text", text: "Download file" }]);

    mgr.hasEmittedTextInTurn = true;
    mgr.activeCollectedOutput = "Downloading file...";
    (mgr as any).activeToolCalls.add("call-tool-download");

    // Quiescence check should be a no-op because activeToolCalls.size > 0
    mgr.scheduleQuiescenceCheck(20);

    await new Promise((r) => setTimeout(r, 60));

    // Promise should still be pending
    let isResolved = false;
    promptPromise.then(() => { isResolved = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(isResolved).toBe(false);

    // Now complete the tool call and send real server response
    (mgr as any).activeToolCalls.clear();
    const promptId = (mgr as any).activePromptRpcId;
    (mgr as any).responses.get(promptId)!({
      jsonrpc: "2.0",
      id: promptId,
      result: { stopReason: "end_turn", usage: { total: 42 } },
    });

    const res = await promptPromise;
    expect(res.stopReason).toBe("end_turn");
    expect(res.usage.total).toBe(42);
  });
});


