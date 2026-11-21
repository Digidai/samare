// External file URLs stay in AppKit. The page describes the drop surface and edits only the active note.
(() => {
  const ring = document.getElementById('finder-drop');
  const badge = ring.firstElementChild;
  function clear() {
    ring.hidden = true;
    badge.textContent = '';
    return true;
  }
  function assess(drop) {
    const overlay = document.getElementById('overlay');
    const palette = !overlay.hidden && overlay.querySelector('#choicebox');
    if (!overlay.hidden && !palette)
      return { allowed: false, label: 'Close this panel before opening dropped items' };
    if (drop.kind === 'images') {
      const element = document.elementFromPoint(drop.x, drop.y);
      const editable = element?.closest('.de-rich')?.querySelector('.ProseMirror[contenteditable="true"]');
      if (!drop.path || window.SamareDropEditor?.activePath() !== drop.path || !editable)
        return { allowed: false, label: 'Drop images into an open workspace document' };
    }
    return { allowed: drop.kind !== 'rejected', label: drop.label, palette };
  }
  window.SamareFinderDrop = {
    clear,
    preview(drop) {
      const result = assess(drop);
      badge.textContent = result.label;
      ring.dataset.allowed = String(result.allowed);
      ring.hidden = false;
      return result.allowed;
    },
    prepare(drop) {
      const result = assess(drop);
      clear();
      if (result.allowed && result.palette)
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return result.allowed;
    },
    insert(drop) {
      return assess(drop).allowed && window.SamareDropEditor?.insert(drop) === true;
    },
  };
  window.addEventListener('blur', clear);
  window.addEventListener('keydown', event => { if (event.key === 'Escape') clear(); });
})();
