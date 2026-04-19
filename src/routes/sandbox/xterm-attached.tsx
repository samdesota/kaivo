import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { trpc } from '../../trpc'

/**
 * Attaches an xterm instance to an existing shell session via `/ws/shell/:id`.
 * Works for any shell kind (human, agent-persistent, agent-run-once) — the
 * shell's owner is determined server-side; this component only needs the id.
 */
export function XTermAttached({ shellId }: { shellId: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const resize = trpc.shell.resize.useMutation()

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const term = new XTerm({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: 13,
      theme: {
        background: '#000000',
        foreground: '#e6e6e6',
        cursor: '#ffffff',
      },
      convertEol: false,
      scrollback: 10_000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    try {
      fit.fit()
    } catch {
      // element not measured yet
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${window.location.host}/ws/shell/${encodeURIComponent(shellId)}`
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'

    let mounted = true
    const pending: string[] = []
    let openedSnapshot = false

    ws.onopen = () => {
      for (const q of pending) ws.send(q)
      pending.length = 0
    }
    ws.onmessage = (evt) => {
      if (!mounted) return
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
        // First chunk is the xterm-serialize snapshot; writing it replays scrollback.
      }
      term.write(str)
    }
    ws.onclose = () => {
      if (!mounted) return
      term.writeln('\r\n\x1b[2m[disconnected]\x1b[0m')
    }
    ws.onerror = () => {
      if (!mounted) return
      term.writeln('\r\n\x1b[31m[ws error]\x1b[0m')
    }

    const send = (data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
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
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }))
      }
      resize.mutate({ id: shellId, cols, rows })
    })
    resizeObserver.observe(el)

    return () => {
      mounted = false
      dataSub.dispose()
      resizeObserver.disconnect()
      try {
        ws.close()
      } catch {
        // ignore
      }
      term.dispose()
    }
    // intentionally exclude `resize` from deps — the mutation is stable per-render and we'd thrash the effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shellId])

  return <div ref={containerRef} className="h-full w-full" />
}
