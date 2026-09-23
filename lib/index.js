/**
 * dsh-all-notify — host half.
 *
 * Raises one native Windows toast per observed host event. Two properties are
 * load-bearing and must not be relaxed:
 *
 *   1. Every listener body is contained. Raising a toast must never break the
 *      event it observes — the approval waterfall in particular, where a
 *      non-`next()` return would swallow the user's decision, and a throw
 *      would fail the requesting call.
 *   2. A missing service must degrade, never block. `inject` is empty so the
 *      fiber can never sit PENDING, and both optional reads (the web server
 *      route and the session-title projection) go through `ctx.get` /
 *      `ctx.inject`, so a host without them still notifies.
 *
 * The toast is raised by spawning PowerShell against the WinRT
 * `ToastNotificationManager`. That keeps the plugin dependency-free: nothing
 * to resolve, nothing to download, no platform-specific binary fallback.
 */
import { spawn } from 'node:child_process'

/** Loader entry name; also the client bundle id. */
export const name = 'dsh-all-notify'
/** No required services: an unsatisfied inject leaves the fiber PENDING with no error. */
export const inject = []

/** Path the browser half reports the currently-open session to. */
const ROUTE = '/dsh-all-notify/state'
/** A viewer report older than this is treated as absent, so a closed page cannot silence a session. */
const VIEWER_TTL_MS = 30_000
/** Bound on the report body the route will buffer. */
const MAX_BODY_BYTES = 4096
/** Cap on remembered per-session error turns; a runaway set is dropped rather than grown. */
const MAX_ERROR_TURNS = 256

const DEFAULTS = {
  enabled: true,
  onApproval: true,
  onQuestion: true,
  onCompleted: true,
  onError: true,
  onAborted: true,
  onBlocked: true,
  onMaxTokens: true,
  appName: 'DeepSeek Harness',
  /** Log every viewer transition and toast decision; for diagnosing suppression. */
  debug: false,
}

let viewer = { sessionId: null, hidden: false, at: 0 }

/**
 * The page's freshest viewer report, or null when nothing arrived recently.
 * @returns the displayed session and whether the page is behind another window.
 */
function viewerState() {
  return Date.now() - viewer.at < VIEWER_TTL_MS
    ? { sessionId: viewer.sessionId, hidden: viewer.hidden }
    : null
}

/**
 * Whether one event belongs to the session the page is actively showing.
 *
 * Suppression needs both conditions: the event's session is the displayed one
 * AND the page is in the foreground. A backgrounded page still displaying the
 * session must notify — that is exactly the moment the user has looked away.
 * @param sessionId - session that produced the event, or null when unknown.
 * @returns true when the event must not raise a toast.
 */
function suppressed(sessionId) {
  const state = viewerState()
  if (state === null || state.hidden) return false
  return state.sessionId !== null && sessionId !== null && state.sessionId === sessionId
}

/**
 * Read an event's session id without trusting either shape.
 * @param agent - the event's agent, when it carries one.
 * @returns the session id, or null.
 */
function sessionIdOf(agent) {
  try {
    return agent?.session?.id ?? agent?.id ?? null
  } catch {
    return null
  }
}

/** Whether the configured outcome switches admit one turn-end reason. */
function reasonEnabled(settings, kind) {
  switch (kind) {
    case 'completed': return settings.onCompleted
    case 'aborted': return settings.onAborted
    case 'blocked': return settings.onBlocked
    case 'max-tokens': return settings.onMaxTokens
    case 'error': return settings.onError
    default: return true
  }
}

