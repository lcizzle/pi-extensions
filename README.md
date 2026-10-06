# PI Agent Extensions

# List

### PI-Hello-World
PI slash command that prints "Hello, World!"

### PI-Exit
PI slash command that is an alias to /quit, musccle memory 1 - /quit 0

### PI-Effort
PI slash command `/effort` that aliases `/thinking` to set the model's thinking level.

### PI-Clear
PI slash command `/clear` that aliases `/new` to start a fresh session.

### PI-Rename
PI slash command `/rename` that aliases `/name` to rename the current session. Pass a name directly (`/rename Session-Name`) or run `/rename` without arguments to open a name prompt.

### PI-Agy-ACP
PI slash command `/acp` and `/agy-acp`, plus `agy_acp_task` tool, providing interactive or direct delegation to Google Antigravity via Agent Client Protocol (ACP). Supports profile selection, model selection (`gemini-3.8-flash`, `gemini-3.1-pro`), reasoning effort (`high`, `medium`, `low`), and execution modes (`auto_edit`, `default`, `yolo`).

