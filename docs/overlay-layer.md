# Overlay Layer

Desktop modals must render in the detached Electron overlay layer so they appear above browser tabs. Do not mount blocking modal UI directly in workspace or app routes.

## Flow

1. App code calls an `openXOverlay(...)` function from `src/lib/overlay-layer-controller.tsx`.
2. The controller creates a typed `OverlayRequest` and sends it over `BroadcastChannel` to `/internal/overlay-layer`.
3. Electron attaches and focuses the detached overlay web contents above the app.
4. `src/routes/internal/overlay-layer.tsx` renders the requested modal and posts a typed `OverlayResponse` back.
5. The controller detaches the overlay and resolves the caller's promise.

The browser-only fallback renders the same `OverlayLayerApp` into a temporary DOM root, but new modal code should still follow the same request/response path.

## Data Access

App/identity data uses `trpc` and is available from the root app provider because `/internal/overlay-layer` is a normal route in the React app.

Env data uses `envTrpc`. Env-backed overlay requests must include `env` and `envToken`; `EnvOverlayRequestRenderer` creates a request-scoped env client, provider, and `EnvContextProvider` for the overlay UI.

## Adding A Modal

1. Add a typed request and response to `OverlayRequest` and `OverlayResponse` in `src/routes/internal/overlay-layer.tsx`.
2. Add an `openXOverlay(...)` function to `src/lib/overlay-layer-controller.tsx`.
3. Render the modal in `OverlayRequestRenderer` or `EnvOverlayRequestRenderer`.
4. Keep the modal component in the overlay layer path, or make route-facing components launchers that call the controller and return `null`.

Avoid adding new `<Modal>`, `role="dialog"`, command palette, picker, or confirmation UI directly inside app routes.
