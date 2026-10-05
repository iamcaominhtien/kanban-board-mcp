import React from 'react';

interface AppLogoProps {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

export function AppLogo({ size = 22, className, style }: AppLogoProps) {
  // Proportions mapped directly from Main.dc.html (size 22 reference):
  // container: 22px, radius 6px, background: #2E6F40
  // card: 10px x 7px, radius 1.5px
  // white card: background #F3F8F4, shadow, lines #B7D9C0
  // overlay card in front: background #1E4A2C, opacity 0.55, rotate(-9deg) translate(-1.2px, 0.8px)
  const containerRadius = Math.max(3, Math.round(size * (6 / 22)));
  const cardWidth = Math.max(7, Math.round(size * (10 / 22)));
  const cardHeight = Math.max(5, Math.round(size * (7 / 22)));
  const cardRadius = Math.max(1, size * (1.5 / 22));
  const showLines = size >= 16;
  const lineHeight = Math.max(1, Math.round(size * (1 / 22)));
  const lineGap = Math.max(1, Math.round(size * (1 / 22)));
  const transX = -(size * (1.2 / 22)).toFixed(2);
  const transY = (size * (0.8 / 22)).toFixed(2);

  return (
    <div
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: containerRadius,
        background: size <= 32 ? '#2E6F40' : 'linear-gradient(160deg, #2E6F40 0%, #1E4A2C 100%)',
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        boxShadow: size >= 46 ? '0 6px 14px rgba(30,42,34,0.24)' : undefined,
        overflow: 'hidden',
        ...style,
      }}
      aria-label="Kanban logo"
      role="img"
    >
      {/* 1. White card in the BACK with the 2 lines (#B7D9C0) */}
      <div
        style={{
          width: cardWidth,
          height: cardHeight,
          borderRadius: cardRadius,
          backgroundColor: '#F3F8F4',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: lineGap,
          padding: `0 ${Math.max(1, Math.round(cardWidth * 0.12))}px`,
          boxSizing: 'border-box',
          boxShadow: size >= 22 ? '0 1.5px 3px rgba(0,0,0,0.14)' : undefined,
        }}
      >
        {showLines && (
          <>
            <div
              style={{
                width: '60%',
                height: lineHeight,
                borderRadius: lineHeight / 2,
                backgroundColor: '#B7D9C0',
              }}
            />
            <div
              style={{
                width: '85%',
                height: lineHeight,
                borderRadius: lineHeight / 2,
                backgroundColor: '#B7D9C0',
              }}
            />
          </>
        )}
      </div>

      {/* 2. Translucent card in FRONT: background #1E4A2C, opacity 0.55, rotated -9deg */}
      <div
        style={{
          position: 'absolute',
          width: cardWidth,
          height: cardHeight,
          borderRadius: cardRadius,
          backgroundColor: '#1E4A2C',
          opacity: 0.55,
          transform: `rotate(-9deg) translate(${transX}px, ${transY}px)`,
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}
