import React, { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
export default function RecordDrawer({ open, title, onClose, children }) {
  const ref = useRef(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    const node = ref.current;
    node.showModal();
    return () => { node.close(); previous?.isConnected && previous.focus(); };
  }, [open]);
  return <dialog ref={ref} className="account-dialog" aria-labelledby={titleId} onCancel={e => { e.preventDefault(); closeRef.current(); }} onClick={e => { if (e.target === e.currentTarget) closeRef.current(); }}><div className="account-drawer"><div className="account-drawer-heading"><h2 id={titleId}>{title}</h2><button autoFocus className="icon-button" aria-label="Close details" onClick={onClose}><X size={21}/></button></div>{children}</div></dialog>;
}
