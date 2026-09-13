import type { CSSProperties } from "react";

/**
 * Tenon mark: the letter T assembled from two wooden members — the crossbar
 * carries a mortise, the leg's tenon neck seats into it with a 1px precision
 * seam. 2.5D flat faces with a depth extrusion. Seams pick up --badge-bg so
 * they read as cut joints against any surface.
 */
export function TIcon({ size = 16, style }: { size?: number; style?: CSSProperties }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      role="img"
      aria-label="Tenon"
      style={style}
    >
      <g transform="translate(0,4) scale(1,0.92) translate(0,52)">
        <rect x="126" y="124" width="288" height="100" rx="10" fill="#a5792a" />
        <rect x="218" y="244" width="104" height="170" rx="9" fill="#a5792a" />
        <path
          d="M 234 184 H 278 V 230 H 304 V 391 Q 304 400 295 400 H 213 Q 204 400 204 391 V 230 H 234 Z"
          fill="#e8b84b"
        />
        <rect x="112" y="110" width="288" height="100" rx="10" fill="#e8b84b" />
        <g stroke="#c08a2e" strokeWidth="10" strokeLinecap="round" opacity="0.5">
          <line x1="136" y1="136" x2="376" y2="136" />
          <line x1="222" y1="266" x2="290" y2="266" />
        </g>
      </g>
    </svg>
  );
}
