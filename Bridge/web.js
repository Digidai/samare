'use strict';

window.SamareBrowserReader = function ({
  getEditor,
  getHeadings,
  beforeNavigate,
}) {
  const $ = (selector) => document.querySelector(selector);
  const root = $('#document');
  const input = $('#find input');
  const search = $('#find');
  const inspector = $('#inspector');
  const panel = $('#inspector-panel');
  let name = '',
    closeTimer,
    activeHeading = '',
    headingsKey = '',
    outlineFrame;
  let matches = [],
    index = 0,
    currentField,
    caseSensitive = false;
  const longFind = window.SamareEditor?.createDocumentFind?.(getEditor);
  let longResults=false, searching=false;
  let frame,
    restoreFocus,
    countedText,
    cachedStats,
    sourceStats = false;

  // Only entries created by following a link inside this tab belong to its document history.
  const pendingKey = 'samare-reader-next';
  let entry = history.state?.samareReader;
  if (!entry) {
    try {
      const pending = JSON.parse(sessionStorage.getItem(pendingKey));
      sessionStorage.removeItem(pendingKey);
      if (
        pending?.to === location.pathname &&
        Date.now() - pending.time < 30000
      ) {
        entry = pending.entry;
        sessionStorage.setItem(
          'samare-reader-history/' + entry.group,
          String(entry.index),
        );
      }
    } catch {}
    entry ||= { group: window.SamareEditor.randomSessionID(), index: 0 };
    history.replaceState({ ...history.state, samareReader: entry }, '');
  }
  const highKey = 'samare-reader-history/' + entry.group;
  function updateNavigation() {
    let last = entry.index;
    try {
      last = Math.max(last, Number(sessionStorage.getItem(highKey)) || 0);
    } catch {}
    $('#doc-back').disabled = entry.index === 0;
    $('#doc-forward').disabled = entry.index >= last;
  }
  function syncNavigation() {
    if (history.state?.samareReader) entry = history.state.samareReader;
    updateNavigation();
  }
  window.addEventListener('pageshow', syncNavigation);
  window.addEventListener('popstate', syncNavigation);
  updateNavigation();
  for (const [id, direction] of [
    ['doc-back', -1],
    ['doc-forward', 1],
  ]) {
    $('#' + id).onclick = async () => {
      if (await beforeNavigate()) history.go(direction);
    };
  }
  function navigate(url) {
    const next = new URL(url, location.href);
    if (next.origin !== location.origin || !/^\/d\/[\w-]+$/.test(next.pathname))
      return;
    const item = { group: entry.group, index: entry.index + 1 };
    try {
      sessionStorage.setItem(
        pendingKey,
        JSON.stringify({ time: Date.now(), to: next.pathname, entry: item }),
      );
    } catch {}
    location.assign(next.href);
  }

  function openInspector() {
    if (inspector.hidden) return;
    clearTimeout(closeTimer);
    panel.hidden = false;
    $('#inspector-edge').setAttribute('aria-expanded', 'true');
    syncOutline();
  }
  function closeInspector() {
    clearTimeout(closeTimer);
    panel.hidden = true;
    $('#inspector-edge').setAttribute('aria-expanded', 'false');
  }
  inspector.onpointerenter = openInspector;
  inspector.onpointerleave = () => {
    closeTimer = setTimeout(closeInspector, 90);
  };
  inspector.onfocusin = openInspector;
  inspector.onfocusout = (e) => {
    if (!inspector.contains(e.relatedTarget)) closeInspector();
  };
  $('#inspector-close').onclick = closeInspector;
  $('#inspector-edge').onclick = () =>
    panel.hidden ? openInspector() : closeInspector();
  document.addEventListener('pointerdown', (event) => {
    if (!inspector.contains(event.target)) closeInspector();
  });

  function quantity(n, unit) {
    return n.toLocaleString('en') + ' ' + unit + (n === 1 ? '' : 's');
  }
  function selectHeading(id) {
    activeHeading = id;
    for (const button of $('#outline').children) {
      if (button.dataset.heading === id)
        button.setAttribute('aria-current', 'location');
      else button.removeAttribute('aria-current');
    }
  }
  function syncOutline() {
    if (panel.hidden) return;
    const nodes = root.querySelectorAll(
      '.ProseMirror h1,.ProseMirror h2,.ProseMirror h3,.ProseMirror h4,.ProseMirror h5,.ProseMirror h6',
    );
    if (!nodes.length) return;
    const page = document.scrollingElement;
    const bar = document
      .querySelector('body > header')
      .getBoundingClientRect().bottom;
    const threshold = bar + (innerHeight - bar) * 0.3;
    let i = 0;
    if (page.scrollHeight - page.clientHeight - page.scrollTop <= 1)
      i = nodes.length - 1;
    else
      while (
        i + 1 < nodes.length &&
        nodes[i + 1].getBoundingClientRect().top <= threshold
      )
        i++;
    const id = getHeadings()[i]?.id;
    if (id && activeHeading !== id) selectHeading(id);
  }
  function queueOutline() {
    if (panel.hidden) return;
    cancelAnimationFrame(outlineFrame);
    outlineFrame = requestAnimationFrame(syncOutline);
  }
  window.addEventListener('scroll', queueOutline, { passive: true });
  window.addEventListener('resize', queueOutline);
  function updateStats() {
    const editor = getEditor();
    const visible = !!editor && /\.(md|mkd|mdown|markdown)$/i.test(name);
    inspector.hidden = $('#word-count').hidden = !visible;
    if (!visible) return;
    const text = editor.getText();
    if (
      countedText !== text ||
      (sourceStats && editor.command('getMode') !== 'source')
    ) {
      countedText = text;
      cachedStats = editor.command('getStats');
      sourceStats = !Number.isFinite(cachedStats?.words);
      if (sourceStats) {
        // Source mode exposes raw Markdown. Count that representation in a single pass.
        const value = text.trim();
        let words = 0,
          chars = 0;
        for (const token of value.matchAll(
          /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu,
        ))
          if (/[\p{L}\p{N}]/u.test(token[0])) words++;
        for (const char of value) chars++;
        cachedStats = { words, chars };
      }
    }
    const stats = cachedStats;
    $('#word-count').title = sourceStats
      ? 'Source text statistics'
      : 'Document statistics';
    const wordLabel = quantity(stats.words, 'word');
    $('#word-count').textContent =
      wordLabel + ' · ' + quantity(stats.chars, 'character');
    $('#inspector-title').textContent = name;
    const headings = getHeadings(),
      key = JSON.stringify(headings);
    $('#inspector-metrics').replaceChildren(
      ...[wordLabel, quantity(headings.length, 'heading')].map((label) => {
        const item = document.createElement('span');
        item.textContent = label;
        return item;
      }),
    );
    if (headingsKey === key) return;
    headingsKey = key;
    const list = $('#outline');
    list.replaceChildren();
    if (!headings.some((h) => h.id === activeHeading))
      activeHeading = headings[0]?.id || '';
    for (const h of headings) {
      const button = document.createElement('button');
      button.textContent = h.text;
      button.style.paddingInlineStart =
        14 + Math.max(0, h.level - 1) * 12 + 'px';
      button.dataset.heading = h.id;
      if (h.id === activeHeading)
        button.setAttribute('aria-current', 'location');
      button.onclick = () => {
        selectHeading(h.id);
        editor.command('goto', h);
      };
      list.append(button);
    }
    if (!headings.length) {
      const empty = document.createElement('p');
      empty.textContent = 'No headings';
      list.append(empty);
    }
    syncOutline();
  }

  function clearField() {
    currentField?.classList.remove('reader-find-cell');
    currentField = null;
  }
  function clearHighlights() {
    clearField();
    globalThis.CSS?.highlights?.delete('reader-matches');
    globalThis.CSS?.highlights?.delete('reader-current');
  }
  function textMatches(pattern, value, append) {
    pattern.lastIndex = 0;
    let hit;
    while ((hit = pattern.exec(value)))
      append(hit.index, hit.index + hit[0].length);
  }
  function rangeFor(hit) {
    const { parts, from, to } = hit;
    const a = parts.find((p) => p.end > from),
      b = parts.find((p) => p.end >= to);
    if (!a || !b || !a.node.isConnected || !b.node.isConnected) return null;
    const range = new Range();
    range.setStart(a.node, from - a.start);
    range.setEnd(b.node, to - b.start);
    return range;
  }
  function collect() {
    const editor = getEditor();
    if (!editor || !input.value) return [];
    const data = editor.command('findDataMatches', {
      query: input.value,
      caseSensitive,
    });
    if (Array.isArray(data)) return data;
    const target =
      root.querySelector('.ProseMirror,.de-source') ||
      root.querySelector('.de-sheet');
    if (!target) return [];
    const expression = input.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(expression, caseSensitive ? 'gu' : 'giu');
    const found = [];
    const fields = target.matches('textarea')
      ? [target]
      : target.querySelectorAll('textarea,input:not([type=checkbox])');
    for (const field of fields) {
      if (field.getClientRects().length)
        textMatches(pattern, field.value, (from, to) =>
          found.push({ field, from, to }),
        );
    }
    if (target.matches('textarea')) return found;
    const groups = new Map();
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode,
        parent = node.parentElement;
      if (
        !parent ||
        parent.closest(
          'button,textarea,input,.katex-mathml,select,script,style,[hidden]',
        ) ||
        !parent.getClientRects().length
      )
        continue;
      const block =
        parent.closest('p,h1,h2,h3,h4,h5,h6,pre,td,th,label') || parent;
      if (!groups.has(block)) groups.set(block, []);
      groups.get(block).push(node);
    }
    for (const nodes of groups.values()) {
      let size = 0;
      const parts = nodes.map((node) => {
        const start = size;
        size += node.length;
        return { node, start, end: size };
      });
      textMatches(
        pattern,
        nodes.map((node) => node.data).join(''),
        (from, to) => found.push({ parts, from, to }),
      );
    }
    return found;
  }
  function revealField(field, hit) {
    if (field.matches('input,textarea'))
      field.setSelectionRange(hit.from, hit.to);
    if (!field.matches('.de-source')) {
      field.scrollIntoView({ block: 'center', inline: 'nearest' });
      return;
    }
    const style = getComputedStyle(field),
      mirror = document.createElement('div');
    Object.assign(mirror.style, {
      position: 'fixed',
      visibility: 'hidden',
      top: '0',
      left: '0',
      width: field.clientWidth + 'px',
      boxSizing: 'border-box',
      padding: style.padding,
      font: style.font,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      tabSize: style.tabSize,
      whiteSpace: 'pre-wrap',
      overflowWrap: 'break-word',
    });
    const marker = document.createElement('span');
    marker.textContent = '\u200b';
    mirror.append(
      document.createTextNode(field.value.slice(0, hit.from)),
      marker,
    );
    document.body.append(mirror);
    const offset =
      marker.getBoundingClientRect().top - mirror.getBoundingClientRect().top;
    mirror.remove();
    field.scrollTop = Math.max(0, offset - field.clientHeight / 2);
    window.scrollBy(
      0,
      field.getBoundingClientRect().top +
        offset -
        field.scrollTop -
        innerHeight / 2,
    );
  }
  function displayCount() {
    const count = matches.length;
    $('#find output').textContent = count
      ? index + 1 + ' of ' + count + (searching ? '…' : '')
      : searching ? 'Searching…' : input.value
        ? 'No matches'
        : '';
    $('#find-prev').disabled = $('#find-next').disabled = !count;
  }
  function displayMatch(scroll) {
    displayCount();
    clearField();
    const count=matches.length;
    globalThis.CSS?.highlights?.delete('reader-current');
    if (!count) return;
    const hit = matches[index];
    function showRange(range) {
      if (!range) return;
      if (typeof Highlight !== 'undefined')
        CSS.highlights.set('reader-current', new Highlight(range));
      if (scroll)
        range.startContainer.parentElement.scrollIntoView({
          block: 'center',
          inline: 'nearest',
        });
    }
    if (longResults) { longFind.reveal(hit,showRange); return; }
    if (hit.parts) { showRange(rangeFor(hit)); return; }
    if (!scroll && !hit.field) return;
    const field = hit.field || getEditor().command('revealDataMatch', hit);
    if (!field?.classList) return;
    currentField = field;
    field.classList.add('reader-find-cell');
    if (scroll) revealField(field, hit);
  }
  function searchFor(reset, scroll) {
    if (search.hidden) return;
    if (longFind?.start(input.value,caseSensitive,(hits,pending,first) => {
      searching=pending; longResults=true;
      matches=hits;
      if (!hits.length) {
        clearHighlights();
        if (reset) index=0;
      } else index=Math.min(index,hits.length-1);
      if (first) displayMatch(scroll); else displayCount();
    })) return;
    searching=longResults=false;
    clearHighlights();
    matches = collect();
    index = reset ? 0 : Math.min(index, Math.max(0, matches.length - 1));
    if (typeof Highlight !== 'undefined') {
      const ranges = matches
        .slice(0, 2000)
        .filter((hit) => hit.parts)
        .map(rangeFor)
        .filter(Boolean);
      CSS.highlights.set('reader-matches', new Highlight(...ranges));
    }
    displayMatch(scroll);
  }
  function step(direction) {
    if (!matches.length) return;
    index = (index + direction + matches.length) % matches.length;
    displayMatch(true);
  }
  function showSearch() {
    if (!getEditor()) return;
    if (search.hidden) restoreFocus = document.activeElement;
    closeInspector();
    search.hidden = false;
    input.focus({ preventScroll: true });
    input.select();
    searchFor(true, true);
  }
  function hideSearch() {
    longFind?.cancel(); searching=longResults=false;
    search.hidden = true;
    matches = [];
    clearHighlights();
    if (restoreFocus?.isConnected && restoreFocus !== document.body)
      restoreFocus.focus({ preventScroll: true });
  }
  search.onmousedown = (event) => {
    if (event.target.closest('button')) event.preventDefault();
  };
  input.oninput = () => searchFor(true, true);
  $('#find-case').onclick = () => {
    caseSensitive = !caseSensitive;
    $('#find-case').setAttribute('aria-pressed', String(caseSensitive));
    searchFor(true, true);
  };
  $('#find-close').onclick = hideSearch;
  $('#find-next').onclick = () => step(1);
  $('#find-prev').onclick = () => step(-1);
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'f' &&
        getEditor()
      ) {
        event.preventDefault();
        showSearch();
        return;
      }
      if (!search.hidden && event.key === 'Escape') {
        event.preventDefault();
        hideSearch();
      } else if (
        !search.hidden &&
        event.key === 'Enter' &&
        event.target === input
      ) {
        event.preventDefault();
        step(event.shiftKey ? -1 : 1);
      } else if (event.key === 'Escape' && !panel.hidden) closeInspector();
    },
    true,
  );
  function refresh() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (!getEditor()?.command('isHydrating')) updateStats();
      searchFor(false, false);
    });
  }
  return {
    navigate,
    refresh,
    loaded(fileName) {
      name = fileName;
      refresh();
    },
  };
};

