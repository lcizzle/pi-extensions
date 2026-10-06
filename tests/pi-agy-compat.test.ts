import { describe, expect, test, spyOn } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import registerAgyCompatExtension from "../extensions/pi-agy-compat/pi-agy-compat.ts";
import { createMockPi } from "./mocks/mock-pi.ts";

describe("pi-agy-compat extension unit tests", () => {
  test("registers clear, effort, exit, and rename commands", () => {
    const { pi, registeredCommands } = createMockPi();
    registerAgyCompatExtension(pi as any);

    expect(registeredCommands.has("clear")).toBe(true);
    expect(registeredCommands.has("effort")).toBe(true);
    expect(registeredCommands.has("exit")).toBe(true);
    expect(registeredCommands.has("rename")).toBe(true);
  });

  test("executes 'clear' handler calling ctx.newSession()", async () => {
    const { pi, registeredCommands, mockCtx } = createMockPi();
    registerAgyCompatExtension(pi as any);

    let newSessionCalled = false;
    mockCtx.newSession = async () => {
      newSessionCalled = true;
    };

    const command = registeredCommands.get("clear")!;
    await command.handler("", mockCtx);

    expect(newSessionCalled).toBe(true);
  });

  test("executes 'effort' handler updating thinking level", async () => {
    const { pi, registeredCommands, mockCtx, capturedOutputs } = createMockPi();
    registerAgyCompatExtension(pi as any);

    let setLevel: string | undefined;
    pi.setThinkingLevel = (lvl: string) => {
      setLevel = lvl;
    };

    // Case 1: Model does not support reasoning
    mockCtx.model = { reasoning: false };
    const command = registeredCommands.get("effort")!;
    await command.handler("high", mockCtx);
    expect(capturedOutputs).toContain("The current model does not support thinking");

    // Case 2: Direct argument set
    mockCtx.model = {
      reasoning: true,
      thinkingLevelMap: { high: "high", low: "low" },
    };
    await command.handler("high", mockCtx);
    expect(setLevel).toBe("high");

    // Case 3: Interactive select
    mockCtx.ui.select = async () => "low (selected)";
    await command.handler("", mockCtx);
    expect(setLevel).toBe("low");
  });

  test("executes 'exit' handler calling ctx.shutdown() or process.exit", async () => {
    const { pi, registeredCommands, mockCtx } = createMockPi();
    registerAgyCompatExtension(pi as any);

    let shutdownCalled = false;
    mockCtx.shutdown = () => {
      shutdownCalled = true;
    };

    const processExitSpy = spyOn(process, "exit").mockImplementation((() => {}) as any);

    const command = registeredCommands.get("exit")!;
    await command.handler("", mockCtx);

    expect(shutdownCalled).toBe(true);
    processExitSpy.mockRestore();
  });

  test("executes 'rename' handler setting session name", async () => {
    const { pi, registeredCommands, mockCtx, capturedOutputs } = createMockPi();
    registerAgyCompatExtension(pi as any);

    let sessionName: string | undefined;
    pi.setSessionName = (name: string) => {
      sessionName = name;
    };

    const command = registeredCommands.get("rename")!;

    // Direct argument
    await command.handler("My Session", mockCtx);
    expect(sessionName).toBe("My Session");
    expect(capturedOutputs.some((msg) => msg.includes("Session name set: My Session"))).toBe(true);

    // Interactive prompt
    mockCtx.ui.input = async () => "Prompted Session";
    await command.handler("", mockCtx);
    expect(sessionName).toBe("Prompted Session");
  });
});

describe("pi-agy-compat extension headless CLI smoke test", () => {
  test("loads cleanly in pi CLI without error", async () => {
    const tmpDir = join(tmpdir(), `pi-agy-compat-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });

    const server = Bun.serve({
      port: 0,
      fetch() {
        const sseData = [
          `event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}\n\n`,
          `event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}\n\n`,
        ].join("");

        return new Response(sseData, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });

    try {
      writeFileSync(
        join(tmpDir, "models.json"),
        JSON.stringify({
          providers: {
            mock: {
              name: "Mock Provider",
              baseUrl: `http://127.0.0.1:${server.port}/v1`,
              api: "openai-responses",
              models: [{ id: "mock-model", name: "Mock Model" }],
            },
          },
        })
      );

      writeFileSync(
        join(tmpDir, "auth.json"),
        JSON.stringify({
          mock: { type: "api_key", key: "mock-key" },
        })
      );

      const result = Bun.spawnSync(
        [
          "pi",
          "-e",
          "./extensions/pi-agy-compat/pi-agy-compat.ts",
          "--no-session",
          "-p",
          "exit",
        ],
        {
          stdin: "ignore",
          timeout: 10000,
          env: {
            ...process.env,
            CI: "true",
            PI_CODING_AGENT_DIR: tmpDir,
          },
        }
      );

      expect(result.exitCode).toBe(0);
    } finally {
      server.stop();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 15000);
});
