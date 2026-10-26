/*
 * How the record and its Stash host talk (embed.ts says what they say). There are two hosts:
 *
 * - The Stash player on the web frames embed.html (?embed=stash). Messages are objects posted between the frame and its parent,
 *   same origin only, exactly as before the app existed.
 * - The Stash app on Android opens embed.html full screen in a WebView (?embed=stash-app). The app puts a `StashHost` object on
 *   the window before any of the page's scripts run (androidx.webkit addWebMessageListener). Messages are JSON strings both ways:
 *   out through `StashHost.postMessage`, in through its `onmessage`. A string that isn't JSON, isn't a message or isn't one the
 *   app may send is dropped.
 *
 * The functions take the window (or the bridge) they work on, so the tests can hand them their own.
 */

/** A message as both hosts carry it: an object with its type. embed.ts types each one. */
export interface Envelope {
  type: string
}

/** What the transport needs of a window: the real one, or a test's. */
export interface HostWindow {
  readonly parent: { postMessage(message: unknown, targetOrigin: string): void }
  readonly location: { readonly search: string; readonly origin: string }
  addEventListener(type: 'message', listener: (e: MessageEvent) => void): void
  removeEventListener(type: 'message', listener: (e: MessageEvent) => void): void
  /** The Stash app's bridge, when the app put one there */
  readonly StashHost?: unknown
}

/** The Stash app's bridge. `onmessage` is a single slot: one handler gets every message the app sends. */
export interface StashHost {
  postMessage(message: string): void
  onmessage: ((event: { data: unknown }) => void) | null
}

export interface Transport {
  send(msg: Envelope): void
  /** Calls `handler` with each message the host sends; returns the unsubscribe. */
  listen(handler: (msg: Envelope) => void): () => void
}

const embedParam = (win: HostWindow) => new URLSearchParams(win.location.search).get('embed')

/**
 * The Stash app's bridge, when the page runs inside the app: the address says so (?embed=stash-app) and the bridge is there.
 * Either alone is not enough: the address opened in a browser has no bridge, and a bridge on any other page isn't ours to use.
 */
export function appHostOf(win: HostWindow): StashHost | null {
  if (embedParam(win) !== 'stash-app') return null
  const host = win.StashHost as Partial<StashHost> | null | undefined
  return host && typeof host.postMessage === 'function' ? (host as StashHost) : null
}

/** True inside the Stash player's frame on the web (?embed=stash). */
export function inPlayerFrame(win: HostWindow): boolean {
  return (win.parent as unknown) !== win && embedParam(win) === 'stash'
}

/** The player's frame: objects posted to and from the parent window, this origin only. */
export function frameTransport(win: HostWindow): Transport {
  return {
    send: (msg) => win.parent.postMessage(msg, win.location.origin),
    listen(handler) {
      const listen = (e: MessageEvent) => {
        if (e.source !== win.parent || e.origin !== win.location.origin) return
        const m = e.data as Envelope | null
        if (m && typeof m === 'object' && typeof m.type === 'string' && m.type.startsWith('stash:')) handler(m)
      }
      win.addEventListener('message', listen)
      return () => win.removeEventListener('message', listen)
    },
  }
}

/** A message from the app, or null when the string isn't one of the types it may send (`accepts`). */
export function readAppMessage(data: unknown, accepts: ReadonlySet<string>): Envelope | null {
  // The bridge can also carry binary (ArrayBuffer): the app never sends any, so it isn't a message
  if (typeof data !== 'string') return null
  let m: unknown
  try {
    m = JSON.parse(data)
  } catch {
    return null
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null
  const type = (m as { type?: unknown }).type
  return typeof type === 'string' && accepts.has(type) ? (m as Envelope) : null
}

/**
 * The Stash app: JSON strings through its bridge. The bridge has one `onmessage`, so it is taken here, once, and shared out to
 * every listener; a listener that throws is reported and the rest still hear the message, as with the window's own listeners.
 */
export function appTransport(host: StashHost, accepts: ReadonlySet<string>): Transport {
  const handlers = new Set<(msg: Envelope) => void>()
  host.onmessage = (event) => {
    const m = readAppMessage(event?.data, accepts)
    if (!m) return
    // A copy: a listener may stop listening (or start another) while the message goes round
    for (const handler of [...handlers]) {
      try {
        handler(m)
      } catch (err) {
        report(err)
      }
    }
  }
  return {
    send: (msg) => host.postMessage(JSON.stringify(msg)),
    listen(handler) {
      // Each subscription its own entry, as each is its own window listener in the frame: the same handler subscribed twice
      // hears a message twice, and stops one subscription at a time
      const entry = (m: Envelope) => handler(m)
      handlers.add(entry)
      return () => handlers.delete(entry)
    },
  }
}

/** The browser's own report of an error a listener threw, where it has one; the console otherwise. */
function report(err: unknown): void {
  if (typeof reportError === 'function') reportError(err)
  else console.error(err)
}
