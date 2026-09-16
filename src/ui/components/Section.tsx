import { useState, type ReactNode } from 'react';
import { Icon } from './Icon';

/** Collapsible panel section; the header is a real button, so it works from the keyboard. */
export function Section({
  title, children, defaultOpen = true, right,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  right?: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="section">
      <header>
        <button type="button" className="section-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span className="chev"><Icon name="chevron" size={11} /></span>
          <span className="section-title">{title}</span>
        </button>
        {right ? <span className="section-right">{right}</span> : null}
      </header>
      {open ? <div className="body">{children}</div> : null}
    </div>
  );
}
