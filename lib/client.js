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
     * Menu row styling, copied from how the host renders its own dangerous
     * menu rows (dsh-client-ui-schedule): the row keeps the menu's normal
     * transparent background and only its LABEL turns red. No filled block,
     * so it sits flush with the "归档会话" row above/below it. Hover uses the
     * host's own danger hover token.
     * ------------------------------------------------------------------ */
    const MENU_ROW_CSS = `
.dsd-menu-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-state-error-primary);
  font: inherit;
  font-size: 13px;
  line-height: 18px;
  text-align: left;
  cursor: pointer;
}
.dsd-menu-row:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger);
}
.dsd-menu-row:focus-visible:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger);
  outline: none;
}
.dsd-menu-row:disabled {
  opacity: 0.5;
  cursor: default;
}
.dsd-menu-row svg {
  flex: none;
  width: 14px;
  height: 14px;
  color: inherit;
}
`

    /**
     * Trash glyph drawn to the host's own icon spec, taken from a shipped
     * Client bundle: `viewBox="0 0 14 14"`, `fill="none"`, hairline
     * `strokeWidth="0.875"`, `stroke="currentColor"`, round caps/joins. Using
     * the host's numbers (not an approximated 16px/1.5 grid) is what keeps it
     * visually identical to the neighbouring rows.
     */
    function TrashIcon() {
      return h('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 14 14',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 0.875,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      // The lid line.
      h('path', { d: 'M1.641 3.5h10.718' }),
      // The handle above the lid.
      h('path', { d: 'M5.4 3.5V2.6a0.9 0.9 0 0 1 0.9-0.9h1.4a0.9 0.9 0 0 1 0.9 0.9V3.5' }),
      // The tapered body.
      h('path', { d: 'M3 3.5l0.58 8.02a0.95 0.95 0 0 0 0.95 0.88h4.94a0.95 0.95 0 0 0 0.95-0.88L11 3.5' }),
      // Two ribs.
      h('path', { d: 'M5.75 5.9v4.4' }),
      h('path', { d: 'M8.25 5.9v4.4' }),
      )
    }

    /**
     * Menu row: "删除会话…". Asks first; deletes only on confirmation.
     * @param props - the seat's owner share (sessionId, displayTitle) and the
     *   `useMenuOpenState` hook that dismisses the menu it sits in.
     */
    function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState }) {
      const [, setMenuOpen] = useMenuOpenState()
      return h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'dsd-menu-row',
        onClick() {
          setMenuOpen(false)
          requestDelete({ sessionId, displayTitle })
        },
      }, TrashIcon(), '删除会话…')
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
    const errorStyle = { marginTop: '10px', color: 'var(--dsw-alias-state-error-primary)', fontSize: '13px' }
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
      inject: ['slots'],
      apply(ctx) {
        // The menu row carries a class, so its rule sheet lives for exactly as
        // long as this plugin does. Registered with `ctx.effect` so unloading
        // the plugin removes the <style> instead of leaving it behind.
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-plugin', 'dsh-session-delete')
          style.textContent = MENU_ROW_CSS
          document.head.appendChild(style)
          return () => { style.remove() }
        }, 'dsh-session-delete: menu row styles')

        // The Session menu seat: one row rendered before the built-in Archive
        // row, dismissed through the shared menu's open-state hook. `inject`
        // ties the registration to the owning slot declaration's lifetime, so
        // collapsing and re-mounting the sidebar reinstalls the row.
        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'dsh-session-delete',
          order: 500,
        }, DeleteSessionMenuItem))

        // The frame-wide layer: the confirmation must outlive the row menu.
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-session-delete-confirm',
        }, DeleteSessionConfirm))
      },
    }
  },
})
