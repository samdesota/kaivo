# OpenCode Gateway Compatibility

`/agent/*` is Kaivo's OpenCode-compatible gateway. Browser clients authenticate to the env-server with `Authorization: Bearer <envToken>`; env-server injects OpenCode Basic Auth internally. The OpenCode server password must not be exposed to frontend code.

Frontend code may use `/agent/*` directly for OpenCode-native reads that do not require Kaivo semantics, such as raw session message history, OpenCode-native file/search reads, and compatibility experiments with OpenCode SDK consumers.

Frontend code should stay on Kaivo tRPC for product-runtime behavior: OpenCode lifecycle, Kaivo session ID mapping, queued follow-ups, notifications, workspace summaries, pending approval/question aggregation, composite status, transcript overlay replay, and Kaivo-specific tool/pane/browser state.

Session calls for non-default directories must preserve both the `directory` query parameter and the `x-opencode-directory` header when OpenCode expects directory routing. A null or missing `workingDir` means the env default working directory.

Direct proxy use should go through a small adapter rather than embedding raw URLs in UI components.
