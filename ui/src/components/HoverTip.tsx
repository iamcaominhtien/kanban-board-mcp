import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface HoverTipProps {
  /** Tooltip body. */
  tip: React.ReactNode;
  className?: string;
  as?: 'span' | 'div';
  children: React.ReactNode;
}

/**
 * Dark hover / focus tooltip for the Reopened badge and the Pending strip. Rendered in a portal at fixed
 * coordinates so that a column or card edge never clips it.
 */
export const HoverTip: React.FC<HoverTipProps> = ({ tip, className, as = 'span', children }) => {
  const ref = useRef<HTMLElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  function show() {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ x: Math.min(Math.max(r.left, 8), window.innerWidth - 260), y: r.bottom + 8 });
  }

  const Tag = as as 'span';
  return (
    <Tag
      ref={ref as React.RefObject<HTMLSpanElement>}
      className={className}
      tabIndex={0}
      onMouseEnter={show}
      onMouseLeave={() => setPos(null)}
      onFocus={show}
      onBlur={() => setPos(null)}
    >
      {children}
      {pos &&
        createPortal(
          <span
            role="tooltip"
            style={{
              position: 'fixed',
              left: pos.x,
              top: pos.y,
              zIndex: 10000,
              width: 'max-content',
              maxWidth: 240,
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
              padding: '10px 12px',
              borderRadius: 8,
              background: '#1F2A24',
              color: '#fff',
              fontSize: 12,
              fontWeight: 500,
              lineHeight: 1.4,
              textAlign: 'left',
              whiteSpace: 'normal',
              boxShadow: '0 8px 20px rgba(30,42,34,0.28)',
              pointerEvents: 'none',
            }}
          >
            {tip}
          </span>,
          document.body,
        )}
    </Tag>
  );
};
