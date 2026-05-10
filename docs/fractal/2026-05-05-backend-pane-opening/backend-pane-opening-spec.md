# Backend Pane Opening

## Seed

`cloud_open_pane` should open Zoottle panes through backend state instead of depending on a currently rendered frontend event handler. Opening a file, shell, preview, or browser pane must work even when no frontend is mounted at the moment the tool is called.

## Solution

- State: `workspace_tabs` and `workspace_view_states` are the canonical pane state; no new pane queue or frontend-only persistence.
- Write path: `agentUi.openPane` writes the resolved pane into backend workspace state instead of only publishing an in-memory event.
- Session mapping: `openPane` resolves the agent session to its workspace and local env identity before creating the tab.
- Tab identity: backend tab creation uses the same logical keys as the workspace UI so repeated opens focus existing tabs.
- Activation: `activate !== false` updates `activeWorkspaceTabId`; inactive opens preserve the current active tab.
- Live UI: subscriptions become refresh hints for mounted frontends, not the source of truth.
