// Three-way edits are expressed in base-document coordinates. Overlapping line
// changes are retried at character granularity before asking for a decision.
(function (root) {
  const diff =
    root.Diff ||
    (typeof require === 'function' && require('./lib/diff.min.js'));
  const delimiters = ['<<<<<<< Your version', '=======', '>>>>>>> New version'];
  function edits(a, b, fine) {
    let chunks = fine
      ? diff.diffChars(a, b, { timeout: 90 })
      : diff.diffLines(a, b, { timeout: 160 });
    if (!chunks) return [{ start: 0, end: a.length, text: b }];
    const result = [];
    let offset = 0,
      pending;
    for (const part of chunks) {
      if (part.added || part.removed) {
        pending ||= { start: offset, end: offset, text: '' };
        if (part.added) pending.text += part.value;
        else {
          offset += part.value.length;
          pending.end = offset;
        }
      } else {
        if (pending) result.push(pending);
        pending = null;
        offset += part.value.length;
      }
    }
    if (pending) result.push(pending);
    return result;
  }
  function apply(base, start, end, changes) {
    let cursor = start,
      text = '';
    for (const change of changes) {
      text += base.slice(cursor, change.start) + change.text;
      cursor = change.end;
    }
    return text + base.slice(cursor, end);
  }
  function merge(base, mine, theirs, fine = false) {
    if (mine === theirs || base === theirs) return mine;
    if (base === mine) return theirs;
    const a = edits(base, mine, fine),
      b = edits(base, theirs, fine);
    const all = [
      ...a.map((x) => ({ ...x, side: 0 })),
      ...b.map((x) => ({ ...x, side: 1 })),
    ].sort((x, y) => x.start - y.start || x.end - y.end);
    let out = '',
      cursor = 0;
    for (let i = 0; i < all.length;) {
      const group = [all[i++]],
        start = group[0].start;
      let end = group[0].end;
      while (
        i < all.length &&
        (all[i].start < end ||
          (start === end && all[i].start === start && all[i].end === start))
      ) {
        end = Math.max(end, all[i].end);
        group.push(all[i++]);
      }
      out += base.slice(cursor, start);
      const local = group.filter((x) => !x.side),
        remote = group.filter((x) => x.side);
      if (!local.length || !remote.length)
        out += apply(base, start, end, group);
      else {
        let x = apply(base, start, end, local),
          y = apply(base, start, end, remote);
        if (x === y) out += x;
        else if (fine) return null;
        else {
          const combined = merge(base.slice(start, end), x, y, true);
          if (combined !== null) out += combined;
          else {
            const nl = base.includes('\r\n') ? '\r\n' : '\n';
            // The extra delimiter newline is removed by parse() on resolution,
            // so an original missing terminal newline stays missing.
            out +=
              delimiters[0] +
              nl +
              x +
              nl +
              delimiters[1] +
              nl +
              y +
              nl +
              delimiters[2] +
              nl;
          }
        }
      }
      cursor = end;
    }
    return out + base.slice(cursor);
  }
  function conflicts(text) {
    const pattern =
      /^<<<<<<< Your version\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> New version(?:\r?\n|$)/gm;
    return Array.from(text.matchAll(pattern), (m) => ({
      start: m.index,
      end: m.index + m[0].length,
      mine: m[1],
      theirs: m[2],
    }));
  }
  root.SamareMerge = { merge, conflicts };
  if (typeof module !== 'undefined') module.exports = root.SamareMerge;
})(globalThis);
