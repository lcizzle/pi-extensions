# PI Agent Extensions

A collection of extensions for the PI Coding Agent. All extensions are located in the [`extensions/`](./extensions) directory.

---

## Overview

| Extension | Command / Tool | Description |
| :--- | :--- | :--- |
| **[pi-agy-acp](./extensions/pi-agy-acp)** | `/acp`, `/agy-acp`, `agy_acp_task` | Delegation to Google Antigravity via Agent Client Protocol (ACP). Supports profile & model selection (`gemini-3.8-flash`, `gemini-3.1-pro`), reasoning effort (`high`, `medium`, `low`), and execution modes (`auto_edit`, `default`, `yolo`). |
| **[pi-agy-compat](./extensions/pi-agy-compat)** | `/clear`, `/effort`, `/exit`, `/rename` | Consolidated compatibility slash commands providing aliases for session reset (`/clear`), thinking capacity (`/effort`), agent exit (`/exit`), and session renaming (`/rename`). |
| **[pi-hello-world](./extensions/pi-hello-world)** | `/hello-world` | Basic extension that outputs "Hello, World!". |
| **[pi-laya-obsidian](./extensions/pi-laya-obsidian)** | `/laya-status`, `/laya-triage`, `obsidian_laya_triage`, `obsidian_precommit_check` | Integrates with Laya daemon for Obsidian vault active session triage, protocol compliance audit, and CQRS state write barrier. |

---

## Directory Structure

```text
.
├── README.md
├── .gitignore
└── extensions/
    ├── pi-agy-acp/
    ├── pi-agy-compat/
    ├── pi-hello-world/
    └── pi-laya-obsidian/
```

---

## Extensions Detail

### PI-Agy-ACP
Provides interactive or direct delegation to Google Antigravity via Agent Client Protocol (ACP). Supports selecting profile, model (`gemini-3.8-flash`, `gemini-3.1-pro`), reasoning effort (`high`, `medium`, `low`), and execution mode (`auto_edit`, `default`, `yolo`).

### PI-Agy-Compat
Consolidates legacy Antigravity compatibility slash commands:
- `/clear`: Alias for `/new` to start a fresh session (e.g., `/clear`).
- `/effort`: Alias for `/thinking` to set or adjust the model's reasoning effort level (e.g., `/effort high` or `/effort` for interactive selection).
- `/exit`: Alias for `/quit` to exit Pi (e.g., `/exit`).
- `/rename`: Alias for `/name` to rename the current session (e.g., `/rename My-Session` or `/rename` without arguments to open an interactive prompt).

### PI-Hello-World
A simple slash command extension demonstration that prints "Hello, World!".

### PI-Laya-Obsidian
Obsidian & Laya Daemon integration for session note triaging, pre-commit compliance checks, and state note line limit enforcement. Includes commands `/laya-status` and `/laya-triage`, as well as tools `obsidian_laya_triage` and `obsidian_precommit_check`.
