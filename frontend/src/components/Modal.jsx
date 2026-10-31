import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import { bindModalA11y } from '../utils/modalA11y.js';
/**
 * Shared accessible modal dialog: role="dialog", aria-modal, Escape/overlay close, body scroll
 * lock, initial focus, a minimal focus trap, and focus restore to the trigger on close (wired by
 * bindModalA11y). Markup uses the GLOBAL modal styles (.modal-overlay/.modal/.modal-header/
 * .modal-body/.modal-footer from index.css), so the card gets the 90vh cap with pinned
 * header/footer and a scrolling body for free.
 *
 * Every page previously hand-rolled the overlay+dialog without any dialog semantics; new modals
 * must use this component, and existing ones are being migrated to it.
 */
export function Modal({ open, onClose, title, children, footer, className, closeLabel = 'Close', headerExtra, subheader, hideCloseButton = false, initialFocusRef, }) {
    const titleId = useId();
    const cardRef = useRef(null);
    // Keep the latest onClose in a ref so the open/close effect below can depend on `[open]` (and the stable
    // initial-focus ref object) only.
    // Callers commonly pass an inline arrow (`onClose={() => setShow(false)}`), which is a fresh
    // reference on every parent render. If `onClose` were a useEffect dependency, the effect would
    // re-run on every keystroke that re-renders the parent — and because that effect performs the
    // initial-focus step, focus would be yanked back to the first focusable (the header close button)
    // after every character, making text inputs inside the modal unusable (issue #837). Reading via
    // the ref breaks that coupling without holding a stale handler.
    const onCloseRef = useRef(onClose);
    useEffect(() => {
        onCloseRef.current = onClose;
    });
    useEffect(() => {
        if (!open || !cardRef.current)
            return undefined;
        return bindModalA11y(document, cardRef.current, () => onCloseRef.current(), () => initialFocusRef?.current ?? null);
    }, [open, initialFocusRef]);
    if (!open)
        return null;
    return (<div className="modal-overlay" onMouseDown={event => {
            // Close only on a press that STARTS on the overlay itself — a drag that begins inside the
            // dialog and ends outside must not dismiss it (e.g. selecting text outwards).
            if (event.target === event.currentTarget)
                onClose();
        }}>
      <div ref={cardRef} className={className ? `modal ${className}` : 'modal'} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="modal-header">
          <h2 id={titleId}>{title}</h2>
          {headerExtra}
          {hideCloseButton ? null : (<button type="button" className="btn-icon" onClick={onClose} aria-label={closeLabel}>
              <X size={20}/>
            </button>)}
        </div>
        {subheader}
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>);
}
