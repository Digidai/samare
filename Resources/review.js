// Revision comparisons retain their source positions while the document is edited.
const SamareRevisionDisk = (() => {
  const start = '<!-- samare:undecided yours: two versions of this part, not chosen yet. Yours first, then the new one. -->';
  const middle = '<!-- samare:undecided new -->', end = '<!-- samare:undecided end -->';
  function decode(source) {
    const pattern = new RegExp('^' + start.replaceAll('.', '\\.') + '\\r?\\n\\r?\\n([\\s\\S]*?)\\r?\\n^' +
      middle + '\\r?\\n\\r?\\n([\\s\\S]*?)\\r?\\n^' + end + '(?:\\r?\\n|$)', 'gm');
    const conflicts = Array.from(source.matchAll(pattern), m => ({start:m.index,end:m.index+m[0].length,mine:m[1],theirs:m[2]}));
    if (!conflicts.length) return SamareMerge.conflicts(source);
    // Documentation may quote the on-disk format inside a fenced code sample.
    const fences = Array.from(source.matchAll(/^ {0,3}(`{3,}|~{3,})([^\n]*)/gm));
    let i=0, fence='';
    return conflicts.filter(item => {
      while (i < fences.length && fences[i].index < item.start) {
        const [,run,after] = fences[i++];
        if (!fence) fence=run;
        else if (run.startsWith(fence) && !after.trim()) fence='';
      }
      return !fence;
    });
  }
  function project(text, items, marked = false) {
    if (!items?.length) return text;
    const nl = text.includes('\r\n') ? '\r\n' : '\n';
    let cursor = 0, result = '';
    for (const item of items) {
      result += text.slice(cursor,item.from);
      const mine = text.slice(item.from,item.to);
      result += marked ? start + nl+nl + mine + nl + middle + nl+nl + item.theirs + nl + end +
        (/\n$/.test(mine) || item.to < text.length ? nl : '') : item.theirs;
      cursor = item.to;
    }
    return result + text.slice(cursor);
  }
  return {decode, project};
})();
window.SamareRevisionDisk = SamareRevisionDisk;

window.SamareRevisionReview = function ({getEditor, commit, onStateChanged}) {
  const $ = selector => document.querySelector(selector);
  $('#merge-controls').innerHTML = `<aside id="merge-banner" hidden role="status">
  <span id="merge-message"></span><span id="merge-stepper"><button id="merge-prev" aria-label="Previous">‹</button><output></output><button id="merge-next" aria-label="Next">›</button></span>
  <span id="merge-actions"><button id="merge-show">Show changes</button><button id="merge-undo">Undo</button><button id="merge-done">Done</button><button id="keep-all">Keep all mine</button><button id="use-all">Use all new</button></span>
</aside>
<section id="merge-card" role="dialog" hidden tabindex="-1">
  <div class="merge-panes"><button id="merge-left"><b></b><small></small><span></span></button><button id="merge-right"><b></b><small></small><span></span></button></div>
  <footer><span id="merge-hint"></span><kbd>←</kbd><kbd>→</kbd><button id="keep-both">Keep both</button></footer>
</section>`;
  const banner = $('#merge-banner'), card = $('#merge-card');
  banner.prepend(window.samareGlyph('merge', 'revision-icon'));
  $('#merge-prev').replaceChildren(window.samareGlyph('chevron-left', 'revision-icon'));
  $('#merge-next').replaceChildren(window.samareGlyph('chevron-right', 'revision-icon'));
  let state, index = 0, reviewing = false, open = false, anchor, generation = 0, hasMarkers = false;
  let warning = '', reference = '', previewSide = null;

  function changes(before, after, fine = false) {
    if (before === after) return [];
    const parts = (fine ? Diff.diffChars(before, after, {timeout: 60}) : null)
      || Diff.diffLines(before, after, {timeout: 120});
    if (!parts) return [{start:0, end:before.length, before, after}];
    const result = [];
    let pos = 0, block;
    for (const part of parts) {
      if (part.added || part.removed) {
        if (!block) {
          block = {start:pos, end:pos, before:'', after:''};
          result.push(block);
        }
        if (part.added) block.after += part.value;
        else { block.before += part.value; pos += part.value.length; block.end = pos; }
      } else { block = null; pos += part.value.length; }
    }
    return result;
  }

  function remap(before, after, items) {
    if (before === after || !items.length) return;
    const edits = changes(before, after, true);
    function mapped(offset, end) {
      let delta = 0;
      for (const edit of edits) {
        if (offset < edit.start) break;
        if (offset === edit.start && (!end || edit.start !== edit.end)) return offset + delta;
        if (offset < edit.end) return edit.start + delta + Math.min(offset - edit.start, edit.after.length);
        delta += edit.after.length - edit.before.length;
      }
      return offset + delta;
    }
    for (const item of items) {
      item.from = mapped(item.from, false);
      item.to = mapped(item.to, true);
    }
  }

  function parse(markedText) {
    const items = [];
    let text = '', cursor = 0;
    for (const conflict of SamareRevisionDisk.decode(markedText)) {
      text += markedText.slice(cursor, conflict.start);
      const from = text.length;
      text += conflict.mine;
      items.push({from, to:text.length, theirs:conflict.theirs});
      cursor = conflict.end;
    }
    return {text:text + markedText.slice(cursor), items};
  }

  function applyIncoming(base, before, incoming, wasEditing) {
    const diskMarked = parse(incoming);
    const baseMarked = parse(base);
    const diskText = SamareRevisionDisk.project(diskMarked.text,diskMarked.items);
    const baseText = SamareRevisionDisk.project(baseMarked.text,baseMarked.items);
    const merged = parse(SamareMerge.merge(baseText, before, diskText));
    if (diskMarked.items.length && !merged.items.length) {
      const mine = SamareMerge.merge(diskText, merged.text, diskMarked.text);
      if (!SamareMerge.conflicts(mine).length) {
        remap(diskMarked.text,mine,diskMarked.items);
        merged.text = mine; merged.items = diskMarked.items;
      }
    }
    const previous = state?.type === 'conflict' ? state.items : [];
    remap(before, merged.text, previous);
    const remaining = previous.filter(old => !merged.items.some(fresh =>
      fresh.from <= old.to && fresh.to >= old.from));
    const conflicts = [...remaining, ...merged.items].sort((a,b) => a.from-b.from);
    index = 0;
    if (conflicts.length) {
      state = {type:'conflict', items:conflicts};
      reviewing = true; open = !diskMarked.items.length;
    } else if (wasEditing && before !== merged.text) {
      let delta = 0;
      const items = changes(before, merged.text).map(edit => {
        const start = edit.start + delta, end = start + edit.after.length;
        delta += edit.after.length - edit.before.length;
        return {...edit, start, end, from:start, to:end};
      });
      state = {type:'automatic', items, before, after:merged.text};
      reviewing = open = false;
    } else if (before !== merged.text) {
      state = null;
    }
    reference = merged.text;
    warning = '';
    return merged.text;
  }

  function advanceText(text) {
    if (state) remap(reference, text, state.items);
    reference = text;
  }

  function clearMarkers() {
    if (hasMarkers) getEditor()?.command('markRevisionBlocks',{changes:[],active:-1});
    hasMarkers = false;
    anchor = null;
  }

  function positionCard() {
    if (card.hidden) return;
    const rect = anchor?.isConnected ? anchor.getBoundingClientRect() : null;
    const width = Math.min(innerWidth - 24, (rect?.width || 624) + 12);
    card.style.width = width + 'px';
    card.style.left = Math.max(12, Math.min(innerWidth - width - 12,
      rect ? rect.left - 6 : (innerWidth - width)/2)) + 'px';
    const h = card.offsetHeight;
    const below = rect ? rect.bottom + 12 : banner.getBoundingClientRect().bottom + 10;
    const top = below + h <= innerHeight - 12 ? below : (rect?.top || below) - h - 12;
    card.style.top = Math.max(64, Math.min(innerHeight - h - 12, top)) + 'px';
  }

  function paint(scroll) {
    if (!state || !reviewing) { clearMarkers(); return; }
    const positions = state.items.map((item, i) => {
      const firstText = reference.slice(item.from, item.to).search(/\S/);
      return {offset:item.from + Math.max(0,firstText), index:i};
    });
    const item = state.items[index];
    const previewText = state.type === 'automatic' && previewSide === 'left' ? item.before :
      state.type === 'conflict' && previewSide === 'right' ? item.theirs : null;
    const preview = open && previewText !== null ? {index,text:previewText} : null;
    getEditor()?.command('markRevisionBlocks',{changes:positions, active:index, preview});
    hasMarkers = true;
    anchor = (preview && document.querySelector('.reader-change-preview')) || getEditor()?.command('elementAtSourceOffset', positions[index].offset);
    if (scroll) anchor?.scrollIntoView({block:'nearest'});
    positionCard();
  }

  function preview(button, title, meta, parts, left, fallback) {
    button.querySelector('b').textContent = title;
    button.querySelector('small').textContent = meta;
    const text = button.querySelector('span');
    text.replaceChildren();
    for (const part of parts) {
      if (left ? part.added : part.removed) continue;
      if (part.added || part.removed) {
        const mark = document.createElement('mark');
        mark.textContent = part.value;
        text.append(mark);
      } else text.append(part.value);
    }
    if (!text.textContent) text.textContent = fallback;
  }
  function draw(scroll = false) {
    const drawID = ++generation;
    onStateChanged?.();
    const conflict = state?.type === 'conflict';
    banner.hidden = !state;
    card.hidden = !state || !open;
    if (!state) { clearMarkers(); return; }
    const {items} = state, count = items.length;
    index = Math.max(0, Math.min(index, count - 1));
    const item = items[index];
    $('#merge-message').textContent = warning || (conflict
      ? (count === 1 ? 'One paragraph changed while you were writing.' : count + ' paragraphs changed while you were writing.')
      : reviewing ? 'The new version changed ' + (count === 1 ? 'one paragraph.' : count + ' paragraphs.')
        : 'A new version came in while you were writing. Both are kept.');
    $('#merge-stepper').hidden = !(reviewing && count > 1);
    $('#merge-stepper output').textContent = (index+1) + ' of ' + count;
    $('#merge-prev').disabled = !index;
    $('#merge-next').disabled = index === count - 1;
    $('#merge-show').hidden = $('#merge-undo').hidden = conflict || reviewing;
    $('#merge-done').hidden = conflict || !reviewing;
    $('#keep-all').hidden = $('#use-all').hidden = !conflict;
    $('#keep-both').hidden = !conflict;
    card.dataset.type = state.type;
    if (open) {
      card.setAttribute('aria-label', conflict ? 'Choose which version to keep' : 'What the new version changed');
      const a = (conflict ? reference.slice(item.from, item.to) : item.before).trimEnd();
      const b = (conflict ? item.theirs : item.after).trimEnd();
      const parts = Diff.diffWordsWithSpace(a,b,{timeout:40}) || [{value:a,removed:true},{value:b,added:true}];
      preview($('#merge-left'), conflict ? 'Yours' : 'Before', conflict ? 'in the note' : '', parts,true,
        conflict ? '(Deleted)' : 'This wasn’t here before.');
      preview($('#merge-right'), conflict ? 'New version' : 'Now', conflict ? 'on disk' : 'from the new version', parts,false,
        conflict ? '(Deleted)' : 'The new version deleted this.');
      $('#merge-hint').textContent = conflict ? 'Click the version to keep' : 'Review complete. Press Esc to return to the document.';
    }
    queueMicrotask(() => { if (generation === drawID) paint(scroll); });
  }

  function step(delta) {
    if (!state) return;
    warning = ''; previewSide = null;
    index = Math.max(0, Math.min(state.items.length - 1, index + delta));
    open = reviewing = true;
    draw(true);
    card.focus({preventScroll:true});
  }
  function choose(side, all = false) {
    if (!state) return;
    let text = getEditor().getText();
    advanceText(text);
    const targets = all ? [...state.items] : [state.items[index]];
    for (const item of targets.reverse()) {
      let updated = text;
      if (state.type === 'automatic' && side === 'left') {
        const undo = state.after.slice(0,item.start) + item.before + state.after.slice(item.end);
        updated = SamareMerge.merge(state.after, text, undo);
        if (SamareMerge.conflicts(updated).length) {
          warning = 'This paragraph has newer edits. Your changes are still here.';
          draw(); return;
        }
      } else if (state.type === 'conflict' && side !== 'left') {
        const mine = text.slice(item.from, item.to);
        const value = side === 'both' ? joinVersions(mine,item.theirs) : item.theirs;
        updated = text.slice(0,item.from) + value + text.slice(item.to);
      }
      state.items.splice(state.items.indexOf(item), 1);
      advanceText(updated);
      text = updated;
    }
    warning = '';
    if (!state.items.length) state = null;
    commit(text);
    draw(true);
  }
  function joinVersions(mine,theirs) {
    if (!mine || !theirs) return mine || theirs;
    const nl = (mine + theirs).includes('\r\n') ? '\r\n' : '\n';
    return mine.replace(/(?:\r?\n)*$/, '') + nl + nl + theirs;
  }
  function done() { state = null; draw(); }
  function closeCard() { open = false; previewSide = null; draw(); }
  $('#merge-prev').onclick = () => step(-1);
  $('#merge-next').onclick = () => step(1);
  $('#merge-show').onclick = () => step(0);
  $('#merge-done').onclick = done;
  $('#merge-undo').onclick = () => {
    const text = SamareMerge.merge(state.after, getEditor().getText(), state.before);
    if (SamareMerge.conflicts(text).length) {
      warning = 'Some paragraphs have newer edits. Review changes individually.';
      draw(); return;
    }
    done(); commit(text);
  };
  $('#keep-all').onclick = () => choose('left',true);
  $('#use-all').onclick = () => choose('right',true);
  $('#keep-both').onclick = () => choose('both');
  $('#merge-left').onclick = () => choose('left');
  $('#merge-right').onclick = () => choose('right');
  for (const [button,left] of [[$('#merge-left'),true],[$('#merge-right'),false]]) {
    button.onpointerenter = () => {
      if (!state || !open) return;
      previewSide = left ? 'left' : 'right';
      paint(false);
      if (state.type !== 'automatic') return;
      button.querySelector('small').textContent = left ? 'Click to put back' : 'Click to keep';
      $('#merge-hint').textContent = left ? 'Previewing what was there before' : 'Previewing the new version';
    };
    button.onpointerleave = () => {
      if (!state || !open) return;
      previewSide = null; paint(false);
      if (state.type !== 'automatic') return;
      button.querySelector('small').textContent = left ? '' : 'from the new version';
      $('#merge-hint').textContent = 'Review complete. Press Esc to return to the document.';
    };
  }
  document.addEventListener('click', event => {
    if (!state || !reviewing || card.contains(event.target) || banner.contains(event.target)) return;
    const node = event.target.closest('[data-review-change]');
    if (node) { index = Number(node.dataset.reviewChange); step(0); }
    else if (open) closeCard();
  });
  document.addEventListener('keydown', event => {
    if (!open || !state || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Escape') { event.preventDefault(); closeCard(); }
    else if (['ArrowLeft','ArrowRight'].includes(event.key) && !event.target.closest('input,textarea,[contenteditable=true]')) {
      event.preventDefault(); choose(event.key === 'ArrowLeft' ? 'left' : 'right');
    }
  });
  document.addEventListener('scroll',positionCard,{passive:true,capture:true});
  addEventListener('resize',positionCard);
  return {
    snapshot:() => state ? {state, index, reviewing, open, reference, warning} : null,
    use(session) {
      previewSide = null; state = session?.state || null; index = session?.index || 0;
      reviewing = !!session?.reviewing; open = !!session?.open;
      reference = session?.reference || ''; warning = session?.warning || '';
    },
    draw,
    incoming:applyIncoming, update(text) { advanceText(text); draw(); },
    unresolved:() => state?.type === 'conflict',
    disk:(text,marked=false) => SamareRevisionDisk.project(text,state?.type === 'conflict' ? state.items : null,marked),
    recovery:() => state?.type === 'conflict' ? state.items : null,
    restore(text, items) {
      if (!Array.isArray(items) || !items.length || !items.every(item =>
        Number.isInteger(item.from) && item.from >= 0 && Number.isInteger(item.to) &&
        item.to >= item.from && item.to <= text.length && typeof item.theirs === 'string')) return;
      state = {type:'conflict',items}; reference = text;
      reviewing = true; open = false;
    },
    readMarkers(text) {
      const parsed = parse(text);
      if (parsed.items.length) {
        state = {type:'conflict',items:parsed.items}; reference = parsed.text;
        reviewing = true; open = false;
      }
      return parsed.text;
    },
  };
};
