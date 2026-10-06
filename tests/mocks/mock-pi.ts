export interface CommandOptions {
  description?: string;
  handler: (args: string[], ctx: MockContext) => Promise<void> | void;
  [key: string]: any;
}

export interface MockSession {
  messages: any[];
  [key: string]: any;
}

export interface MockUI {
  notify: (...args: any[]) => void;
  write: (...args: any[]) => void;
  log: (...args: any[]) => void;
  [key: string]: any;
}

export interface MockContext {
  ui: MockUI;
  session: MockSession;
  [key: string]: any;
}

export interface MockPiHarness {
  registerCommand: (name: string, options: CommandOptions) => void;
  [key: string]: any;
}

export interface MockPiResult {
  pi: MockPiHarness;
  registeredCommands: Map<string, CommandOptions>;
  mockCtx: MockContext;
  capturedOutputs: string[];
  session: MockSession;
}

export function createMockPi(): MockPiResult {
  const registeredCommands = new Map<string, CommandOptions>();
  const capturedOutputs: string[] = [];
  const session: MockSession = { messages: [] };

  const recordOutput = (...args: any[]) => {
    for (const arg of args) {
      if (typeof arg === "string") {
        capturedOutputs.push(arg);
      } else if (arg !== null && arg !== undefined) {
        capturedOutputs.push(String(arg));
      }
    }
  };

  const mockCtx: MockContext = {
    ui: {
      notify: recordOutput,
      write: recordOutput,
      log: recordOutput,
    },
    session,
  };

  const pi: MockPiHarness = {
    registerCommand: (name: string, options: CommandOptions) => {
      registeredCommands.set(name, options);
    },
  };

  return {
    pi,
    registeredCommands,
    mockCtx,
    capturedOutputs,
    session,
  };
}
