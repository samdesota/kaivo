import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { envTrpc } from '../../env-trpc'
import { envWsUrl } from '../../lib/env-client'
import { useEnv } from './env-context'

/**
 * Attaches an xterm instance to an existing shell session via
 * `<env>/ws/shell/:id?token=<envToken>`. Works for any shell kind;
 * ownership is resolved server-side.
 */
export function XTermAttached({ shellId }: { shellId: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const { env, envToken } = useEnv()
  const resize = envTrpc.shell.resize.useMutation()

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const term = new XTerm({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: 13,
      theme: {
        background: '#111318',
        foreground: '#e6e6e6',
        cursor: '#ffffff',
      },
      convertEol: false,
      scrollback: 10_000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    requestAnimationFrame(() => {
      try {
        fit.fit()
      } catch {
        // ignore — observer will retry on next layout
      }
    })

    let mounted = true
    const pending: string[] = []
    let ws: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let reconnectAttempt = 0
    let reconnecting = false

    const connect = () => {
      const wsUrl = envWsUrl(env, `/ws/shell/${encodeURIComponent(shellId)}`) +
        `?token=${encodeURIComponent(envToken)}`
      const socket = new WebSocket(wsUrl)
      ws = socket
      socket.binaryType = 'arraybuffer'
      let openedSnapshot = false

      socket.onopen = () => {
        reconnectAttempt = 0
        for (const q of pending) socket.send(q)
        pending.length = 0
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
          term.writeln(`\r\n\x1b[31m[disconnected: ${evt.reason || 'unauthorized'}]\x1b[0m`)
          return
        }
        const delay = Math.min(1_000 * 2 ** reconnectAttempt++, 10_000)
        term.writeln(`\r\n\x1b[2m[disconnected, reconnecting in ${Math.round(delay / 1000)}s]\x1b[0m`)
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null
          if (!mounted) return
          reconnecting = true
          connect()
        }, delay)
      }
      socket.onerror = () => {
        if (!mounted || ws !== socket) return
        term.writeln('\r\n\x1b[31m[ws error]\x1b[0m')
        socket.close()
      }
    }

    connect()

    const send = (data: string) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(data)
      } else {
        pending.push(data)
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
  }, [shellId, env.id, envToken])

  return <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-neutral-975" />
}
