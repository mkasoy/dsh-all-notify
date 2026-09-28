# dsh-all-notify

Native Windows toast notifications for DeepSeek Harness: approval, question,
turn-end, and error events raise a real OS notification, and the session
currently open in the page stays silent.

No runtime dependencies. No build step.

[中文](README.md) | English

## Features

- **Real OS notifications, not the browser `Notification` API.** The host process
  drives PowerShell and the WinRT `ToastNotificationManager`, so toasts appear
  even with the page closed.
- **Named sessions.** Every toast carries the session's title, read on demand
  from the durable `title` projection.
- **Interrupts only when it should.** An event is silent when it belongs to the
  session on screen *and* the page is in the foreground. Switch to another
  application and that same session's events notify again.
- **Zero runtime dependencies.** No `node-notifier`, no downloaded binary,
  nothing that can fail to resolve.
- Per-outcome switches for every way a turn can end.

## Install

```powershell
# npm
dsh plugin --profile web add @mkasoy/dsh-all-notify

# or from GitHub
dsh plugin --profile web add github:mkasoy/dsh-all-notify
```

A host-half change needs a `dsh web` restart; a browser-half change only needs a
page refresh.

## What it notifies

| Event | Toast |
|---|---|
| `approval/request` | `需要你的批准` — tool name and reason. **Sandbox-escalation prompts arrive here too.** |
| `user-questions/request` | `需要你的回答` — the first question |
| `session/event` + `turn/end` | `任务完成` / `任务出错` / `任务已中止` / `任务被阻塞` / `任务达到输出上限` |
| `agent/error` | `出错` — failure code and message |

The second line reads `「session title」 · event detail`.

**A failed turn raises one toast, not two.** `agent/error` reports first; the
closing `turn/end(error)` for that same turn is recognised as already reported.

## Silencing rule

An event is silenced only when both hold:

1. the event's session is the one the page displays, **and**
2. the page is in the foreground.

Switch to another application while that session is on screen and its events
notify again — that is exactly when the reminder matters. Every other case
notifies. The browser half reports the current session and its visibility every
10 s, plus on session switch and on `visibilitychange`; a report older than 30 s
is treated as absent and notifications resume.

## Configuration

All keys are optional. Set them in the plugin's own `cordis.patch.yml`, or
override the same row id in `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: all-notify
  config:
    enabled: true          # master switch
    onApproval: true       # approval requests
    onQuestion: true       # user questions
    onCompleted: true      # turn ended normally
    onError: true          # turn or step failed
    onAborted: true        # turn cancelled
    onBlocked: true        # turn blocked
    onMaxTokens: true      # turn hit its output ceiling
    appName: DeepSeek Harness   # application name Windows shows
    debug: false           # log every decision to the dsh web terminal
```

## How it works

```
┌──────────── browser (lib/client.js) ───────────┐
│  inject: []           ← can never sit PENDING  │
│  apply fully contained ← can never fail boot   │
│                                                │
│  current session id + document.hidden          │
│         │ POST /dsh-all-notify/state           │
└─────────┼──────────────────────────────────────┘
          ▼
┌──────────── host (lib/index.js) ───────────────┐
│  inject: []                                    │
│  viewer = { sessionId, hidden, at }            │
│                                                │
│  approval/request ─┐                           │
│  user-questions/request ─┤                     │
│  session/event(turn/end) ─┼→ silenced? → spawn │
│  agent/error ─┘                powershell      │
│                                   → WinRT toast│
└────────────────────────────────────────────────┘
```

The host half only observes events; the browser half only reports viewing state.
They talk over one custom HTTP route rather than a Remote namespace — that would
be disproportionate here, and Typert is a pre-stable protocol.

**The browser half is advisory, not required.** If it never runs the host
receives no reports and therefore notifies *every* event. The failure direction
is more toasts, never silence.

## Design constraints

Each one answers a failure measured in third-party notification plugins on DSH
0.1.7-alpha.1:

