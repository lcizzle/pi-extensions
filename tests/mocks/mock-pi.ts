export interface CommandOptions {
  description?: string;
  handler: (args: any, ctx: MockContext) => Promise<void> | void;
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
  select?: (title: string, options: string[]) => Promise<string | undefined> | string | undefined;
  input?: (title: string, placeholder?: string) => Promise<string | undefined> | string | undefined;
  [key: string]: any;
}

export interface MockContext {
  ui: MockUI;
  session: MockSession;
  model?: any;
  thinkingLevel?: string;
  newSession?: () => Promise<void> | void;
  shutdown?: () => void;
  [key: string]: any;
}

export interface MockPiHarness {
  registerCommand: (name: string, options: CommandOptions) => void;
  getThinkingLevel?: () => string;
  setThinkingLevel?: (level: string) => void;
  setSessionName?: (name: string) => void;
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

  let currentThinkingLevel = "low";

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
    getThinkingLevel: () => currentThinkingLevel,
    setThinkingLevel: (level: string) => {
      currentThinkingLevel = level;
    },
    setSessionName: (_name: string) => {},
  };

  return {
    pi,
    registeredCommands,
    mockCtx,
    capturedOutputs,
    session,
  };
}
