import type { UnsavedWrite } from './save-status';

const TYPED_TEXT = 'textarea, input:not([type=search]):not(#palette-input):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=password]):not([type=hidden]):not([readonly]), [contenteditable]:not([contenteditable="false"])';

/** Keep disconnected drafts available even after blur removes their editor. */
export function protectUnsavedEdits(writes: () => UnsavedWrite[]) {
  const drafts = new Map<Element, { field: string; text: string }>();
  let disconnected = false;
  const capture = (element: Element | null) => {
    if (!element?.matches(TYPED_TEXT)) return;
    const text = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : element.textContent ?? '';
    drafts.set(element, { field: element.getAttribute('aria-label') || element.id || 'Text', text });
  };
  document.addEventListener('input', event => {
    if (disconnected && event.target instanceof Element) capture(event.target);
  });
  document.addEventListener('draft-cancel', event => {
    if (event.target instanceof Element) drafts.delete(event.target);
  });
  const blocked = () => drafts.size > 0 || writes().length > 0 || Boolean(document.activeElement?.matches(TYPED_TEXT));
  window.addEventListener('beforeunload', event => {
    if (!blocked()) return;
    event.preventDefault();
    event.returnValue = '';
  });
  return {
    blocked,
    disconnect() {
      disconnected = true;
      capture(document.activeElement);
    },
    download() {
      // An acknowledgement can be lost too: this is a backup, never an automatic replay.
      const body = JSON.stringify({ drafts: [...drafts.values()], unacknowledgedWrites: writes() }, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2);
      const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'unsaved-edits.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  };
}