/** Escape one value for a PowerShell single-quoted string literal. */
function psQuote(value) {
  return String(value).replace(/'/g, "''")
}

/**
 * Raise one native toast.
 *
 * Two deliberate choices, both measured on Windows 11 rather than assumed:
 *
 *   - The legacy `ToastText02` template, NOT the modern `ToastGeneric`. A
 *     `ToastGeneric` toast is created and lands in the notification history but
 *     never renders a banner from this unregistered AUMID: `Show()` returns
 *     without error and nothing appears. `ToastText02` displays. Both templates
 *     are drawn by the shell with the system's light or dark theme and there is
 *     no per-toast theme attribute, so nothing is lost by using the legacy one.
 *   - The script travels as `-EncodedCommand` (UTF-16LE base64) because Windows
 *     PowerShell 5.1 reads a `-Command` argument as ANSI and would mangle
 *     non-ASCII body text.
 * @param title - toast heading.
 * @param body - toast body; an empty body leaves the second line blank.
 * @param appName - registering application name shown by Windows.
 */
function toast(title, body, appName) {
  if (process.platform !== 'win32') return
  const script = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
    "$texts = $t.GetElementsByTagName('text')",
    `$texts.Item(0).AppendChild($t.CreateTextNode('${psQuote(title)}')) | Out-Null`,
    `$texts.Item(1).AppendChild($t.CreateTextNode('${psQuote(body)}')) | Out-Null`,
    '$toast = [Windows.UI.Notifications.ToastNotification]::new($t)',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${psQuote(appName)}').Show($toast)`,
  ].join('\n')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  try {
    // Not `detached` and not `unref`'d. On Windows a detached child gets its
    // own console, and a PowerShell started that way raises no toast at all —
    // `Show()` succeeds and nothing appears. Measured on Windows 11 with
    // PowerShell 5.1: detached = no toast, ordinary async spawn = toast.
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('error', () => { /* a missing powershell must not surface anywhere */ })
  } catch {
    // Spawning is best effort; the caller is already inside a contained listener.
  }
}

/**
 * Compose a toast body from the non-empty parts of one event.
 * @param parts - candidate fragments.
 * @returns the joined body, or '' when every part is empty.
 */
function bodyOf(parts) {
  return parts.filter(part => typeof part === 'string' && part.trim() !== '').join(' · ')
}

/** Human-facing label for one turn-end reason kind. */
function reasonLabel(kind) {
  switch (kind) {
    case 'completed': return '完成'
    case 'error': return '出错'
    case 'aborted': return '已中止'
    case 'blocked': return '被阻塞'
    case 'max-tokens': return '达到输出上限'
    default: return String(kind ?? '结束')
  }
}

/**
 * Install the notifier.
 * @param ctx - Host context.
 * @param config - optional Loader config; every key falls back to {@link DEFAULTS}.
 */