- **The host `inject` is empty.** A service listed in `inject` that nothing
  provides leaves the fiber PENDING forever, with no error.
- **Every listener is contained in `try`/`catch`.** An escaping throw fails the
  entry and the client boot audit reports `web boot: 1 entry did not activate`.
- **Both waterfall listeners `return next()`.** Anything else claims the
  decision and the approval card never renders.
- **No `ctx.settings.register`.** DSH 0.1.7 replaced the plugin-registered
  settings namespace with Loader-derived configuration forms; the call no longer
  exists.
- **The browser half has an empty `inject` and a contained `apply`.** When it can
  read nothing it degrades to "no silencing" instead of breaking startup.
- **No runtime dependencies.**

## Measured on Windows: two counter-intuitive constraints

Both were isolated by A/B testing, **not assumed**. They are documented because
each is the kind of code a reviewer would otherwise "simplify" away.

### 1. A detached child raises no toast

| variant | result |
|---|---|
| `detached: true` + `unref()` + `-EncodedCommand` | ❌ nothing appears |
| foreground `-EncodedCommand` | ✅ |
| script file via `-File` | ✅ |
| inline ASCII `-Command` | ✅ |

On Windows a detached child gets its own console, and a PowerShell started that
way returns from `Show()` without error and even lands in the notification
history, but never draws anything. Encoding is not the problem: the same
`-EncodedCommand` payload works once the process is not detached.

### 2. `ToastGeneric` does not display; `ToastText02` does

| template | result |
|---|---|
| `ToastText02` (legacy) | ✅ appears |
| `ToastGeneric` (modern) | ❌ nothing appears |

Same signature: created, present in the notification history, never drawn. Both
templates are rendered by the shell with the current light or dark theme, and
`ToastNotification` has no per-toast theme attribute, so the legacy template
costs nothing.

## Compatibility

Developed and measured against **DSH 0.1.7-alpha.1** (`dsh web` profile,
Windows 11 with Windows PowerShell 5.1).

The host half depends only on interfaces verified present in 0.1.7-alpha.1:

| interface | package |
|---|---|
| `approval/request` waterfall | `packages/interaction/user-approval` |
| `user-questions/request` waterfall | `packages/interaction/user-questions` |
| `session/event` + `turn/end` | `packages/core/session` |
| `agent/error` | `packages/core/agent-loop` |
| the `title` projection | `@deepseek-ai/dsh-session-title` |
| `webServer.register` | `@deepseek-ai/dsh-host-webserver` |
| `sessions.list` / `sessions.retainInfo` (browser) | `@deepseek-ai/dsh-api-session-controller` |

The browser half identifies the displayed session through the reference counter
`sessions.retainInfo(id).retainedBy.mainView > 0`, which is how 0.1.7-alpha.1
marks the session shown in the main conversation.

## Known limitations

- **Windows only.** On other platforms the host half loads and does nothing.
- **Roughly one second of latency.** Each toast starts a PowerShell process
  (0.5–1 s). `node-notifier` (bundling SnoreToast) would cut that to tens of
  milliseconds at the cost of a dependency tree, which this plugin deliberately
  avoids.
- **Multiple tabs fight.** Each tab reports on its own heartbeat, so the
  last report wins the "current session" slot. Single-tab use is unaffected.
- **Reports are trusted as-is.** The route is reachable only on the server's own
  origin.
- Configuration lives in `cordis.patch.yml`; there is no settings page. Adding
  one would reintroduce exactly the browser-side dependency surface this plugin
  exists to avoid.

## Development

No build step: the sources are the artifacts.

```powershell
node --check lib\index.js
node --check lib\client.js
```

The host half can be driven offline: build a fake `ctx` (`inject` / `effect` /
`on` / `get` / `logger`), call `apply(ctx, { debug: true, enabled: false })`,
then invoke the captured listeners. `enabled: false` keeps `notify` at the log
stage so decisions can be asserted without raising real notifications.

## License

MIT