(() => {
  "use strict";
  const id = location.pathname.split("/").pop();
  const api = "/api/" + id;
  const $ = (selector) => document.querySelector(selector);
  const glyph = name => window.samareGlyph(name, 'reader-glyph');
  for (const [selector,name] of Object.entries({
    '#doc-back':'chevron-left','#doc-forward':'chevron-right','#open':'dock','#copy':'clipboard',
    '#find-case':'case-sensitive','#find-prev':'chevron-up','#find-next':'chevron-down','#find-close':'x',
    '.find-icon':'search','#inspector-close':'x','#dismiss':'x','#mode':'code'
  })) $(selector).replaceChildren(glyph(name));
  $('#inspector-panel h3 svg').replaceWith(glyph('list-tree'));
  const status = message => {
    const target = $('.status');
    target.textContent = message;
    target.dataset.ready = String(message === "Ready");
    if (message === "Ready") target.prepend(glyph('circle-check'));
  };
  let editor, version, base, timer, saving = false, polling = false, dirty = false, mode = "edit";
  let applying = false, headings = [];
  let displayPath = "", attention = null, noticeDismissed = false;
  const reader = window.SamareBrowserReader({getEditor:()=>editor, getHeadings:()=>headings, beforeNavigate});
  const changeReview = window.SamareRevisionReview({getEditor:()=>editor, commit:text=>{replaceText(text);changed();}});
  const reviewSession = window.SamareEditor.randomSessionID();
  let keepMarkers = false, staged = null, pendingStage = null;
  function diskText() { return changeReview.disk(editor.getText(),keepMarkers); }
  function prepareReview() {
    pendingStage = null;
    if (keepMarkers || !changeReview.unresolved()) return;
    const marked = changeReview.disk(editor.getText(),true);
    if (new Blob([JSON.stringify({version,text:marked})]).size > 60000) pendingStage = marked;
  }
  const noticeText = {
    deleted: "The file was removed. Your edits are available in this tab.",
    save: "This note could not be saved.",
    offline: "The local bridge is disconnected. If it stays offline, get a fresh link from Samare."
  };
  function showNotice(reason) {
    if (attention !== reason) noticeDismissed = false;
    attention = reason;
    clearTimeout(timer);
    $("#notice-text").textContent = noticeText[reason];
    $("#retry").hidden = reason !== "save";
    $("#notice").hidden = noticeDismissed;
    status("Needs attention");
  }
  function clearNotice() {
    attention = null;
    noticeDismissed = false;
    $("#notice").hidden = true;
  }
  $("#dismiss").onclick = () => {
    noticeDismissed = true;
    $("#notice").hidden = true;
  };
  $("#retry").onclick = () => {
    if (attention !== "save") return;
    clearNotice();
    save();
  };
  function gotoHeading(value){
    if(!value)return;
    const slug=s=>s.trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu,"").replace(/\s+/g,"-");
    const target=headings.find(h=>h.text===value||slug(h.text)===slug(value)||h.id===value);
    if(target)editor.command("goto",target);
  }
  async function beforeNavigate() {
    editor?.command("commitCell");
    if (changeReview.unresolved()) { keepMarkers=true; changed(); }
    while (saving || polling || dirty) {
      if (attention && dirty) return false;
      if (saving || polling) await new Promise(resolve => window.addEventListener("reader-idle", resolve, {once:true}));
      else await save();
    }
    return true;
  }
  async function openReference(ref){
    try {
      const externalURL=new URL(ref);
      if (externalURL.origin === location.origin && /^\/d\/[\w-]+$/.test(externalURL.pathname)) {
        if (externalURL.pathname === location.pathname) gotoHeading(decodeURIComponent(externalURL.hash.slice(1)));
        else if (await beforeNavigate()) reader.navigate(externalURL);
      } else if(["https:","http:","mailto:"].includes(externalURL.protocol))window.open(externalURL.href,"_blank","noopener,noreferrer");
      return;
    }catch{}
    if(ref.startsWith("#")){
      try{gotoHeading(decodeURIComponent(ref.slice(1)));}catch{}
      return;
    }
    try{
      if(!await beforeNavigate())return;
      const res=await fetch("/link/"+id+"?ref="+encodeURIComponent(ref));
      if(!res.ok){status("Linked document unavailable");return;}
      const target=await res.json();
      if(target.id===id){gotoHeading(target.heading);return;}
      reader.navigate("/d/"+target.id+(target.heading?"#"+encodeURIComponent(target.heading):""));
    }catch{status("Linked document unavailable");}
  }
  const options = window.matchMedia("(prefers-color-scheme: dark)");
  function theme() {
    let saved = localStorage.getItem("samare-appearance") || "system";
    let current = saved === "system" ? (options.matches ? "dark" : "light") : saved;
    document.documentElement.dataset.theme = current;
    document.documentElement.classList.toggle("dark", current === "dark");
    const toggle = $('#theme');
    toggle.replaceChildren(glyph(current === 'dark' ? 'moon' : 'sun'));
    editor?.updateSettings?.({theme:current});
  }
  $("#theme").onclick = () => {
    let current = localStorage.getItem("samare-appearance") || "system";
    localStorage.setItem("samare-appearance", {system:"light", light:"dark", dark:"system"}[current]);
    theme();
  };
  if (options.addEventListener) options.addEventListener("change", theme);
  theme();
  $("#open").onclick = async () => {
    const button = $("#open");
    button.disabled = true;
    try {
      if (!editor || !await beforeNavigate()) return;
      const response = await fetch("/api/docs/" + id + "/open-in-app", {
        method: "POST", headers: {"Content-Type": "application/json"}, body: "{}"
      });
      if (!response.ok) throw new Error("Open failed");
    } catch {
      status("Could not open in Samare");
    } finally {
      button.disabled = false;
    }
  };
  $("#copy").onclick = $("#breadcrumb").onclick = async () => {
    if (!displayPath) return;
    try{await navigator.clipboard.writeText(displayPath);status("Path copied");}catch{status("Clipboard unavailable");}
  };
  $("#mode").onclick = () => {
    if (!editor) return;
    mode = mode === "source" ? "edit" : "source";
    editor.command("mode", mode);
    reader.refresh();
    $("#mode").setAttribute("aria-pressed", String(mode === "source"));
    $("#mode").title = mode === "source" ? "Show document" : "Show source";
    $("#mode").setAttribute("aria-label", $("#mode").title);
  };

  function replaceText(text) {
    if (editor.getText() === text) return;
    applying = true;
    try { editor.setText(text); } finally { applying = false; }
  }

  function ready() {
    status(attention || changeReview.unresolved() ? "Needs attention" : "Ready");
  }
  function rememberDraft(closingReviewSession) {
    try {
      if (dirty || changeReview.unresolved()) {
        sessionStorage.setItem("draft-"+id, JSON.stringify({base, text:editor.getText(), conflicts:changeReview.recovery(), closingReviewSession}));
      } else sessionStorage.removeItem("draft-"+id);
      return true;
    } catch { return false; }
  }
  function changed() {
    const text = editor.getText();
    reader.refresh();
    changeReview.update(text);
    if (!changeReview.unresolved()) keepMarkers = false;
    dirty = diskText() !== base;
    prepareReview();
    if (!dirty && attention === "save") clearNotice();
    if ((dirty || staged !== pendingStage) && !attention) { status("Editing"); schedule(); }
    else ready();
    rememberDraft();
  }
  function external(data) {
    if (data.version === version) return;
    const mine = editor.getText();
    const marked = SamareRevisionDisk.decode(data.text).length > 0;
    const solvedElsewhere = keepMarkers && !marked && !dirty && changeReview.unresolved();
    if (solvedElsewhere) changeReview.use(null);
    const text = solvedElsewhere ? data.text : changeReview.incoming(base, mine, data.text, mine !== base);
    keepMarkers = marked;
    base = data.text; version = data.version;
    replaceText(text);
    changed();
  }

  function schedule() {
    if(attention)return;
    clearTimeout(timer);
    timer=setTimeout(save,450);
  }
  async function current(closingSession) {
    const endpoint = typeof closingSession === "string" && /^[a-f0-9]{32}$/.test(closingSession) ?
      api + "?reviewSession=" + closingSession : api;
    const response=await fetch(endpoint,{cache:"no-store"});
    if(!response.ok){
      const error=Error("The document could not be opened.");
      error.status=response.status;
      throw error;
    }
    return response.json();
  }
  async function save() {
    if((!dirty && staged === pendingStage)||saving||polling||attention)return;
    const text=diskText(), sentVersion=version, prepared=pendingStage;
    const body={text,version:sentVersion};
    if (prepared !== null || staged !== null) { body.reviewSession=reviewSession; body.preparedReview=prepared; }
    saving=true;status("Saving…");
    try{
      const response=await fetch(api,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
      if(response.status===409){external(await current());return;}
      if(!response.ok){showNotice(response.status===404?"deleted":"save");return;}
      version=(await response.json()).version; base=text; staged=prepared;
      dirty=diskText()!==text;rememberDraft();if(dirty)status("Saving…");else ready();
    }catch{showNotice("offline");}
    finally{saving=false;window.dispatchEvent(new Event("reader-idle"));if((dirty || staged !== pendingStage) && !attention)schedule();}
  }
  async function poll(){
    if(!editor||saving||polling||document.hidden)return;
    polling=true;
    try{
      const res=await fetch(api,{headers:{"If-None-Match":'"'+version+'"'},cache:"no-store"});
      if(res.status===404){showNotice("deleted");return;}
      if(res.status!==200 && res.status!==304){showNotice("offline");return;}
      if(attention==="deleted" || attention==="offline")clearNotice();
      if(res.status===200)external(await res.json());
      if(!dirty)ready();
    }catch{showNotice("offline");}
    finally{polling=false;window.dispatchEvent(new Event("reader-idle"));if(dirty)schedule();}
  }
  window.addEventListener("pagehide", () => {
    if (!changeReview.unresolved()) return;
    const marked=changeReview.disk(editor.getText(),true);
    if (base === marked) { try { sessionStorage.removeItem("draft-"+id); } catch {} return; }
    rememberDraft(reviewSession);
    const full=new Blob([JSON.stringify({text:marked,version,reviewSession,closeReview:true})],{type:"application/json"});
    let packet = full;
    if (full.size > 60000) {
      // A long document can still have a very small pending paragraph. Trim the
      // unchanged prefix and suffix before using the pre-staged large payload.
      let from = 0, tail = 0;
      while (from < base.length && from < marked.length && base[from] === marked[from]) from++;
      while (tail < base.length-from && tail < marked.length-from && base[base.length-1-tail] === marked[marked.length-1-tail]) tail++;
      const low = code => code >= 0xdc00 && code <= 0xdfff;
      if (from && low(base.charCodeAt(from))) from--;
      if (tail && low(base.charCodeAt(base.length-tail))) tail--;
      const patch = {from,to:base.length-tail,text:marked.slice(from,marked.length-tail)};
      packet = new Blob([JSON.stringify({version,reviewPatch:patch,reviewSession,closeReview:true})],{type:"application/json"});
      if (packet.size > 60000) packet = new Blob([JSON.stringify({finishReview:true,reviewSession})],{type:"application/json"});
    }
    navigator.sendBeacon(api,packet);
  });
  window.addEventListener("beforeunload",e=>{editor?.command("commitCell");if((dirty && !(changeReview.unresolved() && rememberDraft()))||saving||pendingStage!==staged||editor?.command("hasCSVRecovery")){e.preventDefault();e.returnValue="";}});
  window.addEventListener("focus",poll);
  document.addEventListener("visibilitychange",()=>{if(document.hidden){editor?.command("commitCell");save();}else poll();});
  async function openDocument(){
    status("Opening…");
    let draft;
    try { draft=JSON.parse(sessionStorage.getItem("draft-"+id)); } catch {}
    const data=await current(draft?.closingReviewSession);
    if (data.reviewClosed) {
      draft=null;
      try { sessionStorage.removeItem("draft-"+id); } catch {}
    }
    document.title=data.name+" · Samare"; $(".filename").textContent=data.name;
    displayPath=data.displayPath || data.name;
    $("#breadcrumb").textContent=displayPath;
    $("#breadcrumb").setAttribute("aria-label","Copy file path: "+displayPath);
    $("#breadcrumb").title="Copy file path: "+displayPath;
    $("#breadcrumb").disabled=$("#copy").disabled=false;
    version=data.version;base=data.text;keepMarkers=SamareRevisionDisk.decode(base).length>0;
    $("#document").dataset.kind=/\.(csv|tsv)$/i.test(data.name)?"table":"note";
    editor=window.SamareEditor.mount($("#document"),{path:data.name,text:data.text,sessionRecovery:id,
      settings:{theme:document.documentElement.dataset.theme},
      onChange:()=>{if(!applying&&editor)changed();},
      assetURL:ref=>"/image/"+id+"?ref="+encodeURIComponent(ref),
      onOutline:items=>{headings=items;reader.refresh();},onHydrated:()=>reader.refresh(),onLink:openReference
    });
    try{
      if(draft&&typeof draft.base==="string"&&typeof draft.text==="string"){
        changeReview.restore(draft.text,draft.conflicts);
        const text = draft.base === base ? draft.text : changeReview.incoming(draft.base,draft.text,base,true);
        replaceText(text);
        changed();
      } else {
        const clean = changeReview.readMarkers(base);
        if (clean !== base) { replaceText(clean); changed(); }
      }
    }catch{}
    reader.loaded(data.name);
    if(!dirty)ready();
    if(location.hash){try{gotoHeading(decodeURIComponent(location.hash.slice(1)));}catch{}}
    setInterval(poll,1800);
  }
  function unavailable(error){
    status("Unavailable");
    const panel=document.createElement("section");
    panel.className="bridge-error";
    const title=document.createElement("h2"), message=document.createElement("p");
    const missing=error.status===404;
    title.textContent=missing?"This document was moved or deleted":"This document is unavailable";
    message.textContent=missing?"Samare could not find the file at its saved location.":"Check the local bridge and try opening this document again.";
    const retry=document.createElement("button");
    retry.textContent="Retry";
    retry.onclick=()=>{
      retry.disabled=true;
      openDocument().catch(unavailable);
    };
    panel.append(title,message,retry);
    $("#document").replaceChildren(panel);
  }
  openDocument().catch(unavailable);
})();
