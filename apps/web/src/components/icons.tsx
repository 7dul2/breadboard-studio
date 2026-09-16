/**
 * Toolbar glyphs (issue #37). Inline SVG on a 16×16 grid, `currentColor`
 * strokes, no icon dependency.
 *
 * Every glyph is decorative: the button that owns it carries the accessible
 * name (`aria-label`), so the SVG itself is `aria-hidden`.
 */
import type { ReactNode } from 'react';

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Undo: arrow curving back to the left. */
export function UndoIcon() {
  return (
    <Glyph>
      <path d="M3.2 8h6a3.3 3.3 0 0 1 0 6.6H6.6" />
      <path d="M5.8 5.4 3.2 8l2.6 2.6" />
    </Glyph>
  );
}

/** Redo: the same arrow mirrored. */
export function RedoIcon() {
  return (
    <Glyph>
      <path d="M12.8 8h-6a3.3 3.3 0 0 0 0 6.6h2.6" />
      <path d="M10.2 5.4 12.8 8l-2.6 2.6" />
    </Glyph>
  );
}

/** Copy: a sheet in front of another sheet. */
export function CopyIcon() {
  return (
    <Glyph>
      <rect x="5.6" y="5.6" width="7.9" height="7.9" rx="1.4" />
      <path d="M10.5 5.6V4.1a1.4 1.4 0 0 0-1.4-1.4H4.1a1.4 1.4 0 0 0-1.4 1.4v5a1.4 1.4 0 0 0 1.4 1.4h1.5" />
    </Glyph>
  );
}

/** Paste: a clipboard. */
export function PasteIcon() {
  return (
    <Glyph>
      <path d="M6.2 3.4H4.6a1.4 1.4 0 0 0-1.4 1.4v7a1.4 1.4 0 0 0 1.4 1.4h6.8a1.4 1.4 0 0 0 1.4-1.4v-7a1.4 1.4 0 0 0-1.4-1.4h-1.6" />
      <rect x="6.2" y="2" width="3.6" height="2.8" rx="1" />
    </Glyph>
  );
}

/** Fit to view: four corner brackets. */
export function FitIcon() {
  return (
    <Glyph>
      <path d="M2.5 6V4.1a1.6 1.6 0 0 1 1.6-1.6H6" />
      <path d="M10 2.5h1.9a1.6 1.6 0 0 1 1.6 1.6V6" />
      <path d="M13.5 10v1.9a1.6 1.6 0 0 1-1.6 1.6H10" />
      <path d="M6 13.5H4.1a1.6 1.6 0 0 1-1.6-1.6V10" />
    </Glyph>
  );
}

/** Rotate the view a quarter turn. */
export function RotateIcon() {
  return (
    <Glyph>
      <path d="M13 8a5 5 0 1 1-1.5-3.5" />
      <path d="M13.4 2.6v2.9h-2.9" />
    </Glyph>
  );
}
