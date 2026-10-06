# PI Agent Extensions

A collection of extensions for the PI Coding Agent. All extensions are located in the [`extensions/`](./extensions) directory.

---

## Overview

| Extension | Command / Tool | Description |
| :--- | :--- | :--- |
| **[pi-agy-acp](./extensions/pi-agy-acp)** | `/acp`, `/agy-acp`, `agy_acp_task` | Delegation to Google Antigravity via Agent Client Protocol (ACP). Supports profile & model selection (`gemini-3.8-flash`, `gemini-3.1-pro`), reasoning effort (`high`, `medium`, `low`), and execution modes (`auto_edit`, `default`, `yolo`). |
| **[pi-clear](./extensions/pi-clear)** | `/clear` | Alias to `/new` to start a fresh session. |
| **[pi-effort](./extensions/pi-effort)** | `/effort` | Alias to `/thinking` to configure the model's reasoning/thinking effort level. |
| **[pi-exit](./extensions/pi-exit)** | `/exit` | Alias to `/quit` to close the session. |
| **[pi-hello-world](./extensions/pi-hello-world)** | `/hello-world` | Basic extension that outputs "Hello, World!". |
| **[pi-laya-obsidian](./extensions/pi-laya-obsidian)** | `/laya-status`, `/laya-triage`, `obsidian_laya_triage`, `obsidian_precommit_check` | Integrates with Laya daemon for Obsidian vault active session triage, protocol compliance audit, and CQRS state write barrier. |
| **[pi-rename](./extensions/pi-rename)** | `/rename` | Alias to `/name` to rename the current session. Accepts session name directly or opens a prompt. |

---

## Directory Structure

```text
.
├── README.md
├── .gitignore
└── extensions/
    ├── pi-agy-acp/
    ├── pi-clear/
    ├── pi-effort/
    ├── pi-exit/
    ├── pi-hello-world/
    ├── pi-laya-obsidian/
    └── pi-rename/
```

---

## Extensions Detail

### PI-Agy-ACP
Provides interactive or direct delegation to Google Antigravity via Agent Client Protocol (ACP). Supports selecting profile, model (`gemini-3.8-flash`, `gemini-3.1-pro`), reasoning effort (`high`, `medium`, `low`), and execution mode (`auto_edit`, `default`, `yolo`).

### PI-Clear
Provides `/clear` as a convenient alias for `/new` to reset or start a fresh session.

### PI-Effort
Provides `/effort` as an alias for `/thinking` to set or adjust the model's thinking capacity/reasoning effort.

### PI-Exit
Provides `/exit` as an alias for `/quit`.

### PI-Hello-World
A simple slash command extension demonstration that prints "Hello, World!".

### PI-Laya-Obsidian
Obsidian & Laya Daemon integration for session note triaging, pre-commit compliance checks, and state note line limit enforcement. Includes commands `/laya-status` and `/laya-triage`, as well as tools `obsidian_laya_triage` and `obsidian_precommit_check`.

### PI-Rename
Provides `/rename` as an alias for `/name`. Run `/rename Session-Name` directly or run `/rename` without arguments to open an interactive prompt.
