// Outside-click / Escape dismissal for floating popovers (context menus,
// pickers, share menus). Every popover reimplemented the same effect: a
// `mousedown` listener that closes on a click outside `ref`, an Escape
// `keydown` listener, and a `setTimeout(0)` so the very click/keypress that
// opened the popover does not immediately close it. Centralised here.

import { useEffect, type RefObject } from "react";

interface Options {
  /** Also dismiss when focus leaves the popover subtree (Tab past the last
   *  control). A null relatedTarget is ignored — left to the click/Escape
   *  paths — since focus falling to <body> is not a deliberate move out. */
  onFocusOut?: boolean;
  /** A subtree that lives outside `ref` but counts as part of the popover — a
   *  panel portalled to <body> so a `contain` / `overflow` ancestor can't clip
   *  it. Clicks in it are inside, and focus moving into it does not dismiss. */
  portalRef?: RefObject<HTMLElement | null>;
  /** Arm the listeners only while the popover is on screen. Popovers that
   *  mount their panel per open (TagPicker, ContextMenu) can leave this alone;
   *  one that toggles a panel inside an always-mounted component passes its
   *  `open` flag. */
  enabled?: boolean;
}

/** Dismiss `ref`'s popover on an outside click, Escape, or (optionally) a
 *  Tab out of its subtree. */
export function useDismiss(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  { onFocusOut = false, portalRef, enabled = true }: Options = {},
) {
  useEffect(() => {
    if (!enabled) return;
    /** Is `node` part of the popover — in `ref` or in its portalled panel? */
    const owns = (node: Node | null) =>
      !!node &&
      (!!ref.current?.contains(node) || !!portalRef?.current?.contains(node));
    const onDown = (e: MouseEvent) => {
      if (!owns(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onBlur = (e: FocusEvent) => {
      const next = e.relatedTarget as Node | null;
      if (next && !owns(next)) onClose();
    };
    const tm = window.setTimeout(() => {
      document.addEventListener("mousedown", onDown);
      window.addEventListener("keydown", onKey);
      if (onFocusOut) document.addEventListener("focusout", onBlur);
    }, 0);
    return () => {
      window.clearTimeout(tm);
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("focusout", onBlur);
    };
  }, [ref, portalRef, onClose, onFocusOut, enabled]);
}
