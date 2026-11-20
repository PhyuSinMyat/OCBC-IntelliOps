import React, { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
export default function RecordDrawer({ open, title, onClose, children, className = '', header, footer, lockScroll = false }) {
  const ref = useRef(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    const node = ref.current;
    node.showModal();
    const overflow = document.documentElement.style.overflow;
    if (lockScroll) document.documentElement.style.overflow = 'hidden';
    return () => {
      node.close();
      if (lockScroll) document.documentElement.style.overflow = overflow;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open, lockScroll]);
  const closeButton = <button type="button" autoFocus className="icon-button" aria-label="Close details" onClick={onClose}><X size={21}/></button>;
  return <dialog ref={ref} className={`account-dialog ${className}`} aria-labelledby={titleId}
    onCancel={e => { e.preventDefault(); closeRef.current(); }}
    onClick={e => { if (e.target === e.currentTarget) closeRef.current(); }}>
    {header ? <>
      {header(<h2 id={titleId}>{title}</h2>, closeButton)}
      {children}
      {footer}
    </> : <div className="account-drawer">
      <div className="account-drawer-heading"><h2 id={titleId}>{title}</h2>{closeButton}</div>
      {children}
    </div>}
  </dialog>;
}
