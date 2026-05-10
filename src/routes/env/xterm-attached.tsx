import { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { envTrpc } from '../../env-trpc'
import { envWsUrl } from '../../lib/env-client'
import { THEME_COLOR_CHANGE_EVENT } from '../../lib/ui-prefs'
import { useEnv } from './env-context'

function readTerminalTheme() {
  const rootStyle = getComputedStyle(document.documentElement)
  const hue = rootStyle.getPropertyValue('--app-color-hue').trim() || '222.86'
  const saturation = rootStyle.getPropertyValue('--app-color-saturation').trim() || '20%'
  return {
    background: `hsl(${hue} ${saturation} 10.78%)`,
    foreground: `hsl(${hue} ${saturation} 90.2%)`,
    cursor: `hsl(${hue} ${saturation} 98.04%)`,
  }
}

/**
 * Attaches an xterm instance to an existing shell session via
 * `<env>/ws/shell/:id?token=<envToken>`. Works for any shell kind;
 * ownership is resolved server-side.
 */
export function XTermAttached({ shellId }: { shellId: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const { env, envToken } = useEnv()
  const resize = envTrpc.shell.resize.useMutation()
  const wsUrl = useMemo(
    () => envWsUrl(env, `/ws/shell/${encodeURIComponent(shellId)}`) +
      `?token=${encodeURIComponent(envToken)}`,
    [env.id, env.url, envToken, shellId],
  )
  const wsEndpoint = useMemo(() => wsUrl.split('?')[0], [wsUrl])
  const [connectionState, setConnectionState] = useState<'connecting' | 'connected' | 'reconnecting' | 'disconnected'>('connecting')

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const term = new XTerm({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: 13,
      theme: readTerminalTheme(),
      convertEol: false,
      scrollback: 10_000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    const onThemeColorChange = () => {
      term.options.theme = readTerminalTheme()
    }
    window.addEventListener(THEME_COLOR_CHANGE_EVENT, onThemeColorChange)
    requestAnimationFrame(() => {
      try {
        fit.fit()
      } catch {
        // ignore — observer will retry on next layout
      }
    })

    let mounted = true
    let ws: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let reconnectAttempt = 0
    let reconnecting = false

    const connect = () => {
      const socket = new WebSocket(wsUrl)
      ws = socket
      socket.binaryType = 'arraybuffer'
      let openedSnapshot = false
      setConnectionState(reconnecting ? 'reconnecting' : 'connecting')
      console.info('[shell-ws] connecting', { shellId, wsEndpoint })

      socket.onopen = () => {
        reconnectAttempt = 0
        setConnectionState('connected')
        console.info('[shell-ws] open', { shellId, wsEndpoint })
      }
      socket.onmessage = (evt) => {
        if (!mounted || ws !== socket) return
        let str: string
        if (evt.data instanceof ArrayBuffer) {
          str = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(evt.data))
        } else if (typeof evt.data === 'string') {
          str = evt.data
        } else {
          return
        }
        if (!openedSnapshot) {
          openedSnapshot = true
          if (reconnecting) {
            reconnecting = false
            term.clear()
          }
        }
        term.write(str)
      }
      socket.onclose = (evt) => {
        if (!mounted || ws !== socket) return
        ws = null
        if (evt.code === 4401 || evt.code === 4404) {
          setConnectionState('disconnected')
          console.info('[shell-ws] closed permanently', { shellId, wsEndpoint, code: evt.code, reason: evt.reason })
          return
        }
        const delay = Math.min(1_000 * 2 ** reconnectAttempt++, 10_000)
        setConnectionState('reconnecting')
        console.info('[shell-ws] closed, retrying', { shellId, wsEndpoint, code: evt.code, reason: evt.reason, delay })
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null
          if (!mounted) return
          reconnecting = true
          connect()
        }, delay)
      }
      socket.onerror = () => {
        if (!mounted || ws !== socket) return
        console.info('[shell-ws] error', { shellId, wsEndpoint })
        socket.close()
      }
    }

    connect()

    const send = (data: string) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(data)
      }
    }

    const dataSub = term.onData((data) => send(data))
    const resizeObserver = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        // ignore
      }
      const cols = term.cols
      const rows = term.rows
      resize.mutate({ id: shellId, cols, rows })
    })
    resizeObserver.observe(el)

    return () => {
      mounted = false
      if (reconnectTimer) clearTimeout(reconnectTimer)
      window.removeEventListener(THEME_COLOR_CHANGE_EVENT, onThemeColorChange)
      dataSub.dispose()
      resizeObserver.disconnect()
      try {
        ws?.close()
      } catch {
        // ignore
      }
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shellId, wsUrl, wsEndpoint])

  return (
    <div className="relative h-full w-full overflow-hidden bg-neutral-975">
      <div ref={containerRef} className="h-full w-full" />
      {connectionState !== 'connected' && (
        <div className="pointer-events-none absolute right-3 top-3 rounded border border-neutral-800 bg-neutral-950/90 px-2 py-1 text-[10px] uppercase tracking-wide text-neutral-400 shadow">
          {connectionState}
        </div>
      )}
    </div>
  )
}
