'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  function el(tag, cls, value) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (value != null) n.textContent = value;
    return n;
  }
  const icon = name => window.samareGlyph(name, 'icon');
  function button(label, kind, fn, cls = 'ico') {
    const b = el('button', cls);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    if (kind) b.append(icon(kind));
    else b.textContent = label;
    b.onclick = (e) => {
      e.stopPropagation();
      fn(e);
    };
    return b;
  }
  function host(type, p = {}) {
    window.webkit?.messageHandlers?.host?.postMessage({ type, ...p });
  }
  const docMap = new Map(),
    listing = new Map(),
    expanded = new Set(),
    closed = [],
    opts = {
      theme: matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light',
      sidebar: true,
      focus: false,
      sort: {},
      views: {},
      recents: [],
    };
  const nameOf = (p) => p.split('/').pop(),
    parentOf = (p) => p.slice(0, p.lastIndexOf('/')),
    noExt = (s) => s.replace(/\.(?:md|markdown|mdown|mkd)$/i, ''),
    isData = (p) => /\.(csv|tsv|jsonl?|ndjson)$/i.test(p),
    isText = (p) => /\.txt$/i.test(p);
  const pathUnder = (p, dir) => p === dir || p.startsWith(dir === '/' ? '/' : dir + '/');
  let roots = [],
    workspace = '',
    creationFolder = '',
    releaseVersion = '0.1.0',
    pendingRelease = false,
    home = true,
    tabs = [],
    active = '',
    editor = null,
    headings = [],
    links = [],
    linkedOpen = false,
    sideQuery = '',
    sideResults = [],
    querySeq = 0,
    quickSeq = 0,
    linkSeq = 0,
    linkPickerSeq = 0,
    filterTimer,
    toastTimer,
    inspectorTimer,
    dragPath = '',
    dialog = '',
    menuOpen = false;
  let bridge = {},
    defaultApp = {},
    flushRequest = null,
    chosenHeading = '',
    filePickerQuery = '',
    quickFiles = [],
    paletteIndex = 0,
    onQuery,
    pendingJump = null,
    quickTimer,
    closeAfter = new Set(),
    shareAfterSave = '',
    saveState = new Map(),
    findState = null;
  const current = () => docMap.get(active),
    view = () => opts.views[active] || {},
    remember = () => host('preferences', { settings: opts }),
    syncTabs = () => host('recentTabs', { paths: tabs, activePath: active });
  window.SamareDropEditor = {
    activePath: () => active,
    insert: (payload) => active === payload.path && editor?.command('insertDroppedImages', payload) === true,
  };
  function toast(msg) {
    clearTimeout(toastTimer);
    $('toast').textContent = msg;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => ($('toast').hidden = true), 2700);
  }
  function timeAgo(timestamp) {
    if (!timestamp) return '';
    const delta = Math.max(0, Date.now() / 1000 - timestamp);
    if (delta < 60) return 'just now';
    if (delta < 3600) return Math.floor(delta / 60) + 'm ago';
    if (delta < 86400) return Math.floor(delta / 3600) + 'h ago';
    if (delta < 604800) return Math.floor(delta / 86400) + 'd ago';
    return new Date(timestamp * 1000).toLocaleDateString('en', {
      month: 'short',
      day: 'numeric',
    });
  }
  let focusIdleTimer;
  function revealFocusControl() {
    if (!document.body.matches('.focused.native-fullscreen')) return;
    document.body.classList.add('focus-controls-visible');
    clearTimeout(focusIdleTimer);
    focusIdleTimer = setTimeout(() => document.body.classList.remove('focus-controls-visible'), 500);
  }
  document.addEventListener('pointermove', revealFocusControl, {passive:true});

  function setNativeFullscreen(value) {
    document.body.classList.toggle('native-fullscreen', !!value);
    revealFocusControl();
  }
  function applySettings() {
    const focusedToggle = document.activeElement?.id === 'focus-toggle';

    document.documentElement.dataset.theme = opts.theme;
    document.body.classList.toggle('hide-side', !opts.sidebar);
    document.body.classList.toggle('focused', !!opts.focus);
    document.documentElement.style.setProperty(
      '--side',
      Math.min(
        Math.max(170, opts.sideWidth || 266),
        Math.max(180, innerWidth * 0.5),
      ) + 'px',
    );
    $('side-toggle').title = opts.sidebar
      ? 'Collapse sidebar'
      : 'Expand sidebar';
    $('side-toggle').setAttribute('aria-label', $('side-toggle').title);
    $('surface').classList.toggle('wide', !!view().wide);
    $('surface').classList.toggle('structured', isData(active));
    const focusName = $('focus-document');
    focusName.replaceChildren();
    if (opts.focus && active)
      focusName.append(icon(fileIcon({path:active})), el('span', '', noExt(nameOf(active))));
    $('tools').replaceChildren(
      button('Use in Agent', 'link-2', () => { if (!agentUnavailable()) command('agent'); }),
      button('Settings', 'settings-2', () => command('settings')),
      button('More actions', 'ellipsis', (e) => more(e.currentTarget)),
      button(
        opts.theme === 'dark'
          ? 'Switch to light theme'
          : 'Switch to dark theme',
        opts.theme === 'dark' ? 'moon' : 'sun',
        () => command('theme'),
      ),
      button(opts.focus ? 'Leave Focus' : 'Focus', opts.focus ? 'leave-focus' : 'scan', () => command('focus')),
    );
    updateAgentButton();
    const focusToggle = $('tools').lastChild;
    if (!active) {
      focusToggle.setAttribute('aria-disabled', 'true');
      focusToggle.setAttribute('aria-label', 'Open a file to focus on it');
      focusToggle.tabIndex = -1;
      focusToggle.onclick = e => e.stopPropagation();
    }
    focusToggle.id = 'focus-toggle';
    focusToggle.setAttribute('aria-pressed', String(!!opts.focus));
    focusToggle.setAttribute('aria-keyshortcuts', 'Meta+Shift+F');
    const focusHint = el('span', 'focus-hint', focusToggle.title);
    focusHint.append(el('kbd', '', '⌘⇧F'));
    focusHint.setAttribute('aria-hidden', 'true');
    focusToggle.removeAttribute('title');
    focusToggle.after(focusHint);
    if (focusedToggle) focusToggle.focus({preventScroll:true});
    revealFocusControl();
    $('rail').hidden = !active || isData(active) || isText(active);
    $('counter').hidden = !active || isData(active);
    $('column').style.zoom = view().zoom || 1;
    if (editor)
      editor.updateSettings?.({
        theme: opts.theme,
        dark: opts.theme === 'dark',
      });
  }
  function keys(s) {
    const group = el('span', 'keys');
    for (const k of s.split(' ')) group.append(el('kbd', '', k));
    return group;
  }
  function showMenu(anchor, items, point, treeContext = false) {
    const m = $('menu');
    m.classList.toggle('tree-context', treeContext);
    m.replaceChildren();
    for (const [label, kind, fn, disabled, checked] of items) {
      if (label == null) {
        m.append(el('hr'));
        continue;
      }
      const b = button(
        label,
        kind,
        () => {
          hideMenu();
          fn();
        },
        '',
      );
      if (kind) b.append(el('span', '', label));
      if (checked) {
        const tick = icon('check');
        tick.classList.add('menu-check');
        b.append(tick);
      }
      b.disabled = !!disabled;
      if (typeof disabled === 'string' && disabled) b.title = disabled;
      b.setAttribute('role', checked === undefined ? 'menuitem' : 'menuitemradio');
      if (checked !== undefined) b.setAttribute('aria-checked', String(checked));
      m.append(b);
    }
    const r = anchor?.getBoundingClientRect(),
      x = point?.[0] ?? (r ? r.right - 200 : 0),
      y = point?.[1] ?? (r ? r.bottom + 4 : 0);
    m.hidden = false;
    menuOpen = true;
    m.style.left =
      Math.max(4, Math.min(x, innerWidth - m.offsetWidth - 5)) + 'px';
    m.style.top =
      Math.max(4, Math.min(y, innerHeight - m.offsetHeight - 5)) + 'px';
    m.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
  }
  function hideMenu() {
    menuOpen = false;
    $('menu').hidden = true;
  }
  function agentUnavailable() {
    if (bridge.enabled === false) return 'Enable Use in Agent in Settings';
    if (bridge.commandInstalled === false) return 'Repair Use in Agent in Settings';
    if (!active) return 'Open a note or a data file';
    return isText(active) ? 'Text files can’t be used in an agent yet' : '';
  }
  function updateAgentButton() {
    const b = $('tools').firstElementChild;
    if (!b) return;
    const why = agentUnavailable();
    b.setAttribute('aria-label', why ? 'Use in Agent unavailable: ' + why : 'Use in Agent');
    b.title = why || 'Use in Agent';
    b.tabIndex = why ? -1 : 0;
    if (why) b.setAttribute('aria-disabled', 'true');
    else b.removeAttribute('aria-disabled');
  }
  function more(anchor) {
    const markdown = !!current() && !isData(active) && !isText(active);
    showMenu(anchor, [
      ['Copy as text', 'file-text', () => command('copyText'), !active],
      ['Copy as Markdown', 'copy', () => command('copyMD'), !active],
      ['Export as PDF…', 'file-output', () => command('exportPDF'), !markdown],
      ['Word count', 'hash', () => command('wordCount'), !active],
      ...(markdown ? [[view().wide ? 'Standard width' : 'Wide view',
        view().wide ? 'standard-width' : 'wide-view', () => command('wide')]] : []),
      ...(markdown && editor?.command('canAddProperties')
        ? [['Add properties', 'list-plus', () => editor.command('addProperties')]] : []),
      ['Use in Agent', 'link-2', () => command('agent'), agentUnavailable()],
      ['Reveal in Finder', 'folder-open', () => command('reveal'), !active],
      ['Copy file path', 'clipboard', () => command('copyPath'), !active],
    ]);
  }
  function refresh() {
    if (workspace) host('listFolder', { path: workspace });
    for (const path of expanded)
      if (pathUnder(path, workspace)) host('listFolder', { path });
    if (sideQuery) searchSide();
    if (active) requestLinks();
  }
  function sideLine(label, kind, fn, selected = false) {
    const row = el('div', 'side-row' + (selected ? ' selected' : ''));
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', label);
    if (kind) row.append(icon(kind));
    row.append(el('span', 'grow', label));
    row.onclick = fn;
    row.onkeydown = (e) => {
      if (e.target === row && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        fn(e);
      }
    };
    return row;
  }
  function header(label, action, tip) {
    const h = el('div', 'section-head');
    h.append(el('span', 'grow', label), button(tip, 'plus', action));
    return h;
  }
  function sectionAction(anchor, dir) {
    showMenu(anchor, [
      ['New file', 'file-plus', () => host('newFile', { parent: dir })],
      [
        'New folder',
        'folder-plus',
        () => host('createFolder', { parent: dir }),
      ],
    ]);
  }
  let homeWorkspacesExpanded = false, homeFilesExpanded = false;
  function renderHome() {
    const firstHome = !active && !roots.length && !tabs.length && !opts.recents.length;
    document.body.classList.toggle('first-home', firstHome);
    if (active) return;
    if (firstHome) {
      const box = el('section', 'first-start');
      const brand = el('h1', 'brand', 'Samare');
      brand.prepend(el('i'));
      const add = button('Add workspace', 'plus', () => host('openFolder'), 'first-workspace');
      add.append(el('span', '', 'Add workspace'));
      const keys = el('span', 'first-keys');
      keys.setAttribute('aria-hidden', 'true');
      keys.append(el('kbd', '', '⌘'), el('kbd', '', 'O'));
      add.append(keys);
      box.append(brand, el('p', '', 'Edit Markdown and data files in place.'), add);
      $('editor').replaceChildren(box);
      return;
    }
    const box = el('div', 'empty workspace-picker');
    const section = (name, entries, limit, expanded, toggle, open, lastOpened) => {
      if (!entries.length) return;
      const group = el('section', 'home-group');
      const label = el('h3', '', name);
      label.append(el('small', '', String(entries.length)));
      group.append(label);
      const basenameCounts = new Map();
      entries.forEach(path => basenameCounts.set(nameOf(path), (basenameCounts.get(nameOf(path)) || 0) + 1));
      for (const path of entries.slice(0, expanded ? entries.length : limit)) {
        const row = button(nameOf(path), null, () => open(path), 'home-entry');
        row.title = path;
        if (basenameCounts.get(nameOf(path)) > 1) row.append(el('small', '', parentOf(path)));
        const at = lastOpened?.[path];
        if (at) row.append(el('small', 'home-time', timeAgo(at)));
        group.append(row);
      }
      if (entries.length > limit) {
        const more = button(expanded ? 'Show fewer' : 'Show all', null, toggle, 'home-more');
        more.setAttribute('aria-expanded', String(expanded));
        group.append(more);
      }
      box.append(group);
    };
    const workspaces = roots.map(r => r.path).sort((a,b) => (opts.workspaceVisits?.[b] || 0) - (opts.workspaceVisits?.[a] || 0));
    const files = [...new Set([...opts.recents, ...tabs])].filter(path => !roots.some(root => pathUnder(path, root.path)));
    const brand = el('h1', 'brand', 'Samare');
    brand.prepend(el('i'));
    box.append(brand, el('p', 'quiet', workspaces.length ? 'Choose a workspace to continue.' : 'Edit Markdown and data files in place.'));
    section('Workspaces', workspaces, 4, homeWorkspacesExpanded, () => {
      homeWorkspacesExpanded = !homeWorkspacesExpanded; renderHome();
    }, setWorkspace, opts.workspaceVisits);
    section('Other files', files, 3, homeFilesExpanded, () => {
      homeFilesExpanded = !homeFilesExpanded; renderHome();
    }, browse);
    box.append(button('Add workspace', null, () => host('openFolder'), 'action'),
               button('Open files…', null, () => host('openFiles'), 'action'));
    $('editor').replaceChildren(box);
  }
  function setWorkspace(path, notify = true) {
    creationFolder = path;
    workspace = path;
    home = !path;
    sideQuery = '';
    sideResults = [];
    if (path) {
      (opts.workspaceVisits ||= {})[path] = Date.now() / 1000;
      remember();
      host('listFolder', { path });
      if (notify) host('chooseWorkspace', { path });
    }
    revealActiveFile(active);
    renderSide();
    renderHome();
  }
  let sidebarReveal = '';
  function revealActiveFile(path) {
    sidebarReveal = '';
    if (home || sideQuery || !workspace || !pathUnder(path, workspace) || path === workspace) return;
    sidebarReveal = path;
    const dirs = [];
    for (let dir = parentOf(path); dir !== workspace && pathUnder(dir, workspace); dir = parentOf(dir)) {
      dirs.push(dir);
      if (!dir) break;
    }
    for (const dir of dirs.reverse()) {
      expanded.add(dir);
      if (!listing.has(dir)) host('listFolder', {path:dir});
    }
  }
  function browse(path) {
    if (docMap.has(path) && tabs.includes(path)) {
      activate(path);
    } else host('read', { path });
  }
  function openPickerFile(path) {
    const owner = roots
      .filter((root) => pathUnder(path, root.path))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (owner) {
      if (home || workspace !== owner.path) setWorkspace(owner.path);
    } else command('workspaces');
    browse(path);
  }
  function fileIcon(entry) {
    if (entry.isDirectory)
      return expanded.has(entry.path) ? 'folder-open' : 'folder';
    if (/\.([ct]sv)$/i.test(entry.path)) return 'table';
    if (/\.json$/i.test(entry.path)) return 'braces';
    if (/\.(jsonl|ndjson)$/i.test(entry.path)) return 'list';
    return 'file-text';
  }
  function sortBy() {
    return opts.sort[workspace] || 'az';
  }
  function sorting(anchor) {
    showMenu(
      anchor,
      [
        ['az', 'Name (A to Z)', 'arrow-down-a-z'],
        ['za', 'Name (Z to A)', 'arrow-down-z-a'],
        ['new', 'Last edited (new to old)', 'clock-arrow-down'],
        ['old', 'Last edited (old to new)', 'clock-arrow-up'],
      ].map(([id, label, glyph]) => [
        label, glyph,
        () => {
          opts.sort[workspace] = id;
          remember();
          renderSide();
        }, false, sortBy() === id,
      ]),
    );
  }
  function allowedDrop(row, dir) {
    row.ondragover = (e) => {
      if (dragPath && !pathUnder(dir, dragPath) && parentOf(dragPath) !== dir) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        row.classList.add('drag-over');
      }
    };
    row.ondragleave = () => row.classList.remove('drag-over');
    row.ondrop = (e) => {
      e.preventDefault();
      e.stopPropagation();
      row.classList.remove('drag-over');
      if (dragPath && !pathUnder(dir, dragPath) && parentOf(dragPath) !== dir)
        host('move', { path: dragPath, parent: dir });
      dragPath = '';
    };
  }
  // The write acknowledgement must arrive before an open tab or its folder can be trashed.
  async function saveTreeDocuments(paths) {
    const affected = path => paths.some(parent => pathUnder(path, parent));
    if (active && affected(active) && !canLeaveEditor()) return false;
    const deadline = Date.now() + 5000;
    for (;;) {
      const targets = [...docMap.values()].filter(f => affected(f.path));
      for (const f of targets) if (unresolved(f)) f.markOnDisk = true;
      const dirty = targets.filter(f => diskText(f) !== f.base || f.pending != null);
      if (!dirty.length) return true;
      if (dirty.some(f => f.failed || f.missing) || Date.now() >= deadline) {
        toast('Save your changes before moving these items to Trash.');
        return false;
      }
      dirty.forEach(submit);
      await new Promise(resolve => setTimeout(resolve, 35));
    }
  }
  const trashTree = window.createTrashTree({
    render: renderSide, refresh, toast, saveAffected: saveTreeDocuments, onSettled: flush,
    closeSelected(paths) {
      for (const path of [...tabs].reverse()) if (paths.includes(path)) finishClose(path, false);
    },
    stage: (id, paths) => host('stageTrash', { id, paths }),
    cancel: id => host('cancelTrash', { id }),
    send: (id, paths) => host('trashBatch', { id, paths }),
  });
  function entryRow(entry, depth = 0, search = false) {
    const { path, name, isDirectory } = entry;
    const row = sideLine(
      noExt(name),
      fileIcon(entry),
      (event) => {
        if (trashTree.click(path, event, isDirectory)) return;
        creationFolder = isDirectory ? path : parentOf(path);
        if (isDirectory) {
          if (expanded.has(path)) expanded.delete(path);
          else {
            expanded.add(path);
            host('listFolder', { path });
          }
          renderSide();
        } else {
          if (search && entry.snippet)
            pendingSearch = { path, query: sideQuery };
          browse(path);
          applySearchJump();
        }
      },
      active === path,
    );
    row.classList.add('file-row');
    row.dataset.treePath = path;
    row.dataset.selected = String(trashTree.selected.has(path));
    row.setAttribute('aria-pressed', row.dataset.selected);
    const activateRow = row.onkeydown;
    row.onkeydown = (event) => {
      if (event.target === row && trashTree.key(path, event)) return;
      activateRow(event);
    };
    row.style.setProperty('--depth', depth);
    row.title = path;
    if (!isDirectory && noExt(name) === name && name.includes('.')) {
      const n = row.querySelector('.grow'),
        i = name.lastIndexOf('.');
      n.replaceChildren(
        document.createTextNode(name.slice(0, i)),
        el('span', 'ext', name.slice(i)),
      );
    }
    if (search && entry.snippet) {
      row.classList.add('matchrow');
      const snippet = el('span', 'snippet');
      markText(snippet, entry.snippet, sideQuery);
      row.querySelector('.grow').append(snippet);
    }
    if (isDirectory) {
      row.append(
        button(
          'New file in ' + name,
          'plus',
          (e) => sectionAction(e.currentTarget, path),
          'ico reveal',
        ),
      );
      allowedDrop(row, path);
    } else row.append(el('span', 'side-extra', timeAgo(entry.modified)));
    row.draggable = true;
    row.ondragstart = (e) => {
      dragPath = path;
      e.dataTransfer.setData('text/plain', path);
      e.dataTransfer.effectAllowed = 'move';
    };
    row.ondragend = () => {
      dragPath = '';
      document
        .querySelectorAll('.drag-over')
        .forEach((n) => n.classList.remove('drag-over'));
    };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      const targets = trashTree.targets(path);
      const trashAction = ['Move to Trash', null, () => trashTree.queue(targets)];
      if (targets.length > 1) {
        showMenu(null, [trashAction], [e.clientX, e.clientY], true);
        return;
      }
      showMenu(
        null,
        [
          ['New File', null, () => host('newFile', { parent: isDirectory ? path : parentOf(path) })],
          ['New Folder', null, () => host('createFolder', { parent: isDirectory ? path : parentOf(path) })],
          [],
          ['Rename', null, () => host('rename', { path })],
          trashAction,
          [],
          ['Reveal in Finder', null, () => host('reveal', { path })],
          ['Copy Path', null, () => host('copy', { text: path })],
        ],
        [e.clientX, e.clientY],
        true,
      );
    };
    return row;
  }
  function markText(node, s, q) {
    const i = q ? s.toLowerCase().indexOf(q.toLowerCase()) : -1;
    if (i < 0) {
      node.textContent = s;
      return;
    }
    node.append(
      document.createTextNode(s.slice(0, i)),
      el('mark', '', s.slice(i, i + q.length)),
      document.createTextNode(s.slice(i + q.length)),
    );
  }
  function tree(parent, dir, depth = 0) {
    const order = sortBy(),
      entries = [...(listing.get(dir) || [])].sort(
        (a, b) =>
          Number(b.isDirectory) - Number(a.isDirectory) ||
          (order === 'new'
            ? (b.modified || 0) - (a.modified || 0)
            : order === 'old'
              ? (a.modified || 0) - (b.modified || 0)
              : 0) ||
          (order === 'za' ? -1 : 1) *
            a.name.localeCompare(b.name, undefined, { numeric: true }),
      );
    for (const e of entries) {
      if (trashTree.hidden(e.path)) continue;
      parent.append(entryRow(e, depth));
      if (e.isDirectory && expanded.has(e.path))
        tree(parent, e.path, depth + 1);
    }
  }
  function renderSide() {
    trashTree.setScope(home ? '' : workspace);
    const side = $('side-body');
    const focusedRow = side.contains(document.activeElement) && document.activeElement?.dataset.treePath;
    const was = document.activeElement?.id === 'side-query',
      sel = was
        ? [
            document.activeElement.selectionStart,
            document.activeElement.selectionEnd,
          ]
        : null;
    side.replaceChildren();
    if (home || !workspace) {
      side.append(
        header('Workspaces', () => host('openFolder'), 'Add workspace'),
      );
      for (const root of roots) {
        const row = sideLine(root.name, 'layers-2', () =>
          setWorkspace(root.path),
        );
        row.querySelector('.grow').title = root.name;
        row.append(
          button(
            'Remove ' + root.name + ' workspace',
            'x',
            () => host('closeWorkspace', { path: root.path }),
            'ico reveal',
          ),
        );
        side.append(row);
      }
      const other = header(
        'Other files',
        () => host('openFiles'),
        'Open files',
      );
      other.classList.add('other');
      side.append(other);
      for (const path of [...new Set([...tabs, ...opts.recents])].filter(
        (p) => !trashTree.hidden(p) && !roots.some((r) => pathUnder(p, r.path)),
      ))
        side.append(entryRow({ name: nameOf(path), path }));
      return;
    }
    side.append(
      sideLine('Back to workspaces', 'arrow-left', () => {
        home = true;
        renderSide();
      }),
    );
    const h = el('div', 'section-head workspace-head');
    h.append(
      icon('layers-2'),
      el('span', 'grow', nameOf(workspace)),
      button('Refresh', 'refresh-cw', refresh),
      button('Sort', 'arrow-down-wide-narrow', (e) => sorting(e.currentTarget)),
      button('New in ' + nameOf(workspace), 'plus', (e) =>
        sectionAction(e.currentTarget, workspace),
      ),
    );
    h.title = workspace;
    h.querySelector('.grow').title = nameOf(workspace);
    allowedDrop(h, workspace);
    side.append(h);
    const search = el('label', 'side-search');
    search.append(icon('search'));
    const input = el('input');
    input.id = 'side-query';
    input.placeholder = 'Search';
    input.setAttribute('aria-label', 'Search ' + nameOf(workspace));
    input.value = sideQuery;
    input.oninput = () => {
      sideQuery = input.value;
      searchSide();
    };
    input.onkeydown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        sideQuery = '';
        renderSide();
      }
    };
    search.append(input);
    side.append(search);
    if (sideQuery) {
      const visible = sideResults.filter(e => !trashTree.hidden(e.path));
      for (const e of visible) side.append(entryRow(e, 0, true));
      if (!visible.length)
        side.append(el('div', 'sect-label', 'No matching files'));
    } else tree(side, workspace);
    if (sidebarReveal && !sideQuery) {
      const row = [...side.querySelectorAll('.file-row.selected')].find(item => item.title === sidebarReveal);
      if (row) {
        sidebarReveal = '';
        const box = side.getBoundingClientRect(), item = row.getBoundingClientRect();
        if (item.top < box.top || item.bottom > box.bottom) {
          side.scrollTop += item.top - box.top - (box.height - item.height) / 2;
        }
      }
    }
    if (was) {
      input.focus();
      input.setSelectionRange(...sel);
    } else if (focusedRow) {
      [...side.querySelectorAll('[data-tree-path]')].find(row => row.dataset.treePath === focusedRow)?.focus({preventScroll:true});
    }
  }
  function searchSide() {
    clearTimeout(filterTimer);
    const id = ++querySeq;
    if (!sideQuery) {
      sideResults = [];
      renderSide();
      return;
    }
    filterTimer = setTimeout(
      () =>
        host('searchFiles', {
          query: sideQuery,
          workspace,
          mode: 'content',
          requestId: id,
        }),
      95,
    );
  }
  function renderTabs() {
    const group = $('tabs');
    group.replaceChildren();
    for (const path of tabs) {
      const selected = path === active,
        row = el('div', 'tab');
      row.tabIndex = selected ? 0 : -1;
      row.draggable = true;
      row.setAttribute('role', 'tab');
      row.setAttribute('aria-label', noExt(nameOf(path)));
      row.setAttribute('aria-selected', String(selected));
      row.title = path;
      row.onclick = () => activate(path);
      row.onkeydown = (e) => {
        if (e.key === 'Enter') activate(path);
      };
      row.append(
        el('span', '', noExt(nameOf(path))),
        button('Close ' + nameOf(path), 'x', () => closeTab(path)),
      );
      row.ondragstart = (e) =>
        e.dataTransfer.setData('application/x-samare-tab', path);
      row.ondragover = (e) => {
        if (e.dataTransfer.types.includes('application/x-samare-tab'))
          e.preventDefault();
      };
      row.ondrop = (e) => {
        const p = e.dataTransfer.getData('application/x-samare-tab');
        if (!p || p === path) return;
        e.preventDefault();
        tabs.splice(tabs.indexOf(p), 1);
        tabs.splice(tabs.indexOf(path), 0, p);
        renderTabs();
        syncTabs();
      };
      group.append(row);
    }
    group
      .querySelector('[aria-selected=true]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  const changeReview = window.SamareRevisionReview({
    getEditor:() => editor,
    onStateChanged() {
      const f = current();
      if (f) saveReview(f);
    },
    commit(text) {
      const f = current();
      if (!f) return;
      f.text = text;
      if (editor?.getText() !== text) editor?.setText(text);
      f.failed = false;
      saveReview(f);
      updateCount();
      updateNotice();
      submit(f);
      flush();
    },
  });
  function reviewKey(path) { return 'samare-conflict:' + path; }
  function unresolved(f) { return f?.review?.state.type === 'conflict'; }
  function diskText(f) {
    return unresolved(f) ? SamareRevisionDisk.project(f.text,f.review.state.items,!!f.markOnDisk) : f.text;
  }
  function saveReview(f) {
    f.review = changeReview.snapshot();
    if (!unresolved(f)) f.markOnDisk = false;
    if (!unresolved(f) && !f.hasRecovery) return;
    try {
      if (unresolved(f) && (!f.markOnDisk || diskText(f) !== f.base || f.missing)) {
        localStorage.setItem(reviewKey(f.path), JSON.stringify({base:f.base,text:f.text,items:changeReview.recovery()}));
        f.hasRecovery = true;
      } else {
        localStorage.removeItem(reviewKey(f.path));
        f.hasRecovery = false;
      }
    } catch { /* A close or quit still writes both alternatives to the file. */ }
  }
  function storeDoc(p) {
    const f = {
      ...p,
      base: p.text,
      missing: false,
      pending: null,
      review: null,
      markOnDisk: SamareRevisionDisk.decode(p.text).length > 0,
    };
    const activeReview = changeReview.snapshot();
    changeReview.use(null);
    let saved;
    try { saved = JSON.parse(localStorage.getItem(reviewKey(f.path))); } catch {}
    if (saved && typeof saved.base === 'string' && typeof saved.text === 'string') {
      changeReview.restore(saved.text, saved.items);
      if (changeReview.unresolved()) {
        f.hasRecovery = true;
        f.text = saved.base === f.base ? saved.text : changeReview.incoming(saved.base,saved.text,f.base,true);
      }
    } else f.text = changeReview.readMarkers(f.base);
    saveReview(f);
    changeReview.use(activeReview);
    docMap.set(p.path, f);
    return f;
  }
  let readingTimer, readingFrame, restoringReading = false;
  function readingMetrics() {
    const source = $('editor').querySelector('.de-source');
    const scroller = source && source.scrollHeight - source.clientHeight > 3 ? source : $('scroll');
    const extent = scroller.scrollHeight - scroller.clientHeight;
    const top = scroller.scrollTop;
    if (extent <= 0 || top <= 2) return 0;
    if (extent - top <= 2) return 100;
    return Math.min(100, Math.max(top > 8 ? 1.5 : 0, top / extent * 100));
  }
  function paintProgress(percent) {
    $('reading-progress').style.setProperty('--read', percent / 100);
  }
  function saveReading() {
    clearTimeout(readingTimer);
    if (!active || !editor || restoringReading) return;
    const percent = readingMetrics();
    paintProgress(percent);
    const next = {
      mode: editor.command('getMode'),
      scroll: $('scroll').scrollTop,
      progress: Math.round(percent),
      ...editor.captureReadingSelection(),
    };
    const pref = (opts.views[active] ||= {});
    const prev = pref.reading;
    if (prev && prev.mode === next.mode && prev.scroll === next.scroll &&
        prev.progress === next.progress && prev.cursor === next.cursor &&
        prev.innerScroll === next.innerScroll) {
      const before = prev.grid || {}, after = next.grid || {};
      if (Object.keys(before).length === Object.keys(after).length &&
          Object.keys(after).every(key => before[key] === after[key])) return;
    }
    pref.reading = next;
    remember();
  }
  function readingChanged() {
    if (!editor || restoringReading) return;
    cancelAnimationFrame(readingFrame);
    readingFrame = requestAnimationFrame(() => paintProgress(readingMetrics()));
    clearTimeout(readingTimer);
    readingTimer = setTimeout(saveReading, 250);
  }
  $('scroll').addEventListener('scroll', readingChanged, {passive:true, capture:true});
  document.addEventListener('selectionchange', readingChanged);
  $('editor').addEventListener('keyup', readingChanged);
  window.addEventListener('pagehide', saveReading);
  const readingResize = new ResizeObserver(readingChanged);
  readingResize.observe($('column'));
  readingResize.observe($('scroll'));
  function submit(f) {
    if (!f || f.pending != null || f.missing) return;
    const text = diskText(f);
    if (text === f.base) return;
    clearTimeout(saveState.get(f.path));
    f.pending = text;
    host('save', { path: f.path, text, baseText: f.base });
  }
  function schedule(f) {
    clearTimeout(saveState.get(f.path));
    saveState.set(
      f.path,
      setTimeout(() => submit(f), 380),
    );
  }
  function trackEdit(f, text) {
    if (f.text === text) return;
    f.text = text;
    f.failed = false;
    if (current() === f) changeReview.update(text);
    schedule(f);
    if (!editor?.command('isHydrating')) updateCount();
    updateNotice();
    if (findState) runFind(false);
  }
  function flush() {
    if (!flushRequest || trashTree.isCommitting) return;
    let fail = false,
      waiting = false;
    for (const f of docMap.values()) {
      if (unresolved(f)) f.markOnDisk = true;
      if (f.failed || (f.missing && diskText(f) !== f.base)) fail = true;
      else {
        submit(f);
        if (f.pending != null || diskText(f) !== f.base) waiting = true;
      }
    }
    if (fail || !waiting) {
      host('flushed', { id: flushRequest.id, ok: !fail });
      flushRequest = null;
    }
  }
  function shareWhenSaved(f) {
    if (!f || f.path !== shareAfterSave) return;
    if (f.missing || f.failed) {
      shareAfterSave = '';
      toast('Save the file before copying its agent link.');
    } else if (f.pending != null || diskText(f) !== f.base) {
      submit(f);
    } else {
      shareAfterSave = '';
      host('agentLink', {path: f.path});
    }
  }
  function canLeaveEditor() {
    editor?.command('commitCell');
    if (!editor?.command('hasUnstoredCSVRecovery')) return true;
    toast('Choose what to do with the recovered cell draft before leaving.');
    return false;
  }
  function closeTab(path) {
    if (active === path && !canLeaveEditor()) return;
    const f = docMap.get(path);
    if (!f) return;
    if (unresolved(f)) f.markOnDisk = true;
    if (!f.missing && (diskText(f) !== f.base || f.pending != null)) {
      closeAfter.add(path);
      submit(f);
      return;
    }
    if (f.missing && f.text !== f.base) {
      toast('Save this file again before closing it.');
      return;
    }
    finishClose(path);
  }
  function finishClose(path, recordHistory = true) {
    const i = tabs.indexOf(path);
    if (i < 0) return;
    tabs.splice(i, 1);
    if (recordHistory) closed.push(path);
    if (path === active) activate(tabs[Math.min(i, tabs.length - 1)] || '');
    else {
      trashTree.selectOnly(active);
      renderTabs();
      renderSide();
      syncTabs();
    }
  }
  function openDoc(p) {
    if (p.previousPath) {
      tabs = tabs.filter((x) => x !== p.previousPath);
      docMap.delete(p.previousPath);
    }
    let f = docMap.get(p.path);
    if (!f) f = storeDoc(p);
    else external(p, false);
    if (!tabs.includes(p.path)) tabs.push(p.path);
    activate(p.path);
  }
  function activate(path) {
    if (path === active && editor) {
      trashTree.selectOnly(path);
      if (!dialog && !isData(path)) editor.command('focus');
      revealActiveFile(path);
      renderSide();
      renderTabs();
      return;
    }
    if (current()) {
      if (!canLeaveEditor()) return;
      saveReading();
      submit(current());
    }
    editor?.destroy();
    editor = null;
    cancelAnimationFrame(readingFrame);
    clearTimeout(readingTimer);
    closeFind();
    clearTimeout(inspectorTimer);
    $('inspector').hidden = true;
    active = path;
    if (path) document.body.classList.remove('first-home');
    creationFolder = pathUnder(path, workspace) && path ? parentOf(path) : workspace;
    trashTree.setScope(home ? '' : workspace);
    trashTree.selectOnly(path);
    revealActiveFile(path);
    links = [];
    headings = [];
    chosenHeading = '';
    linkedOpen = false;
    const f = current();
    changeReview.use(f?.review);
    changeReview.draw();
    const reading = view().reading;
    restoringReading = !!f;
    paintProgress(reading?.progress || 0);
    $('editor').replaceChildren();
    $('backlinks').replaceChildren();
    applySettings();
    renderTabs();
    renderSide();
    syncTabs();
    updateNotice();
    if (!f) {
      renderHome();
      return;
    }
    opts.recents = [path, ...opts.recents.filter((p) => p !== path)].slice(
      0,
      80,
    );
    remember();
    if (!window.SamareEditor) {
      toast('The editor could not load. Rebuild the application resources.');
      return;
    }
    editor = window.SamareEditor.mount($('editor'), {
      path,
      text: f.text,
      modified:
        f.modified ||
        listing.get(parentOf(path))?.find((e) => e.path === path)?.modified,
      settings: {
        theme: opts.theme,
        dark: opts.theme === 'dark',
        contentWidth: '100%',
        fontFamily: 'var(--samare-font-sans)',
        fontSize: 17,
        lineHeight: 1.5,
      },
      onChange: (t) => trackEdit(f, t),
      onHydrated: () => queueMicrotask(() => { if (current() === f) { updateCount(); if (restoringReading) restorePosition(); } }),
      onOutline: (list) => {
        headings = list || [];
        if (!$('inspector').hidden) showInspector();
      },
      assetURL: (ref) =>
        /^(https?:|data:image\/)/i.test(ref)
          ? ref
          : 'samareasset://local/?document=' +
            encodeURIComponent(path) +
            '&src=' +
            encodeURIComponent(ref),
      onLink: (r) => follow(r),
      onNoteSearch: (q, cb) => lookupNotes(q, cb),
    });
    changeReview.draw();
    if (reading?.mode && reading.mode !== editor.command('getMode'))
      editor.command('mode', reading.mode);
    if (!dialog && (!isData(path) || reading?.mode === 'source')) editor.command('focus');
    const mounted = editor;
    editor.restoreReadingSelection(reading?.cursor, reading?.innerScroll, reading, !dialog);
    if (!editor.command('isHydrating')) updateCount();
    requestLinks();
    // Layout the fresh source textarea before positioning it. A background Mac
    // window may receive Quit without ever receiving an animation frame.
    const restorePosition = () => {
      if (editor !== mounted) return;
      $('scroll').scrollTop = reading?.scroll || 0;
      const source = $('editor').querySelector('.de-source');
      if (source && reading?.innerScroll) source.scrollTop = reading.innerScroll;
      restoringReading = false;
      paintProgress(readingMetrics());
      applySearchJump();
      if (pendingJump?.path === path) {
        jumpHeading(pendingJump.hash);
        pendingJump = null;
      }
    };
    if (!editor.command('isHydrating') || !reading?.scroll) queueMicrotask(restorePosition);
  }
  function visibleText() {
    const plain = editor?.command('getPlainText');
    if (typeof plain === 'string') return plain.trim();
    const source = current()?.text || '';
    return source
      .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
      .replace(/(?:^|\n)\s{0,3}#{1,6} /g, '\n')
      .replace(/[*_\x60~>|]/g, '')
      .trim();
  }
  function counts() {
    const stats = editor?.command('getStats');
    if (stats && Number.isFinite(stats.words) && Number.isFinite(stats.chars))
      return stats;
    const s = visibleText();
    return {
      words: (
        s.match(
          /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu,
        ) || []
      ).length,
      chars: Array.from(s).length,
    };
  }
  function updateCount() {
    if (!active || isData(active)) return;
    const c = counts();
    const counter = $('counter');
    const label = c.words.toLocaleString() + (c.words === 1 ? ' word · ' : ' words · ') +
      c.chars.toLocaleString() + (c.chars === 1 ? ' character' : ' characters');
    if (label === counter.getAttribute('aria-label')) return;
    counter.setAttribute('aria-label', label);
    // Reuse stable characters so only the changed part animates as the user types.
    const characters = Array.from(label);
    characters.forEach((char, index) => {
      const old = counter.children[index];
      if (old?.textContent === char) return;
      const next = el('span', '', char);
      next.setAttribute('aria-hidden', 'true');
      if (old) old.replaceWith(next);
      else counter.append(next);
    });
    while (counter.children.length > characters.length) counter.lastChild.remove();
  }
  function requestLinks() {
    const id = ++linkSeq;
    if (active && !isData(active) && !isText(active))
      host('searchFiles', {
        mode: 'backlinks',
        target: active,
        query: '',
        requestId: id,
        workspace: roots.find((r) => pathUnder(active, r.path))?.path || '',
      });
  }
  function renderLinks() {
    const slot = $('backlinks');
    slot.replaceChildren();
    if (!links.length) return;
    slot.append(
      button(
        (linkedOpen ? '⌄ ' : '› ') +
          links.length +
          ' backlink' +
          (links.length === 1 ? '' : 's'),
        null,
        () => {
          linkedOpen = !linkedOpen;
          renderLinks();
        },
        '',
      ),
    );
    if (linkedOpen)
      for (const x of links)
        slot.append(
          button(noExt(x.name), null, () => browse(x.path), 'linked-row'),
        );
  }
  function jumpHeading(text) {
    const slug = (s) =>
        decodeURIComponentSafe(String(s || ''))
          .toLowerCase()
          .replace(/[\s_-]+/g, ' ')
          .trim(),
      h = headings.find(
        (h) => slug(h.id) === slug(text) || slug(h.text) === slug(text),
      );
    if (h) {
      chosenHeading = h.id;
      editor?.command('goto', h.id);
    }
  }
  function showInspector() {
    if (!current() || isData(active) || isText(active)) return;
    const card = $('inspector');
    clearTimeout(inspectorTimer);
    card.replaceChildren();
    card.hidden = false;
    const title = el('div', 'setting-row');
    title.append(
      el('h3', '', noExt(nameOf(active))),
      button('Close inspector', 'x', () => (card.hidden = true)),
    );
    const dir = listing.get(parentOf(active)),
      modified =
        current().modified || dir?.find((x) => x.path === active)?.modified;
    const n = counts();
    card.append(
      title,
      el('small', '', modified ? 'Edited ' + timeAgo(modified) : 'Document'),
      el(
        'small',
        '',
        n.words +
          ' words · ' +
          headings.length +
          ' headings · ' +
          links.length +
          ' backlinks',
      ),
    );
    if (links.length) {
      card.append(el('div', 'group-title', 'Linked from · ' + links.length));
      for (const x of links)
        card.append(
          button(noExt(x.name), null, () => browse(x.path), 'outline-row'),
        );
    }
    if (headings.length) {
      card.append(el('div', 'group-title', 'Outline'));
      headings.forEach((h, i) => {
        const b = button(
          h.text,
          null,
          () => {
            chosenHeading = h.id;
            editor?.command('goto', h.id);
            showInspector();
          },
          'outline-row' +
            ((chosenHeading ? chosenHeading === h.id : i === 0)
              ? ' current'
              : ''),
        );
        b.style.paddingLeft = 8 + Math.max(0, h.level - 1) * 12 + 'px';
        card.append(b);
      });
    }
  }
  function decodeURIComponentSafe(s) {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  }
  let noteLookup = null,
    following = '',
    pendingSearch = null;
  function applySearchJump() {
    if (pendingSearch?.path !== active || !editor) return;
    const q = pendingSearch.query;
    pendingSearch = null;
    findBar();
    $('findbar').querySelector('input').value = q;
    runFind(true);
  }
  function lookupNotes(q, fn) {
    noteLookup = fn;
    host('searchFiles', {
      mode: 'filename',
      query: q,
      requestId: 'pick' + ++linkPickerSeq,
      workspace: roots.find((r) => pathUnder(active, r.path))?.path || '',
    });
  }
  function follow(ref) {
    ref = String(ref?.href || ref || '').trim();
    if (/^https?:|^mailto:/i.test(ref)) {
      host('openExternal', { url: ref });
      return;
    }
    ref = decodeURIComponentSafe(ref.replace(/^\[\[|\]\]$/g, '').split('|')[0]);
    if (ref.startsWith('#')) {
      jumpHeading(ref.slice(1));
      return;
    }
    if (/^[\w+-]+:/.test(ref)) return;
    const [name, hash] = ref.split('#');
    if (!name) return;
    const resolved = new URL(name, 'file://' + active).pathname,
      known = [
        ...docMap.keys(),
        ...[...listing.values()].flat().map((x) => x.path),
      ];
    const matches = (p) =>
      p === resolved ||
      noExt(p) === noExt(resolved) ||
      noExt(nameOf(p)).toLowerCase() === noExt(nameOf(name)).toLowerCase();
    const open = (p) => {
      if (hash) pendingJump = { path: p, hash };
      if (p === active) jumpHeading(hash);
      else browse(p);
    };
    const hit = known.find(matches);
    if (hit) {
      open(hit);
      return;
    }
    following = name;
    lookupNotes(noExt(nameOf(name)), (entries) => {
      if (following !== name) return;
      const row = entries.find((e) => matches(e.path));
      if (row) open(row.path);
      else toast('Linked note could not be found.');
    });
  }
  let agentSettings = null, modalOpener = null;
  function closeDialog() {
    clearTimeout(quickTimer);
    agentSettings?.dispose();
    agentSettings = null;
    dialog = '';
    onQuery = null;
    $('overlay').hidden = true;
    $('overlay').replaceChildren();
    $('layout').inert = false;
    $('bar').inert = false;
    if (modalOpener?.isConnected) modalOpener.focus({preventScroll: true});
    modalOpener = null;
  }
  function dialogBox(kind, center = false) {
    hideMenu();
    if (!dialog) modalOpener = document.activeElement;
    $('layout').inert = true;
    $('bar').inert = true;
    dialog = kind;
    const over = $('overlay');
    over.hidden = false;
    over.classList.toggle('centered', center);
    const b = el('section', 'dialog' + (center ? ' center' : ''));
    b.setAttribute('role', 'dialog');
    b.setAttribute('aria-modal', 'true');
    over.replaceChildren(b);
    return b;
  }
  const actions = [
    ['Bold', 'bold', 'bold', '⌘ B'],
    ['Italic', 'italic', 'italic', '⌘ I'],
    ['Strikethrough', 'strike', 'strikethrough', '⌘ ⇧ X'],
    ['Inline Code', 'code', 'code-xml', '⌘ E'],
    ['Use in Agent', 'agent', 'link-2', '⌘ L'],
    ['Export as PDF…', 'exportPDF', 'file-text', ''],
    ['Toggle Sidebar', 'sidebar', 'panel-left', '⌘ \\'],
    ['Focus', 'focus', 'scan', '⌘ ⇧ F'],
    ['Zoom In', 'zoomIn', 'plus', '⌘ +'],
    ['Zoom Out', 'zoomOut', 'minus', '⌘ −'],
    ['Actual Size', 'zoomReset', 'rotate-ccw', '⌘ 0'],
    ['Wide view', 'wide', 'align-horizontal-space-around', ''],
    ['Refresh Files', 'refresh', 'refresh-cw', ''],
    ['Toggle Theme', 'theme', 'sun-moon', '⌘ ⇧ L'],
    ['Add Workspace', 'openFolder', 'layers-plus', '⌘ O'],
    ['Show Workspaces', 'workspaces', 'layers-2', ''],
    ['What’s New in Samare', 'whatsNew', 'file-text', ''],
    ['Check for Updates', 'checkUpdates', 'refresh-cw', ''],
    ['Settings', 'settings', 'sliders-horizontal', '⌘ ,'],
    ['Close Tab', 'closeTab', 'x', '⌘ W'],
  ];
  function selectRow(index, scroll = false) {
    const rows = $('overlay').querySelectorAll('.choice');
    if (!rows.length) return;
    paletteIndex = (index + rows.length) % rows.length;
    rows.forEach((r, i) => {
      r.classList.toggle('current', i === paletteIndex);
    });
    if (scroll) rows[paletteIndex].scrollIntoView({ block: 'nearest' });
  }
  function drawChoices(items) {
    const box = $('choicebox');
    if (!box) return;
    box.replaceChildren();
    let prev;
    for (const [i, [label, kind, fn, shortcut, group, detail, reason]] of items.entries()) {
      if (group && group !== prev) {
        box.append(el('div', 'sect-label', group));
        prev = group;
      }
      const row = button(
        label,
        kind,
        () => {
          if (reason) return;
          closeDialog();
          fn();
        },
        'choice',
      );
      row.removeAttribute('aria-label');
      row.removeAttribute('title');
      row.append(el('span', 'grow', label));
      if (shortcut) row.append(keys(shortcut));
      if (detail || reason) row.append(el('small', 'subtle', reason || detail));
      if (reason) {
        row.setAttribute('aria-disabled', 'true');
        row.title = reason;
      }
      row.onpointermove = () => selectRow(i);
      box.append(row);
    }
    if (!items.length) box.append(el('div', 'sect-label', 'No results'));
    selectRow(0);
  }
  function searchScore(label, query) {
    const name = label.toLowerCase();
    if (!query || name === query) return 100;
    if (name.startsWith(query)) return 80;
    if (name.split(/[\s_-]+/).some(word => word.startsWith(query))) return 60;
    return name.includes(query) ? 40 : 0;
  }
  function showPalette(kind) {
    const b = dialogBox(kind),
      input = el('input', 'query');
    b.setAttribute('aria-label', kind === 'palette' ? 'Command palette' : 'Open workspace or file');
    input.placeholder =
      kind === 'palette'
        ? 'Search commands...'
        : 'Search workspaces or files...';
    input.setAttribute('aria-label', input.placeholder);
    const list = el('div', 'choices');
    list.id = 'choicebox';
    b.append(input, list);
    const render = () => {
      const q = input.value.toLowerCase().trim();
      if (kind === 'palette') {
        const rows = [];
        const workspaceView = !!active || (!!workspace && !home);
        const markdown = !!active && !isData(active) && !isText(active);
        for (const [label, cmd, glyph, shortcut] of actions) {
          if (!workspaceView && !['theme', 'openFolder', 'settings'].includes(cmd)) continue;
          if (cmd === 'wide' && !markdown) continue;
          const name = cmd === 'wide' && view().wide ? 'Standard width' : label;
          const score = Math.max(searchScore(name, q), cmd === 'wide' ? searchScore(view().wide ? 'wide view' : 'width', q) / 2 : 0);
          if (q && !score) continue;
          const reason = cmd === 'agent' ? agentUnavailable()
            : cmd === 'exportPDF' && !markdown ? 'Open a note to export it.'
            : cmd === 'focus' && !active ? 'Open a file to focus on it.' : '';
          rows.push({score, choice:[name, cmd === 'wide' && view().wide ? 'standard-width' : glyph, () => command(cmd), shortcut, '', '', reason]});
        }
        drawChoices(rows.sort((a, b) => b.score - a.score).map(row => row.choice));
        return;
      }
      const items = [];
      const rootRows = roots.map(root => ({
        root, score: Math.max(searchScore(root.name, q), searchScore(parentOf(root.path), q) / 2),
      })).filter(item => item.score).sort((a, b) => b.score - a.score);
      for (const {root:r} of rootRows)
        items.push([
          r.name,
          'layers-2',
          () => setWorkspace(r.path),
          '',
          'Workspaces',
          parentOf(r.path),
        ]);
      const paths = q
        ? quickFiles.map((x) => x.path)
        : [...new Set([...opts.recents, ...tabs])];
      // Display enough of each path to distinguish identical filenames in sibling folders.
      const locations = [...new Set([...roots.map(r => r.path), ...paths.map(parentOf)])];
      let common = locations[0] || '';
      for (const dir of locations) {
        while (common && !pathUnder(dir, common)) common = parentOf(common);
      }
      for (const p of paths)
        items.push([
          noExt(nameOf(p)),
          'file-text',
          () => openPickerFile(p),
          '',
          q ? 'Files' : 'Recent Files',
          common ? parentOf(p).slice(common.length).replace(/^\/+/, '') : parentOf(p),
        ]);
      drawChoices(items);
    };
    onQuery = render;
    filePickerQuery = '';
    quickFiles = [];
    input.oninput = () => {
      filePickerQuery = input.value;
      quickFiles = [];
      clearTimeout(quickTimer);
      const requestId = 'quick' + ++quickSeq;
      if (kind === 'quickOpen' && input.value.trim())
        quickTimer = setTimeout(
          () =>
            host('searchFiles', {
              mode: 'quickOpen',
              query: filePickerQuery,
              recent: opts.recents.slice(0, 10),
              requestId,
            }),
          65,
        );
      render();
    };
    render();
    input.focus();
  }
  function settings() {
    const old = document.querySelector('.dialog.settings');
    const focusId = old?.contains(document.activeElement) ? document.activeElement.id : '';
    const oldScroll = old?.scrollTop || 0;
    const card = $('agent-card');
    const cardScroll = card?.scrollTop || 0;
    const oldTab = card?.dataset.tab;
    if (!old || !agentSettings) {
      agentSettings?.dispose();
      agentSettings = window.createAgentSettings({el, icon, button, host, toast, refresh: settings});
    }
    const box = dialogBox('settings', true);
    box.classList.add('settings');
    box.tabIndex = -1;
    box.setAttribute('aria-label', 'Settings');
    const d = el('section', 'setting'),
      line = el('div', 'setting-row'),
      info = el('div');
    const outsideApplications = defaultApp.installedInApplications === false;
    const checking = defaultApp.installedInApplications == null;
    const heading = el('h2', '', 'Default Markdown app');
    heading.id = 'settings-default-markdown';
    d.setAttribute('aria-labelledby', heading.id);
    d.setAttribute('aria-busy', String(checking || !!defaultApp.pending));
    const detail = el('p');
    detail.setAttribute('role', 'status');
    detail.setAttribute('aria-live', 'polite');
    const action = el('div');
    action.tabIndex = -1;
    action.id = 'settings-default-action';
    let label;
    if (defaultApp.pending) {
      detail.textContent = 'Waiting for macOS to finish the change…';
      label = 'Making Samare Default…';
    } else if (defaultApp.error) {
      detail.textContent = defaultApp.error;
      label = 'Try Again';
    } else if (checking) {
      detail.textContent = 'Checking the current macOS setting…';
    } else if (outsideApplications) {
      detail.textContent = 'Install Samare in Applications to change this setting.';
    } else if (defaultApp.isDefault) {
      detail.textContent = 'Markdown files open in Samare by default.';
      const check = icon('check');
      check.removeAttribute('aria-hidden');
      check.setAttribute('role', 'img');
      check.setAttribute('aria-label', 'Samare is the default');
      action.append(check);
    } else {
      detail.textContent = 'Open Markdown files in Samare when you double-click them in Finder.';
      label = 'Make Samare Default';
    }
    if (label) {
      const change = button(label, null, () => { if (!defaultApp.pending) host('setDefault'); }, 'bttn');
      change.id = 'settings-default-button';
      change.setAttribute('aria-disabled', String(!!defaultApp.pending));
      action.append(change);
    }
    info.append(heading, detail);
    line.append(info, action);
    d.append(line);
    box.append(d, el('div', 'hr'));
    agentSettings.render(box, bridge);
    box.scrollTop = oldScroll;
    const newCard = $('agent-card');
    if (newCard && newCard.dataset.tab === oldTab) newCard.scrollTop = cardScroll;
    const focusTarget = focusId && ($(focusId) || (focusId === 'settings-default-button' && action));
    (focusTarget && !focusTarget.disabled ? focusTarget : box).focus({preventScroll: true});
  }
  function shortcuts() {
    const sheet = dialogBox('shortcuts');
    sheet.classList.add('shortcut-sheet');
    sheet.setAttribute('aria-label', 'Keyboard shortcuts');
    sheet.tabIndex = -1;
    const groups = [
      ['Navigation', [['Open command palette','⌘ K'], ['Find workspaces, files, and recents','⌘ P'], ['Show keyboard shortcuts','⌘ /']]],
      ['Files', [['New file','⌘ N'], ['Use in Agent','⌘ L'], ['Copy file path','⌃ ⌘ P'], ['Close tab','⌘ W']]],
      ['Tabs', [['Jump to tab by position','⌘ 1…8'], ['Jump to last tab','⌘ 9'], ['Previous tab','⌘ ⇧ ['], ['Next tab','⌘ ⇧ ]'], ['Reopen closed tab','⌘ ⇧ T']]],
      ['Panels', [['Toggle sidebar','⌘ \\'], ['Focus','⌘ ⇧ F'], ['Zoom in','⌘ +'], ['Zoom out','⌘ −'], ['Actual size','⌘ 0'], ['Cycle theme','⌘ ⇧ L']]],
    ];
    for (const [name, items] of groups) {
      const group = el('section'), list = el('ul');
      group.append(el('h3', '', name), list);
      for (const [label, shortcut] of items) {
        const item = el('li');
        item.append(el('span', '', label), keys(shortcut));
        list.append(item);
      }
      sheet.append(group);
    }
    sheet.focus();
  }
  const longFind = window.SamareEditor?.createDocumentFind?.(() => editor);
  function closeFind() {
    longFind?.cancel();
    const restore = $('findbar').contains(document.activeElement) ? findState?.opener : null;
    document.querySelector('.find-cell')?.classList.remove('find-cell');
    findState = null;
    $('findbar').hidden = true;
    if (restore?.isConnected) restore.focus({preventScroll: true});
    globalThis.CSS?.highlights?.delete('find-matches');
    globalThis.CSS?.highlights?.delete('find-current');
  }
  function findBar() {
    if (!active) return;
    const bar = $('findbar');
    if (findState) {
      bar.querySelector('input').focus();
      return;
    }
    bar.hidden = false;
    bar.replaceChildren();
    const input = el('input');
    input.placeholder = 'Find in page';
    input.setAttribute('aria-label', 'Find in page');
    findState = { index: 0, exact: false, ranges: [], opener: document.activeElement };
    const count = el('output');
    const toggle = button(
      'Aa',
      'case-sensitive',
      () => {
        findState.exact = !findState.exact;
        toggle.classList.toggle('active', findState.exact);
        toggle.setAttribute('aria-pressed', String(findState.exact));
        runFind(true);
      },
      'ico',
    );
    toggle.title = 'Match case';
    toggle.setAttribute('aria-label', toggle.title);
    toggle.setAttribute('aria-pressed', 'false');
    bar.append(
      input,
      count,
      toggle,
      button('Previous match', 'chevron-up', () => stepFind(-1)),
      button('Next match', 'chevron-down', () => stepFind(1)),
      button('Close find', 'x', closeFind),
    );
    input.oninput = () => runFind(true);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        stepFind(e.shiftKey ? -1 : 1);
      }
    };
    input.focus();
    runFind(true);
  }
  function runFind(reset) {
    const f = findState;
    if (!f) return;
    const q = $('findbar').querySelector('input').value;
    const root = $('editor').querySelector('.ProseMirror') || $('editor');
    if (longFind?.start(q,f.exact,(hits,pending,first) => {
      f.searching=pending; f.longResults=true; f.ranges=hits;
      if (!hits.length) {
        if (reset) f.index=0;
        globalThis.CSS?.highlights?.delete('find-matches');
        globalThis.CSS?.highlights?.delete('find-current');
      } else f.index=Math.min(f.index,hits.length-1);
      if (first) stepFind(0,reset); else displayFindCount(f);
    })) return;
    f.searching=f.longResults=false;
    f.ranges = [];
    if (reset) f.index = 0;
    const cells = q && editor?.command('findDataMatches', { query: q, caseSensitive: f.exact });
    if (Array.isArray(cells)) {
      f.ranges = cells.map(cell => ({ cell }));
      globalThis.CSS?.highlights?.delete('find-matches');
      stepFind(0, reset);
      return;
    }
    if (q) {
      const needle = f.exact ? q : q.toLowerCase();
      function matches(value, fn) {
        const s = f.exact ? value : value.toLowerCase();
        let start = 0,
          index;
        while ((index = s.indexOf(needle, start)) >= 0) {
          fn(index, index + q.length);
          start = index + q.length;
        }
      }
      const groups = new Map(),
        walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const p = n.parentElement;
        if (
          !p ||
          p.closest(
            'textarea,input,select,button,script,style,[hidden],.katex-mathml',
          ) ||
          !p.getClientRects().length
        )
          continue;
        const block =
          p.closest('p,h1,h2,h3,h4,h5,h6,pre,td,th,summary,label') || p;
        if (!groups.has(block)) groups.set(block, []);
        groups.get(block).push(n);
      }
      for (const nodes of groups.values()) {
        let total = 0;
        const boundaries = nodes.map((node) => {
          const from = total;
          total += node.length;
          return { node, from, end: total };
        });
        matches(nodes.map((n) => n.data).join(''), (i, j) => {
          const a = boundaries.find((n) => n.end > i),
            b = boundaries.find((n) => n.end >= j);
          if (!a || !b) return;
          const r = new Range();
          r.setStart(a.node, i - a.from);
          r.setEnd(b.node, j - b.from);
          f.ranges.push(r);
        });
      }
      for (const area of root.querySelectorAll(
        'textarea,input:not([type=checkbox])',
      )) {
        if (area.offsetHeight && typeof area.value === 'string')
          matches(area.value, (from, to) => f.ranges.push({ area, from, to }));
      }
    }
    if (typeof Highlight !== 'undefined')
      CSS.highlights.set(
        'find-matches',
        new Highlight(...f.ranges.filter((r) => !r.area).slice(0, 4000)),
      );
    stepFind(0, reset);
  }
  function displayFindCount(f) {
    const length = f.ranges.length;
    for (const direction of ['Previous match','Next match'])
      $('findbar').querySelector('[aria-label="' + direction + '"]').disabled = !length;
    $('findbar').querySelector('output').textContent = length
      ? f.index + 1 + ' of ' + length + (f.searching ? '…' : '')
      : f.searching ? 'Searching…' : $('findbar').querySelector('input').value
        ? 'No matches'
        : '';
  }
  function stepFind(n, scroll = true) {
    const f = findState;
    if (!f) return;
    const length = f.ranges.length;
    f.index = length ? (f.index + n + length) % length : 0;
    displayFindCount(f);
    if (!length) {
      document.querySelector('.find-cell')?.classList.remove('find-cell');
      globalThis.CSS?.highlights?.delete('find-current');
      return;
    }
    const r = f.ranges[f.index];
    if (r.cell) {
      globalThis.CSS?.highlights?.delete('find-current');
      const field = editor.command('revealDataMatch', r.cell);
      document.querySelector('.find-cell')?.classList.remove('find-cell');
      field?.classList.add('find-cell');
      if (scroll) field?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (f.longResults) {
      longFind.reveal(r,range=>{
        if (typeof Highlight !== 'undefined') CSS.highlights.set('find-current',new Highlight(range));
        if (scroll) range.startContainer.parentElement?.scrollIntoView({block:'nearest'});
      });
      return;
    }
    if (r.area) {
      document.querySelector('.find-cell')?.classList.remove('find-cell');
      r.area.classList.add('find-cell');
      try {
        r.area.setSelectionRange(r.from, r.to);
      } catch {}
      if (scroll) r.area.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (typeof Highlight !== 'undefined')
      CSS.highlights.set('find-current', new Highlight(r));
    if (scroll)
      r.startContainer.parentElement.scrollIntoView({ block: 'nearest' });
  }
  function external(p, fromSave) {
    const f = docMap.get(p.path);
    if (!f) return;
    if (fromSave) f.pending = null;
    if (Number.isFinite(p.modified)) f.modified = p.modified;
    if (p.text === f.base && !f.missing) {
      if (fromSave) submit(f);
      return;
    }
    const before = f.text,
      dirty = before !== f.base,
      wasMissing = f.missing;
    const selected = active === p.path;
    const activeReview = changeReview.snapshot();
    if (!selected) changeReview.use(f.review);
    const marked = SamareRevisionDisk.decode(p.text).length > 0;
    const solvedElsewhere = f.markOnDisk && !marked && unresolved(f) && diskText(f) === f.base;
    if (solvedElsewhere) changeReview.use(null);
    const next = solvedElsewhere ? p.text : changeReview.incoming(f.base, before, p.text, dirty);
    f.base = p.text;
    f.markOnDisk = marked;
    f.text = next;
    f.failed = false;
    f.missing = false;
    f.modified = p.modified ?? Date.now() / 1000;
    saveReview(f);
    if (!selected) changeReview.use(activeReview);
    if (active === p.path) {
      if (before !== next) editor?.setText(next);
      if (findState) runFind(false);
      changeReview.draw();
      if (!editor?.command('isHydrating')) updateCount();
      if (!$('inspector').hidden) showInspector();
      updateNotice();
      requestLinks();
    }
    if (diskText(f) !== f.base) submit(f);
    else if (wasMissing) flush();
  }
  function updateNotice() {
    const n = $('notice'),
      f = current();
    n.replaceChildren();
    n.hidden = true;
    if (!f) return;
    const action = (label, fn) => button(label, null, fn, '');
    if (f.missing) {
      n.hidden = false;
      n.append(
        'This file was removed from disk.',
        action('Save it again', () =>
          host('restoreFile', { path: f.path, text: f.text }),
        ),
        action('Close', () => finishClose(active)),
      );
      return;
    }
  }
  async function exportDoc(kind) {
    if (!active) return;
    const file = active, mounted = editor;
    editor?.command('finishHydration');
    await window.SamareDiagrams?.ready();
    if (active !== file || editor !== mounted) return;
    const source = $('editor').querySelector('.ProseMirror') || $('editor');
    const copy = source.cloneNode(true);
    const diagramCSS = window.SamareDiagrams?.preparePrint(copy, 624) || '';
    copy
      .querySelectorAll('button,select,.de-toolbar,[hidden],script,style')
      .forEach((n) => n.remove());
    for (const table of copy.querySelectorAll('table')) {
      const row = table.rows[0];
      if (!table.tHead && row?.cells.length && [...row.cells].every(cell => cell.tagName === 'TH')) {
        table.createTHead().append(row);
      }
    }
    copy.querySelectorAll('a[data-target]').forEach((a) => {
      const target = a.getAttribute('data-target');
      if (/^(https?:\/\/|mailto:|#)/i.test(target))
        a.setAttribute('href', target);
      else a.removeAttribute('href');
    });
    copy
      .querySelectorAll('[contenteditable]')
      .forEach((n) => n.removeAttribute('contenteditable'));
    copy
      .querySelectorAll('textarea,input')
      .forEach((n) => n.replaceWith(document.createTextNode(n.value || '')));
    const syntaxCSS = `
      .hljs-keyword,.hljs-selector-tag{color:#b0306a}.hljs-number,.hljs-literal,.hljs-symbol{color:#a4561f}
      .hljs-string,.hljs-regexp,.hljs-addition{color:#2c7449}.hljs-title{color:#6b44c2}
      .hljs-type,.hljs-built_in{color:#1f7389}.hljs-comment,.hljs-quote{color:#67676f;font-style:italic}
      .de-muted{color:#52525b}.de-code-wide{letter-spacing:.2em}.de-code-bold{font-weight:bold}.de-code-italic{font-style:italic}`;
    const html =
      '<!doctype html><meta charset="utf-8"><style>body{color:#222;background:white;font:12pt/1.55 -apple-system,sans-serif}h1,h2,h3,h4,h5,h6{break-after:avoid}hr{border:0;height:1px;background:rgba(24,24,27,.2);margin:30px 0}thead{display:table-header-group}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:5px 9px;text-align:left}pre,code{font-family:Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}pre,blockquote{padding:10px;background:#f5f5f5}img,svg{max-width:100%;height:auto}tr,img,svg{break-inside:avoid}a{color:#315ea0}a[href^=http]:after{content:" (" attr(href) ")";font-size:85%}.katex-html{display:none}.katex-mathml{position:static}li[data-task]{list-style:none}</style>' +
      '<style>' + syntaxCSS + diagramCSS + '</style>' + copy.outerHTML;
    host(kind, { path: active, title: noExt(nameOf(active)), html });
  }
  function command(id) {
    if (id !== 'settings' && dialog) closeDialog();
    hideMenu();
    const f = current();
    switch (id) {
      case 'palette':
      case 'quickOpen':
        showPalette(id);
        break;
      case 'settings':
        settings();
        host('defaultStatus', {reset:true});
        host('bridgeStatus');
        break;
      case 'sidebar':
        opts.sidebar = !opts.sidebar;
        if (opts.focus) opts.focus = false;
        applySettings();
        remember();
        break;
      case 'focus':
        opts.focus = !opts.focus;
        applySettings();
        remember();
        break;
      case 'theme':
        opts.theme = opts.theme === 'dark' ? 'light' : 'dark';
        applySettings();
        remember();
        break;
      case 'wide':
      case 'zoomIn':
      case 'zoomOut':
      case 'zoomReset':
        if (!f) return;
        const v = (opts.views[active] ||= {});
        if (id === 'wide') {
          if (isText(active) || isData(active)) return;
          v.wide = !v.wide;
        }
        else
          v.zoom =
            id === 'zoomReset'
              ? 1
              : Math.min(
                  2,
                  Math.max(
                    0.8,
                    Math.round(
                      ((v.zoom || 1) + (id === 'zoomIn' ? 0.1 : -0.1)) * 10,
                    ) / 10,
                  ),
                );
        applySettings();
        remember();
        break;
      case 'wordCount': {
        if (f) {
          const {words} = counts();
          toast(words.toLocaleString() + (words === 1 ? ' word' : ' words'));
        }
        break;
      }
      case 'refresh':
        refresh();
        break;
      case 'workspaces':
        home = true;
        renderSide();
        break;
      case 'find':
        findBar();
        break;
      case 'shortcuts':
        shortcuts();
        break;
      case 'newFile':
      case 'createFolder':
        host(id, workspace ? { parent: pathUnder(creationFolder, workspace) ? creationFolder : workspace } : {});
        break;
      case 'openFolder':
      case 'openFiles':
        host(id);
        break;
      case 'save':
        editor?.command('commitCell');
        if (f) {
          f.failed = false;
          submit(f);
        }
        break;
      case 'saveAs':
        editor?.command('commitCell');
        if (f) host(id, { path: active, text: f.text });
        break;
      case 'closeTab':
        if (active) closeTab(active);
        break;
      case 'reopenTab': {
        const p = closed.pop();
        if (p) browse(p);
        break;
      }
      case 'copyMD':
      case 'copyText':
      case 'copyPath':
        if (f) {
          host('copy', {
            text:
              id === 'copyPath'
                ? active
                : id === 'copyText'
                  ? visibleText()
                  : f.text,
          });
          toast({copyText:'Copied as text', copyMD:'Copied as Markdown', copyPath:'Copied file path'}[id]);
        }
        break;
      case 'reveal':
        if (f) host('reveal', { path: active });
        break;
      case 'agent':
        editor?.command('commitCell');
        if (bridge.enabled === false || bridge.commandInstalled === false) {
          command('settings');
          toast(bridge.enabled ? 'Repair Use in Agent in Settings.' : 'Enable Use in Agent in Settings.');
        } else if (f && !isText(f.path)) {
          shareAfterSave = f.path;
          shareWhenSaved(f);
        } else if (f) toast('Text files can’t be used in an agent yet.');
        else command('settings');
        break;
      case 'checkUpdates':
        host('checkUpdates');
        break;
      case 'whatsNew': {
        const b = dialogBox('whatsNew', true);
        b.classList.add('release-card');
        b.setAttribute('aria-labelledby', 'release-title');
        const title = el('h2', '', 'What’s new in Samare');
        title.id = 'release-title';
        const close = button('Close', 'x', closeDialog, 'ico release-close');
        b.append(close, el('p', 'release-version', 'Version ' + releaseVersion), title);
        const highlights = releaseVersion === '0.1.0' ? [
          ['Long notes', 'Start reading and editing while the remaining sections load.'],
          ['Quick Look', 'Preview diagrams directly in Finder.'],
          ['Changes from disk', 'Review individual edits and put them back from a browser.'],
        ] : [];
        for (const [name, detail] of highlights) b.append(el('h3', '', name), el('p', 'quiet', detail));
        const changelog = button('Samare release notes', null, () => host('openExternal', {
          url: 'https://github.com/Digidai/samare/releases',
        }), 'release-link');
        if (highlights.length) b.append(changelog);
        else b.append(el('p','quiet','Samare has been updated to version ' + releaseVersion + '.'));
        close.focus();
        if (pendingRelease) {
          pendingRelease = false;
          host('releasePresented', {version: releaseVersion});
        }
        break;
      }
      case 'exportHTML':
      case 'exportPDF':
      case 'print':
        exportDoc(id);
        break;
      default:
        editor?.command(id);
    }
  }
  function relabel(oldPath, path) {
    const move = (p) =>
      pathUnder(p, oldPath) ? path + p.slice(oldPath.length) : p;
    const oldActive = active;
    if (current() && pathUnder(active, oldPath)) {
      saveReading();
      editor?.destroy();
      editor = null;
    }
    for (const [p, f] of [...docMap])
      if (pathUnder(p, oldPath)) {
        clearTimeout(saveState.get(p));
        docMap.delete(p);
        f.path = move(p);
        if (f.hasRecovery) {
          try {
            const draft = localStorage.getItem(reviewKey(p));
            if (draft) localStorage.setItem(reviewKey(f.path),draft);
            localStorage.removeItem(reviewKey(p));
          } catch { /* The previous path still holds the recovery record. */ }
        }
        f.name = nameOf(f.path);
        docMap.set(f.path, f);
        if (f.base !== f.text) schedule(f);
      }
    tabs = tabs.map(move);
    opts.recents = opts.recents.map(move);
    for (const p of Object.keys(opts.views))
      if (pathUnder(p, oldPath)) {
        opts.views[move(p)] = opts.views[p];
        delete opts.views[p];
      }
    for (let i = 0; i < closed.length; i++) closed[i] = move(closed[i]);
    for (const p of [...expanded])
      if (pathUnder(p, oldPath)) {
        expanded.delete(p);
        expanded.add(move(p));
      }
    active = move(oldActive);
    if (active !== oldActive) {
      const next = active;
      active = '';
      activate(next);
    } else {
      renderTabs();
      renderSide();
      syncTabs();
    }
    remember();
  }
  let waitingForFirstListing = '', launchTimeout, firstPaintSent = false;
  function presentInterface() {
    if (firstPaintSent) return;
    firstPaintSent = true;
    clearTimeout(launchTimeout);
    host('firstPaint');
  }
  window.hostEvent = (type, p) => {
    switch (type) {
      case 'updateState': {
        const pill = $('update-pill');
        const installing = p.phase === 'installing';
        pill.hidden = !['available','installing','error','retryQuit'].includes(p.phase);
        pill.disabled = installing;
        pill.textContent = installing ? p.percent + '%' : p.phase === 'error' || p.phase === 'retryQuit' ? 'Retry' : 'Update';
        pill.title = p.message || ((installing ? 'Installing ' : 'Update to ') + 'Samare ' + (p.version || ''));
        pill.setAttribute('aria-label', pill.title);
        pill.onclick = () => host('installUpdate');
        if (p.message) toast(p.message);
        break;
      }
      case 'nativeFullscreen':
        setNativeFullscreen(p);
        break;
      case 'bootstrap': {
        setNativeFullscreen(p.nativeFullscreen);
        roots = p.workspaces || [];
        releaseVersion = p.version || releaseVersion;
        pendingRelease = !!p.showRelease;
        host('bridgeStatus');
        Object.assign(opts, p.settings || {});
        opts.sort ||= {};
        opts.views ||= {};
        opts.recents ||= [];
        workspace = p.activeWorkspace || roots[0]?.path || '';
        home = !workspace;
        tabs = (p.files || []).map((x) => {
          storeDoc(x);
          return x.path;
        });
        active = '';
        activate(tabs.includes(p.activePath) ? p.activePath : tabs[0] || '');
        if (workspace) {
          waitingForFirstListing = workspace;
          host('listFolder', {path:workspace});
          launchTimeout = setTimeout(presentInterface, 1000);
        } else presentInterface();
        if (pendingRelease && !dialog) command('whatsNew');
        break;
      }
      case 'workspaces':
        roots = p.workspaces || [];
        renderHome();
        if (!roots.some((r) => r.path === workspace)) {
          workspace = p.activeWorkspace || '';
          home = !workspace;
        }
        renderSide();
        break;
      case 'activeWorkspace':
        setWorkspace(p.path, false);
        break;
      case 'listing':
        listing.set(p.path, p.entries || []);
        renderSide();
        if (p.path === waitingForFirstListing) presentInterface();
        break;
      case 'document':
        openDoc(p);
        break;
      case 'saved': {
        const f = docMap.get(p.path);
        if (!f) break;
        f.base = p.text;
        f.pending = null;
        f.missing = false;
        f.failed = false;
        f.modified = p.modified ?? Date.now() / 1000;
        if (unresolved(f) && f.markOnDisk && diskText(f) === f.base) {
          try { localStorage.removeItem(reviewKey(f.path)); f.hasRecovery=false; } catch {}
        }
        if (diskText(f) !== f.base) submit(f);
        else if (closeAfter.delete(f.path)) finishClose(f.path);
        if (f.path === active) {
          updateNotice();
          if (!$('inspector').hidden) showInspector();
        }
        shareWhenSaved(f);
        flush();
        break;
      }
      case 'saveError': {
        const f = docMap.get(p.path);
        if (f) {
          f.pending = null;
          f.failed = true;
          if (shareAfterSave === p.path) shareAfterSave = '';
          closeAfter.delete(p.path);
        }
        toast(p.message);
        flush();
        break;
      }
      case 'fileMetadata': {
        const f = docMap.get(p.path);
        if (f && Number.isFinite(p.modified)) {
          f.modified = p.modified;
          if (p.path === active && !$('inspector').hidden) showInspector();
        }
        break;
      }
      case 'externalChange':
      case 'conflict':
        external(p, type === 'conflict');
        shareWhenSaved(docMap.get(p.path));
        flush();
        break;
      case 'missing': {
        const f = docMap.get(p.path);
        if (f) {
          f.missing = true;
          f.pending = null;
          shareWhenSaved(f);
          if (active === p.path) updateNotice();
        }
        flush();
        break;
      }
      case 'flush':
        saveReading();
        if (!canLeaveEditor()) {
          host('flushed', {id:p.id,ok:false});
          break;
        }
        trashTree.cancelForClose();
        flushRequest = p;
        flush();
        break;
      case 'trashBatchResult':
        trashTree.result(p);
        break;
      case 'trashStageFailed':
        trashTree.stageFailed(p);
        break;
      case 'trashed':
        for (const path of [...tabs])
          if (pathUnder(path, p.path)) finishClose(path, false);
        for (const path of docMap.keys()) if (pathUnder(path, p.path)) docMap.delete(path);
        for (const path of listing.keys()) if (pathUnder(path, p.path)) listing.delete(path);
        const parentEntries = listing.get(parentOf(p.path));
        if (parentEntries) listing.set(parentOf(p.path), parentEntries.filter(item => item.path !== p.path));
        sideResults = sideResults.filter(item => !pathUnder(item.path, p.path));
        for (let i = closed.length - 1; i >= 0; i--)
          if (pathUnder(closed[i], p.path)) closed.splice(i, 1);
        opts.recents = opts.recents.filter((path) => !pathUnder(path, p.path));
        remember();
        refresh();
        break;
      case 'renamed':
        relabel(p.oldPath, p.path);
        break;
      case 'createdFolder':
        expanded.add(p.parent);
        refresh();
        break;
      case 'searchResults':
        if (p.mode === 'backlinks' && p.requestId === linkSeq) {
          links = p.entries || [];
          renderLinks();
          if (!$('inspector').hidden) showInspector();
        } else if (
          p.mode === 'content' &&
          p.requestId === querySeq &&
          p.query === sideQuery
        ) {
          sideResults = p.entries || [];
          renderSide();
        } else if (
          p.mode === 'quickOpen' &&
          p.requestId === 'quick' + quickSeq &&
          dialog === 'quickOpen' &&
          p.query === filePickerQuery
        ) {
          quickFiles = p.entries || [];
          onQuery?.();
        } else if (
          p.mode === 'filename' &&
          p.requestId === 'pick' + linkPickerSeq
        ) {
          const cb = noteLookup;
          noteLookup = null;
          cb?.(p.entries || []);
        }
        break;
      case 'copyResult':
        agentSettings?.copyResult(p);
        break;
      case 'agentSetupRequired':
        command('settings');
        toast(p.message || 'Use in Agent setup needed');
        break;
      case 'bridgeStatus':
        bridge = p;
        updateAgentButton();
        {
          const card = $('side-agent');
          const repair = p.enabled && (p.commandInstalled === false || p.running === false ||
            !!p.portConflict || (p.issues || []).length > 0 || !!p.error);
          card.hidden = p.enabled !== false && !repair;
          card.dataset.attention = String(!!repair);
          card.querySelector('strong').textContent = repair ? 'Repair setup' : 'Use in Agent';
          card.querySelector('span').textContent = repair ? 'Agent links broke.' : 'Connect your agents.';
          card.onclick = () => command('settings');
        }
        agentSettings?.receivedStatus();
        if (dialog === 'settings') settings();
        else if (dialog === 'palette') onQuery?.();
        break;
      case 'defaultStatus':
        defaultApp = p;
        if (dialog === 'settings') settings();
        break;
      case 'agentLink':
        host('copy', { text: p.url });
        toast('Agent link copied · Paste it in your agent client.');
        break;
      case 'command':
        command(p);
        break;
      case 'exported':
        toast('Saved ' + nameOf(p.path));
        break;
      case 'error':
        toast(typeof p === 'string' ? p : p?.message || 'Operation failed.');
        break;
    }
  };
  $('side-toggle').append(icon('panel-left'));
  $('side-toggle').onclick = () => command('sidebar');
  $('drag').onmousedown = (e) => {
    if (e.button === 0 && e.detail < 2) host('dragWindow');
  };
  $('drag').ondblclick = () => host('toggleZoom');
  $('divider').onpointerdown = (e) => {
    const div = $('divider');
    div.setPointerCapture(e.pointerId);
    const move = (event) => {
      opts.sideWidth = Math.max(170, Math.min(innerWidth * 0.5, event.clientX));
      document.documentElement.style.setProperty(
        '--side',
        opts.sideWidth + 'px',
      );
    };
    div.onpointermove = move;
    div.onpointerup = () => {
      div.onpointermove = null;
      remember();
    };
  };
  $('rail').onclick = showInspector;
  $('rail').onmouseenter = () => {
    clearTimeout(inspectorTimer);
    inspectorTimer = setTimeout(showInspector, 180);
  };
  function hideInspectorSoon() {
    clearTimeout(inspectorTimer);
    inspectorTimer = setTimeout(() => ($('inspector').hidden = true), 240);
  }
  $('rail').onmouseleave = hideInspectorSoon;
  $('inspector').onmouseenter = () => clearTimeout(inspectorTimer);
  $('inspector').onmouseleave = hideInspectorSoon;
  $('overlay').onmousedown = (e) => {
    if (e.target === $('overlay')) closeDialog();
  };
  document.addEventListener('pointerdown', (e) => {
    if (menuOpen && !$('menu').contains(e.target)) hideMenu();
    if (!$('inspector').hidden && !e.target.closest('#inspector,#rail'))
      $('inspector').hidden = true;
  });
  document.addEventListener(
    'keydown',
    (e) => {
      // WebKit sends the Esc that cancels marked text with isComposing=false and keyCode 229.
      if (e.isComposing || e.keyCode === 229) return;
      // VoiceOver uses Control-Option with arrows and Return to move and interact.
      if (e.ctrlKey && e.altKey) return;
      if (e.key === 'Escape') {
        if (menuOpen) {
          hideMenu();
          e.preventDefault();
        } else if (dialog) {
          closeDialog();
          e.preventDefault();
        } else if (findState) {
          closeFind();
          e.preventDefault();
        } else if (!$('inspector').hidden) {
          $('inspector').hidden = true;
          e.preventDefault();
        } else if (!document.querySelector('.de-popover,.de-pop,.de-block-edit:focus-within')) {
          queueMicrotask(() => { if (!e.defaultPrevented && !e.isComposing) host('exitFullScreen'); });
        }
        return;
      }
      if (menuOpen && ['ArrowUp', 'ArrowDown', 'Enter'].includes(e.key)) {
        e.preventDefault();
        const items = [...$('menu').querySelectorAll('button:not(:disabled)')];
        if (e.key === 'Enter') document.activeElement?.click();
        else
          items[
            (items.indexOf(document.activeElement) +
              (e.key === 'ArrowDown' ? 1 : -1) +
              items.length) %
              items.length
          ]?.focus();
        return;
      }
      if (dialog && e.key === 'Tab') {
        const sheet = $('overlay').querySelector('.dialog');
        const items = [...sheet.querySelectorAll("button:not(:disabled), input:not(:disabled), [tabindex='0']")]
          .filter(n => n.tabIndex >= 0 && n.getClientRects().length);
        const from = document.activeElement;
        if (items.length && (e.shiftKey ? from === items[0] || from === sheet : from === items.at(-1))) {
          e.preventDefault();
          (e.shiftKey ? items.at(-1) : items[0]).focus();
        }
        return;
      }
      if ((dialog === 'palette' || dialog === 'quickOpen') && e.target.matches('.query')) {
        if (['ArrowUp', 'ArrowDown', 'Enter'].includes(e.key)) {
          e.preventDefault();
          if (e.key === 'Enter') {
            $('choicebox').querySelector('.current')?.click();
          } else
            selectRow(paletteIndex + (e.key === 'ArrowDown' ? 1 : -1), true);
          return;
        }
      }
      if (!e.metaKey || e.altKey) return;
      let cmd;
      const k = e.key.toLowerCase(),
        code = e.code;
      if (e.ctrlKey && k === 'p') cmd = 'copyPath';
      else if (
        e.shiftKey &&
        (code === 'BracketLeft' || code === 'BracketRight')
      ) {
        e.preventDefault();
        if (tabs.length)
          activate(
            tabs[
              (tabs.indexOf(active) +
                (code === 'BracketRight' ? 1 : -1) +
                tabs.length) %
                tabs.length
            ],
          );
        return;
      } else if (!e.shiftKey && /^[1-9]$/.test(k)) {
        e.preventDefault();
        const tab = k === '9' ? tabs.at(-1) : tabs[Number(k) - 1];
        if (tab) activate(tab);
        return;
      } else if (e.shiftKey)
        cmd = {
          f: 'focus',
          l: 'theme',
          t: 'reopenTab',
          s: 'saveAs',
          o: 'openFiles',
          n: 'createFolder',
          x: 'strike',
          '+': 'zoomIn',
        }[k];
      else
        cmd = {
          p: 'quickOpen',
          k: 'palette',
          l: 'agent',
          f: 'find',
          ',': 'settings',
          '\\': 'sidebar',
          '=': 'zoomIn',
          '-': 'zoomOut',
          0: 'zoomReset',
          '/': 'shortcuts',
          n: 'newFile',
          s: 'save',
          w: 'closeTab',
          o: 'openFolder',
        }[k];
      if (cmd) {
        e.preventDefault();
        command(cmd);
      }
    },
    true,
  );
  window.addEventListener('focus', () => {
    if (dialog === 'settings') host('defaultStatus');
  });
  window.addEventListener('blur', () => {
    for (const f of docMap.values()) submit(f);
  });
  applySettings();
  host('ready');
})();
