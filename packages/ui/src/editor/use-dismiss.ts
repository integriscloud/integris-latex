import { type RefObject, useEffect } from 'react';

/** Closes an open menu on Escape or on a pointer down outside `root`. */
export function useDismiss(
  root: RefObject<HTMLElement | null>,
  open: boolean,
  close: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onEvent = (event: Event) => {
      if (
        event instanceof KeyboardEvent
          ? event.key === 'Escape'
          : !root.current?.contains(event.target as Node)
      ) {
        close();
      }
    };
    document.addEventListener('keydown', onEvent);
    document.addEventListener('pointerdown', onEvent);
    return () => {
      document.removeEventListener('keydown', onEvent);
      document.removeEventListener('pointerdown', onEvent);
    };
  }, [root, open, close]);
}
