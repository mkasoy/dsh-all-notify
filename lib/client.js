/**
 * dsh-all-notify — browser half.
 *
 * This half is advisory. Its only job is to tell the host which session the
 * page is currently showing, so the host can suppress that session's toasts.
 *
 * It is written to be impossible to break the boot:
 *
 *   - `inject` is empty, so the fiber activates immediately. A missing service
 *     in `inject` leaves a fiber PENDING forever with no error, which fails the
 *     client boot audit.
 *   - `apply` contains its whole body, so nothing here can reject the entry.
 *   - Every read is reached through `ctx.get` and guarded, so an unavailable
 *     service degrades instead of throwing.
 *
 * If this half never runs, the host stops receiving viewer reports and falls
 * back to notifying every event. The failure direction is more toasts, never
 * silence.
 */
window.__ModuleLoader__.load({
  id: 'dsh-all-notify',
  factory: () => {
    const module = { exports: {} }
    const exports = module.exports

    const ROUTE = '/dsh-all-notify/state'
    /** Well under the host's 30s viewer TTL, so a live page never goes stale. */
    const HEARTBEAT_MS = 10000

    /**
     * Resolve the session the page is currently showing.
     *
     * The main conversation retains its session with `mainView`; the reference
     * counters live on the client sessions service and move to the newly
     * displayed session on every switch.
     * @param ctx - client root context.
     * @returns the session id, or null when unknown.
     */
    function currentSessionId(ctx) {
      const sessions = ctx.get('sessions')
      const list = sessions?.list?.getSnapshot?.()
      if (!list || !Array.isArray(list.ids)) return null
      for (const id of list.ids) {
        const info = sessions.retainInfo?.(id)?.getSnapshot?.()
        if ((info?.retainedBy?.mainView ?? 0) > 0) return String(id)
      }
      return null
    }

    /**
     * Publish one viewer report; failures are ignored by design.
     * @param ctx - client root context.
     */
    function report(ctx) {
      try {
        const body = JSON.stringify({
          sessionId: currentSessionId(ctx),
          hidden: typeof document !== 'undefined' ? document.hidden : false,
          at: Date.now(),
        })
        fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          keepalive: true,
        }).catch(() => { /* the host may not expose the route; nothing to do */ })
      } catch {
        // Reporting is advisory.
      }
    }

    /**
     * Start reporting. Any failure disables reporting only.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      try {
        console.info('[dsh-all-notify] viewer reporter active; current session =', currentSessionId(ctx))
        report(ctx)
        const sessions = ctx.get('sessions')
        if (typeof sessions?.list?.subscribe === 'function') sessions.list.subscribe(() => report(ctx))
        if (typeof document !== 'undefined') {
          document.addEventListener('visibilitychange', () => report(ctx))
        }
        const beat = setInterval(() => report(ctx), HEARTBEAT_MS)
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => () => clearInterval(beat), 'dsh-all-notify: viewer heartbeat')
        }
      } catch (error) {
        console.warn('[dsh-all-notify] viewer reporter disabled; the host will notify every event', error)
      }
    }

    exports.name = 'dsh-all-notify'
    exports.inject = []
    exports.apply = apply
    return module.exports
  },
})
