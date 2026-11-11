// Portals keep their DOM and media in the child window. Keep cloned styles in
// sync as well, so Vite updates never leave the live meeting on an older layout.
export function syncMeetingWindowStyles(source: Document, target: Document) {
  const selector = 'style,link[rel="stylesheet"]';
  const copies = new Map<Element, Element>();
  const existing = new Set(target.head.querySelectorAll(selector));
  const sync = () => {
    const originals = [...source.head.querySelectorAll(selector)];
    for (const original of originals) {
      let copy = copies.get(original);
      if (!copy) {
        copy = [...existing].find(candidate => candidate.tagName === original.tagName && (
          original.getAttribute('data-vite-dev-id')
            ? candidate.getAttribute('data-vite-dev-id') === original.getAttribute('data-vite-dev-id')
            : candidate.outerHTML === original.outerHTML
        ));
        if (copy) existing.delete(copy);
      }
      if (!copy || copy.outerHTML !== original.outerHTML) {
        const next = original.cloneNode(true) as Element;
        if (copy) copy.replaceWith(next); else target.head.appendChild(next);
        copy = next;
      }
      copies.set(original, copy);
    }
    for (const [original, copy] of copies) {
      if (!originals.includes(original)) { copy.remove(); copies.delete(original); }
    }
    for (const stale of existing) stale.remove();
    existing.clear();
  };
  sync();
  const observer = new MutationObserver(sync);
  observer.observe(source.head, { subtree: true, childList: true, characterData: true, attributes: true });
  return () => observer.disconnect();
}