export function apply(ctx, config) {
  const settings = { ...DEFAULTS, ...(config !== null && typeof config === 'object' ? config : {}) }
  /** Turn number that last reported an `agent/error`, per session. */
  const erroredTurns = new Map()

  const log = message => {
    if (!settings.debug) return
    try { ctx.logger?.info?.(`[dsh-all-notify] ${message}`) } catch { /* logging is never load-bearing */ }
  }
  const notify = (title, body) => {
    log(`toast: ${title} | ${body}`)
    if (!settings.enabled) return
    toast(title, body, settings.appName)
  }

  /**
   * Read one session's durable title through the projection seam.
   *
   * Read on demand rather than remembered from `session/title` events: a title
   * recorded before this plugin loaded must still name the session.
   * @param session - session whose title is read, when the event carries one.
   * @returns the title, or null when unavailable.
   */
  const titleOf = session => {
    try {
      const value = ctx.get('sessionProjections')?.snapshot?.(session)?.values?.title
      return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
    } catch {
      return null
    }
  }

  /**
   * Name the session in a toast body.
   * @param session - session the event belongs to, when the event carries one.
   * @returns a bracketed title, or null when no title is available yet.
   */
  const labelOf = session => {
    const title = titleOf(session)
    return title === null ? null : `「${title}」`
  }

  // The viewer route is optional: a host without a web server still notifies,
  // it just cannot suppress the session the page is showing.
  ctx.inject(['webServer'], webCtx => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: (req, res) => {
        let raw = ''
        req.on('data', chunk => {
          raw += chunk
          if (raw.length > MAX_BODY_BYTES) req.destroy()
        })
        req.on('end', () => {
          try {
            const parsed = JSON.parse(raw)
            const previous = `${viewer.sessionId ?? ''}|${viewer.hidden}`
            viewer = {
              sessionId: typeof parsed?.sessionId === 'string' && parsed.sessionId !== '' ? parsed.sessionId : null,
              hidden: parsed?.hidden === true,
              at: Date.now(),
            }
            // Log only transitions: the heartbeat repeats the same value.
            if (`${viewer.sessionId ?? ''}|${viewer.hidden}` !== previous) {
              log(`viewer report: session=${viewer.sessionId ?? 'null'} hidden=${viewer.hidden}`)
            }
          } catch {
            // A malformed report leaves the previous viewer state in place.
          }
          res.writeHead(204)
          res.end()
        })
      },
    }), 'dsh-all-notify: viewer route')
  })

  // Approval — the sandbox-escalation prompt also arrives here. Delegation is
  // mandatory: returning a value would claim the decision and the GUI would
  // never render the approval card.
  ctx.on('approval/request', (req, next) => {
    try {
      const session = req?.agent?.session
      const sessionId = sessionIdOf(req?.agent)
      if (settings.onApproval && !suppressed(sessionId)) {
        notify('需要你的批准', bodyOf([labelOf(session), req?.toolName, req?.reason]))
      } else if (settings.debug) {
        const state = viewerState()
        const shown = state === null
          ? 'none/stale'
          : `${state.sessionId ?? 'null'}${state.hidden ? ' hidden' : ' visible'}`
        log(`approval suppressed: session=${sessionId} viewer=${shown}`)
      }
    } catch {
      // Never let the notifier affect the approval outcome.
    }
    return next()
  })

  // Question. `agent` is optional on this payload: without it the event cannot
  // be attributed to a session, so it is never suppressed.
  ctx.on('user-questions/request', (req, next) => {
    try {
      const session = req?.agent?.session
      if (settings.onQuestion && !suppressed(sessionIdOf(req?.agent))) {
        const first = Array.isArray(req?.questions) ? req.questions[0] : undefined
        notify('需要你的回答', bodyOf([labelOf(session), first?.question, first?.header]))
      }
    } catch {
      // Never let the notifier affect the question outcome.
    }
    return next()
  })

  // Completion, with the reason the turn ended.
  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type !== 'turn/end') return
      const kind = event?.data?.reason?.kind
      // Crash-orphan and fork-seed markers are not live outcomes.
      if (kind === 'interrupted' || kind === 'forked') return
      const sessionId = session?.id ?? null

      // A turn failure is reported once. `agent/error` fires first for the same
      // turn, so the closing event must not raise a second toast for it.
      const errored = erroredTurns.get(sessionId)
      if (errored !== undefined) {
        erroredTurns.delete(sessionId)
        if (kind === 'error' && errored === event?.data?.turn) {
          log(`turn/end error already reported by agent/error: session=${sessionId} turn=${errored}`)
          return
        }
      }

      if (!reasonEnabled(settings, kind)) return
      if (suppressed(sessionId)) return
      notify('任务' + reasonLabel(kind), bodyOf([labelOf(session)]))
    } catch {
      // Observation only.
    }
  })

  // Failure. Also the earlier of the two reports for a failed turn.
  ctx.on('agent/error', payload => {
    try {
      if (!settings.onError) return
      const sessionId = sessionIdOf(payload?.agent)
      if (typeof payload?.turn === 'number' && sessionId !== null) {
        if (erroredTurns.size >= MAX_ERROR_TURNS) erroredTurns.clear()
        erroredTurns.set(sessionId, payload.turn)
      }
      if (suppressed(sessionId)) return
      const error = payload?.error
      notify('出错', bodyOf([labelOf(payload?.agent?.session), error?.code, error?.message ?? error?.detail]))
    } catch {
      // Observation only.
    }
  })
}
