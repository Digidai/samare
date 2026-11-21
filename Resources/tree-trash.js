'use strict';

// Tree selection follows the visible sort order, including children of expanded folders.
window.createTrashTree = function ({
  render,
  refresh,
  saveAffected,
  closeSelected,
  stage,
  cancel,
  send,
  toast,
  onSettled,
}) {
  const selected = new Set();
  const committing = new Map();
  const banner = document.getElementById('tree-trash-toast');
  const undoButton = banner.querySelector('button');
  let anchor = '',
    pending = null,
    nextID = 0,
    dismissTimer,
    preparing = false,
    revision = 0,
    scope = '';
  const under = (path, parent) =>
    path === parent || path.startsWith(parent + '/');
  function paint() {
    for (const row of document.querySelectorAll(
      '#side-body [data-tree-path]',
    )) {
      const on = selected.has(row.dataset.treePath);
      row.dataset.selected = String(on);
      row.setAttribute('aria-pressed', String(on));
    }
  }
  function selectOnly(path) {
    selected.clear();
    if (path) selected.add(path);
    anchor = path;
  }
  function click(path, evt, folder) {
    if (evt.metaKey || evt.ctrlKey) {
      if (selected.has(path)) selected.delete(path);
      else selected.add(path);
      anchor = path;
    } else if (evt.shiftKey) {
      const rows = Array.from(
        document.querySelectorAll('#side-body [data-tree-path]'),
        (r) => r.dataset.treePath,
      );
      const start = rows.indexOf(anchor || path),
        end = rows.indexOf(path);
      if (start < 0 || end < 0) {
        selected.clear();
        selected.add(path);
        anchor = path;
      } else
        for (const entry of rows.slice(
          Math.min(start, end),
          Math.max(start, end) + 1,
        ))
          selected.add(entry);
    } else {
      selectOnly(path);
      if (folder) selected.clear();
    }
    paint();
    return evt.metaKey || evt.ctrlKey || evt.shiftKey;
  }
  function showBanner(paths) {
    clearTimeout(dismissTimer);
    const name =
      paths.length === 1 ? paths[0].split('/').pop() : paths.length + ' items';
    const label = banner.querySelector('strong');
    label.textContent = label.title = name;
    undoButton.disabled = false;
    banner.hidden = false;
    banner.dataset.state = 'open';
  }
  function dismiss() {
    if (banner.hidden) return;
    banner.dataset.state = 'closing';
    undoButton.disabled = true;
    clearTimeout(dismissTimer);
    dismissTimer = setTimeout(() => {
      banner.hidden = true;
    }, 100);
  }
  function cancelPending() {
    if (!pending) return false;
    clearTimeout(pending.timer);
    cancel(pending.id);
    pending = null;
    dismiss();
    return true;
  }
  function undo() {
    if (!cancelPending()) return;
    render();
    refresh();
  }
  undoButton.onclick = undo;

  async function commit(batch) {
    if (batch !== pending) return;
    clearTimeout(batch.timer);
    pending = null;
    committing.set(batch.id, batch.paths);
    dismiss();
    if (await saveAffected(batch.paths)) send(batch.id, batch.paths);
    else {
      cancel(batch.id);
      committing.delete(batch.id);
      render();
      refresh();
      onSettled();
    }
  }
  async function queue(paths) {
    if (!paths.length || preparing) return;
    preparing = true;
    const version = revision;
    try {
      if (!(await saveAffected(paths)) || revision !== version) return;
      if (pending) void commit(pending);
      const batch = { id: String(++nextID), paths: [...paths] };
      pending = batch;
      stage(batch.id, batch.paths);
      for (const path of paths) selected.delete(path);
      if (paths.includes(anchor)) anchor = '';
      closeSelected(paths);
      showBanner(paths);
      render();
      batch.timer = setTimeout(
        () => commit(batch),
        paths.length >= 5 ? 5000 : 3000,
      );
    } finally {
      preparing = false;
    }
  }
  function targets(path) {
    return selected.size > 1 && selected.has(path) ? [...selected] : [path];
  }
  function key(path, evt) {
    if (evt.metaKey || evt.ctrlKey) return false;
    if (evt.key === 'Delete' || evt.key === 'Backspace') {
      evt.preventDefault();
      evt.stopPropagation();
      void queue(targets(path));
      return true;
    }
    if (evt.key === 'Escape' && selected.size > 1) {
      evt.preventDefault();
      evt.stopPropagation();
      selected.clear();
      if (anchor) selected.add(anchor);
      paint();
      return true;
    }
    return false;
  }
  return {
    click,
    key,
    queue,
    targets,
    selected,
    selectOnly,
    get isCommitting() {
      return committing.size > 0;
    },
    cancelForClose() {
      revision++;
      if (cancelPending()) render();
    },
    stageFailed({ id, message }) {
      if (pending?.id !== id || !cancelPending()) return;
      render();
      refresh();
      toast(message);
    },
    hidden(path) {
      if (pending?.paths.some((p) => under(path, p))) return true;
      for (const paths of committing.values())
        if (paths.some((p) => under(path, p))) return true;
      return false;
    },
    setScope(next) {
      if (scope === next) return;
      revision++;
      scope = next;
      selected.clear();
      anchor = '';
      cancelPending();
    },
    result({ id, errors }) {
      if (!committing.delete(id)) return;
      render();
      if (errors?.length) {
        refresh();
        toast(errors.join(' · '));
      }
      onSettled();
    },
  };
};
