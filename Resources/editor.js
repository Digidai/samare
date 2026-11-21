/* Independent Markdown and structured-data editor for the Mac reconstruction. */
(() => {
  'use strict';
  const L = window.SamareEditorLibs;
  const vendor = new URL('vendor/', document.currentScript.src);
  const el = (tag, cls, label) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (label !== undefined) node.textContent = label;
    return node;
  };
  const action = (label, run, title = label) => {
    const b = el('button', 'de-button', label);
    if (/^\+\s/.test(label)) {
      b.replaceChildren(lineIcon('plus'), document.createTextNode(label.replace(/^\+\s+/, '')));
      b.classList.add('de-add-action');
    }
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', run);
    return b;
  };
  const lineIcon = name => window.samareGlyph(name, 'de-line-icon');
  function decode(s) {
    if (!s.includes('&')) return s;
    return s.replace(/&(?:#[0-9]+|#x[\da-f]+|[a-z][a-z0-9]+);/gi, (entity) => {
      const t = document.createElement('textarea');
      t.innerHTML = entity;
      return t.value;
    });
  }
  const diagramEngines = new Map();
  function loadEngine(file, globalName) {
    if (!diagramEngines.has(file)) {
      const job = new Promise((resolve, reject) => {
        const script = el('script');
        script.src = new URL(file, vendor).href;
        script.onload = () => resolve(window[globalName]);
        script.onerror = () => {
          diagramEngines.delete(file);
          reject(new Error('Diagram renderer unavailable'));
        };
        document.head.append(script);
      });
      diagramEngines.set(file, job);
    }
    return diagramEngines.get(file);
  }
  // Extend the Markdown token stream before constructing the editable tree.
  L.marked.use(L.markedCjkFriendly());
  L.marked.use({
    extensions: [
      {
        name: 'svgblock',
        level: 'block',
        start(src) {
          const m = /(^|\n)<svg(?=[\s>])/i.exec(src);
          return m ? m.index : undefined;
        },
        tokenizer(src) {
          const m = /^<svg(?=[\s>])[\s\S]*?<\/svg>[ \t]*(?=\n|$)/i.exec(src);
          if (m) return { type: 'svgblock', raw: m[0], text: m[0] };
        },
      },
      {
        name: 'displaymath',
        level: 'block',
        start(src) {
          return src.indexOf('$$');
        },
        tokenizer(src) {
          const m = /^\$\$[ \t]*\n([\s\S]+?)\n\$\$[ \t]*(?=\n|$)/.exec(src);
          if (m) return { type: 'displaymath', raw: m[0], text: m[1] };
        },
      },
      {
        name: 'inlinemath',
        level: 'inline',
        start(src) {
          return src.indexOf('$');
        },
        tokenizer(src) {
          const m = /^\$(?![\s$])((?:\\.|[^$\n])+?)(?<!\s)\$(?!\d)/.exec(src);
          if (m) return { type: 'inlinemath', raw: m[0], text: m[1] };
        },
      },
      {
        name: 'wikilink',
        level: 'inline',
        start(src) {
          const next = /\[\[|\\\[\\\[/.exec(src);
          return next ? next.index : undefined;
        },
        tokenizer(src) {
          const m = /^\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/.exec(src) ||
            /^\\\[\\\[([^\]\\\n|]+)(?:\|([^\]\\\n]+))?\\\]\\\]/.exec(src);
          if (m)
            return {
              type: 'wikilink',
              raw: m[0],
              href: m[1],
              text: m[2] || m[1],
            };
        },
      },
    ],
  });
  const keyAttr = { uid: { default: null } };
  const block = (tag, extra = {}) => ({
    group: 'block',
    content: 'inline*',
    attrs: keyAttr,
    parseDOM: [{ tag }],
    toDOM: () => [tag, 0],
    ...extra,
  });
  const monoBlock = (tag, name) => ({
    group: 'block',
    content: 'text*',
    marks: '',
    code: true,
    attrs: keyAttr,
    parseDOM: [
      { tag: 'pre[data-kind="' + name + '"]', preserveWhitespace: 'full' },
    ],
    toDOM: () => [tag, { 'data-kind': name }, 0],
  });
  const schema = new L.Schema({
    nodes: {
      doc: { content: 'block+', attrs: { sourceVersion: { default: null } } },
      text: { group: 'inline' },
      conflict: {
        group: 'block',
        atom: true,
        isolating: true,
        attrs: { ...keyAttr, mine: {}, theirs: {}, raw: {} },
        toDOM: (node) => ['pre', { 'data-kind': 'conflict' }, node.attrs.raw],
      },
      paragraph: block('p'),
      heading: block('h1', {
        defining: true,
        attrs: { ...keyAttr, level: { default: 1 } },
        parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({
          tag: 'h' + level,
          attrs: { level },
        })),
        toDOM: (n) => ['h' + n.attrs.level, 0],
      }),
      blockquote: block('blockquote', { content: 'block+', defining: true }),
      bullet_list: block('ul', { content: 'list_item+',
        attrs:{...keyAttr, marker:{default:'-'}, loose:{default:false}} }),
      ordered_list: block('ol', {
        content: 'list_item+',
        attrs: { ...keyAttr, order: { default: 1 }, marker:{default:'.'}, loose:{default:false} },
        parseDOM: [
          { tag: 'ol', getAttrs: (n) => ({ order: Number(n.start) || 1 }) },
        ],
        toDOM: (n) => ['ol', { start: n.attrs.order }, 0],
      }),
      list_item: {
        content: 'paragraph block*',
        defining: true,
        attrs: { checked: { default: null } },
        parseDOM: [
          {
            tag: 'li',
            getAttrs: (n) => ({
              checked: n.hasAttribute('data-checked')
                ? n.dataset.checked === 'true'
                : null,
            }),
          },
        ],
        toDOM: (n) => [
          'li',
          n.attrs.checked === null
            ? {}
            : { 'data-checked': String(n.attrs.checked) },
          0,
        ],
      },
      code_block: {
        ...monoBlock('pre', 'code'),
        attrs: { ...keyAttr, lang: { default: '' } },
        parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
        toDOM: (n) => ['pre', ['code', { 'data-language': n.attrs.lang }, 0]],
      },
      displaymath: monoBlock('pre', 'math'),
      svg_block: monoBlock('pre', 'svg'),
      raw_block: monoBlock('pre', 'raw'),
      horizontal_rule: {
        group: 'block',
        attrs: keyAttr,
        parseDOM: [{ tag: 'hr' }],
        toDOM: () => ['hr'],
      },
      hard_break: {
        group: 'inline',
        inline: true,
        selectable: false,
        parseDOM: [{ tag: 'br' }],
        toDOM: () => ['br'],
      },
      image: {
        group: 'inline',
        inline: true,
        draggable: true,
        attrs: { src: {}, alt: { default: '' }, title: { default: null } },
        parseDOM: [
          {
            tag: 'img[src]',
            getAttrs: (n) => ({
              src: n.getAttribute('src'),
              alt: n.alt,
              title: n.title || null,
            }),
          },
        ],
        toDOM: (n) => ['img', { alt: n.attrs.alt }],
      },
      inlinemath: {
        group: 'inline',
        inline: true,
        atom: true,
        attrs: { tex: {} },
        toDOM: (n) => ['span', { 'data-tex': n.attrs.tex }, n.attrs.tex],
      },
      ...Object.fromEntries(
        Object.entries(
          L.tableNodes({
            tableGroup: 'block',
            cellContent: 'paragraph+',
            cellAttributes: {
              align: {
                default: null,
                getFromDOM: (n) => n.style.textAlign || null,
                setDOMAttr: (v, a) => {
                  if (v) a.style = 'text-align:' + v;
                },
              },
            },
          }),
        ).map(([name, spec]) => [
          name,
          name === 'table' ? { ...spec, attrs: keyAttr } : spec,
        ]),
      ),
    },
    marks: {
      strong: {
        parseDOM: [{ tag: 'strong' }, { tag: 'b' }],
        toDOM: () => ['strong', 0],
      },
      em: { parseDOM: [{ tag: 'em' }, { tag: 'i' }], toDOM: () => ['em', 0] },
      strike: {
        parseDOM: [{ tag: 's' }, { tag: 'del' }],
        toDOM: () => ['s', 0],
      },
      code: {
        code: true,
        excludes: '_',
        parseDOM: [{ tag: 'code' }],
        toDOM: () => ['code', 0],
      },
      link: {
        inclusive: false,
        attrs: { href: {}, title: { default: null }, wiki: { default: false } },
        parseDOM: [
          {
            tag: 'a[href]',
            getAttrs: (n) => ({
              href: n.getAttribute('href'),
              title: n.title || null,
            }),
          },
        ],
        toDOM: (m) => [
          'a',
          {
            href: '#',
            title: m.attrs.title || m.attrs.href,
            'data-target': m.attrs.href,
            'data-wiki': String(m.attrs.wiki),
          },
          0,
        ],
      },
    },
  });
  const N = schema.nodes,
    M = schema.marks;
  let uid = 0;
  function inline(tokens, marks = []) {
    return (tokens || []).flatMap((t) => {
      const kind = {
        strong: 'strong',
        em: 'em',
        del: 'strike',
        codespan: 'code',
        link: 'link',
        wikilink: 'link',
      }[t.type];
      if (kind) {
        const mark = M[kind].create(
          kind === 'link'
            ? {
                href: t.href,
                title: t.title || null,
                wiki: t.type === 'wikilink',
              }
            : null,
        );
        return t.tokens
          ? inline(t.tokens, mark.addToSet(marks))
          : t.text
            ? [
                schema.text(
                  t.type === 'codespan' ? t.text : decode(t.text),
                  mark.addToSet(marks),
                ),
              ]
            : [];
      }
      if (t.type === 'br') return [N.hard_break.create(null, null, marks)];
      if (t.type === 'image')
        return [
          N.image.create(
            { src: t.href, alt: t.text, title: t.title || null },
            null,
            marks,
          ),
        ];
      if (t.type === 'inlinemath')
        return [N.inlinemath.create({ tex: t.text }, null, marks)];
      if (t.tokens) return inline(t.tokens, marks);
      const s =
        t.type === 'escape' || t.type === 'html'
          ? t.text
          : decode(t.text ?? t.raw ?? '');
      return s ? [schema.text(s, marks)] : [];
    });
  }
  function parseBlock(t, id = null) {
    const attrs = { uid: id },
      content = t.text ? [schema.text(t.text)] : [];
    switch (t.type) {
      case 'conflict':
        return N.conflict.create({
          ...attrs,
          mine: t.mine,
          theirs: t.theirs,
          raw: t.raw.trimEnd(),
        });
      case 'heading':
        return N.heading.create({ ...attrs, level: t.depth }, inline(t.tokens));
      case 'text':
      case 'paragraph':
        return N.paragraph.create(attrs, t.tokens ? inline(t.tokens) : content);
      case 'hr':
        return N.horizontal_rule.create(attrs);
      case 'code':
        return N.code_block.create({ ...attrs, lang: t.lang || '' }, content);
      case 'displaymath':
        return N.displaymath.create(attrs, content);
      case 'svgblock':
        return N.svg_block.create(attrs, content);
      case 'blockquote':
        return N.blockquote.create(attrs, parseChildren(t.tokens));
      case 'list':
        return (t.ordered ? N.ordered_list : N.bullet_list).create(
          { ...attrs, order: t.start || 1,
            marker:/^\s*\d*([.)*+-])/.exec(t.raw)?.[1] || (t.ordered ? '.' : '-'), loose:!!t.loose },
          t.items.map((item) => {
            const children = parseChildren(
              item.tokens.filter((t) => t.type !== 'checkbox'),
            );
            if (children[0]?.type !== N.paragraph)
              children.unshift(N.paragraph.create());
            return N.list_item.create(
              { checked: item.task ? !!item.checked : null },
              children,
            );
          }),
        );
      case 'table': {
        const rows = [t.header, ...t.rows].map((cells) =>
          N.table_row.create(
            null,
            cells.map((c) =>
              (c.header ? N.table_header : N.table_cell).create(
                { align: c.align || null },
                N.paragraph.create(null, inline(c.tokens)),
              ),
            ),
          ),
        );
        return N.table.create(attrs, rows);
      }
      default: {
        const s = t.raw.replace(/\n+$/, '');
        const kind =
          t.type === 'html' && /^<svg[\s>][\s\S]*<\/svg>$/i.test(s.trim())
            ? N.svg_block
            : N.raw_block;
        return kind.create(attrs, s ? schema.text(s) : []);
      }
    }
  }
  function parseChildren(tokens) {
    return tokens
      .filter((t) => t.type !== 'space' && t.type !== 'checkbox')
      .map((t) => parseBlock(t));
  }
  function splitHeader(text) {
    const match =
      /^(\uFEFF?---[ \t]*\r?\n)([\s\S]*?)(^---[ \t]*(?:\r?\n|$))/m.exec(text);
    return match?.index === 0 && !window.SamareMerge?.conflicts(match[0]).length
      ? { header: match[0], yaml: match[2], body: text.slice(match[0].length) }
      : { header: '', yaml: '', body: text };
  }
  // Keep blank lines in their original slice. Splitting only between independent
  // blocks lets the editor show a first page without reinterpreting the next one.
  function markdownChunks(body) {
    if (body.length < 16000) return [body];
    const chunks = [];
    let beginning = 0, fence = '', protectedEnd = '', blank = false;
    for (const match of body.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
      const line = match[0].replace(/[\r\n]+$/, '');
      if (fence) {
        if (line.trim().length >= fence.length &&
            line.trim().split(fence[0]).join('') === '') fence = '';
      } else if (protectedEnd) {
        if (line.includes(protectedEnd)) protectedEnd = '';
      } else {
        // A label elsewhere in the file may change any reference link.
        if (/^ {0,3}\[[^\]]+\]:/.test(line)) return [body];
        if (blank && match.index - beginning >= 8000 &&
            /^\S/.test(line) && !/^(?:[-*+]\s|\d+[.)]\s|[<>|])/.test(line)) {
          chunks.push(body.slice(beginning, match.index));
          beginning = match.index;
        }
        const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
        if (opening) fence = opening[1];
        else if (line.trim() === '$$') protectedEnd = '$$';
        else if (line.startsWith('<<<<<<< Your version')) protectedEnd = '>>>>>>> New version';
        else if (line.startsWith('<!--') && !line.includes('-->')) protectedEnd = '-->';
        else {
          const tag = /^ {0,3}<(svg|pre|script|style|textarea|div|table|details)(?:\s|>)/i.exec(line);
          if (tag && !line.toLowerCase().includes('</' + tag[1].toLowerCase() + '>'))
            protectedEnd = '</' + tag[1] + '>';
        }
      }
      blank = /^[ \t]*$/.test(line);
    }
    chunks.push(body.slice(beginning));
    return chunks;
  }
  function parseBody(body, allowBOM = true) {
    const eol = body.match(/\r\n|\r|\n/)?.[0] || '\n',
      bom = allowBOM && body.startsWith('\ufeff') ? '\ufeff' : '';
    const src = body.slice(bom.length),
      normalized = src.replace(/\r\n?/g, '\n');
    // Only CRLF pairs change length during tokenization. Source offsets move
    // forwards, so the mapping needs one entry per pair instead of per character.
    const crlf = [];
    for (let i = src.indexOf('\r\n'); i >= 0; i = src.indexOf('\r\n',i+2))
      crlf.push(i-crlf.length);
    let pair = 0;
    function sourceIndex(index) {
      while (pair < crlf.length && crlf[pair] < index) pair++;
      return index + pair;
    }
    const sources = new Map(),
      nodes = [];
    let offset = 0,
      end = 0;
    let tokens = [];
    const changes = window.SamareMerge?.conflicts(normalized) || [];
    if (changes.length) {
      let cursor = 0;
      for (const change of changes) {
        if (change.start > cursor)
          for (const token of L.marked.lexer(normalized.slice(cursor, change.start))) tokens.push(token);
        tokens.push({
          type: 'conflict',
          raw: normalized.slice(change.start, change.end),
          mine: change.mine,
          theirs: change.theirs,
        });
        cursor = change.end;
      }
      if (cursor < normalized.length)
        for (const token of L.marked.lexer(normalized.slice(cursor))) tokens.push(token);
    } else tokens = L.marked.lexer(normalized);
    for (const token of tokens) {
      const start = normalized.indexOf(token.raw, offset);
      if (start < 0) throw new Error('Markdown token alignment failed');
      offset = start + token.raw.length;
      if (token.type === 'space') continue;
      const rawEnd = offset - (token.raw.match(/\n+$/)?.[0].length || 0);
      const id = ++uid,
        node = parseBlock(token, id);
      const originalStart = sourceIndex(start), originalEnd = sourceIndex(rawEnd);
      sources.set(id, {
        node,
        before: src.slice(end, originalStart),
        raw: src.slice(originalStart, originalEnd),
        index: nodes.length,
      });
      end = originalEnd;
      nodes.push(node);
    }
    const doc = N.doc.create(
      { sourceVersion: ++uid },
      nodes.length ? nodes : N.paragraph.create(),
    );
    return { doc, sources, tail: src.slice(end), bom, eol };
  }
  const children = (node) => {
    const rows = [];
    node.forEach((n) => rows.push(n));
    return rows;
  };
  const maxTicks = (s) =>
    Math.max(0, ...(s.match(/`+/g) || []).map((v) => v.length));
  const fence = (s, min) => '`'.repeat(Math.max(min, maxTicks(s) + 1));
  function markTokens(mark) {
    if (mark.type === M.link) {
      const href = mark.attrs.href;
      if (mark.attrs.wiki) return ['[[' + href + '|', ']]'];
      return [
        '[',
        '](' +
          (/[\s()]/.test(href) ? '<' + href.replace(/>/g, '%3E') + '>' : href) +
          (mark.attrs.title
            ? ' "' + mark.attrs.title.replace(/"/g, '\\"') + '"'
            : '') +
          ')',
      ];
    }
    const symbol =
      mark.type === M.strong ? '**' : mark.type === M.em ? '*' : '~~';
    return [symbol, symbol];
  }
  function inlineSource(node) {
    let value = '',
      active = [];
    for (const leaf of children(node)) {
      const marks = leaf.marks.filter((m) => m.type !== M.code);
      let common = 0;
      while (
        common < marks.length &&
        common < active.length &&
        marks[common].eq(active[common])
      )
        common++;
      for (let i = active.length - 1; i >= common; i--)
        value += markTokens(active[i])[1];
      for (let i = common; i < marks.length; i++)
        value += markTokens(marks[i])[0];
      active = marks;
      if (leaf.isText) {
        const s = leaf.text;
        if (leaf.marks.some((m) => m.type === M.code)) {
          const f = fence(s, 1),
            pad =
              /^`|`$/.test(s) ||
              (s.trim() !== '' && s.startsWith(' ') && s.endsWith(' '))
                ? ' '
                : '';
          value += f + pad + s + pad + f;
        } else
          value += s
            .replace(/\\/g, '\\\\')
            .replace(/([`*\[\]~])/g, '\\$1')
            .replace(/(^|\s)_(?=\S)/g, '$1\\_')
            .replace(/&(?=#?\w+;)/g, '&amp;')
            .replace(/</g, '&lt;');
      } else if (leaf.type === N.hard_break) value += '  \n';
      else if (leaf.type === N.image)
        value +=
          '![' +
          leaf.attrs.alt.replace(/]/g, '\\]') +
          '](<' +
          leaf.attrs.src.replace(/>/g, '%3E') +
          '>' +
          (leaf.attrs.title
            ? ' "' + leaf.attrs.title.replace(/"/g, '\\"') + '"'
            : '') +
          ')';
      else if (leaf.type === N.inlinemath) value += '$' + leaf.attrs.tex + '$';
    }
    for (let i = active.length - 1; i >= 0; i--)
      value += markTokens(active[i])[1];
    return value.replace(/\[\[([^\]|\n]+)\|\1\]\]/g, '[[$1]]');
  }
  function blockSource(node) {
    const c = children(node);
    switch (node.type) {
      case N.conflict:
        return node.attrs.raw;
      case N.paragraph:
        return inlineSource(node).replace(
          /^(#{1,6}(?=\s)|>|[-+](?=\s)|\d+[.)](?=\s)|={3,}$|-{3,}$)/gm,
          (m) =>
            m.replace(/[.)]$/, '\\$&') === m
              ? '\\' + m
              : m.replace(/[.)]$/, '\\$&'),
        );
      case N.heading:
        return '#'.repeat(node.attrs.level) + ' ' + inlineSource(node);
      case N.horizontal_rule:
        return '---';
      case N.raw_block:
      case N.svg_block:
        return node.textContent;
      case N.code_block: {
        const f = fence(node.textContent, 3);
        return f + node.attrs.lang + '\n' + node.textContent + '\n' + f;
      }
      case N.displaymath:
        return '$$\n' + node.textContent + '\n$$';
      case N.blockquote:
        return c
          .map(blockSource)
          .join('\n\n')
          .split('\n')
          .map((l) => '> ' + l)
          .join('\n');
      case N.bullet_list:
      case N.ordered_list:
        return c
          .map((item, i) => {
            const marker =
              (node.type === N.bullet_list ? '' : node.attrs.order + i) + node.attrs.marker + ' ';
            const check =
              item.attrs.checked === null
                ? ''
                : item.attrs.checked
                  ? '[x] '
                  : '[ ] ';
            return (
              marker +
              check +
              children(item)
                .map((child, i) => {
                  const source = blockSource(child);
                  return i === 0 && check && child.type === N.paragraph
                    ? source.replace(/^(\d+)\\([.)])(?=\s)/, '$1$2') : source;
                })
                .join('\n\n')
                .split('\n')
                .join('\n' + ' '.repeat(marker.length))
            );
          })
          .join(node.attrs.loose ? '\n\n' : '\n');
      case N.table: {
        const rows = c.map(row => children(row).map(cell => children(cell)
          .map(inlineSource).filter(Boolean).join('<br>').replace(/\|/g, '\\|').replace(/\n/g, '<br>')));
        const aligns = children(c[0]).map(cell =>
          ({left: ':---', right: '---:', center: ':---:'})[cell.attrs.align] || '---');
        const wide = /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff01-\uff60]/u;
        if (rows.some(row => row.some(value => wide.test(value)))) {
          const width = value => Array.from(value).reduce((n,ch) =>
            n + (/\p{Mark}/u.test(ch) ? 0 : wide.test(ch) || /\p{Extended_Pictographic}/u.test(ch) ? 2 : 1),0);
          const widths = aligns.map((align, col) => rows.reduce((n,row) => Math.max(n,width(row[col] || '')),align.length));
          rows.forEach(row => row.forEach((value,col) => row[col] = value + ' '.repeat(widths[col] - width(value))));
          aligns.forEach((align,col) => aligns[col] = align.replace('---', '-'.repeat(widths[col] - align.length + 3)));
        }
        rows.splice(1,0,aligns);
        const lines = rows.map(row => '| ' + row.join(' | ') + ' |');
        return lines.join('\n');
      }
      default:
        return c.map(blockSource).join('\n\n');
    }
  }
  function serialize(doc, meta, visit) {
    if (!visit && doc.eq(meta.doc)) return meta.original;
    const seen = new Set();
    let out = meta.bom,
      prev = null;
    doc.forEach((node, off, index) => {
      const id = node.attrs.uid,
        record = !seen.has(id) && meta.sources.get(id);
      if (id) seen.add(id);
      if (!index) out += record?.index === 0 ? record.before : '';
      else if (record && prev && record.index === prev.index + 1)
        out += record.before;
      else out += meta.eol.repeat(2);
      visit?.(off, out.length);
      out +=
        record && record.node.eq(node)
          ? record.raw
          : blockSource(node).replace(/\n/g, meta.eol);
      prev = record;
    });
    return out + meta.tail;
  }
  function countableText(node, sources) {
    if (node.type === N.table) {
      const record = sources.get(node.attrs.uid);
      return record?.node.eq(node)
        ? record.raw.replace(/\r\n?/g, '\n')
        : blockSource(node);
    }
    if (node.type === N.conflict) return node.attrs.raw;
    if (node.isTextblock)
      return node.textBetween(0, node.content.size, '', (leaf) => {
        if (leaf.type === N.hard_break) return '\n';
        return leaf.attrs.alt || leaf.attrs.tex || '';
      });
    const parts = children(node).map((child) => countableText(child, sources));
    if (node.type === N.list_item && node.attrs.checked !== null)
      parts[0] = (node.attrs.checked ? '[x] ' : '[ ] ') + parts[0];
    return parts.join('\n');
  }
  function fields(yaml) {
    return yaml
      .split(/\r?\n/)
      .map((line, i) => {
        const m = /^([\p{L}\p{N}_.-][\p{L}\p{N}_. -]*):[ \t]*(.*)$/u.exec(line);
        return m ? { key: m[1], value: m[2], line: i } : null;
      })
      .filter(Boolean);
  }
  function csvRows(text, sep) {
    const rows = [];
    let row = [],
      pos = text.startsWith('\ufeff') ? 1 : 0;
    if (pos === text.length) return [];
    for (;;) {
      const start = pos;
      let value = '',
        quoted = false;
      if (text[pos] === '"') {
        quoted = true;
        pos++;
        let closed = false;
        while (pos < text.length) {
          const char = text[pos++];
          if (char !== '"') {
            value += char;
            continue;
          }
          if (text[pos] === '"') {
            value += '"';
            pos++;
            continue;
          }
          closed = true;
          break;
        }
        if (!closed) throw new Error('Unclosed quoted field');
        if (pos < text.length && !['\r', '\n', sep].includes(text[pos]))
          throw new Error('Unexpected text after a closing quote');
      } else {
        while (pos < text.length && text[pos] !== '\r' && text[pos] !== '\n' && text[pos] !== sep) pos++;
        value = text.slice(start, pos);
      }
      row.push({ value, start, end: pos, quoted });
      if (pos === text.length) {
        rows.push(row);
        break;
      }
      if (text[pos++] === sep) continue;
      if (text[pos - 1] === '\r' && text[pos] === '\n') pos++;
      rows.push(row);
      row = [];
      if (pos === text.length) break;
    }
    return rows;
  }
  const gridWidth = rows => rows.reduce((width, row) => Math.max(width, row.length), 0);

  function csvEncode(s, sep, quoted = false) {
    return quoted || s.includes(sep) || /["\r\n]/.test(s)
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  }
  // Record source ranges so editing one value leaves number precision, duplicate keys
  // and formatting of every other JSON field intact.
  function parseJSON(src, base = 0) {
    let i = src[0] === '\ufeff' ? 1 : 0;
    function fail(message, offset = i, edit) {
      const error = new SyntaxError(message);
      error.offset = base + Math.min(src.length, offset);
      if (edit) error.edit = { offset: base + edit.offset, insert: edit.insert, remove: edit.remove };
      throw error;
    }
    const space = () => {
      while (/[ \t\r\n]/.test(src[i] || '!')) i++;
    };
    function string() {
      const start = i++;
      let escaped = false;
      while (i < src.length) {
        const c = src[i++];
        if (!escaped && c === '"') {
          try { return JSON.parse(src.slice(start, i)); }
          catch { fail('Invalid JSON string', start); }
        }
        escaped = c === '\\' && !escaped;
      }
      fail('Unterminated JSON string', start);
    }
    function item(label, depth) {
      if (depth > 200)
        fail('Large nested value can be edited in source view');
      space();
      const start = i;
      let type,
        value,
        entries = [];
      if (src[i] === '{' || src[i] === '[') {
        const object = src[i++] === '{',
          close = object ? '}' : ']';
        type = object ? 'object' : 'array';
        space();
        if (src[i] !== close)
          for (;;) {
            let key = String(entries.length),
              keyStart,
              keyEnd;
            if (object) {
              if (src[i] !== '"') fail('Expected field name');
              keyStart = i + base;
              key = string();
              keyEnd = i + base;
              space();
              if (src[i] !== ':') fail('Expected colon');
              i++;
            }
            const child = item(key, depth + 1);
            child.keyStart = keyStart;
            child.keyEnd = keyEnd;
            entries.push(child);
            space();
            if (src[i] === close) break;
            if (src[i] !== ',') {
              if (object ? /^"(?:\\.|[^"\\])*"\s*:/.test(src.slice(i)) : /["{[\dtfn-]/.test(src[i] || '!'))
                fail('Expected a comma', child.end - base, { offset: child.end - base, remove: 0, insert: ',' });
              fail('Expected a comma or closing ' + close);
            }
            const comma = i++;
            space();
            if (src[i] === close)
              fail('Unexpected trailing comma', comma, { offset: comma, remove: 1, insert: '' });
          }
        i++;
      } else if (src[i] === '"') {
        type = 'string';
        value = string();
      } else {
        const token =
          /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
            src.slice(i),
          )?.[0];
        if (token == null) fail('Expected a JSON value');
        value = token;
        i += token.length;
        type =
          token === 'null'
            ? 'null'
            : /true|false/.test(token)
              ? 'boolean'
              : 'number';
      }
      return {
        label,
        type,
        value,
        entries,
        start: base + start,
        end: base + i,
      };
    }
    const root = item('', 0);
    space();
    if (i !== src.length) fail('Unexpected JSON content');
    return root;
  }
  function jsonRoots(text, lines) {
    if (!lines) return [parseJSON(text)];
    const roots = [];
    let pos = 0;
    for (const m of text.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
      if (m[0].trim()) roots.push(parseJSON(m[0], pos));
      pos += m[0].length;
    }
    return roots;
  }

  function mount(host, options = {}) {
    const path = options.path || '',
      ext = path.split('.').pop().toLowerCase();
    const isCSV = ['csv', 'tsv'].includes(ext),
      isJSON = ['json', 'ndjson', 'jsonl'].includes(ext),
      isData = isCSV || isJSON;
    const lines = ['jsonl', 'ndjson'].includes(ext),
      delimiter = ext === 'tsv' ? '\t' : ',';
    let text = options.text ?? '',
      settings = { ...options.settings },
      mode = ext === 'txt' ? 'source' : 'edit';
    let view = null, longDoc = null,
      meta = null,
      propsOpen = false,
      outline = [],
      headingPositions = new Map(),
      destroyed = false,
      sourceArea = null,
      csvPage = 0,
      csvDraft = null,
      newestFirst = false, freshRecords = 0, freshButton = null;
    let header = '',
      yaml = '',
      surface,
      article,
      props,
      dataBar,
      selectionBar,
      searchBox,
      searchTerm = '',
      searchLast = -1,
      panel, finishInline = null;
    let picker = null,
      pickerItems = [],
      pickerIndex = 0,
      pickerKey = '',
      pickerTimer,
      pickerVersion = 0;
    const edits = [],
      future = [],
      expandedJSON = new Set(),
      collapsedJSON = new Set(),
      diagramRenderers = new Set();
    const sourceVersions = new Map();
    function rememberSource(body) {
      const version = parseBody(body);
      version.original = body;
      sourceVersions.set(version.doc.attrs.sourceVersion, version);
      return version;
    }
    function pendingBody() {
      return longDoc ? longDoc.body.slice(longDoc.consumed) : '';
    }
    function pendingChunk(index) {
      const chunk = longDoc.chunks[index];
      return chunk.parsed ||= parseBody(chunk.raw, false);
    }
    function hydrateTo(end) {
      if (!longDoc || longDoc.next >= end) return;
      const current = longDoc;
      let content = null;
      while (current.next < end && current.next < current.chunks.length) {
        const chunk = current.chunks[current.next], parsed = pendingChunk(current.next);
        const previousTail = meta.tail, previousCount = meta.sources.size;
        for (const [id, record] of parsed.sources) {
          meta.sources.set(id, { ...record, index: previousCount + record.index,
            before: record.index === 0 ? previousTail + record.before : record.before });
        }
        chunk.childCount = parsed.doc.childCount;
        meta.tail = parsed.tail;
        content = content ? content.append(parsed.doc.content) : parsed.doc.content;
        current.consumed += chunk.raw.length;
        current.next++;
        chunk.parsed = null;
      }
      meta.doc = meta.doc.copy(meta.doc.content.append(content));
      meta.original = current.body.slice(0, current.consumed);
      const tr = view.state.tr.insert(view.state.doc.content.size, content)
        .setMeta('hydrate', true).setMeta('addToHistory', false);
      view.dispatch(tr);
      root.dataset.hydratedFraction = (current.consumed / current.body.length).toFixed(3);
      if (current.next === current.chunks.length) {
        refreshOutline();
        queueMicrotask(() => { if (current === longDoc && !destroyed) options.onHydrated?.(); });
      }
    }
    function scheduleHydration(current) {
      if (current.next >= current.chunks.length) return;
      function next() {
        if (current !== longDoc || destroyed) return;
        // Larger notes batch several slices per frame to bound the number of
        // ProseMirror layout passes without delaying the initial rich view.
        const batch = current.searching ? 1 : Math.min(18, Math.max(2, Math.ceil(current.chunks.length / 18)));
        hydrateTo(Math.min(current.chunks.length, current.next + batch));
        scheduleHydration(current);
      }
      current.timer = typeof requestIdleCallback === 'function'
        ? requestIdleCallback(next, { timeout: 80 }) : setTimeout(next, 12);
    }
    function stopHydration() {
      if (!longDoc) return;
      if (typeof cancelIdleCallback === 'function') cancelIdleCallback(longDoc.timer);
      else clearTimeout(longDoc.timer);
      longDoc = null;
      delete root.dataset.longDoc;
      delete root.dataset.hydratedFraction;
    }
    function eachDocument(run) {
      let offset = 0;
      run(view.state.doc, meta.sources, offset);
      offset += view.state.doc.content.size;
      for (let i = longDoc?.next ?? 0; longDoc && i < longDoc.chunks.length; i++) {
        const chunk = pendingChunk(i);
        run(chunk.doc, chunk.sources, offset);
        offset += chunk.doc.content.size;
      }
    }
    function hydratePosition(pos) {
      if (!longDoc || pos <= view.state.doc.content.size) return;
      let size = view.state.doc.content.size, end = longDoc.next;
      while (size < pos && end < longDoc.chunks.length)
        size += pendingChunk(end++).doc.content.size;
      hydrateTo(end);
    }
    function findPattern(query, caseSensitive) {
      return new RegExp(String(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'gu' : 'giu');
    }
    function findDocumentMatches({ query, caseSensitive } = {}) {
      if (!longDoc || !query) return longDoc ? [] : null;
      const matches = [];
      const regex = findPattern(query, caseSensitive);
      eachDocument((doc, _, offset) => {
        doc.descendants((node, pos) => {
          if (!node.isTextblock) return;
          const visible = node.textBetween(0, node.content.size, '', '\uFFFC');
          for (const hit of visible.matchAll(regex)) {
            const from = offset + pos + 1 + hit.index;
            matches.push({ from, to: from + hit[0].length });
          }
          return false;
        });
      });
      return matches;
    }
    function yieldSearch() {
      // Timers share turns with rendering and keyboard input even when the
      // platform prioritizes continuations of an already-running search.
      return new Promise((resolve) => setTimeout(resolve, 0));
    }
    function findDocumentMatchesAsync({ query, caseSensitive, signal, onProgress }) {
      if (!view || (!longDoc && text.length < 16000)) return null;
      const document = longDoc,
        owner = view,
        revision = text,
        mounted = view.state.doc,
        nextChunk = document?.next || 0;
      const valid = () =>
        !signal?.aborted && !destroyed && view === owner && longDoc === document && text === revision;
      // The mounted prefix may include unsaved edits. Subsequent chunks are appended
      // in order, so their ProseMirror positions stay valid during background hydration.
      async function scan() {
        const hits = [],
          regex = findPattern(query, caseSensitive);
        let pos = 0,
          childIndex = 0,
          deadline = 0,
          lastProgress = 0;
        if (document) document.searching = (document.searching || 0) + 1;
        async function pause() {
          if (performance.now() - lastProgress > 60) {
            onProgress?.(hits);
            lastProgress = performance.now();
          }
          await yieldSearch();
          deadline = performance.now() + 7;
        }
        function* blocks(node, start) {
          if (node.isTextblock) {
            yield [node, start];
            return;
          }
          let childStart = start + 1;
          for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            yield* blocks(child, childStart);
            childStart += child.nodeSize;
          }
        }
        try {
          if (!query) return hits;
          // Yield before parsing even the first chunk so Escape and replacement
          // queries queued by the platform can cancel this request immediately.
          await pause();
          for (let i = nextChunk - 1; i < (document?.chunks.length || 0); i++) {
            if (!valid()) return null;
            let doc, start, end;
            if (i === nextChunk - 1) {
              doc = mounted;
              start = 0;
              end = mounted.childCount;
            } else if (i < document.next) {
              doc = view.state.doc;
              start = childIndex;
              end = start + document.chunks[i].childCount;
            } else {
              doc = pendingChunk(i).doc;
              start = 0;
              end = doc.childCount;
            }
            for (let n = start; n < end; n++) {
              const top = doc.child(n);
              for (const [node, offset] of blocks(top, pos)) {
                const value = node.textBetween(0, node.content.size, '', '\uFFFC');
                let batch = 0;
                for (const hit of value.matchAll(regex)) {
                  const from = offset + 1 + hit.index;
                  hits.push({ from, to: from + hit[0].length });
                  if (++batch % 256 === 0 && performance.now() >= deadline) {
                    await pause();
                    if (!valid()) return null;
                  }
                }
                if (performance.now() >= deadline) {
                  await pause();
                  if (!valid()) return null;
                }
              }
              pos += top.nodeSize;
              childIndex++;
            }
            if (performance.now() >= deadline) await pause();
          }
          return valid() ? hits : null;
        } finally {
          if (document) document.searching--;
        }
      }
      return scan();
    }
    async function revealDocumentMatchAsync({ match, signal }) {
      if (!view || !Number.isInteger(match?.from) || !Number.isInteger(match?.to)) return null;
      const document = longDoc,
        owner = view,
        revision = text;
      const valid = () =>
        !signal?.aborted && !destroyed && view === owner && longDoc === document && revision === text;
      if (document) document.searching = (document.searching || 0) + 1;
      try {
        while (
          document &&
          valid() &&
          view.state.doc.content.size < match.to &&
          document.next < document.chunks.length
        ) {
          await yieldSearch();
          if (!valid()) return null;
          if (view.state.doc.content.size < match.to) hydrateTo(document.next + 1);
        }
        return valid() && match.to <= view.state.doc.content.size ? renderedRange(match) : null;
      } finally {
        if (document) document.searching--;
      }
    }
    function revealDocumentMatch(hit) {
      if (!longDoc || !Number.isInteger(hit?.from) || !Number.isInteger(hit?.to)) return null;
      hydratePosition(hit.to);
      return renderedRange(hit);
    }
    function renderedRange(hit) {
      if (hit.from < 0 || hit.to > view.state.doc.content.size) return null;
      const start = view.domAtPos(hit.from, 1), end = view.domAtPos(hit.to, -1);
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      return range;
    }
    const root = el('div', 'de-root' + (isData ? ' de-data' : ''));
    const large = () =>
      text.length > 1_500_000 || text.split('\n', 20_002).length > 20_000;
    host.replaceChildren(root);
    function commit(value, withHistory = false) {
      if (value === text) return;
      if (withHistory) {
        edits.push(text);
        if (edits.length > 100) edits.shift();
        future.length = 0;
      }
      text = value;
      options.onChange?.(value);
    }
    function setHeader(content) {
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      const body = splitHeader(text).body,
        ending = content.replace(/(?:\r?\n)+$/, '');
      const bom = (header || body).startsWith('\ufeff') ? '\ufeff' : '';
      header = ending ? bom + '---' + eol + ending + eol + '---' + eol : bom;
      yaml = ending ? ending + eol : '';
      commit(header + body.replace(/^\ufeff/, ''), true);
    }
    function properties() {
      props.replaceChildren();
      const list = fields(yaml),
        total = list.length;
      props.classList.toggle('de-blank-props', !header && !propsOpen);
      props.classList.toggle('de-props-open', propsOpen);
      const toggle = action(
        total ? 'Properties  ' + total : 'Add properties',
        () => {
          propsOpen = !propsOpen;
          properties();
        },
      );
      toggle.className = 'de-props-toggle';
      toggle.setAttribute('aria-expanded', String(propsOpen));
      toggle.replaceChildren(
        lineIcon('chevron-right'),
        document.createTextNode(total ? 'Properties' : 'Add properties'),
      );
      if (total) toggle.append(el('span', 'de-props-count', String(total)));
      props.append(toggle);
      if (!propsOpen) return;
      const rows = el('div', 'de-prop-list');
      for (const f of list) {
        const row = el('label', 'de-prop-row');
        row.append(el('span', '', f.key));
        const input = el('input');
        input.value = f.value;
        input.disabled = mode === 'preview';
        input.setAttribute('aria-label', f.key);
        input.addEventListener('change', () => {
          const first = splitHeader(text).yaml.split(/\r?\n/),
            before = first[f.line].match(/^.*?:[ \t]*/)?.[0] || f.key + ': ';
          first[f.line] = before + input.value;
          setHeader(first.join(meta?.eol || '\n'));
        });
        row.append(input);
        rows.append(row);
      }
      const raw = action('Edit YAML', () => {
        popForm(
          'Properties',
          yaml.trimEnd(),
          (value) => {
            setHeader(value);
            properties();
          },
          { multiline: true },
        );
      });
      raw.disabled = mode === 'preview';
      rows.append(raw);
      const add = action('+ Add property', () => {
        popForm('Property name', '', (key) => {
          key = key.trim();
          if (
            !/^[\p{L}\p{N}_.-][\p{L}\p{N}_. -]*$/u.test(key) ||
            fields(yaml).some((p) => p.key === key)
          )
            throw new Error('Enter a unique property name');
          setHeader((yaml ? yaml.trimEnd() + '\n' : '') + key + ': ');
          properties();
          props.querySelectorAll('.de-prop-row input')[list.length]?.focus();
        });
      });
      add.classList.add('de-add-property');
      add.disabled = mode === 'preview';
      rows.append(add);
      props.append(rows);
    }
    function popForm(title, initial, submit, { multiline = false } = {}) {
      panel?.remove();
      panel = el('form', 'de-pop-form');
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', title);
      const label = el('label', '', title),
        input = el(multiline ? 'textarea' : 'input');
      input.value = initial;
      label.append(input);
      panel.append(label);
      const error = el('small', 'de-validation');
      panel.append(error);
      const buttons = el('div', 'de-form-buttons');
      buttons.append(
        action('Cancel', () => {
          panel?.remove();
          panel = null;
          view?.focus();
        }),
      );
      const apply = el('button', 'de-button', 'Apply');
      apply.type = 'submit';
      buttons.append(apply);
      panel.append(buttons);
      root.append(panel);
      panel.onsubmit = (e) => {
        e.preventDefault();
        try {
          submit(input.value);
          panel?.remove();
          panel = null;
        } catch (err) {
          error.textContent = err.message;
        }
      };
      panel.onkeydown = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          panel.remove();
          panel = null;
          view?.focus();
        }
      };
      input.focus();
      input.select();
    }
    function refreshOutline() {
      outline = [];
      headingPositions = new Map();
      if (view)
        view.state.doc.descendants((node, pos) => {
          if (node.type !== N.heading) return;
          const h = {
            id: 'heading-' + outline.length,
            text: node.textContent,
            level: node.attrs.level,
            index: outline.length,
          };
          outline.push(h);
          headingPositions.set(h.id, pos);
        });
      else if (!isData && !large()) {
        try {
          const parsed = parseBody(splitHeader(text).body);
          parsed.doc.descendants((n) => {
            if (n.type === N.heading)
              outline.push({
                id: 'heading-' + outline.length,
                level: n.attrs.level,
                text: n.textContent,
                index: outline.length,
              });
          });
        } catch {}
      }
      options.onOutline?.(outline);
    }
    function resolveImage(src) {
      if (/^https?:\/\//i.test(src)) return src;
      if (/^(?:\/\/|[a-z][a-z0-9+.-]*:)/i.test(src)) return null;
      return options.assetURL?.(src) || null;
    }
    function mathRender(dom, value, display) {
      L.katex.render(value, dom, {
        displayMode: display,
        throwOnError: false,
        strict: 'ignore',
        trust: false,
        output: 'htmlAndMathml',
      });
    }
    function inlineEditor({ title, label, value, multiline, anchor, preview, commit, linkText, existing }) {
      finishInline?.();
      panel?.remove();
      const box = el('div','de-inline-editor');
      panel = box;
      box.setAttribute('role','dialog');
      box.setAttribute('aria-label',title);
      const input = el(multiline ? 'textarea' : 'input');
      input.setAttribute('aria-label',label);
      input.spellcheck = false;
      input.autocomplete = 'off';
      if (multiline) input.rows = 1;
      input.value = value;
      let textField;
      if (linkText !== undefined) {
        textField = el('input');
        textField.value = linkText;
        textField.placeholder = 'Link text';
        input.placeholder = 'URL or workspace path';
        for (const [name,field] of [['Text',textField],['Link',input]]) {
          const row = el('label','de-inline-field',name);
          row.append(field); box.append(row);
        }
        const controls = el('div','de-inline-actions');
        if (existing) {
          controls.append(action('Remove', () => close('remove')), action('Open', () => {
            close('after'); options.onLink?.(input.value);
          }));
        }
        controls.append(action('Cancel', () => close('cancel')),action(existing ? 'Update' : 'Insert',() => close('after')));
        box.append(controls);
      } else box.append(input);
      root.append(box);
      function position() {
        if (multiline) {
          input.style.height = 'auto';
          input.style.height = Math.min(180,input.scrollHeight + 2) + 'px';
        }
        const r = anchor(), height = box.offsetHeight;
        const above = r.bottom + 8 + height > innerHeight - 8 && r.top > innerHeight - r.bottom;
        box.dataset.placement = above ? 'above' : 'below';
        box.style.top = Math.max(8,Math.min(innerHeight-height-8, above ? r.top-height-8 : r.bottom+8)) + 'px';
        box.style.left = Math.max(8,Math.min(innerWidth-box.offsetWidth-8,r.left)) + 'px';
      }
      function close(direction) {
        if (finishInline !== close) return;
        finishInline = null;
        panel = null;
        box.remove();
        commit(input.value, direction, textField?.value);
        if (waiting && !composing) queueMicrotask(applyWaiting);
      }
      finishInline = close;
      input.oninput = () => { preview?.(input.value); position(); };
      box.onfocusout = event => { if (!box.contains(event.relatedTarget)) close(); };
      box.onkeydown = event => {
        if (event.isComposing) return;
        const left = input.selectionStart === 0 && input.selectionEnd === 0;
        const right = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
        const single = !multiline || input.scrollHeight - 8 < parseFloat(getComputedStyle(input).lineHeight) * 1.5;
        let direction;
        if (event.key === 'Enter' || event.key === 'Escape')
          direction = textField && event.key === 'Escape' ? 'cancel' : 'after';
        else if (!(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) && multiline) {
          if ((event.key === 'ArrowLeft' && left) || (event.key === 'ArrowUp' && (single || left))) direction = 'before';
          if ((event.key === 'ArrowRight' && right) || (event.key === 'ArrowDown' && (single || right))) direction = 'after';
        }
        if (direction) {
          event.preventDefault(); event.stopPropagation();
          close(direction);
        }
      };
      position();
      input.focus({preventScroll:true});
      input.setSelectionRange(input.value.length,input.value.length);
    }
    function editLink(element) {
      const sel = view.state.selection;
      const from = element ? view.posAtDOM(element,0) : sel.from;
      const to = element ? view.posAtDOM(element,element.childNodes.length) : sel.to;
      const original = view.state.doc.textBetween(from,to);
      const href = element?.dataset.target || '';
      inlineEditor({ title:'Edit link', label:'Link', value:href, linkText:original, existing:!!element,
        anchor:() => element?.getBoundingClientRect() || view.coordsAtPos(from),
        commit(target,direction,label) {
          target = target.trim();
          const tr = view.state.tr;
          if (direction === 'remove') tr.removeMark(from,to,M.link);
          else if (direction !== 'cancel' && target && (target !== href || label !== original)) {
            if (label !== original || from === to) {
              tr.replaceWith(from,to,schema.text(label || target,[M.link.create({href:target})]));
            } else tr.addMark(from,to,M.link.create({href:target}));
          }
          if (tr.docChanged) view.dispatch(L.closeHistory(tr));
          if (direction) view.focus();
        },
      });
    }
    let diagramSequence = 0;
    function codeView(initial, editor, getPos, special = '') {
      let node = initial,
        sourceOpen = false,
        version = 0;
      const dom = el('div', 'de-codebox'),
        bar = el('div', 'de-codebar'),
        pre = el('pre', 'de-pre'),
        code = el('code'),
        result = el('div', 'de-diagram');
      bar.contentEditable = 'false';
      result.contentEditable = 'false';
      pre.append(code);
      const languages = [
        '',
        'bash',
        'c',
        'cpp',
        'css',
        'go',
        'html',
        'java',
        'javascript',
        'js',
        'json',
        'jsx',
        'kotlin',
        'latex',
        'markdown',
        'math',
        'mermaid',
        'python',
        'rust',
        'sql',
        'svg',
        'swift',
        'typescript',
        'ts',
        'yaml',
        'zsh',
      ];
      const languageControl = el('label', 'de-language');
      const languageName = el('span');
      const select = el('select', 'de-language-select');
      select.setAttribute('aria-label', 'Code language');
      for (const lang of new Set([
        ...(node.attrs.lang && !languages.includes(node.attrs.lang)
          ? [node.attrs.lang]
          : []),
        ...languages,
      ])) {
        const full = {
          js: 'JavaScript',
          ts: 'TypeScript',
          py: 'Python',
          sh: 'Shell', bash: 'Bash', zsh: 'Zsh', go: 'Go', python: 'Python',
          javascript: 'JavaScript', typescript: 'TypeScript', cpp:'C++', html:'HTML', css:'CSS',
          json:'JSON', sql:'SQL', jsx:'JSX', swift:'Swift', rust:'Rust', markdown:'Markdown',
        };
        const o = el('option', '', full[lang] || lang || 'Plain text');
        o.value = lang;
        select.append(o);
      }
      select.value = node.attrs.lang || '';
      languageName.textContent =
        select.selectedOptions[0]?.textContent || 'Plain text';
      languageControl.append(languageName, lineIcon('chevron-down'), select);
      select.disabled = mode === 'preview';
      let languageMenu = null;
      function closeLanguage() {
        languageMenu?.remove();
        languageMenu = null;
        select.setAttribute('aria-expanded', 'false');
        document.removeEventListener('pointerdown', outsideLanguage, true);
        window.removeEventListener('resize', closeLanguage);
      }
      function outsideLanguage(e) {
        if (!languageControl.contains(e.target) && !languageMenu?.contains(e.target)) closeLanguage();
      }
      function openLanguage(e) {
        if (select.disabled) return;
        e.preventDefault();
        if (languageMenu) { closeLanguage(); return; }
        const menu = el('div','de-language-menu');
        languageMenu = menu;
        menu.setAttribute('role','listbox');
        menu.setAttribute('aria-label','Choose code language');
        const seen = new Set();
        for (const opt of select.options) {
          const label = opt.textContent;
          if (seen.has(label)) continue;
          seen.add(label);
          const row = el('button','',label);
          row.type = 'button';
          row.setAttribute('role','option');
          row.setAttribute('aria-selected', String(label === languageName.textContent));
          row.onclick = () => {
            select.value = opt.value;
            select.onchange();
            closeLanguage();
            select.focus({preventScroll:true});
          };
          menu.append(row);
        }
        const rect = languageControl.getBoundingClientRect();
        const below = innerHeight - rect.bottom - 16, above = rect.top - 16;
        const up = below < 220 && above > below;
        menu.style.maxHeight = Math.min(280,Math.max(100,(up ? above : below) - 6)) + 'px';
        menu.style.left = Math.max(4,Math.min(rect.left,innerWidth - 176)) + 'px';
        menu.style[up ? 'bottom' : 'top'] = (up ? innerHeight - rect.top + 6 : rect.bottom + 6) + 'px';
        menu.onkeydown = key => {
          if (key.key === 'Escape' || key.key === 'Tab') { key.preventDefault(); closeLanguage(); select.focus(); return; }
          if (!['ArrowDown','ArrowUp','Home','End'].includes(key.key)) return;
          key.preventDefault();
          const options = Array.from(menu.children), pos = options.indexOf(document.activeElement);
          options[key.key === 'Home' ? 0 : key.key === 'End' ? options.length-1 :
            (pos + (key.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length].focus();
        };
        document.body.append(menu);
        select.setAttribute('aria-expanded','true');
        (menu.querySelector('[aria-selected=true]') || menu.firstElementChild)?.focus({preventScroll:true});
        document.addEventListener('pointerdown', outsideLanguage, true);
        window.addEventListener('resize', closeLanguage);
      }
      select.onpointerdown = openLanguage;
      select.onkeydown = e => { if (['Enter',' ','ArrowDown','ArrowUp'].includes(e.key)) openLanguage(e); };
      select.setAttribute('aria-expanded','false');
      select.onchange = () => {
        const pos = getPos();
        editor.dispatch(
          editor.state.tr.setNodeMarkup(pos, undefined, {
            ...node.attrs,
            lang: select.value,
          }),
        );
      };
      bar.append(
        special ? el('span', 'de-special-language', special) : languageControl,
      );
      function showSource(open) {
        sourceOpen = open;
        updateUI();
        if (open) {
          const pos = getPos();
          editor.dispatch(
            editor.state.tr.setSelection(
              L.TextSelection.create(editor.state.doc, pos + 1),
            ),
          );
          editor.focus();
        }
      }
      const drawToggle = action('Source', () => showSource(!sourceOpen));
      result.onclick = () => {
        if (mode !== 'preview' && !sourceOpen) showSource(true);
      };
      const dismiss = (e) => {
        if (sourceOpen && !dom.contains(e.target)) showSource(false);
      };
      const escape = (e) => {
        if (sourceOpen && e.key === 'Escape' && editor.hasFocus()) {
          e.preventDefault();
          showSource(false);
          result.tabIndex = -1;
          result.focus();
        }
      };
      document.addEventListener('pointerdown', dismiss, true);
      document.addEventListener('keydown', escape, true);
      const wrap = action('Wrap', () => {
        dom.classList.toggle('de-wrapped');
        wrap.setAttribute(
          'aria-pressed',
          String(dom.classList.contains('de-wrapped')),
        );
      });
      wrap.classList.add('de-code-action');
      wrap.replaceChildren(
        lineIcon('wrap-text'),
      );
      const copyIcon = () => lineIcon('copy');
      const copy = action('Copy', async () => {
        try {
          await navigator.clipboard.writeText(node.textContent);
          copy.replaceChildren(lineIcon('check'));
          copy.dataset.copied = 'true';
          setTimeout(() => {
            if (copy.isConnected) {
              copy.replaceChildren(copyIcon());
              delete copy.dataset.copied;
            }
          }, 1000);
        } catch {
          const field = el('textarea', 'de-copy-field');
          field.value = node.textContent;
          dom.append(field);
          field.select();
          document.execCommand('copy');
          field.remove();
        }
      });
      copy.classList.add('de-code-action');
      copy.replaceChildren(copyIcon());
      bar.append(drawToggle, wrap, copy);
      dom.append(bar, result, pre);
      let drawnWidth = 0;
      const observer = new ResizeObserver(() => {
        if (node.attrs.lang === 'mermaid' && result.clientWidth && result.clientWidth !== drawnWidth) updateUI();
      });
      observer.observe(result);
      function updateUI() {
        const job = paint();
        return window.SamareDiagrams ? SamareDiagrams.track(job) : job;
      }
      async function paint() {
        const run = ++version,
          lang = (node.attrs.lang || '').split(/\s/)[0].toLowerCase(),
          diagram = lang === 'mermaid',
          math = special === 'Math' || lang === 'math' || lang === 'latex',
          svg = special === 'SVG' || lang === 'svg';
        const rendered = diagram || math || svg;
        if (!diagram) result.classList.remove('samare-diagram');
        result.classList.toggle('de-display-formula', math);
        result.hidden = !rendered;
        pre.hidden = rendered && !sourceOpen;
        drawToggle.hidden = !rendered || mode === 'preview';
        drawToggle.textContent = sourceOpen ? 'Done' : 'Source';
        drawToggle.title = drawToggle.textContent;
        drawToggle.setAttribute('aria-label',drawToggle.textContent);
        if (!rendered) return;
        if (math) {
          mathRender(result, node.textContent, true);
          return;
        }
        if (svg) {
          const parsed = new DOMParser().parseFromString(
            node.textContent,
            'image/svg+xml',
          );
          if (parsed.documentElement.localName !== 'svg') {
            result.replaceChildren(
              el('pre', 'de-diagram-error', node.textContent),
            );
            return;
          }
          const img = el('img', 'de-svg');
          img.alt = 'SVG diagram';
          img.src =
            'data:image/svg+xml;charset=utf-8,' +
            encodeURIComponent(node.textContent);
          result.replaceChildren(img);
          return;
        }
        try {
          if (window.SamareDiagrams) {
            await Promise.all([loadEngine('pele.global.js', 'pele'), document.fonts.ready]);
            if (run !== version || !dom.isConnected) return;
            drawnWidth = result.clientWidth;
            try {
              SamareDiagrams.draw(result, node.textContent, drawnWidth || 624);
              return;
            } catch { /* Mermaid.js also supports syntax outside Pele's parser. */ }
          }
          result.classList.remove('samare-diagram');
          const engine = await loadEngine('mermaid.min.js', 'mermaid');
          if (run !== version || !dom.isConnected) return;
          const dark = settings.theme
            ? settings.theme === 'dark'
            : matchMedia('(prefers-color-scheme: dark)').matches;
          engine.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            suppressErrorRendering: true,
            theme: dark ? 'dark' : 'default',
            flowchart: { htmlLabels: false },
            maxTextSize: 50000,
          });
          const { svg } = await engine.render(
            'de-diagram-' + ++uid + '-' + ++diagramSequence,
            node.textContent,
          );
          if (run === version && dom.isConnected) result.innerHTML = svg;
        } catch (err) {
          if (run === version) {
            result.replaceChildren(
              el('pre', 'de-diagram-error', node.textContent),
            );
            result.title = String(err.message || err);
          }
        }
      }
      diagramRenderers.add(updateUI);
      queueMicrotask(updateUI);
      return {
        dom,
        contentDOM: code,
        update(next) {
          if (next.type !== node.type) return false;
          const changed = !next.eq(node);
          node = next;
          select.value = node.attrs.lang || '';
          languageName.textContent =
            select.selectedOptions[0]?.textContent || 'Plain text';
          if (changed) updateUI();
          return true;
        },
        ignoreMutation(m) {
          return m.type !== 'selection' && !code.contains(m.target);
        },
        stopEvent(e) {
          return bar.contains(e.target) || result.contains(e.target);
        },
        destroy() {
          version++;
          closeLanguage();
          observer.disconnect();
          diagramRenderers.delete(updateUI);
          document.removeEventListener('pointerdown', dismiss, true);
          document.removeEventListener('keydown', escape, true);
        },
      };
    }
    function nodeViews() {
      return {
        conflict(node, editor, getPos) {
          const dom = el('section', 'de-conflict');
          dom.contentEditable = 'false';
          dom.setAttribute('aria-label', 'Conflicting changes');
          const { mine, theirs } = node.attrs;
          const diff = window.Diff?.diffWordsWithSpace(mine, theirs, {
            timeout: 60,
          }) || [
            { value: mine, removed: true },
            { value: theirs, added: true },
          ];
          function choose(side) {
            if (longDoc) hydrateTo(longDoc.chunks.length);
            const pos = getPos();
            let start;
            const body = serialize(
              editor.state.doc,
              meta,
              (blockPos, offset) => {
                if (blockPos === pos) start = offset;
              },
            );
            if (start === undefined) return;
            const change = window.SamareMerge.conflicts(body.slice(start))[0];
            if (!change || change.start !== 0) return;
            const next = rememberSource(
              body.slice(0, start) +
                change[side] +
                body.slice(start + change.end),
            );
            const tr = editor.state.tr
              .replaceWith(0, editor.state.doc.content.size, next.doc.content)
              .setDocAttribute('sourceVersion', next.doc.attrs.sourceVersion);
            const near = tr.doc.resolve(Math.min(pos, tr.doc.content.size));
            editor.dispatch(
              L.closeHistory(tr.setSelection(L.Selection.near(near))),
            );
          }
          for (const [side, title, button] of [
            ['mine', 'Your version', 'Keep mine'],
            ['theirs', 'New version', 'Use new version'],
          ]) {
            const pane = el('div', 'de-conflict-side');
            const body = el('div', 'de-conflict-text');
            for (const part of diff) {
              if (side === 'mine' ? part.added : part.removed) continue;
              body.append(
                part.added || part.removed
                  ? el('span', 'de-conflict-change', part.value)
                  : document.createTextNode(part.value),
              );
            }
            if (!node.attrs[side]) body.append(el('em', '', '(Deleted)'));
            pane.append(el('div', 'de-conflict-label', title), body);
            if (mode !== 'preview')
              pane.append(action(button, () => choose(side)));
            dom.append(pane);
          }
          return { dom, stopEvent: () => true, ignoreMutation: () => true };
        },
        code_block: (n, v, p) => codeView(n, v, p),
        displaymath: (n, v, p) => codeView(n, v, p, 'Math'),
        svg_block: (n, v, p) => codeView(n, v, p, 'SVG'),
        table() {
          const dom = el('div', 'de-table-frame');
          const table = el('table');
          const contentDOM = el('tbody');
          table.append(contentDOM);
          dom.append(table);
          return { dom, contentDOM };
        },
        list_item(node, editor, getPos) {
          let current = node;
          const dom = el('li'),
            body = el('div', 'de-list-body');
          const check = el('input', 'de-task');
          check.type = 'checkbox';
          check.contentEditable = 'false';
          check.setAttribute('aria-label', 'Task complete');
          function render() {
            if (current.attrs.checked === null) {
              dom.removeAttribute('data-checked');
              check.remove();
            } else {
              dom.dataset.checked = String(current.attrs.checked);
              check.checked = current.attrs.checked;
              check.disabled = mode === 'preview';
              if (!dom.contains(check)) dom.prepend(check);
            }
          }
          check.onchange = () =>
            editor.dispatch(
              editor.state.tr.setNodeMarkup(getPos(), undefined, {
                ...current.attrs,
                checked: check.checked,
              }),
            );
          dom.append(body);
          render();
          return {
            dom,
            contentDOM: body,
            update(n) {
              if (n.type !== current.type) return false;
              current = n;
              render();
              return true;
            },
            stopEvent: (e) => e.target === check,
            ignoreMutation: (m) =>
              m.type !== 'selection' && !body.contains(m.target),
          };
        },
        image(node) {
          const src = resolveImage(node.attrs.src),
            dom = el(src ? 'img' : 'span', 'de-image');
          if (src) {
            dom.alt = node.attrs.alt;
            dom.src = src;
            dom.loading = 'lazy';
          } else dom.textContent = node.attrs.alt || node.attrs.src;
          dom.title = node.attrs.title || node.attrs.alt;
          return { dom };
        },
        inlinemath(node, editor, getPos) {
          const dom = el('span', 'de-inline-math');
          dom.contentEditable = 'false';
          mathRender(dom, node.attrs.tex, false);
          dom.onmousedown = event => { if (mode !== 'preview') event.preventDefault(); };
          dom.onclick = event => {
            if (mode === 'preview') return;
            event.stopPropagation();
            inlineEditor({ title:'Edit formula', label:'LaTeX source', value:node.attrs.tex, multiline:true,
              anchor:() => dom.getBoundingClientRect(), preview:tex => mathRender(dom,tex,false),
              commit(tex, direction) {
                const pos = getPos();
                if (!Number.isInteger(pos)) return;
                const tr = editor.state.tr;
                if (tex !== node.attrs.tex) {
                  if (tex) tr.setNodeMarkup(pos, undefined, {tex});
                  else tr.delete(pos,pos+1);
                }
                if (direction) tr.setSelection(L.TextSelection.create(tr.doc, pos + (direction === 'after' && tex ? 1 : 0)));
                if (tr.docChanged || tr.selectionSet) editor.dispatch(L.closeHistory(tr));
                if (direction) editor.focus();
              },
            });
          };
          return { dom, stopEvent:e => e.type === 'mousedown' || e.type === 'click', ignoreMutation: () => true };
        },
      };
    }
    // Decorations overlap at nested token boundaries. Apply the same precedence
    // as the reader's token palette to keep aliases and their children in sync.
    const scriptColors = [
      ['de-code-ink', ['operator', 'entity', 'url']],
      ['de-muted', ['punctuation']],
      ['hljs-type', ['class-name', 'builtin', 'type', 'namespace']],
      ['hljs-title', ['function', 'method']],
      ['hljs-comment', ['comment', 'prolog', 'doctype', 'cdata']],
      ['hljs-number', ['number', 'boolean', 'constant']],
      ['hljs-string', ['string', 'char', 'template-string', 'attr-value', 'regex']],
      ['hljs-keyword', ['keyword', 'tag', 'attr-name', 'selector', 'important', 'atrule']],
    ];
    function scriptTokens(source, grammar, output) {
      let offset = 0;
      function visit(items, inherited) {
        for (const item of items) {
          if (typeof item === 'string') {
            const color = scriptColors.find(([, names]) => names.some(name => inherited.includes(name)));
            const classes = [color?.[0], inherited.includes('bold') && 'de-code-bold', inherited.includes('italic') && 'de-code-italic'].filter(Boolean);
            if (classes.length && item.length) output.push([offset, offset + item.length, classes.join(' ')]);
            offset += item.length;
          } else {
            const kinds = inherited.concat(item.type, item.alias || []);
            visit(Array.isArray(item.content) ? item.content : [item.content], kinds);
          }
        }
      }
      visit(window.SamareScriptGrammar.tokenize(source, grammar), []);
    }
    function codeWikiColors(source, tokens) {
      let open = source.indexOf('[[');
      while (open !== -1) {
        const close = source.indexOf(']', open + 2);
        if (close === -1) break;
        if (source[close + 1] === ']') {
          // A fence keeps its delimiters and target text. Only the visible
          // label takes link ink, including when it crosses a source newline.
          while (open !== -1 && open < close) {
            const inner = source.slice(open + 2, close);
            const pipe = inner.indexOf('|');
            if (pipe === inner.length - 1 && pipe >= 0) break;
            const target = pipe < 0 ? inner : inner.slice(0, pipe);
            if (target.trim()) {
              tokens.push([open + 2 + (pipe < 0 ? 0 : pipe + 1), close, 'de-code-link']);
              break;
            }
            if (pipe < 0) break;
            open = source.indexOf('[[', open + 3 + pipe);
          }
        }
        open = source.indexOf('[[', close + 1);
      }
    }
    const syntaxCache = new WeakMap();
    function highlighting(doc) {
      const spans = [];
      doc.descendants((node, pos) => {
        if (node.type !== N.code_block) return;
        const language = (node.attrs.lang || '').split(/\s/)[0],
          source = node.textContent;
        if (!source || source.length > 30000) return;
        let tokens = syntaxCache.get(node);
        if (!tokens) {
          tokens = [];
          const wide =
            /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff01-\uff60]+/gu;
          for (const run of source.matchAll(wide))
            tokens.push([run.index, run.index + run[0].length, 'de-code-wide']);
          codeWikiColors(source, tokens);
          const grammars = window.SamareScriptGrammar.languages;
          const id = language.toLowerCase();
          const scriptGrammar = Object.hasOwn(grammars, id) && grammars[id];
          if (scriptGrammar && typeof scriptGrammar === 'object') {
            scriptTokens(source, scriptGrammar, tokens);
          } else if (!/^(?:jsx|tsx)$/i.test(language) && L.hljs.getLanguage(language)) {
            const tmp = el('div');
            tmp.innerHTML = L.hljs.highlight(source, {
              language,
              ignoreIllegals: true,
            }).value;
            const walk = document.createTreeWalker(tmp, NodeFilter.SHOW_TEXT);
            let offset = 0,
              leaf;
            while ((leaf = walk.nextNode())) {
              const len = leaf.data.length,
                cls = leaf.parentElement.className;
              if (cls && len) tokens.push([offset, offset + len, cls]);
              offset += len;
            }
          }
          syntaxCache.set(node, tokens);
        }
        for (const [a, b, cls] of tokens)
          spans.push(
            L.Decoration.inline(pos + 1 + a, pos + 1 + b, { class: cls }),
          );
      });
      return L.DecorationSet.create(doc, spans);
    }
    function runPM(fn) {
      if (!view || mode === 'preview') return false;
      const ok = fn(view.state, view.dispatch, view);
      if (ok) view.focus();
      return ok;
    }
    function rules() {
      return L.inputRules({
        rules: [
          L.textblockTypeInputRule(/^(#{1,6})\s$/, N.heading, (m) => ({
            level: m[1].length,
          })),
          L.wrappingInputRule(/^\s*>\s$/, N.blockquote),
          L.wrappingInputRule(/^\s*([-+*])\s$/, N.bullet_list, m => ({marker:m[1]})),
          L.wrappingInputRule(/^(\d+)\.\s$/, N.ordered_list, (m) => ({
            order: Number(m[1]),
          })),
          L.textblockTypeInputRule(/^```(\w*)\s$/, N.code_block, (m) => ({
            lang: m[1],
          })),
          new L.InputRule(
            /\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]$/,
            (state, match, start, end) =>
              state.tr
                .replaceWith(
                  start,
                  end,
                  schema.text(
                    match[2] || match[1],
                    M.link.create({ href: match[1], wiki: true }),
                  ),
                )
                .removeStoredMark(M.link),
          ),
          ...[
            ['strong', /\*\*([^*\n]+)\*\*$/],
            ['em', /(?:^|(?<=\s))\*([^*\n]+)\*$/],
            ['code', /`([^`\n]+)`$/],
            ['strike', /~~([^~\n]+)~~$/],
          ].map(
            ([kind, re]) =>
              new L.InputRule(re, (state, match, start, end) => {
                const tr = state.tr.replaceWith(
                  start,
                  end,
                  schema.text(match[1], M[kind].create()),
                );
                return tr.removeStoredMark(M[kind]);
              }),
          ),
          new L.InputRule(/^\[([ xX])\]\s$/, (state, match, start, end) => {
            const p = state.doc.resolve(start);
            if (p.depth < 2 || p.node(-1).type !== N.list_item) return null;
            return state.tr
              .delete(start, end)
              .setNodeMarkup(p.before(p.depth - 1), undefined, {
                checked: match[1] !== ' ',
              });
          }),
        ],
      });
    }
    function splitNumbering(state, dispatch) {
      const {empty, $from} = state.selection;
      const depth = $from.depth - 2;
      if (!empty || depth < 1 || $from.parent.type !== N.paragraph || $from.parent.content.size ||
          $from.node(depth+1).type !== N.list_item) return false;
      const list = $from.node(depth), index = $from.index(depth);
      if (list.type !== N.ordered_list || !index || index >= list.childCount-1) return false;
      if (dispatch) {
        const items = children(list), at = $from.before(depth);
        const left = list.type.create(list.attrs,items.slice(0,index));
        const right = list.type.create({...list.attrs,uid:null,
          order:list.attrs.order === 1 ? 1+index : list.attrs.order},items.slice(index+1));
        const tr = state.tr.replaceWith(at,at+list.nodeSize,[left,N.paragraph.create(),right]);
        dispatch(tr.setSelection(L.TextSelection.create(tr.doc,at+left.nodeSize+1)).scrollIntoView());
      }
      return true;
    }
    function removeEmptyLineAfterRule(state, dispatch) {
      const {empty, $from} = state.selection;
      if (!empty || $from.depth !== 1 || $from.parent.type !== N.paragraph || $from.parent.content.size) return false;
      const at = $from.before(), before = state.doc.resolve(at).nodeBefore;
      if (before?.type !== N.horizontal_rule) return false;
      if (dispatch) {
        const tr = state.tr.delete(at, at + $from.parent.nodeSize);
        tr.setSelection(L.TextSelection.near(tr.doc.resolve(Math.min(at,tr.doc.content.size)), 1));
        dispatch(tr.scrollIntoView());
      }
      return true;
    }
    function rejoinNumbering(state, dispatch) {
      const {empty,$from} = state.selection;
      if (!empty || $from.parent.type !== N.paragraph || $from.parent.content.size) return false;
      const parent = $from.node(-1), index = $from.index(-1);
      const left = parent.maybeChild(index-1), right = parent.maybeChild(index+1);
      if (left?.type !== N.ordered_list || right?.type !== N.ordered_list) return false;
      if (dispatch) {
        const at = $from.before()-left.nodeSize;
        const tr = state.tr.replaceWith(at,$from.after()+right.nodeSize,left.copy(left.content.append(right.content)));
        const near = tr.doc.resolve(at+left.nodeSize-3);
        dispatch(tr.setSelection(L.Selection.near(near,-1)).scrollIntoView());
      }
      return true;
    }
    function editorView() {
      const parts = splitHeader(text);
      header = parts.header;
      yaml = parts.yaml;
      sourceVersions.clear();
      const chunks = markdownChunks(parts.body);
      meta = rememberSource(chunks[0]);
      if (chunks.length > 1) {
        longDoc = { body: parts.body, chunks: chunks.map(raw => ({ raw, parsed: null })),
          consumed: chunks[0].length, next: 1 };
        root.dataset.longDoc = 'true';
        root.dataset.hydratedFraction = (longDoc.consumed / parts.body.length).toFixed(3);
      }
      props = el('div', 'de-properties');
      article.append(props);
      properties();
      const holder = el('div', 'de-rich');
      article.append(holder);
      const keys = {
        'Mod-z': L.undo,
        'Shift-Mod-z': L.redo,
        'Mod-y': L.redo,
        'Mod-b': L.toggleMark(M.strong),
        'Mod-i': L.toggleMark(M.em),
        'Mod-e': L.toggleMark(M.code),
        'Mod-Shift-x': L.toggleMark(M.strike),
        'Mod-k': () => command('link'),
        Enter: L.chainCommands(splitNumbering,L.splitListItem(N.list_item)),
        Backspace: L.chainCommands(removeEmptyLineAfterRule,L.undoInputRule,rejoinNumbering),
        Tab: L.chainCommands(L.goToNextCell(1), L.sinkListItem(N.list_item)),
        'Shift-Tab': L.chainCommands(
          L.goToNextCell(-1),
          L.liftListItem(N.list_item),
        ),
        'Shift-Enter': L.chainCommands(L.exitCode, (state, dispatch) => {
          if (dispatch)
            dispatch(
              state.tr
                .replaceSelectionWith(N.hard_break.create())
                .scrollIntoView(),
            );
          return true;
        }),
      };
      for (let level = 1; level <= 6; level++)
        keys['Mod-Alt-' + level] = L.setBlockType(N.heading, { level });
      const syntax = new L.Plugin({
        state: {
          init: (_, state) => highlighting(state.doc),
          apply: (tr, old) => (tr.docChanged ? highlighting(tr.doc) : old),
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      });
      const revisionMarks = new L.Plugin({
        state: {
          init:() => L.DecorationSet.empty,
          apply(tr, old) {
            const spans = tr.getMeta('revisionMarks');
            return spans ? L.DecorationSet.create(tr.doc,spans) : old.map(tr.mapping,tr.doc);
          },
        },
        props:{ decorations(state) { return this.getState(state); } },
      });
      view = new L.EditorView(holder, {
        state: L.EditorState.create({
          doc: meta.doc,
          plugins: [
            rules(),
            L.keymap(keys),
            L.keymap(L.baseKeymap),
            L.history(),
            L.tableEditing(),
            syntax,
            revisionMarks,
          ],
        }),
        editable: () => mode !== 'preview',
        attributes: {
          'aria-label': 'Markdown document',
          role: 'textbox',
          'aria-multiline': 'true',
          spellcheck: String(settings.spellcheck ?? false),
        },
        nodeViews: nodeViews(),
        clipboardTextParser: (s) => {
          const doc = parseBody(s).doc,
            slice = doc.slice(0, doc.content.size);
          return slice.constructor.maxOpen(slice.content);
        },
        clipboardTextSerializer: (slice) => {
          const nodes = [];
          slice.content.forEach((n) =>
            nodes.push(n.isText ? n.text : blockSource(n)),
          );
          return nodes.join('\n\n');
        },
        handleClick(v, pos, e) {
          const link = e.target.closest?.('a[data-target]');
          if (!link) return false;
          if (
            mode === 'preview' ||
            link.dataset.wiki === 'true' ||
            e.metaKey ||
            e.ctrlKey
          ) {
            e.preventDefault();
            options.onLink?.(link.dataset.target);
            return true;
          }
          e.preventDefault();
          editLink(link);
          return true;
        },
        handleKeyDown(v, e) {
          if (longDoc && ((e.metaKey && e.key === 'ArrowDown') || (e.ctrlKey && e.key === 'End')))
            hydrateTo(longDoc.chunks.length);
          // End/Home can move the browser caret before selectionchange reaches
          // ProseMirror. Split or join at the caret the user can actually see.
          if (!e.isComposing && (e.key === 'Enter' || e.key === 'Backspace')) {
            const domSelection = document.getSelection();
            const anchor = domSelection?.anchorNode;
            const cell = anchor?.nodeType === 1 ? anchor : anchor?.parentElement;
            if (domSelection?.isCollapsed && cell?.closest('li') && v.dom.contains(anchor)) {
              const pos = v.posAtDOM(anchor,domSelection.anchorOffset);
              if (v.state.selection.from !== pos && v.state.doc.resolve(pos).parent.inlineContent)
                v.dispatch(v.state.tr.setSelection(L.TextSelection.create(v.state.doc,pos)));
            }
          }
          if (!picker || e.isComposing) return false;
          if (e.key === 'Escape') {
            closePicker();
            return true;
          }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            pickerIndex =
              (pickerIndex +
                (e.key === 'ArrowDown' ? 1 : -1) +
                pickerItems.length) %
              pickerItems.length;
            const buttons = picker.querySelectorAll('[role=option]');
            buttons.forEach((b, i) =>
              b.setAttribute('aria-selected', String(i === pickerIndex)),
            );
            buttons[pickerIndex]?.scrollIntoView({ block: 'nearest' });
            return true;
          }
          if (e.key === 'Enter' || e.key === 'Tab') {
            picker.querySelectorAll('[role=option]')[pickerIndex]?.click();
            return true;
          }
          return false;
        },
        handleDOMEvents: {
          click: (v, e) => {
            if (e.target.closest?.('a[data-target]')) e.preventDefault();
            return false;
          },
        },
        dispatchTransaction(tr) {
          const state = this.state.apply(tr);
          this.updateState(state);
          if (tr.getMeta('hydrate')) return;
          if (tr.docChanged) {
            meta = sourceVersions.get(state.doc.attrs.sourceVersion) || meta;
            commit(header + serialize(state.doc, meta) + pendingBody());
            refreshOutline();
          }
          updateSelectionBar();
          updatePicker();
        },
      });
      refreshOutline();
      if (longDoc) scheduleHydration(longDoc);
    }
    function closePicker() {
      clearTimeout(pickerTimer);
      picker?.remove();
      picker = null;
      pickerItems = [];
      pickerIndex = 0;
      pickerKey = '';
      pickerVersion++;
    }
    function updatePicker() {
      if (!view || mode !== 'edit' || view.composing) return;
      const sel = view.state.selection,
        p = sel.$from;
      const prefix =
        sel.empty && !p.parent.type.spec.code
          ? p.parent.textBetween(0, p.parentOffset, '', '\ufffc')
          : '';
      const slash = /^\/([\w -]{0,40})$/.exec(prefix);
      if (slash) {
        showSlash(slash, sel);
        return;
      }
      const match =
        options.onNoteSearch && /\[\[([^\[\]\n|]{0,100})$/.exec(prefix);
      if (!match) {
        closePicker();
        return;
      }
      const key = p.pos + ':' + match[1];
      if (key === pickerKey) return;
      closePicker();
      pickerKey = key;
      const ticket = pickerVersion;
      pickerTimer = setTimeout(
        () =>
          options.onNoteSearch(match[1], (rows) => {
            if (
              destroyed ||
              ticket !== pickerVersion ||
              !view ||
              !Array.isArray(rows)
            )
              return;
            pickerItems = rows
              .filter((r) => /\.(md|markdown|mdown|mkd)$/i.test(r.name))
              .slice(0, 8);
            if (!pickerItems.length) return;
            const box = view.coordsAtPos(sel.from);
            picker = el('div', 'de-note-picker');
            picker.setAttribute('role', 'listbox');
            picker.style.left =
              Math.min(box.left, window.innerWidth - 245) + 'px';
            picker.style.top =
              Math.min(
                box.bottom + 4,
                window.innerHeight - pickerItems.length * 29 - 12,
              ) + 'px';
            pickerItems.forEach((item, index) => {
              const name = item.name.replace(
                  /\.(?:md|markdown|mdown|mkd)$/i,
                  '',
                ),
                b = action(
                  name,
                  () => {
                    if (!view || view.state.selection.from !== sel.from) return;
                    const dirs = path.split('/').slice(0, -1),
                      target = item.path.split('/');
                    while (
                      dirs.length &&
                      target.length &&
                      dirs[0] === target[0]
                    ) {
                      dirs.shift();
                      target.shift();
                    }
                    const href = [...dirs.map(() => '..'), ...target]
                      .join('/')
                      .replace(/\.(?:md|markdown|mdown|mkd)$/i, '');
                    const node = schema.text(
                      name,
                      M.link.create({ href: href || name, wiki: true }),
                    );
                    closePicker();
                    view.dispatch(
                      view.state.tr
                        .replaceWith(sel.from - match[0].length, sel.from, node)
                        .removeStoredMark(M.link),
                    );
                    view.focus();
                  },
                  item.name,
                );
              b.onmousedown = (e) => e.preventDefault();
              b.setAttribute('role', 'option');
              b.setAttribute('aria-selected', String(index === 0));
              picker.append(b);
            });
            root.append(picker);
          }),
        80,
      );
    }
    function showSlash(match, sel) {
      const key = 'slash:' + sel.from + match[1];
      if (key === pickerKey) return;
      closePicker();
      pickerKey = key;
      const commands = [
        ['Text', 'pilcrow', 'Paragraph', 'paragraph'],
        ...[1,2,3,4].map(n => ['Text', 'heading-' + n, 'Heading ' + n, 'heading', n, '⌘' + n]),
        ['Text', 'quote', 'Block Quote', 'blockquote'],
        ['Text', 'radical', 'Inline Math', 'inlineMath'],
        ['Text', 'bold', 'Bold', 'bold', null, '⌘B'],
        ['Text', 'italic', 'Italic', 'italic', null, '⌘I'],
        ['Text', 'strikethrough', 'Strikethrough', 'strike'],
        ['Text', 'code', 'Inline Code', 'code', null, '⌘E'],
        ['List', 'list', 'Bullet List', 'bulletList', null, '⌘⇧8'],
        ['List', 'list-ordered', 'Numbered List', 'orderedList', null, '⌘⇧7'],
        ['List', 'list-checks', 'Task List', 'taskList'],
        ['Insert', 'code', 'Code Block', 'codeBlock'],
        ['Insert', 'table', 'Table', 'table'],
        ['Insert', 'minus', 'Divider', 'horizontalRule'],
        ['Insert', 'sigma', 'Math Block', 'blockMath'],
        ['Insert', 'workflow', 'Mermaid Diagram', 'mermaid'],
        ['Insert', 'shapes', 'SVG', 'svg'],
        ['Insert', 'list-plus', 'Properties', 'properties'],
        ['Insert', 'image', 'Image', 'image'],
        ['Insert', 'link-2', 'Markdown Link', 'link', null, '⌘K'],
        ['Insert', 'brackets', 'Wikilink', 'wikilink'],
      ];
      const q = match[1].toLowerCase().trim();
      pickerItems = commands.filter(
        (c) => !q || (c[2] + ' ' + c[3]).toLowerCase().includes(q),
      );
      if (!pickerItems.length) return;
      picker = el('div', 'de-note-picker de-slash');
      picker.setAttribute('role', 'listbox');
      picker.setAttribute('aria-label', 'Insert block');
      let prevGroup = '';
      pickerItems.forEach(([group, icon, label, cmd, arg, hint], i) => {
        if (group !== prevGroup) {
          picker.append(el('div', 'de-slash-group', group));
          prevGroup = group;
        }
        const b = action(label, () => {
          closePicker();
          view.dispatch(
            view.state.tr.delete(sel.from - match[0].length, sel.from),
          );
          view.focus();
          command(cmd, arg);
        });
        const mark = el('span', 'de-slash-icon');
        mark.append(lineIcon(icon));
        b.replaceChildren(mark, el('span', '', label));
        if (hint) b.append(el('span', 'de-slash-hint', hint));
        b.setAttribute('role', 'option');
        b.setAttribute('aria-selected', String(i === 0));
        b.onmousedown = (e) => e.preventDefault();
        picker.append(b);
      });
      const box = view.coordsAtPos(sel.from);
      picker.style.left =
        Math.max(6, Math.min(box.left, innerWidth - 252)) + 'px';
      const below = innerHeight - box.bottom - 12,
        above = box.top - 12,
        height = Math.min(350, Math.max(110, below > 175 ? below : above));
      picker.style.maxHeight = height + 'px';
      if (below > 175) picker.style.top = box.bottom + 3 + 'px';
      else picker.style.bottom = innerHeight - box.top + 3 + 'px';
      root.append(picker);
    }
    function updateSelectionBar() {
      if (!selectionBar || !view) return;
      const selection = view.state.selection;
      selectionBar.hidden =
        mode !== 'edit' || selection.empty || !view.hasFocus();
      if (selectionBar.hidden) return;
      try {
        const box = view.coordsAtPos(selection.from);
        selectionBar.style.left =
          Math.max(8, Math.min(window.innerWidth - 235, box.left)) + 'px';
        selectionBar.style.top = Math.max(8, box.top - 40) + 'px';
      } catch {
        selectionBar.hidden = true;
      }
    }
    function dataInput(value, label, write, { readonly = false } = {}) {
      const field = el('textarea', 'de-cell');
      field.rows = 1;
      field.value = value;
      field.spellcheck = false;
      field.setAttribute('aria-label', label);
      field.readOnly = readonly;
      if (!write) return field;
      field.addEventListener('input', () => {
        try {
          write(field.value);
          field.setCustomValidity('');
          field.classList.remove('de-invalid');
        } catch (e) {
          field.setCustomValidity(e.message);
          field.classList.add('de-invalid');
        }
      });
      field.addEventListener('blur', () => {
        if (!field.checkValidity()) field.reportValidity();
      });
      field.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const list = [...article.querySelectorAll('.de-cell')];
          list[list.indexOf(field) + 1]?.focus();
        }
      });
      return field;
    }
    function dataHeading(summary) {
      dataBar = el('header', 'de-data-header');
      const wrap = el('div'),
        name = path.split('/').pop() || 'Untitled',
        title = el('h1');
      const suffix = name.lastIndexOf('.');
      title.textContent = suffix > 0 ? name.slice(0, suffix) : name;
      if (suffix > 0)
        title.append(el('span', 'de-extension', name.slice(suffix)));
      if (options.modified) {
        const elapsed = Math.max(0, Date.now() / 1000 - options.modified);
        summary +=
          ' · edited ' +
          (elapsed < 60
            ? 'just now'
            : elapsed < 3600
              ? Math.floor(elapsed / 60) + 'm ago'
              : elapsed < 86400
                ? Math.floor(elapsed / 3600) + 'h ago'
                : Math.floor(elapsed / 86400) + 'd ago');
      }
      wrap.append(title, el('div', 'de-data-summary', summary));
      dataBar.append(wrap);
      const buttons = el('div', 'de-view-actions');
      if (lines && mode !== 'source') {
        const order = action(
          '',
          () => {
            newestFirst = !newestFirst;
            jsonPages.delete('records');
            render();
          },
          newestFirst ? 'Oldest first' : 'Newest first',
        );
        order.classList.add('de-sort-order');
        order.setAttribute('aria-pressed', String(newestFirst));
        order.append(
          lineIcon(newestFirst ? 'arrow-down-10' : 'arrow-down-01'),
        );
        buttons.append(order);
      }
      const modes = el('div', 'de-segment');
      const columns = action(
          isCSV ? '▦' : '☷',
          () => setMode('edit'),
          isCSV ? 'Table' : lines ? 'Records' : 'Fields',
        ),
        source = action('‹›', () => setMode('source'), 'Source');
      columns.replaceChildren(lineIcon(isCSV ? 'table' : 'list'));
      source.replaceChildren(lineIcon('code'));
      columns.setAttribute('aria-pressed', String(mode !== 'source'));
      source.setAttribute('aria-pressed', String(mode === 'source'));
      modes.append(columns, source);
      buttons.append(modes);
      dataBar.append(buttons);
      surface.append(dataBar);
    }
    function csvCellText(source, row, column, value) {
      const cell = row[column],
        last = row[row.length - 1];
      const encoded = csvEncode(value, delimiter, cell?.quoted);
      return cell
        ? source.slice(0, cell.start) + encoded + source.slice(cell.end)
        : source.slice(0, last.end) +
            delimiter.repeat(column - row.length + 1) +
            encoded +
            source.slice(last.end);
    }
    let parsedSource, parsedData, dataProblem, dataSummary = '';
    const jsonPages = new Map();
    const jsonPageSize = 100;
    let recordPageCount = 1, jumpToFresh = false;
    function readData() {
      if (parsedSource === text) return;
      parsedSource = text;
      parsedData = undefined; dataProblem = undefined;
      try {
        parsedData = isCSV ? csvRows(text, delimiter) : jsonRoots(text, lines);
        const units = (count, label) => count.toLocaleString('en-US') + ' ' + label + (count === 1 ? '' : 's');
        if (isCSV) {
          dataSummary = units(Math.max(0, parsedData.length - (csvHeader ? 1 : 0)), 'row') + ' · ' + units(gridWidth(parsedData), 'column');
        } else {
          dataSummary = lines ? units(parsedData.length, 'record') : units(parsedData[0]?.entries.length || 0, 'field');
        }
      } catch (error) {
        dataProblem = error;
        dataSummary = isJSON ? text.trimEnd().split(/\r\n|\r|\n/).length + ' lines' : 'Invalid ' + ext.toUpperCase();
      }
    }
    // Header mode is a per-document view preference. Keep the file untouched.
    let csvHeader = true;
    const csvHeaderKey = 'samare-csv-letters/' + (options.sessionRecovery || path);
    if (isCSV)
      try {
        csvHeader = localStorage.getItem(csvHeaderKey) !== '1';
      } catch {}
    function columnLetter(index) {
      let label = '';
      for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
        label = String.fromCharCode(65 + ((n - 1) % 26)) + label;
      return label;
    }
    function gridRows(parsed) {
      if (csvHeader && parsed.length) return parsed;
      const width = Math.max(1, gridWidth(parsed));
      const labels = Array.from({ length: width }, (_, i) => ({
        value: columnLetter(i),
      }));
      return [labels, ...parsed];
    }
    function csvPageSize(width) {
      return Math.max(10, Math.min(200, Math.floor(4000 / width)));
    }
    let searchGrid = null;
    let readingGridField = null;
    if (isCSV) root.addEventListener('focusin', ({target}) => {
      readingGridField = target.matches('.de-grid td[data-col] textarea:not([readonly])') ? target : null;
    });
    function findDataMatches({ query, caseSensitive = false } = {}) {
      if (!searchGrid) return null;
      if (!query) return [];
      if (searchGrid.source !== text) {
        searchGrid.rows = csvRows(text, delimiter);
        searchGrid.source = text;
      }
      const needle = caseSensitive ? query : query.toLowerCase();
      const hits = [];
      searchGrid.rows.forEach((cells, physicalRow) => {
        cells.forEach((cell, column) => {
          const value =
            csvDraft?.row === physicalRow && csvDraft.column === column
              ? csvDraft.field.value
              : cell.value;
          const from = (caseSensitive ? value : value.toLowerCase()).indexOf(
            needle,
          );
          if (from >= 0)
            hits.push({
              row: physicalRow + (csvHeader ? 0 : 1),
              column,
              from,
              to: from + query.length,
            });
        });
      });
      return hits;
    }
    function revealDataMatch(match) {
      if (
        !searchGrid ||
        !Number.isInteger(match?.row) ||
        !Number.isInteger(match?.column)
      )
        return null;
      if (match.row > 0) {
        const page = Math.floor((match.row - 1) / searchGrid.pageSize);
        if (page !== csvPage) {
          finishCSVCell();
          csvPage = page;
          render();
        }
      }
      const cell = article.querySelector(
        'tr[data-row="' + match.row + '"] [data-col="' + match.column + '"]',
      );
      return (
        cell?.querySelector(
          'textarea:not([hidden]), .de-column-trigger:not([hidden])',
        ) || null
      );
    }
    function finishCSVCell(cancel = false) {
      if (!csvDraft) return false;
      // Keydown can follow compositionend before the deferred external update.
      if (waiting && !composing) {
        applyWaiting();
        if (!csvDraft) return false;
      }
      const { field, initial, row, column } = csvDraft;
      csvDraft = null;
      if (cancel) field.value = initial;
      else if (field.value !== initial) {
        const cells = csvRows(text, delimiter)[row];
        if (cells) commit(csvCellText(text, cells, column, field.value), true);
        else field.value = initial;
      }
      field.defaultValue = field.value;
      return true;
    }
    // An external deletion must never turn a blur or quit into an insertion.
    // Retain the displaced draft separately until the user chooses its fate.
    const recoveryPrefix =
      'samare-csv-recovery/' +
      encodeURIComponent(options.sessionRecovery || path) +
      '/';
    const recoveries = new Map();
    let recoveryStore;
    if (isCSV)
      try {
        recoveryStore = options.sessionRecovery ? sessionStorage : localStorage;
        for (let i = 0; i < recoveryStore.length; i++) {
          const key = recoveryStore.key(i);
          if (!key.startsWith(recoveryPrefix)) continue;
          try {
            const record = JSON.parse(recoveryStore.getItem(key));
            if (
              typeof record.value === 'string' &&
              typeof record.raw === 'string' &&
              Array.isArray(record.header)
            )
              recoveries.set(key, record);
          } catch {}
        }
      } catch {}
    function keepRecovery(draft) {
      const record = {
        raw: draft.raw,
        column: draft.originalColumn,
        isHeader: draft.row === 0,
        header: draft.header,
        value: draft.value,
      };
      const key = recoveryPrefix + crypto.randomUUID();
      try {
        recoveryStore.setItem(key, JSON.stringify(record));
      } catch {
        record.memoryOnly = true;
      }
      recoveries.set(key, record);
    }
    function showRecoveries() {
      if (!recoveries.size) return;
      let header;
      try {
        header = gridRows(csvRows(text, delimiter))[0]?.map((c) => c.value);
      } catch {}
      const container = el('section', 'de-csv-recovery');
      container.setAttribute('aria-label', 'Recovered cell drafts');
      for (const [key, draft] of recoveries) {
        const row = el('div');
        const canAppend =
          header &&
          !draft.isHeader &&
          draft.header.length === header.length &&
          draft.header.every((v, i) => v === header[i]) &&
          mode !== 'preview';
        row.append(
          el(
            'p',
            '',
            'The edited row or column changed on disk. Your cell draft is available below.',
          ),
        );
        const field = dataInput(draft.value, 'Recovered cell draft', null, {
          readonly: true,
        });
        row.append(field);
        function remove() {
          recoveries.delete(key);
          try {
            recoveryStore.removeItem(key);
          } catch {}
          row.remove();
          if (!container.children.length) container.remove();
        }
        if (canAppend)
          row.append(
            action('Add as new row', () => {
              finishCSVCell();
              const old = csvRows(draft.raw, delimiter)[0] || [
                { start: 0, end: 0, value: '', quoted: false },
              ];
              const raw = csvCellText(draft.raw, old, draft.column, draft.value);
              const eol = text.match(/\r\n|\r|\n/)?.[0] || '\n';
              const ending = /[\r\n]$/.test(text);
              remove();
              commit(
                text +
                  (text && !ending ? eol : '') +
                  (raw || '""') +
                  (ending ? eol : ''),
                true,
              );
              render();
            }),
          );
        row.append(action('Discard draft', remove));
        container.append(row);
      }
      article.prepend(container);
    }
    function captureCSVDraft(incoming) {
      if (!csvDraft || csvDraft.field.value === csvDraft.initial) return null;
      const { field, column } = csvDraft;
      const row = csvDraft.row + (csvHeader ? 0 : 1);
      const old = gridRows(csvRows(text, delimiter));
      const snapshot = {
        row,
        column,
        originalColumn: column,
        value: field.value,
        from: field.selectionStart,
        to: field.selectionEnd,
        raw: text.slice(old[row][0].start, old[row].at(-1).end),
        header: old[0].map((c) => c.value),
      };
      let next;
      try {
        next = gridRows(csvRows(incoming, delimiter));
      } catch {
        snapshot.removed = true;
        return snapshot;
      }
      const same = (a, b) =>
        a.length === b.length && a.every((c, i) => c.value === b[i].value);
      let prefix = 0,
        before = old.length,
        after = next.length;
      while (
        prefix < before &&
        prefix < after &&
        same(old[prefix], next[prefix])
      )
        prefix++;
      while (
        before > prefix &&
        after > prefix &&
        same(old[before - 1], next[after - 1])
      ) {
        before--;
        after--;
      }
      if (row >= before) snapshot.row += next.length - old.length;
      else if (row >= prefix) {
        // Same-size replacement ranges can contain entirely different records.
        // Match identity before reattaching an edit to a coordinate.
        const previousHeader = old[0].map((c) => c.value);
        const currentHeader = next[0]?.map((c) => c.value) || [];
        const mapped = previousHeader.map((name, index) => {
          if (currentHeader[index] === name) return index;
          const offset = currentHeader.indexOf(name);
          return offset >= 0 && currentHeader.lastIndexOf(name) === offset
            ? offset
            : -1;
        });
        const candidates = [];
        for (let i = Math.max(1, prefix); i < after; i++)
          if (same(next[i], old[row])) candidates.push(i);
        if (row === 0) snapshot.row = 0;
        else if (candidates.length === 1) snapshot.row = candidates[0];
        else {
          const id = previousHeader.findIndex(
            (name, i) =>
              mapped[i] >= 0 &&
              /^(id|uuid|identifier|key)$/i.test(name.trim()) &&
              old[row][i]?.value,
          );
          const columns =
            id >= 0
              ? [id]
              : mapped
                  .map((_, i) => i)
                  .filter((i) => i !== column && mapped[i] >= 0);
          const votes = new Set();
          for (const i of columns) {
            const anchor = old[row][i]?.value;
            if (
              !anchor ||
              old.slice(1).filter((r) => r[i]?.value === anchor).length !== 1
            )
              continue;
            let found = -1;
            for (let j = 1; j < next.length; j++)
              if (next[j][mapped[i]]?.value === anchor) {
                if (found !== -1) {
                  found = -1;
                  break;
                }
                found = j;
              }
            if (found !== -1) votes.add(found);
          }
          // The active value can identify a row when *other* fields changed.
          // A single-column replacement has no independent record identity.
          if (
            !votes.size &&
            id < 0 &&
            old[row].length > 1 &&
            mapped[column] >= 0
          ) {
            const anchor = old[row][column]?.value;
            if (
              anchor &&
              old.slice(1).filter((r) => r[column]?.value === anchor).length ===
                1
            ) {
              const positions = next.flatMap((r, j) =>
                j && r[mapped[column]]?.value === anchor ? [j] : [],
              );
              if (positions.length === 1) votes.add(positions[0]);
            }
          }
          if (votes.size === 1) snapshot.row = votes.values().next().value;
          else snapshot.removed = true;
        }
      }
      if (!next[snapshot.row]) snapshot.removed = true;
      else {
        const width = Math.max(1, gridWidth(next));
        csvPage = Math.max(
          0,
          Math.floor((snapshot.row - 1) / csvPageSize(width)),
        );
      }
      const key = snapshot.header[column];
      if (key !== undefined && next[0]?.[column]?.value !== key) {
        const hits =
          next[0]
            ?.map((c, i) => (c.value === key ? i : -1))
            .filter((i) => i >= 0) || [];
        if (hits.length === 1) snapshot.column = hits[0];
        else snapshot.removed = true;
      }
      return snapshot;
    }
    function restoreCSVDraft(draft) {
      const field =
        !draft.removed &&
        article.querySelector(
          'tr[data-row="' +
            draft.row +
            '"] [data-col="' +
            draft.column +
            '"] textarea',
        );
      if (!field) {
        keepRecovery(draft);
        article.querySelector('.de-csv-recovery')?.remove();
        showRecoveries();
        article.querySelector('.de-csv-recovery textarea:last-of-type')?.focus();
        return;
      }
      if (field.hidden)
        field
          .closest('th')
          ?.querySelector('.de-column-trigger')
          ?.setAttribute('hidden', '');
      field.hidden = false;
      field.focus({ preventScroll: true });
      field.value = draft.value;
      field.setSelectionRange(draft.from, draft.to);
    }
    function dataGrid(parsed) {
      const rows = gridRows(parsed),
        headerOffset = csvHeader ? 0 : 1;
      const table = el('table', 'de-grid'),
        body = el('tbody'),
        width = Math.max(1, gridWidth(rows));
      const pageSize = csvPageSize(width),
        pageCount = Math.max(1, Math.ceil((rows.length - 1) / pageSize));
      searchGrid = { source: text, rows: parsed, pageSize };
      csvPage = Math.min(csvPage, pageCount - 1);
      function focusCell(y, x) {
        y = Math.max(0, Math.min(rows.length - 1, y));
        x = Math.max(0, Math.min(width - 1, x));
        const page = Math.max(0, Math.floor((y - 1) / pageSize));
        if (page !== csvPage) {
          csvPage = page;
          render();
        }
        article
          .querySelector('tr[data-row="' + y + '"] [data-col="' + x + '"]')
          ?.focus();
      }
      const colgroup = el('colgroup');
      colgroup.append(el('col', 'de-number-col'));
      let minimumWidth = 48;
      for (let x = 0; x < width; x++) {
        const col = el('col');
        const length = Math.max(
          4,
          ...rows
            .slice(0, 300)
            .map((row) =>
              [...(row[x]?.value || '')].reduce(
                (n, c) => n + (c.charCodeAt(0) > 255 ? 1.7 : 1),
                0,
              ),
            ),
        );
        const preferredWidth = Math.min(
          320,
          Math.max(72, Math.round(length * 7.0) + 22),
        );
        minimumWidth += preferredWidth;
        if (x !== width - 1) col.style.width = preferredWidth + 'px';
        colgroup.append(col);
      }
      table.style.minWidth = minimumWidth + 'px';
      table.append(colgroup);
      function changeRows(change) {
        const old = csvRows(text, delimiter),
          raw = old.map((row) => row.map((c) => text.slice(c.start, c.end)));
        const eol = text.match(/\r\n|\r|\n/)?.[0] || '\n',
          bom = text[0] === '\ufeff' ? '\ufeff' : '';
        const ends = old.map((row, i) =>
          text.slice(
            row[row.length - 1].end,
            old[i + 1]?.[0].start ?? text.length,
          ),
        );
        change(raw, ends);
        const result = raw
          .map(
            (r, i) =>
              r.join(delimiter) + (ends[i] || (i < raw.length - 1 ? eol : '')),
          )
          .join('');
        commit(bom + result, true);
        render();
      }
      function editRow(operation, rowIndex, column = null) {
        const deleting = operation === 'delete';
        const visualIndex = operation === 'below' ? rowIndex + 1 : rowIndex;
        const index = visualIndex - headerOffset;
        const selected = deleting
          ? Math.min(visualIndex, rows.length - 2)
          : visualIndex;
        csvPage = Math.max(0, Math.floor((selected - 1) / pageSize));
        changeRows((raw, ends) => {
          if (deleting) {
            raw.splice(index, 1);
            ends.splice(index, 1);
            return;
          }
          const eol =
            ends[index - 1] || ends[index] || ends.find(Boolean) || '\n';
          const blank = width === 1 ? ['""'] : Array(width).fill('');
          if (index === raw.length && !ends[index - 1]) {
            ends[index - 1] = eol;
            ends.push('');
          } else ends.splice(index, 0, eol);
          raw.splice(index, 0, blank);
        });
        if (column !== null && selected > 0) {
          article
            .querySelector(
              'tr[data-row="' + selected + '"] td[data-col="' + column + '"]',
            )
            ?.focus();
        }
      }
      function rowActions(index) {
        return [
          ['Insert row above', () => editRow('above', index), '⇧⌘↵'],
          ['Insert row below', () => editRow('below', index), '⌘↵'],
          ['Delete row', () => editRow('delete', index), '⌘⌫'],
        ];
      }
      function editColumn(operation, x, selectedRow = null) {
        const index = operation === 'right' ? x + 1 : x,
          deleting = operation === 'delete';
        if (!parsed.length) return;
        changeRows((raw) => {
          raw.forEach((r, i) => {
            if (deleting) r.splice(index, 1);
            else {
              while (r.length < index) r.push('');
              r.splice(index, 0, i === 0 ? 'new column' : '');
            }
          });
        });
        if (selectedRow !== null) {
          const selected = deleting
            ? Math.max(0, Math.min(index, width - 2))
            : index;
          article
            .querySelector(
              'tr[data-row="' + selectedRow + '"] [data-col="' + selected + '"]',
            )
            ?.focus();
        }
      }
      function columnMenu(trigger, x, field) {
        const entries = [];
        if (csvHeader)
          entries.push([
            'Rename column',
            () => {
              trigger.hidden = true;
              field.hidden = false;
              field.focus();
              field.setSelectionRange(0, 0);
            },
            null,
            'pencil-line',
          ]);
        entries.push(
          [
            'Insert column left',
            () => editColumn('left', x),
            '⌥⌘←',
            'arrow-left-to-line',
          ],
          [
            'Insert column right',
            () => editColumn('right', x),
            '⌥⌘→',
            'arrow-right-to-line',
          ],
          [
            'Delete column',
            () => editColumn('delete', x),
            '⌥⌘⌫',
            'trash-2',
          ],
          [
            'First row is a header',
            () => {
              csvHeader = !csvHeader;
            parsedSource = undefined;
              csvPage = 0;
              try {
                if (csvHeader) localStorage.removeItem(csvHeaderKey);
                else localStorage.setItem(csvHeaderKey, '1');
              } catch {}
              render();
            },
            null,
            csvHeader ? 'check' : '',
          ],
        );
        contextMenu(trigger, entries, { column: true, checked: csvHeader });
      }
      table.addEventListener('keydown', (event) => {
        if (
          event.isComposing ||
          composing ||
          event.keyCode === 229 ||
          mode === 'preview'
        )
          return;
        const cell = event.target.closest('[data-col]');
        if (!cell) return;
        const y = Number(cell.parentElement.dataset.row),
          x = Number(cell.dataset.col);
        if (event.target !== cell) {
          if (event.target.classList.contains('de-column-trigger')) return;
          const cancel = event.key === 'Escape';
          const enter =
            event.key === 'Enter' &&
            !event.shiftKey &&
            !event.metaKey &&
            !event.ctrlKey;
          const tab = event.key === 'Tab' && !event.metaKey && !event.ctrlKey;
          if (cancel || enter || tab) {
            event.preventDefault();
            event.stopPropagation();
            finishCSVCell(cancel);
            focusCell(
              enter ? y + 1 : y,
              tab ? x + (event.shiftKey ? -1 : 1) : x,
            );
          }
          return;
        }
        if (
          (event.metaKey || event.ctrlKey) &&
          event.altKey &&
          !event.shiftKey
        ) {
          const operation = {
            ArrowLeft: 'left',
            ArrowRight: 'right',
            Backspace: 'delete',
          }[event.key];
          if (operation) {
            event.preventDefault();
            event.stopPropagation();
            editColumn(operation, x, y);
            return;
          }
        }
        if (y === 0 && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          cell.querySelector('.de-column-trigger')?.click();
          return;
        }
        if (!event.metaKey && !event.ctrlKey && event.key === 'Enter') {
          event.preventDefault();
          const editor = cell.querySelector('textarea');
          editor.focus();
          editor.setSelectionRange(editor.value.length, editor.value.length);
          return;
        }
        const movement = {
          ArrowLeft: [0, -1],
          ArrowRight: [0, 1],
          ArrowDown: [1, 0],
          ArrowUp: [-1, 0],
          Tab: [0, event.shiftKey ? -1 : 1],
        }[event.key];
        if (movement && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault();
          focusCell(Math.max(y > 0 ? 1 : 0, y + movement[0]), x + movement[1]);
          return;
        }
        if (
          y > 0 && event.key.length === 1 &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey
        ) {
          const field = cell.querySelector('textarea');
          event.preventDefault();
          field.focus();
          field.value = event.key;
          field.setSelectionRange(field.value.length, field.value.length);
          field.dispatchEvent(new Event('input', { bubbles: true }));
          return;
        }
        if (y === 0 || (!event.metaKey && !event.ctrlKey) || event.altKey)
          return;
        const operation =
          event.key === 'Enter'
            ? event.shiftKey
              ? 'above'
              : 'below'
            : event.key === 'Backspace' && !event.shiftKey
              ? 'delete'
              : null;
        if (operation) {
          event.preventDefault();
          event.stopPropagation();
          editRow(
            operation,
            Number(cell.parentElement.dataset.row),
            Number(cell.dataset.col),
          );
        }
      });
      rows.forEach((r, y) => {
        if (y > 0 && (y <= csvPage * pageSize || y > (csvPage + 1) * pageSize))
          return;
        const row = el('tr'),
          num = el(y ? 'td' : 'th', 'de-rownum');
        row.dataset.row = String(y);
        if (y > 0) {
          num.append(el('span', 'de-row-label', String(y)));
          if (mode !== 'preview') {
            const options = action('Row ' + y + ' options', () =>
              contextMenu(options, rowActions(y)),
            );
            options.className = 'de-row-options';
            options.setAttribute('aria-haspopup', 'menu');
            options.replaceChildren(lineIcon('ellipsis'));
            num.append(options);
          }
        }
        row.append(num);
        for (let x = 0; x < width; x++) {
          const cell = el(y ? 'td' : 'th'),
            old = r[x];
          cell.dataset.col = String(x);
          cell.tabIndex = -1;
          const field = dataInput(
            old?.start === undefined ? '' : old.value,
            (y ? 'Row ' + y : 'Column') + ', ' + (rows[0]?.[x]?.value || x + 1),
            null,
            { readonly: mode === 'preview' },
          );
          field.defaultValue = field.value;
          const begin = () => {
            if (!field.readOnly && csvDraft?.field !== field)
              csvDraft = {
                field,
                row: y - headerOffset,
                column: x,
                initial: field.defaultValue,
              };
          };
          field.onfocus = begin;
          field.oninput = begin;
          field.onblur = () => {
            if (csvDraft?.field === field) finishCSVCell();
          };
          field.onpaste = (e) => {
            if (mode === 'preview') return;
            const payload = e.clipboardData?.getData('text/plain');
            if (!payload || !/[\t\n\r]/.test(payload)) return;
            let matrix;
            try {
              matrix = csvRows(payload, '\t');
            } catch {
              return;
            }
            if (!matrix.length) return;
            e.preventDefault();
            if (csvDraft?.field === field) finishCSVCell(true);
            changeRows((raw) =>
              matrix.forEach((pasted, dy) => {
                const row =
                  raw[y - headerOffset + dy] ||
                  (raw[y - headerOffset + dy] = []);
                while (row.length < x) row.push('');
                pasted.forEach((cell, dx) => {
                  row[x + dx] = csvEncode(cell.value, delimiter);
                });
              }),
            );
          };
          if (!y) {
            const label = r[x]?.value ?? columnLetter(x);
            const trigger = action(
              label,
              () => columnMenu(trigger, x, field),
              'Column ' + columnLetter(x) + ' options',
            );
            trigger.className = 'de-column-trigger';
            trigger.setAttribute('aria-haspopup', 'menu');
            trigger.setAttribute('aria-expanded', 'false');
            trigger.disabled = mode === 'preview';
            trigger.oncontextmenu = (event) => {
              if (trigger.disabled) return;
              event.preventDefault();
              columnMenu(trigger, x, field);
            };
            const blur = field.onblur;
            field.onblur = () => {
              blur();
              field.hidden = true;
              trigger.hidden = false;
              trigger.textContent = !parsed.length ? columnLetter(x) : field.value;
              // Keep cell labels current after an in-place header rename.
              const data = article.querySelectorAll(
                'td[data-col="' + x + '"] .de-cell',
              );
              for (const node of data)
                node.setAttribute(
                  'aria-label',
                  'Row ' +
                    node.closest('tr').dataset.row +
                    ', ' +
                    (field.value || x + 1),
                );
            };
            if (!csvHeader) cell.classList.add('de-letter-header');
            field.hidden = true;
            cell.append(trigger);
          }
          cell.append(field);
          row.append(cell);
        }
        body.append(row);
      });
      table.append(body);
      article.append(table);
      const footer = el('div', 'de-table-footer');
      if (mode !== 'preview') {
        const addRow = action('New row', () => {
          const eol = text.includes('\r\n') ? '\r\n' : '\n',
            fields = delimiter.repeat(width - 1);
          // A quoted empty cell distinguishes a one-column empty row from the trailing line break.
          const row = width === 1 ? '""' : fields;
          const join = text && !/[\n\r]$/.test(text) ? eol : '';
          commit(text + join + row + eol, true);
          csvPage = Math.floor(Math.max(0, rows.length - 1) / pageSize);
          render();
          article.querySelector('tr:last-child .de-cell')?.focus();
        });
        addRow.classList.add('de-add-row');
        addRow.prepend(lineIcon('plus'));
        footer.append(addRow);
      }
      if (pageCount > 1) {
        const nav = el('div', 'de-grid-pager'),
          prev = action(
            '‹',
            () => {
              csvPage--;
              render();
            },
            'Previous page',
          ),
          next = action(
            '›',
            () => {
              csvPage++;
              render();
            },
            'Next page',
          );
        prev.disabled = !csvPage;
        next.disabled = csvPage + 1 === pageCount;
        nav.append(prev, el('span', '', csvPage + 1 + ' / ' + pageCount), next);
        footer.append(nav);
      }
      article.append(footer);
    }
    function contextMenu(
      anchor,
      entries,
      { column = false, checked = false } = {},
    ) {
      root.querySelector('.de-column-trigger[aria-expanded="true"]')?.setAttribute('aria-expanded', 'false');
      root.querySelector('.de-context')?.remove();
      const menu = el('div', 'de-context');
      menu.setAttribute('role', 'menu');
      const box = anchor.getBoundingClientRect();
      menu.style.left = Math.max(4, Math.min(box.left, innerWidth - 165)) + 'px';
      menu.style.top =
        Math.max(
          4,
          Math.min(box.bottom, innerHeight - entries.length * 30 - 10),
        ) + 'px';
      if (column) {
        menu.classList.add('de-column-menu');
        menu.tabIndex = -1;
        anchor.setAttribute('aria-expanded', 'true');
      }
      function close() {
        menu.remove();
        if (column) anchor.setAttribute('aria-expanded', 'false');
      }
      for (const [title, fn, shortcut, icon] of entries) {
        if (
          column &&
          menu.children.length &&
          [
            'Insert column left',
            'Delete column',
            'First row is a header',
          ].includes(title)
        )
          menu.append(el('hr'));
        const b = action(title, () => {
          close();
          fn();
        });
        b.setAttribute('role', column ? 'menuitemradio' : 'menuitem');
        if (column) {
          b.setAttribute(
            'aria-checked',
            String(title === 'First row is a header' && checked),
          );
          b.prepend(lineIcon(icon));
        }
        if (shortcut) b.append(el('kbd', 'de-menu-shortcut', shortcut));
        menu.append(b);
      }
      menu.onkeydown = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          close();
          anchor.focus();
        } else if (
          column &&
          ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)
        ) {
          e.preventDefault();
          const buttons = [...menu.querySelectorAll('button')],
            i = buttons.indexOf(document.activeElement);
          const next =
            e.key === 'Home'
              ? 0
              : e.key === 'End'
                ? buttons.length - 1
                : e.key === 'ArrowDown'
                  ? (i + 1) % buttons.length
                  : i <= 0
                    ? buttons.length - 1
                    : i - 1;
          buttons[next].focus();
        }
      };
      menu.onfocusout = (e) => {
        if (!menu.contains(e.relatedTarget)) close();
      };
      root.append(menu);
      if (column) {
        const above = box.bottom + 4 + menu.offsetHeight > innerHeight;
        menu.style.left =
          Math.max(4, Math.min(box.left, innerWidth - menu.offsetWidth - 4)) + 'px';
        menu.style.top = Math.max(4, above ? box.top - menu.offsetHeight - 4 : box.bottom + 4) + 'px';
        if (above) menu.style.setProperty('--menu-origin', 'bottom left');
        menu.focus();
      } else menu.firstChild?.focus();
    }
    function jsonFields(roots) {
      // A page keeps JSON keys, array entries and log rows editable without
      // creating one control for every item in a multi-megabyte document.
      function pageItems(parent, length, key, visit) {
        const perPage = length > 500 ? jsonPageSize : Math.max(1, length);
        const pages = Math.max(1, Math.ceil(length / perPage));
        const page = Math.min(jsonPages.get(key) || 0, pages - 1);
        jsonPages.set(key, page);
        if (key === 'records') recordPageCount = pages;
        for (let i = page * perPage; i < Math.min(length, (page + 1) * perPage); i++) visit(i);
        if (pages === 1) return;
        const nav = el('div', 'de-grid-pager');
        const move = offset => { jsonPages.set(key, page + offset); render(); };
        const previous = action('‹', () => move(-1), 'Previous page');
        const next = action('›', () => move(1), 'Next page');
        previous.disabled = page === 0; next.disabled = page === pages - 1;
        nav.append(previous, el('span', '', (page + 1) + ' / ' + pages), next);
        parent.append(nav);
      }
      let count = 0;
      const readonly = mode === 'preview',
        objectLike = (n) => n.type === 'array' || n.type === 'object';
      const start = (n) => n.keyStart ?? n.start;
      function target(steps) {
        readData();
        let n = parsedData[steps[0]];
        for (const i of steps.slice(1)) n = n.entries[i];
        return n;
      }
      function patch(a, b, fragment, redraw = true) {
        commit(text.slice(0, a) + fragment + text.slice(b), true);
        if (redraw) render();
      }
      function remove(steps) {
        const n = target(steps),
          last = steps.at(-1);
        if (steps.length === 1) {
          const a = text.lastIndexOf('\n', n.start - 1) + 1,
            next = text.indexOf('\n', n.end);
          patch(a, next < 0 ? text.length : next + 1, '');
          return;
        }
        const p = target(steps.slice(0, -1)),
          prev = p.entries[last - 1],
          next = p.entries[last + 1];
        patch(
          next ? start(n) : prev ? prev.end : start(n),
          next ? start(next) : n.end,
          '',
        );
      }
      function rename(steps) {
        const n = target(steps);
        popForm('Rename field', n.label, (key) =>
          patch(n.keyStart, n.keyEnd, JSON.stringify(key)),
        );
      }
      function actions(anchor, n, steps) {
        if (readonly) return;
        const options = [];
        if (n.keyStart != null)
          options.push(['Rename field', () => rename(steps)]);
        if (steps.length > 1 || lines)
          options.push([
            steps.length === 1
              ? 'Delete record'
              : n.keyStart != null
                ? 'Delete field'
                : 'Delete item',
            () => remove(steps),
          ]);
        if (!options.length) return;
        const open = (e) => {
          e.preventDefault();
          e.stopPropagation();
          contextMenu(anchor, options);
        };
        anchor.oncontextmenu = open;
        const more = action(
          '···',
          open,
          'Actions for ' + (n.label || 'record'),
        );
        more.className = 'de-mini-action';
        more.replaceChildren(lineIcon('ellipsis'));
        anchor.append(more);
      }
      function add(steps, forceKey) {
        const p = target(steps),
          object = p.type === 'object',
          last = p.entries.at(-1),
          eol = text.includes('\r\n') ? '\r\n' : '\n';
        function append(raw) {
          const insert = last?.end ?? p.start + 1,
            multiline = /[\n\r]/.test(text.slice(p.start, p.end));
          const sibling = last ? start(last) : p.start;
          let indent = multiline
            ? text
                .slice(text.lastIndexOf('\n', sibling - 1) + 1, sibling)
                .match(/^[ \t]*/)[0]
            : '';
          if (multiline && !last) indent += '  ';
          const prefix =
            (last ? ',' : '') + (multiline ? eol + indent : last ? ' ' : '');
          patch(insert, insert, prefix + raw);
        }
        if (object) {
          const enter = (key) => {
            if (p.entries.some((c) => c.label === key))
              throw new Error('That field already exists');
            append(JSON.stringify(key) + ': ""');
          };
          if (forceKey !== undefined) enter(forceKey);
          else popForm('New field name', '', enter);
        } else {
          popForm('New array item', '', (value) => {
            let literal;
            try {
              const parsed = parseJSON(value);
              literal = value.slice(parsed.start, parsed.end);
            } catch {
              literal = JSON.stringify(value);
            }
            append(literal);
          });
        }
      }
      function field(n, steps, label) {
        const change = (value) => {
          const x = target(steps);
          let literal;
          if (n.type === 'string') literal = JSON.stringify(value);
          else {
            const parsed = parseJSON(value);
            if (parsed.type !== n.type) throw new Error('Expected ' + n.type);
            literal = value;
          }
          patch(x.start, x.end, literal, false);
          if (lines) {
            const summary = article.querySelector(
              '[data-record="' + steps[0] + '"] > summary',
            );
            if (summary) {
              const updated = recordSummary(target([steps[0]]), steps[0]);
              for (const span of updated)
                summary.querySelector('.' + span.className).textContent =
                  span.textContent;
            }
          }
        };
        if (n.type === 'boolean') {
          const b = el('button', 'de-switch');
          b.type = 'button';
          b.setAttribute('role', 'switch');
          b.setAttribute('aria-label', label);
          b.setAttribute('aria-checked', String(n.value === 'true'));
          b.append(
            el('span', 'de-switch-track'),
            el('span', 'de-switch-label', n.value === 'true' ? 'Yes' : 'No'),
          );
          b.disabled = readonly;
          b.onclick = () => {
            const value =
              b.getAttribute('aria-checked') === 'true' ? 'false' : 'true';
            change(value);
            b.setAttribute('aria-checked', value);
            b.lastChild.textContent = value === 'true' ? 'Yes' : 'No';
          };
          return b;
        }
        const value = String(n.value);
        if (value.length > 8192) {
          const short = action(value.slice(0, 200) + '…', () => {
            const input = dataInput(value, label, change, {readonly});
            input.wrap = 'off';
            short.replaceWith(input);
            input.focus();
          }, label);
          short.className = 'de-long-value';
          return short;
        }
        return dataInput(value, label, change, { readonly });
      }
      function objectTable(n, steps, parent) {
        const keys = [
          ...new Set(
            n.entries.flatMap((item) => item.entries.map((c) => c.label)),
          ),
        ];
        if (keys.length * n.entries.length > 1500) return false;
        const table = el('table', 'de-object-grid'),
          head = el('tr');
        for (const key of keys) head.append(el('th', '', key));
        table.append(head);
        n.entries.forEach((item, r) => {
          const row = el('tr');
          keys.forEach((key) => {
            const cell = el('td'),
              idx = item.entries.findIndex((c) => c.label === key);
            if (idx >= 0)
              cell.append(
                field(
                  item.entries[idx],
                  [...steps, r, idx],
                  key + ' ' + (r + 1),
                ),
              );
            else if (!readonly)
              cell.append(
                action(
                  '+',
                  () => add([...steps, r], key),
                  'Add ' + key + ' to row ' + (r + 1),
                ),
              );
            row.append(cell);
          });
          table.append(row);
          if (!readonly)
            row.oncontextmenu = (e) => {
              e.preventDefault();
              contextMenu(row, [['Delete item', () => remove([...steps, r])]]);
            };
        });
        parent.append(table);
        return true;
      }
      const typeLabels = {
        string: 'Text',
        number: 'Number',
        boolean: 'Yes / no',
        null: 'Null',
        array: 'List',
      };
      function recordSummary(n, index) {
        const pick = (keys) =>
          keys
            .map((key) =>
              n.entries.find((f) => f.label === key && !objectLike(f)),
            )
            .find(Boolean);
        const time = pick(['time', 'timestamp', 'date', 'created_at', 'ts']);
        const message = pick(['message', 'msg', 'text']);
        const preview = message
          ? String(message.value)
          : n.entries
              .filter((f) => f !== time && !objectLike(f))
              .map((f) => f.label + ': ' + f.value)
              .join(' · ');
        return [
          el('span', 'de-log-number', String(index + 1)),
          el('span', 'de-log-time', time ? String(time.value) : ''),
          el('span', 'de-log-message', preview.length > 512 ? preview.slice(0, 512) + '…' : preview),
          el(
            'span',
            'de-json-type',
            n.entries.length + (n.entries.length === 1 ? ' field' : ' fields'),
          ),
        ];
      }
      function renderValue(n, steps, parent, depth) {
        count++;
        if (count > 4000) {
          if (count === 4001)
            parent.append(
              el('p', 'de-muted', 'Open Source to view the remaining fields.'),
            );
          return;
        }
        const key = steps.join('.'),
          label =
            n.label ||
            (lines
              ? 'Record ' + (steps[0] + 1)
              : n.type === 'array'
                ? 'Array'
                : n.type === 'object'
                  ? 'Object'
                  : 'Value');
        const record = lines && depth === 0;
        if (
          !record &&
          n.type === 'array' &&
          n.entries.every((x) => !objectLike(x))
        ) {
          const chips = el('div', 'de-chip-list');
          pageItems(chips, n.entries.length, key, i => {
            const v = n.entries[i];
            const chip = el('label', 'de-chip'),
              f = field(v, [...steps, i], label + ' ' + (i + 1));
            if (f.tagName === 'TEXTAREA') {
              const caption = el('span', 'de-chip-caption', String(v.value));
              caption.setAttribute('aria-hidden', 'true');
              f.addEventListener('input', () => {
                caption.textContent = f.value;
              });
              chip.append(caption);
            }
            chip.append(f);
            if (!readonly)
              chip.append(
                action(
                  '×',
                  () => remove([...steps, i]),
                  'Remove ' + label + ' ' + (i + 1),
                ),
              );
            chips.append(chip);
          });

          if (!readonly)
            chips.append(action('+ Add', () => add(steps), 'Add to ' + label));
          const row = el('div', 'de-json-row');
          row.append(
            el('span', 'de-json-key', label),
            chips,
            el('small', 'de-json-type', 'List'),
          );
          actions(row, n, steps);
          parent.append(row);
          return;
        }
        if (objectLike(n)) {
          const details = el('details', 'de-json-group'),
            sum = el('summary');
          if (record) {
            details.classList.add('de-log-record');
            details.dataset.record = String(steps[0]);
            sum.setAttribute('aria-label', 'Line ' + (steps[0] + 1));
            sum.append(...recordSummary(n, steps[0]));
          } else {
            const unit = n.type === 'array' ? 'item' : 'field';
            sum.append(
              el('span', 'de-json-key', label),
              el(
                'span',
                'de-json-type',
                n.entries.length +
                  ' ' +
                  unit +
                  (n.entries.length === 1 ? '' : 's'),
              ),
            );
          }
          actions(sum, n, steps);
          details.append(sum);
          details.open =
            !collapsedJSON.has(key) &&
            (expandedJSON.has(key) || (!record && depth < 2 && n.entries.length <= jsonPageSize));
          const nest = el('div', 'de-json-children');
          details.append(nest);
          let filled = false;
          function fill() {
            if (filled) return;
            filled = true;
            const compactTable = n.type === 'array' && n.entries.length > 0 && n.entries.length <= jsonPageSize &&
              n.entries.every(x => x.type === 'object' && x.entries.length > 0 && x.entries.length <= jsonPageSize &&
                x.entries.every(c => !objectLike(c)) && new Set(x.entries.map(c => c.label)).size === x.entries.length);
            if (!compactTable || !objectTable(n, steps, nest)) {
              pageItems(nest, n.entries.length, key, i => renderValue(n.entries[i], [...steps, i], nest, depth + 1));
            }
            if (!readonly)
              nest.append(
                action(
                  n.type === 'object' ? '+ Add field' : '+ Add',
                  () => add(steps),
                  'Add to ' + label,
                ),
              );
          }
          if (details.open) fill();
          details.ontoggle = () => {
            if (details.open) {
              expandedJSON.add(key);
              collapsedJSON.delete(key);
              fill();
            } else {
              expandedJSON.delete(key);
              collapsedJSON.add(key);
            }
          };
          parent.append(details);
          return;
        }
        const row = el('div', 'de-json-row');
        row.append(
          el('span', 'de-json-key', label),
          field(n, steps, label),
          el('small', 'de-json-type', typeLabels[n.type] || n.type),
        );
        actions(row, n, steps);
        parent.append(row);
      }
      pageItems(article, roots.length, lines ? 'records' : 'root', index => {
        const i = lines && newestFirst ? roots.length - 1 - index : index;
        const n = roots[i];
        if (!lines && n.type === 'object') {
          pageItems(article, n.entries.length, 'fields', j =>
            renderValue(n.entries[j], [i, j], article, 1));
          if (!readonly)
            article.append(
              action('+ Add field', () => add([i]), 'Add to Object'),
            );
        } else renderValue(n, [i], article, 0);
      });
      if (lines && !readonly)
        article.append(
          action('+  New record', () => {
            const eol = text.includes('\r\n') ? '\r\n' : '\n';
            commit(
              text + (text && !/[\r\n]$/.test(text) ? eol : '') + '{}' + eol,
              true,
            );
            jsonPages.set('records', newestFirst ? 0 : Number.MAX_SAFE_INTEGER);
            jumpToFresh = true;
            render();
          }),
        );
      if (lines && freshRecords > 0) {
        freshButton = action(freshRecords + ' new', () => {
          jsonPages.set('records', newestFirst ? 0 : Number.MAX_SAFE_INTEGER);
          jumpToFresh = true;
          clearFreshRecords(); render();
        }, 'Show new records');
        freshButton.classList.add('de-fresh-records');
        root.append(freshButton);
      }
    }
    function clearFreshRecords() {
      freshButton?.remove();
      freshButton = null;
      freshRecords = 0;
    }

    function sourceEditor() {
      article.classList.add('de-source-view');
      sourceArea = el('textarea', 'de-source');
      sourceArea.setAttribute('aria-label', 'Source');
      sourceArea.wrap = 'soft';
      sourceArea.spellcheck = false;
      sourceArea.value = text;
      function grow() {
        if (!sourceArea) return;
        if (large()) {
          sourceArea.style.height = '65vh';
          sourceArea.style.overflow = 'auto';
          return;
        }
        sourceArea.style.height = '0';
        sourceArea.style.height =
          Math.max(280, sourceArea.scrollHeight + 2) + 'px';
      }
      const sourceEOL = text.match(/\r\n|\r|\n/)?.[0] || '\n';
      sourceArea.addEventListener('input', () => {
        commit(sourceArea.value.replace(/\n/g, sourceEOL), true);
        grow();
        if (!isData) refreshOutline();
      });
      sourceArea.onkeydown = (e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          sourceArea.setRangeText(
            '  ',
            sourceArea.selectionStart,
            sourceArea.selectionEnd,
            'end',
          );
          sourceArea.dispatchEvent(new Event('input'));
        }
      };
      article.append(sourceArea);
      queueMicrotask(grow);
    }
    function jsonProblem(error) {
      const source = text;
      const inputLines = source.replace(/(?:\r\n|\r|\n)$/, '').split(/\r\n|\r|\n/);
      const line = Math.min(inputLines.length, source.slice(0, error.offset || 0).split(/\r\n|\r|\n/).length);
      const edit = error.edit;
      const missing = edit?.insert === ',';
      const cause = edit ? (missing ? 'A comma is missing at the end of line ' :
        'There is one comma too many on line ') + line : error.message + ' (line ' + line + ')';
      const notice = el('div', 'de-json-notice de-error');
      const icon = lineIcon('triangle-alert');
      icon.setAttribute('aria-hidden','true');
      const copy = el('div', 'de-json-notice-copy');
      copy.append(el('strong', '', 'This file has one small mistake'),
        el('span', '', cause + ", so Samare can't show it as fields yet. Nothing has been changed."));
      const controls = el('div', 'de-json-notice-actions');
      if (edit) controls.append(action(missing ? 'Add the comma' : 'Remove the comma', () => {
        if (text !== source) return;
        commit(source.slice(0, edit.offset) + edit.insert + source.slice(edit.offset + edit.remove), true);
        render();
      }));
      controls.append(action('Edit source', () => {
        setMode('source');
        sourceArea.focus();
        const offset = source.slice(0,error.offset || 0).replace(/\r\n?/g,'\n').length;
        sourceArea.setSelectionRange(offset, offset);
      }));
      notice.append(icon,copy,controls);
      const excerpt = el('ol','de-json-excerpt');
      const start = Math.max(0,line - 40);
      excerpt.start = start + 1;
      inputLines.slice(start, line + 40).forEach((value, index) => {
        const n = start + index + 1, row = el('li');
        row.append(el('span','de-json-line-number', String(n)), el('code','',value || ' '));
        if (n === line) {
          row.dataset.error = 'true';
          row.append(el('span','de-json-error-note','← ' + (edit ? missing ? 'a comma belongs here' :
            'this comma is one too many' : error.message.toLowerCase())));
        }
        excerpt.append(row);
      });
      article.append(notice,excerpt);
    }
    function render() {
      if (destroyed) return;
      stopHydration();
      searchGrid = null;
      readingGridField = null;
      closePicker();
      view?.destroy();
      view = null;
      sourceArea = null;
      panel = null;
      searchBox = null;
      selectionBar = null;
      root.replaceChildren();
      freshButton = null;
      root.dataset.mode = mode;
      surface = el('div', 'de-surface');
      if (isJSON) surface.classList.add(lines ? 'de-json-log' : 'de-json-form');
      root.append(surface);
      article = el('div', isData ? 'de-sheet' : 'de-paper');
      if (isData) {
        const asyncStructure = large();
        if (mode !== 'source' && !asyncStructure) readData();
        dataHeading(parsedSource === text ? dataSummary : '');
        surface.append(article);
        if (mode === 'source') {
          sourceEditor();
        } else {
          const sheet = article;
          function showStructure() {
            if (destroyed || article !== sheet) return;
            readData();
            dataBar.querySelector('.de-data-summary').textContent = dataSummary;
            sheet.removeAttribute('aria-busy');
            if (dataProblem && isJSON) jsonProblem(dataProblem);
            else if (dataProblem) sheet.append(el('p', 'de-error', dataProblem.message), action('Edit source', () => setMode('source')));
            else if (isCSV) dataGrid(parsedData);
            else jsonFields(parsedData);
            if (jumpToFresh) {
              jumpToFresh = false;
              const scroll = host.closest('#scroll') || document.scrollingElement;
              scroll.scrollTop = newestFirst ? 0 : scroll.scrollHeight;
            }
          }
          if (asyncStructure) {
            // Paint the view switcher first. Going directly to Source cancels
            // unused structural work and never requires a parse to succeed.
            sheet.setAttribute('aria-busy','true');
            requestAnimationFrame(() => setTimeout(showStructure, 0));
          } else showStructure();
        }
        options.onOutline?.([]);
      } else {
        surface.append(article);
        if (mode === 'source' || ext === 'txt') {
          if (ext === 'txt' && large()) surface.append(el('small', 'de-large-hint', 'Large document · Source view'));
          sourceEditor();
          refreshOutline();
        } else {
          try {
            editorView();
          } catch (e) {
            view?.destroy();
            view = null;
            article.replaceChildren(el('p', 'de-error', e.message));
            sourceEditor();
          }
        }
      }
      if (view) {
        selectionBar = el('div', 'de-selectionbar');
        selectionBar.hidden = true;
        for (const [label, cmd, title] of [
          ['B', 'bold', 'Bold'],
          ['I', 'italic', 'Italic'],
          ['S', 'strike', 'Strikethrough'],
          ['‹›', 'code', 'Inline code'],
          ['↗', 'link', 'Link'],
        ]) {
          const b = action(label, () => command(cmd), title);
          b.onmousedown = (e) => e.preventDefault();
          selectionBar.append(b);
        }
        root.append(selectionBar);
      }
      if (isCSV) showRecoveries();
      updateSettings(settings);
    }
    function setMode(next) {
      if (!['source', 'preview', 'edit'].includes(next) || next === mode)
        return true;
      finishInline?.();
      finishCSVCell();
      mode = next;
      render();
      return true;
    }
    function openFind(replace) {
      searchBox?.remove();
      searchBox = el('form', 'de-find');
      const input = el('input');
      input.placeholder = 'Find in document';
      input.setAttribute('aria-label', 'Find in document');
      input.value = searchTerm;
      searchBox.append(input);
      const replacement = el('input');
      if (replace) {
        replacement.placeholder = 'Replace with';
        searchBox.append(replacement);
      }
      const status = el('span', 'de-find-status');
      searchBox.append(status);
      function next() {
        searchTerm = input.value;
        if (!searchTerm) {
          status.textContent = '';
          return false;
        }
        const matches = [],
          needle = searchTerm.toLowerCase();
        if (longDoc) {
          for (const match of findDocumentMatches({ query: searchTerm }))
            matches.push([match.from, match.to]);
        } else if (view) {
          view.state.doc.descendants((n, p) => {
            if (!n.isText) return;
            let i = 0;
            while ((i = n.text.toLowerCase().indexOf(needle, i)) !== -1) {
              matches.push([p + i, p + i + searchTerm.length]);
              i += needle.length;
            }
          });
        } else if (sourceArea) {
          let i = 0;
          while (
            (i = sourceArea.value.toLowerCase().indexOf(needle, i)) !== -1
          ) {
            matches.push([i, i + searchTerm.length]);
            i += needle.length;
          }
        }
        if (!matches.length) {
          status.textContent = '0 results';
          return false;
        }
        searchLast = (searchLast + 1) % matches.length;
        const [a, b] = matches[searchLast];
        if (longDoc) hydratePosition(b);
        if (view)
          view.dispatch(
            view.state.tr
              .setSelection(L.TextSelection.create(view.state.doc, a, b))
              .scrollIntoView(),
          );
        else {
          sourceArea.focus();
          sourceArea.setSelectionRange(a, b);
        }
        status.textContent = searchLast + 1 + ' / ' + matches.length;
        return true;
      }
      input.oninput = () => {
        searchLast = -1;
        next();
      };
      searchBox.onsubmit = (e) => {
        e.preventDefault();
        next();
      };
      searchBox.append(action('↓', next, 'Next match'));
      if (replace)
        searchBox.append(
          action('Replace', () => {
            if (!searchTerm || mode === 'preview') return;
            if (view) {
              const s = view.state.selection;
              if (
                view.state.doc.textBetween(s.from, s.to).toLowerCase() ===
                searchTerm.toLowerCase()
              )
                view.dispatch(
                  view.state.tr.insertText(replacement.value, s.from, s.to),
                );
            } else if (
              sourceArea &&
              sourceArea.value
                .slice(sourceArea.selectionStart, sourceArea.selectionEnd)
                .toLowerCase() === searchTerm.toLowerCase()
            ) {
              sourceArea.setRangeText(
                replacement.value,
                sourceArea.selectionStart,
                sourceArea.selectionEnd,
                'end',
              );
              sourceArea.dispatchEvent(new Event('input'));
            }
            searchLast--;
            next();
          }),
        );
      searchBox.append(
        action(
          '×',
          () => {
            searchBox.remove();
            searchBox = null;
          },
          'Close find',
        ),
      );
      searchBox.onkeydown = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          searchBox.remove();
          searchBox = null;
          view?.focus();
        }
      };
      root.prepend(searchBox);
      input.focus();
      input.select();
    }
    function command(name, arg) {
      if (name === 'markRevisionBlocks') {
        if (!view) return false;
        const changes = (arg?.changes || []).slice().sort((a,b) => a.offset-b.offset);
        const blocks = new Map();
        if (changes.length) {
          if (longDoc) hydrateTo(longDoc.chunks.length);
          const starts = [];
          serialize(view.state.doc, meta, (pos, at) => starts.push({pos,at:at+header.length}));
          let block = 0;
          for (const change of changes) {
            while (block+1 < starts.length && starts[block+1].at <= change.offset) block++;
            const pos = starts[block]?.pos;
            if (pos !== undefined && (!blocks.has(pos) || change.index === arg.active)) blocks.set(pos,change.index);
          }
        }
        const spans = [];
        for (const [pos,index] of blocks) {
          const preview = arg.preview?.index === index;
          spans.push(L.Decoration.node(pos,pos+view.state.doc.nodeAt(pos).nodeSize,{
            class:'reader-change' + (index === arg.active ? ' reader-change-active' : '') +
              (preview ? ' reader-change-preview-hidden' : ''), 'data-review-change':String(index),
          }));
          if (preview) {
            const before = arg.preview.text || '';
            spans.push(L.Decoration.widget(pos,() => {
              const dom = el('div','reader-change reader-change-active reader-change-preview');
              dom.contentEditable = 'false';
              dom.dataset.reviewChange = String(index);
              if (before) {
                const parsed = parseBody(before).doc;
                dom.append(...view.serializeForClipboard(parsed.slice(0,parsed.content.size)).dom.childNodes);
              } else dom.append(el('p','','(Empty)'));
              return dom;
            },{side:-1,ignoreSelection:true}));
          }
        }
        view.dispatch(view.state.tr.setMeta('revisionMarks',spans).setMeta('addToHistory',false));
        return true;
      }
      if (name === 'findDocumentMatchesAsync') return findDocumentMatchesAsync(arg);
      if (name === 'revealDocumentMatchAsync') return revealDocumentMatchAsync(arg);
      if (name === 'findDocumentMatches') return findDocumentMatches(arg);
      if (name === 'revealDocumentMatch') return revealDocumentMatch(arg);
      if (name === 'isHydrating') return !!longDoc && longDoc.next < longDoc.chunks.length;
      if (name === 'finishHydration') {
        if (longDoc) hydrateTo(longDoc.chunks.length);
        return true;
      }
      if (name === 'elementAtSourceOffset') {
        if (!view || !Number.isFinite(arg)) return null;
        if (longDoc && arg >= text.length - pendingBody().length) {
          let end = longDoc.next, size = text.length - pendingBody().length;
          while (size <= arg && end < longDoc.chunks.length) size += longDoc.chunks[end++].raw.length;
          hydrateTo(end);
        }
        let block = 0;
        serialize(view.state.doc, meta, (pos, offset) => { if (offset + header.length <= arg) block = pos; });
        return view.nodeDOM(block);
      }
      if (name === 'findDataMatches') return findDataMatches(arg);
      if (name === 'revealDataMatch') return revealDataMatch(arg);
      if (name === 'mode') return setMode(arg);
      if (['source', 'preview', 'edit'].includes(name)) return setMode(name);
      if (name === 'getMode') return mode;
      if (name === 'commitCell') { finishInline?.(); applyWaiting(); return finishCSVCell(); }
      if (name === 'hasCSVRecovery') return recoveries.size > 0;
      if (name === 'hasUnstoredCSVRecovery')
        return [...recoveries.values()].some((r) => r.memoryOnly);
      if (name === 'canAddProperties' || name === 'addProperties') {
        const available =
          !!view &&
          mode === 'edit' &&
          ['md', 'markdown', 'mdown', 'mkd'].includes(ext) &&
          !yaml.trim();
        if (name === 'canAddProperties' || !available) return available;
        if (!propsOpen) {
          propsOpen = true;
          properties();
        }
        if (panel?.getAttribute('aria-label') === 'Property name')
          panel.querySelector('input')?.focus();
        else props.querySelector('.de-add-property')?.click();
        return true;
      }
      if (name === 'properties') {
        if (!props || !props.isConnected) return false;
        propsOpen = !propsOpen;
        properties();
        return true;
      }
      if (name === 'getProperties') return fields(yaml);
      if (name === 'focus') {
        (view || sourceArea || article.querySelector('textarea'))?.focus();
        return true;
      }
      if (name === 'goto') {
        if (longDoc) hydrateTo(longDoc.chunks.length);
        const id =
          typeof arg === 'object'
            ? arg.id
            : typeof arg === 'number'
              ? 'heading-' + arg
              : arg;
        const pos = headingPositions.get(id);
        if (view && pos !== undefined) {
          const dest = view.nodeDOM(pos);
          dest?.scrollIntoView({
            block: 'start',
            behavior: matchMedia('(prefers-reduced-motion)').matches
              ? 'instant'
              : 'smooth',
          });
          return true;
        }
        if (sourceArea) {
          const h = outline.find((v) => v.id === id),
            i = h ? text.indexOf(h.text) : -1;
          if (i >= 0) {
            sourceArea.focus();
            sourceArea.setSelectionRange(i, i + h.text.length);
            return true;
          }
        }
        return false;
      }
      if (name === 'find' || name === 'replace') {
        if (isData && !sourceArea) setMode('source');
        if (name === 'replace' && mode === 'preview') setMode('edit');
        openFind(name === 'replace');
        return true;
      }
      if (name === 'getStats' && view) {
        if (longDoc && longDoc.statsText === text) return longDoc.stats;
        const chunks = [];
        eachDocument((doc, sources) => chunks.push(countableText(doc, sources)));
        const full = chunks.join('\n').trim();
        const tokens =
          full.match(
            /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu,
          ) || [];
        const words = tokens.reduce(
          (count, token) => count + Number(/[\p{L}\p{N}]/u.test(token)),
          0,
        );
        const stats = { words, chars: Array.from(full).length };
        if (longDoc) { longDoc.statsText = text; longDoc.stats = stats; }
        return stats;
      }
      if (name === 'getPlainText') {
        if (view) {
          const pieces = [];
          eachDocument((doc) => doc.descendants((n) => {
            if (n.isTextblock) {
              pieces.push(
                n.textBetween(
                  0,
                  n.content.size,
                  ' ',
                  (leaf) => leaf.attrs.alt || leaf.attrs.tex || '',
                ),
              );
              return false;
            }
          }));
          return pieces.join('\n');
        }
        return text;
      }
      if (name === 'selectAll') {
        if (view) {
          view.focus();
          document.execCommand('selectAll');
        } else sourceArea?.select();
        return true;
      }
      if (mode === 'preview') return false;
      if (name === 'undo' || name === 'redo') {
        if (
          csvDraft &&
          csvDraft.field.value !== csvDraft.initial &&
          name === 'undo'
        )
          return finishCSVCell(true);
        finishCSVCell();
        if (view && runPM(name === 'undo' ? L.undo : L.redo)) return true;
        const stack = name === 'undo' ? edits : future,
          other = name === 'undo' ? future : edits;
        if (stack.length) {
          other.push(text);
          commit(stack.pop());
          render();
          return true;
        }
        return false;
      }
      if (name === 'insertText' && sourceArea) {
        sourceArea.setRangeText(
          String(arg || ''),
          sourceArea.selectionStart,
          sourceArea.selectionEnd,
          'end',
        );
        sourceArea.dispatchEvent(new Event('input'));
        return true;
      }
      if (!view) return false;
      if (name === 'insertDroppedImages') {
        if (
          mode !== 'edit' ||
          (arg?.path !== undefined && arg.path !== path) ||
          !Number.isFinite(arg?.x) ||
          !Number.isFinite(arg?.y) ||
          !Array.isArray(arg.images) ||
          !arg.images.length
        )
          return false;
        if (
          !arg.images.every(
            (item) => typeof item?.src === 'string' && item.src.length > 0,
          )
        )
          return false;
        const hit = view.posAtCoords({ left: arg.x, top: arg.y });
        if (!hit) return false;
        const pos = view.state.doc.resolve(hit.pos);
        const type = pos.parent.inlineContent ? N.image : N.paragraph;
        if (!pos.parent.canReplaceWith(pos.index(), pos.index(), type))
          return false;
        const images = arg.images.map(({ src, alt }) =>
          N.image.create({ src, alt: typeof alt === 'string' ? alt : '' }),
        );
        const content =
          type === N.image ? images : N.paragraph.create(null, images);
        const tr = L.closeHistory(view.state.tr).insert(pos.pos, content);
        tr.setSelection(
          L.TextSelection.near(tr.doc.resolve(tr.mapping.map(pos.pos))),
        );
        view.dispatch(tr.scrollIntoView());
        view.focus();
        return true;
      }
      const mark = {
        bold: 'strong',
        italic: 'em',
        strike: 'strike',
        code: 'code',
      }[name];
      if (mark) return runPM(L.toggleMark(M[mark]));
      if (name === 'heading')
        return runPM(
          L.setBlockType(N.heading, {
            level: Math.max(1, Math.min(6, Number(arg) || 1)),
          }),
        );
      if (name === 'paragraph') return runPM(L.setBlockType(N.paragraph));
      if (name === 'blockquote') return runPM(L.wrapIn(N.blockquote));
      if (name === 'codeBlock')
        return runPM(L.setBlockType(N.code_block, { lang: arg || '' }));
      if (name === 'inlineMath') {
        const {from,to} = view.state.selection;
        inlineEditor({title:'Edit formula', label:'LaTeX source', value:'', multiline:true,
          anchor:() => view.coordsAtPos(from),
          commit(tex,direction) {
            if (tex) view.dispatch(L.closeHistory(view.state.tr.replaceWith(from,to,N.inlinemath.create({tex}))));
            if (direction) view.focus();
          },
        });
        return true;
      }
      if (['blockMath', 'mermaid', 'svg', 'image'].includes(name)) {
        const labels = {
          blockMath: 'Block math',
          mermaid: 'Mermaid diagram',
          svg: 'SVG source',
          image: 'Image URL or path',
        };
        popForm(
          labels[name],
          '',
          (s) => {
            if (!s) return;
            const node =
              name === 'blockMath'
                ? N.displaymath.create(null, schema.text(s))
                : name === 'mermaid'
                  ? N.code_block.create({ lang: 'mermaid' }, schema.text(s))
                  : name === 'svg'
                    ? N.svg_block.create(null, schema.text(s))
                    : N.image.create({ src: s, alt: '' });
            view.dispatch(
              view.state.tr.replaceSelectionWith(node).scrollIntoView(),
            );
            view.focus();
          },
          { multiline: name !== 'image' },
        );
        return true;
      }
      if (name === 'orderedList' || name === 'bulletList')
        return runPM(
          L.wrapInList(name === 'orderedList' ? N.ordered_list : N.bullet_list),
        );
      if (name === 'taskList') {
        if (
          !runPM(L.wrapInList(N.bullet_list)) &&
          !view.state.selection.$from.depth
        )
          return false;
        const p = view.state.selection.$from;
        for (let i = p.depth; i > 0; i--)
          if (p.node(i).type === N.list_item) {
            view.dispatch(
              view.state.tr.setNodeMarkup(p.before(i), undefined, {
                checked: false,
              }),
            );
            return true;
          }
        return false;
      }
      if (name === 'wikilink') {
        view.dispatch(view.state.tr.insertText('[['));
        view.focus();
        return true;
      }
      if (name === 'link') {
        const link = (value) => {
          if (!value.trim()) return;
          const sel = view.state.selection,
            tr = view.state.tr,
            attrs = { href: value.trim() };
          if (sel.empty)
            tr.replaceSelectionWith(schema.text(value, M.link.create(attrs)));
          else tr.addMark(sel.from, sel.to, M.link.create(attrs));
          view.dispatch(tr);
          view.focus();
        };
        if (typeof arg === 'string') link(arg);
        else {
          const dom = view.domAtPos(view.state.selection.from).node;
          editLink((dom.nodeType === 1 ? dom : dom.parentElement)?.closest('a[data-target]'));
        }
        return true;
      }
      if (name === 'table') {
        const { rows = 2, columns = 2 } = arg || {};
        const cells = Array.from(
          { length: Math.max(1, Math.min(50, rows)) },
          (_, r) =>
            N.table_row.create(
              null,
              Array.from({ length: Math.max(1, Math.min(30, columns)) }, () =>
                (r ? N.table_cell : N.table_header).createAndFill(),
              ),
            ),
        );
        view.dispatch(
          view.state.tr
            .replaceSelectionWith(N.table.create(null, cells))
            .scrollIntoView(),
        );
        view.focus();
        return true;
      }
      if (['addRow', 'addColumn', 'deleteRow', 'deleteColumn'].includes(name))
        return runPM(
          {
            addRow: L.addRowAfter,
            addColumn: L.addColumnAfter,
            deleteRow: L.deleteRow,
            deleteColumn: L.deleteColumn,
          }[name],
        );
      if (name === 'horizontalRule') {
        view.dispatch(
          view.state.tr
            .replaceSelectionWith(N.horizontal_rule.create())
            .scrollIntoView(),
        );
        return true;
      }
      if (name === 'insertText') {
        view.dispatch(
          view.state.tr.insertText(String(arg ?? '')).scrollIntoView(),
        );
        view.focus();
        return true;
      }
      return false;
    }
    function updateSettings(next = {}) {
      const previousTheme = settings.theme;
      settings = { ...settings, ...next };
      if (settings.theme !== previousTheme)
        diagramRenderers.forEach((draw) => draw());
      if (settings.fontSize)
        root.style.setProperty(
          '--de-font-size',
          parseFloat(settings.fontSize) + 'px',
        );
      if (settings.fontFamily === 'Geist')
        root.style.removeProperty('--de-font');
      else if (settings.fontFamily)
        root.style.setProperty('--de-font', settings.fontFamily);
      if (settings.lineHeight)
        root.style.setProperty(
          '--de-leading',
          typeof settings.lineHeight === 'number' && settings.lineHeight > 4
            ? settings.lineHeight + 'px'
            : settings.lineHeight,
        );
      if (settings.contentWidth) {
        const width =
          typeof settings.contentWidth === 'number'
            ? settings.contentWidth + 'px'
            : String(settings.contentWidth);
        if (CSS.supports('width', width))
          root.style.setProperty('--de-width', width);
      }
      if (view) view.dom.spellcheck = !!settings.spellcheck;
    }
    const reposition = event => {
      if (selectionBar) selectionBar.hidden = true;
      if (finishInline && !(event.target instanceof Node && panel?.contains(event.target))) finishInline();
      if (picker && !(event.target instanceof Node && picker.contains(event.target))) closePicker();
      if (freshButton) {
        const scroll = host.closest('#scroll') || document.scrollingElement;
        if ((newestFirst ? scroll.scrollTop : scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop) < 8)
          clearFreshRecords();
      }
    };
    const dismissPicker = (e) => {
      if (picker && !picker.contains(e.target)) closePicker();
      if (finishInline && !panel?.contains(e.target)) finishInline();
    };
    document.addEventListener('pointerdown', dismissPicker, true);
    window.addEventListener('scroll', reposition, true);
    // ProseMirror positions include the opening and closing edge of each container.
    // A plain positional fingerprint survives reparsing even when node IDs change.
    function positionText(doc) {
      const parts = [];
      function add(n) {
        if (n.isText) {
          parts.push(n.text);
          return;
        }
        if (n.isLeaf) {
          parts.push('\ufffc');
          return;
        }
        parts.push('\u0001');
        n.forEach(add);
        parts.push('\u0002');
      }
      doc.forEach(add);
      return parts.join('');
    }
    function remap(a, b) {
      let begin = 0,
        endA = a.length,
        endB = b.length;
      while (begin < endA && begin < endB && a[begin] === b[begin]) begin++;
      while (endA > begin && endB > begin && a[endA - 1] === b[endB - 1]) {
        endA--;
        endB--;
      }
      return (pos) =>
        pos <= begin
          ? pos
          : pos >= endA
            ? pos + endB - endA
            : Math.min(pos, endB);
    }
    let composing = false,
      waiting = null;
    root.addEventListener(
      'compositionstart',
      () => {
        composing = true;
      },
      true,
    );
    function applyWaiting() {
      if (!waiting || destroyed || composing || finishInline) return;
      const { base, incoming } = waiting;
      waiting = null;
      const combined =
        text === base
          ? incoming
          : (window.SamareMerge?.merge(base, text, incoming) ?? text);
      setText(combined);
      if (combined !== incoming) options.onChange?.(combined);
    }
    root.addEventListener(
      'compositionend',
      () => {
        composing = false;
        if (waiting) setTimeout(applyWaiting, 30);
      },
      true,
    );
    function setText(value) {
      if (value === text) return;
      if (composing || finishInline) {
        waiting = { base: waiting?.base ?? text, incoming: value };
        return;
      }
      const draft = captureCSVDraft(value);
      csvDraft = null;
      const oldView = view,
        active = document.activeElement,
        hadFocus = root.contains(active),
        scroll = host.closest('#scroll') || document.scrollingElement;
      const scrollTop = scroll?.scrollTop;
      const previousHeight = scroll?.scrollHeight;
      let following = false, appended = false;
      if (lines && mode !== 'source' && value.startsWith(text)) {
        const records = value.slice(text.length).split(/\r\n|\r|\n/).filter(s => s.trim()).length;
        appended = records > 0;
        if (appended) {
          const currentPage = jsonPages.get('records') || 0;
          following = currentPage === (newestFirst ? 0 : recordPageCount - 1) &&
            (newestFirst ? scrollTop : previousHeight - scroll.clientHeight - scrollTop) <= 32;
          if (following) { jsonPages.set('records', newestFirst ? 0 : Number.MAX_SAFE_INTEGER); jumpToFresh = true; }
          freshRecords = following ? 0 : freshRecords + records;
        }
      } else if (lines) clearFreshRecords();
      let selection = oldView?.state.selection;
      const nativeSelection = document.getSelection();
      if (
        oldView &&
        nativeSelection?.anchorNode &&
        oldView.dom.contains(nativeSelection.anchorNode) &&
        oldView.dom.contains(nativeSelection.focusNode)
      ) {
        selection = {
          anchor: oldView.posAtDOM(
            nativeSelection.anchorNode,
            nativeSelection.anchorOffset,
          ),
          head: oldView.posAtDOM(
            nativeSelection.focusNode,
            nativeSelection.focusOffset,
          ),
        };
      }
      const before =
        hadFocus && oldView ? positionText(oldView.state.doc) : null;
      const editing = active?.matches('input,textarea')
        ? {
            selector: active.tagName.toLowerCase(),
            label: active.getAttribute('aria-label'),
            from: active.selectionStart,
            to: active.selectionEnd,
            old: active.value,
            index: [...root.querySelectorAll('input,textarea')]
              .filter(
                (n) =>
                  n.getAttribute('aria-label') ===
                  active.getAttribute('aria-label'),
              )
              .indexOf(active),
          }
        : null;
      text = value;
      edits.length = 0;
      future.length = 0;
      render();
      if (before !== null && view && selection && hadFocus && !editing) {
        if (longDoc) hydratePosition(before.length);
        const doc = view.state.doc,
          map = remap(before, positionText(doc));
        view.dispatch(
          view.state.tr.setSelection(
            L.TextSelection.between(
              doc.resolve(map(selection.anchor)),
              doc.resolve(map(selection.head)),
            ),
          ),
        );
        view.focus();
      } else if (draft) {
        restoreCSVDraft(draft);
      } else if (editing && hadFocus) {
        const field = [...root.querySelectorAll(editing.selector)].filter(
          (n) => n.getAttribute('aria-label') === editing.label,
        )[editing.index];
        if (field) {
          field.focus({ preventScroll: true });
          if (editing.from != null && field.setSelectionRange) {
            const map = remap(editing.old, field.value);
            field.setSelectionRange(map(editing.from), map(editing.to));
          }
        }
      }
      if (scroll && scrollTop !== undefined) {
        if (appended && following) scroll.scrollTop = newestFirst ? 0 : scroll.scrollHeight;
        else if (appended && newestFirst) scroll.scrollTop = scrollTop + scroll.scrollHeight - previousHeight;
        else scroll.scrollTop = scrollTop;
      }
    }
    render();
    return {
      getText: () => text,
      setText,
      command,
      updateSettings,
      captureReadingSelection() {
        if (searchGrid) {
          const grid = { page: csvPage };
          if (article.scrollLeft) grid.left = article.scrollLeft;
          if (readingGridField) {
            const field = readingGridField;
            grid.row = Number(field.closest('tr').dataset.row) - (csvHeader ? 0 : 1);
            grid.column = Number(field.closest('[data-col]').dataset.col);
            grid.from = field.selectionStart;
            grid.to = field.selectionEnd;
            grid.direction = field.selectionDirection;
          }
          return { grid };
        }
        if (sourceArea) {
          const cursor = sourceArea.selectionDirection === 'backward'
            ? sourceArea.selectionStart : sourceArea.selectionEnd;
          return { cursor, innerScroll: sourceArea.scrollTop };
        }
        if (!view) return {};
        const selection = document.getSelection();
        if (selection?.rangeCount && view.dom.contains(selection.getRangeAt(0).startContainer)) {
          const range = selection.getRangeAt(0);
          return { cursor: view.posAtDOM(range.startContainer, range.startOffset) };
        }
        return { cursor: view.state.selection.from };
      },
      restoreReadingSelection(cursor, innerScroll, reading, allowFocus = true) {
        const grid = reading?.grid;
        if (searchGrid && grid && Number.isInteger(grid.page)) {
          const first = csvHeader ? 1 : 0;
          const last = searchGrid.rows.length - 1;
          const hasCell = Number.isInteger(grid.row) && Number.isInteger(grid.column) && last >= first;
          const physical = hasCell ? Math.min(last, Math.max(first, grid.row)) : first;
          const row = physical + (csvHeader ? 0 : 1);
          const page = hasCell ? Math.floor((row - 1) / searchGrid.pageSize) : grid.page;
          const lastPage = Math.max(0, Math.floor((last - first) / searchGrid.pageSize));
          const next = Math.min(lastPage, Math.max(0, page));
          if (csvPage !== next) {
            csvPage = next;
            render();
          }
          if (hasCell) {
            const fields = article.querySelectorAll('tr[data-row="' + row + '"] td[data-col] textarea');
            const field = fields[Math.min(fields.length - 1, Math.max(0, grid.column))];
            if (field && !field.readOnly) {
              if (allowFocus) field.focus({preventScroll:true});
              field.setSelectionRange(grid.from || 0, grid.to || 0, grid.direction);
              readingGridField = field;
            }
          }
          article.scrollLeft = grid.left || 0;
          return;
        }
        if (!Number.isFinite(cursor)) return;
        const pos = Math.max(0, Math.trunc(cursor));
        if (sourceArea) {
          const at = Math.min(pos, sourceArea.value.length);
          sourceArea.setSelectionRange(at, at);
          sourceArea.scrollTop = innerScroll || 0;
        } else if (view) {
          hydratePosition(pos);
          const doc = view.state.doc;
          view.dispatch(view.state.tr.setSelection(
            L.Selection.near(doc.resolve(Math.min(pos, doc.content.size))),
          ));
        }
      },
      destroy() {
        finishInline?.();
        applyWaiting();
        destroyed = true;
        stopHydration();
        finishCSVCell();
        closePicker();
        document.removeEventListener('pointerdown', dismissPicker, true);
        window.removeEventListener('scroll', reposition, true);
        view?.destroy();
        root.remove();
      },
    };
  }
  // Both UI hosts share cancellation for the query and its separate scroll request.
  function createDocumentFind(getEditor) {
    let current;
    function cancel() {
      current?.scan.abort();
      current?.reveal?.abort();
      current = null;
    }
    function start(query, caseSensitive, update) {
      const editor = getEditor(),
        text = editor?.getText(),
        mode = editor?.command('getMode');
      if (
        current &&
        current.editor === editor &&
        current.text === text &&
        current.mode === mode &&
        current.query === query &&
        current.caseSensitive === caseSensitive
      )
        return true;
      cancel();
      if (!editor || !query) return false;
      const job = { editor, text, mode, query, caseSensitive, scan: new AbortController() };
      current = job;
      let count = 0;
      function publish(matches, pending) {
        if (current !== job || matches === null) return;
        if (pending && count === matches.length && count) return;
        const first = !count && matches.length > 0;
        count = matches.length;
        update(matches, pending, first);
      }
      const promise = editor.command('findDocumentMatchesAsync', {
        query,
        caseSensitive,
        signal: job.scan.signal,
        onProgress: (hits) => publish(hits, true),
      });
      if (!promise) {
        current = null;
        return false;
      }
      publish([], true);
      promise.then((hits) => {
        if (current !== job) return;
        if (hits === null) {
          cancel();
          start(query, caseSensitive, update);
        } else publish(hits, false);
      });
      return true;
    }
    function reveal(match, show) {
      const job = current;
      if (!job) return;
      job.reveal?.abort();
      const task = (job.reveal = new AbortController());
      job.editor.command('revealDocumentMatchAsync', { match, signal: task.signal }).then((range) => {
        if (range && current === job && !task.signal.aborted) show(range);
      });
    }
    return { start, reveal, cancel };
  }
  window.SamareEditor = { mount, createDocumentFind };
})();
