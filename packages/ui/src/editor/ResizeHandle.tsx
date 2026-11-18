'use client';

import { type KeyboardEvent, type PointerEvent, useRef } from 'react';
import styles from './editor-layout.module.css';

export interface ResizeHandleProps {
  label: string;
  value: number;
  min: number;
  max: number;
  /** Unit of the value, read out with it ("20 %"). */
  unit: '%' | 'px';
  /** Horizontal move (positive to the right): px for a drag, steps for the arrow keys. */
  onResize: (delta: number, unit: 'px' | 'step') => void;
  className?: string;
}

/** Vertical splitter between two panes: drag with a pointer, or focus it and use the arrows. */
export function ResizeHandle({
  label,
  value,
  min,
  max,
  unit,
  onResize,
  className,
}: ResizeHandleProps) {
  const last = useRef<number | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    last.current = event.clientX;
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (last.current === null) return;
    const delta = event.clientX - last.current;
    if (delta) {
      last.current = event.clientX;
      onResize(delta, 'px');
    }
  };
  const stop = () => {
    last.current = null;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    if (!step) return;
    event.preventDefault();
    onResize(step, 'step');
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={`${Math.round(value)} ${unit}`}
      tabIndex={0}
      className={[styles.handle, className].filter(Boolean).join(' ')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onKeyDown={onKeyDown}
    />
  );
}
