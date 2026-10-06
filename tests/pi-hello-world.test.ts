import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import registerHelloWorldExtension from "../extensions/pi-hello-world/pi-hello-world.ts";
import { createMockPi } from "./mocks/mock-pi.ts";

describe("pi-hello-world extension unit tests", () => {
  test("registers 'hello-world' command and executes handler correctly", async () => {
    const { pi, registeredCommands, mockCtx, capturedOutputs, session } = createMockPi();

    // Register extension
    registerHelloWorldExtension(pi);

    // Verify command registration
    expect(registeredCommands.has("hello-world")).toBe(true);

    const command = registeredCommands.get("hello-world")!;
    expect(command).toBeDefined();
    expect(command.description).toBe("Say Hello, World!");

    // Execute command handler
    await command.handler([], mockCtx);

    // Assert captured output contains expected hello string
    expect(capturedOutputs.some((msg) => /hello, world!/i.test(msg))).toBe(true);

    // Assert session messages remains clean (no context injection)
    expect(session.messages).toBeArray();
    expect(session.messages).toHaveLength(0);
  });
});

describe("pi-hello-world extension headless CLI smoke test", () => {
  test("loads cleanly in pi CLI without error", () => {
    const tmpDir = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

      const res = Bun.spawnSync([
        "pi",
        "-e",
        "./extensions/pi-hello-world/pi-hello-world.ts",
        "--no-session",
        "-p",
        "exit",
      ], {
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: tmpDir,
        },
      });

      expect(res.exitCode).toBe(0);
    } finally {
      server.stop();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30000);
});
