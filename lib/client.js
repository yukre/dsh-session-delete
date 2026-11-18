window.__ModuleLoader__.load({
  id: 'dsh-session-delete',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement

    /** Route the Host half serves. */
    const DELETE_ROUTE = '/session-delete/delete'

    /**
     * Ask the Host to delete one session.
     * @param sessionId - the session to purge.
     * @returns the Host's success payload.
     * @throws when the Host refuses or fails.
     */
    async function deleteSessionOnHost(sessionId) {
      const response = await fetch(DELETE_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (payload !== null && payload.ok === true) return payload
      const message = payload !== null && typeof payload.message === 'string'
        ? payload.message
        : '删除失败（HTTP ' + response.status + '）'
      const error = new Error(message)
      error.code = payload !== null && typeof payload.code === 'string' ? payload.code : 'DELETE_FAILED'
      throw error
    }

    /* ------------------------------------------------------------------ *
     * The pending-confirmation store. The overlay lives in the frame-wide
     * layer (so it outlives the menu that raised it), which means the menu row
     * cannot pass props to it: they meet through this tiny external store.
     * ------------------------------------------------------------------ */

    let pending = null
    const listeners = new Set()

    /** Publish the next pending request (or null to clear it). */
    function setPending(next) {
      pending = next
      for (const listener of listeners) listener()
    }

    /** Raise the confirmation for one session. */
    function requestDelete(request) {
      setPending(request)
    }

    /** Subscribe to pending-request changes. */
    function subscribePending(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }

    /** Read the pending request. */
    function getPending() {
      return pending
    }

    /** Read the pending request through React's sync external store. */
    function usePending() {
      return React.useSyncExternalStore(subscribePending, getPending, getPending)
    }

    /* ------------------------------------------------------------------ *
     * Styles use ONLY the alias tokens the live Theme reports, so light and
     * dark both work and a renamed token degrades rather than breaks:
     *   bg-base / bg-layer-1 / bg-overlay / border-l1 / border-l2
     *   label-primary / label-secondary / state-error-primary
     * The danger action colors its LABEL (like the host's own delete row)
     * instead of painting a solid red block.
     * ------------------------------------------------------------------ */
    const overlayStyle = {
      position: 'fixed',
      inset: '0',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'color-mix(in srgb, var(--dsw-alias-bg-base) 55%, transparent)',
      backdropFilter: 'blur(2px)',
      zIndex: 2147483000,
    }
    const cardStyle = {
      width: 'min(440px, calc(100vw - 48px))',
      padding: '20px 22px',
      borderRadius: '12px',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      border: '1px solid var(--dsw-alias-border-l1)',
      boxShadow: '0 12px 40px color-mix(in srgb, var(--dsw-alias-bg-base) 45%, transparent)',
      fontSize: '14px',
      lineHeight: '1.55',
    }
    const titleStyle = { margin: '0 0 10px', fontSize: '16px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
    const bodyStyle = { margin: '0 0 6px', color: 'var(--dsw-alias-label-primary)' }
    const hintStyle = { margin: '0', color: 'var(--dsw-alias-label-secondary)', fontSize: '13px' }
    // whiteSpace: pre-line keeps the line breaks an AMBIGUOUS_LOCATION message
    // relies on: it lists each conflicting path on its own line, and collapsing
    // them onto one line makes two different directories unreadable.
    const errorStyle = {
      marginTop: '10px',
      color: 'var(--dsw-alias-state-error-primary)',
      fontSize: '13px',
      whiteSpace: 'pre-line',
      wordBreak: 'break-all',
    }
    const actionsStyle = { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '18px' }
    const buttonBase = {
      borderRadius: '8px',
      padding: '6px 14px',
      fontSize: '13px',
      cursor: 'pointer',
      background: 'transparent',
      border: '1px solid var(--dsw-alias-border-l2)',
      color: 'var(--dsw-alias-label-primary)',
    }
    const dangerStyle = {
      ...buttonBase,
      color: 'var(--dsw-alias-state-error-primary)',
      borderColor: 'var(--dsw-alias-state-error-primary)',
    }

    /**
     * Confirmation overlay: in-flight and error state die with the request.
     */
    function DeleteSessionConfirm() {
      const request = usePending()
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      // Declared before the early return below: hooks must run in the same
      // order on every render, including the render where request is null.
      const submitting = React.useRef(false)

      // A settled/withdrawn request must not leak busy/error into the next one.
      React.useEffect(() => {
        if (request === null) {
          setBusy(false)
          setError(null)
          submitting.current = false
        }
      }, [request])

      // Escape closes the dialog, matching the host's own modals. Bound only
      // while a request is open, and ignored while the removal is in flight so
      // an accidental keypress cannot hide a failed/slow delete.
      React.useEffect(() => {
        if (request === null) return undefined
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          if (submitting.current) return
          event.stopPropagation()
          setPending(null)
        }
        document.addEventListener('keydown', onKey, true)
        return () => { document.removeEventListener('keydown', onKey, true) }
      }, [request])

      if (request === null) return null

      const close = () => {
        if (busy) return
        setPending(null)
      }
      // Guard against a double fire (Enter key + click, or a fast double
      // click): the second request would find the directory already gone and
      // surface a confusing NOT_FOUND after a successful delete.
      const confirm = () => {
        if (submitting.current) return
        submitting.current = true
        setBusy(true)
        setError(null)
        deleteSessionOnHost(request.sessionId).then(() => {
          submitting.current = false
          setBusy(false)
          setPending(null)
        }).catch((reason) => {
          submitting.current = false
          setBusy(false)
          setError(reason instanceof Error ? reason.message : String(reason))
        })
      }
      const title = request.displayTitle && request.displayTitle.length > 0
        ? request.displayTitle
        : request.sessionId

      return h('div', { style: overlayStyle, onMouseDown: (e) => { if (e.target === e.currentTarget) close() } },
        h('div', {
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '删除会话',
          style: cardStyle,
        },
        h('h2', { style: titleStyle }, '永久删除这个会话？'),
        h('p', { style: bodyStyle },
          '「', title, '」以及它的全部对话记录将从本机移除。'),
        h('p', { style: hintStyle },
          '此操作不可撤销。如果你只是想把它从侧栏隐藏起来，请改用「归档」。'),
        error !== null ? h('div', { role: 'alert', style: errorStyle }, error) : null,
        h('div', { style: actionsStyle },
          h('button', { type: 'button', style: buttonBase, disabled: busy, onClick: close }, '取消'),
          h('button', { type: 'button', style: dangerStyle, disabled: busy, onClick: confirm },
            busy ? '正在删除…' : '永久删除')),
        ),
      )
    }

    return {
      // `contextMenus` must be named here or the host never injects it: the
      // property would be undefined and `ctx.contextMenus.register(...)` would
      // throw inside apply, taking the whole plugin down with it.
      inject: ['slots'],
      apply(ctx) {
        // The dynamic Client context is RESTRICTED: it offers only
        // ctx.get / ctx.on / ctx.provide / ctx.effect (Client inspect,
        // listBuiltins). There is no declarative service injection here, so a
        // service must be read through ctx.get and checked. Reading
        // `ctx.contextMenus` is always undefined, and calling .register() on it
        // throws from apply — which the host treats as a failed plugin, making
        // the row disappear entirely.
        // `contextMenus` is provided via ctx.provide() by the context-menu
        // plugin, which does NOT list it in the Client Service catalog — so a
        // declarative `inject` entry cannot be relied on to resolve it. Read it
        // through ctx.get(), and fall back to the plain property for builds
        // that inject it directly.
        const contextMenus = typeof ctx.get === 'function'
          ? (ctx.get('contextMenus') ?? ctx.contextMenus)
          : ctx.contextMenus
        if (contextMenus === undefined || typeof contextMenus.register !== 'function') {
          // Missing service: skip the row but keep the overlay below usable.
          // Throwing here would take the whole plugin down for an optional
          // dependency instead of losing one menu entry.
          console.warn('[dsh-session-delete] contextMenus unavailable; menu row skipped')
        } else {
          // The row goes through the STRUCTURED menu API rather than the legacy
          // `sidebar.workspaces.session.menu.item` slot, whose contract renders
          // its entries together BEFORE the built-in Archive action — no order
          // value there can put a row underneath it. The structured API carries
          // the same `afterContent` flag the host's own Archive row sets, and
          // order 601 lands just past Archive's 600 in the popup footer.
          ctx.effect(() => contextMenus.register({
            id: 'session.delete',
            target: 'session',
            order: 601,
            resolve(target) {
              return [{
                id: 'delete',
                label: '删除会话…',
                icon: { key: 'workspace.delete' },
                danger: true,
                separatorBefore: true,
                afterContent: true,
                failureLabel: '删除会话失败',
                run: () => { requestDelete({ sessionId: target.sessionId, displayTitle: target.displayTitle }) },
              }]
            },
          }), 'dsh-session-delete: session menu row')
        }

        // The frame-wide layer: the confirmation must outlive the row menu.
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-session-delete-confirm',
        }, DeleteSessionConfirm))
      },
    }
  },
})
