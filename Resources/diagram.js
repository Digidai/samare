// Offline diagram layout shared by the editor, Quick Look (JavaScriptCore) and print.
(() => {
  'use strict';
  const sans = '"Geist Variable", Geist, system-ui, -apple-system, sans-serif';
  const mono = '"Geist Mono Variable", "Geist Mono", ui-monospace, monospace';
  const palette = (colors) => colors.map((color, i) => '--pele-series-' + (i + 1) + ':' + color).join(';');
  const light = palette(['#73bdff','#1ad1d1','#61d19a','#ddb049','#f7a062','#ff9495','#e698df','#b6a8ff']);
  const dark = palette(['#63b3ff','#00c9c9','#4bc98f','#d6a62e','#f1944f','#fa8789','#df8cd8','#ad9dff']);
  const night = '--pele-bg:#08090b;--pele-fg:#e4e4e7;--pele-muted:#a1a1aa;--pele-line:#a1a1aa;--pele-surface:#27272a;--pele-surface-alt:#18181b;--pele-border:#52525b;--pele-accent:#2e6bc6;' + dark;
  const styles = `
    .samare-diagram{box-sizing:border-box;display:flex;align-items:center;justify-content:flex-start;max-width:100%;overflow-x:auto;padding:4px 0;margin:0 0 16px;scrollbar-width:thin;
      --pele-font:${sans};--pele-font-mono:${mono};--pele-title-weight:600;--pele-heading-weight:600;--pele-radius:6px;
      --pele-bg:#fafafa;--pele-fg:#1e1e22;--pele-muted:#52525b;--pele-line:#71717a;--pele-surface:#fff;--pele-surface-alt:#f4f4f5;--pele-border:#d4d4d8;--pele-accent:#115cdd;--pele-critical:#dc2626;${light}}
    [data-theme="dark"] .samare-diagram:not(.samare-print-diagram){${night}}
    @media(prefers-color-scheme:dark){:root:not([data-theme]) .samare-diagram:not(.samare-print-diagram){${night}}}
    .samare-diagram>svg{display:block;flex:none;margin-inline:auto;height:auto}
    .de-diagram.samare-diagram>svg{width:clamp(var(--diagram-floor),100%,var(--diagram-width));max-width:none!important}
    .samare-diagram .pele-slice-labels[fill]{fill:#18181b}
    .samare-diagram .pele-edges{stroke-width:1.25px}
    .samare-diagram .pele-cluster>rect{fill:none}
    .samare-diagram .pele-slices{stroke-width:2px}
    .samare-print-diagram{break-inside:avoid;overflow:visible}
    .samare-print-diagram>svg{width:auto!important;max-width:100%!important}
  `;
  let counter = 0;
  function render(source, width, measurer) {
    const options = {idPrefix:'samare-diagram-' + ++counter, fontFamily:sans, fontFamilyMono:mono, fontSize:14, links:false, images:false, measurer};
    const natural = pele.render(source, options);
    if (!(width > 0) || natural.width <= width) return natural;
    try {
      const fitted = pele.render(source, {...options, maxWidth:width, directionBreakpoint:width+1});
      // A short horizontal chain can shrink slightly and still read more naturally.
      if (fitted.width < width * 0.4 && fitted.height > fitted.width * 3 && natural.width * 0.7 <= width) return natural;
      return fitted;
    } catch { return natural; }
  }
  const pending = new Set();
  function track(job) {
    pending.add(job);
    job.then(() => pending.delete(job), () => pending.delete(job));
    return job;
  }
  async function ready() {
    while (pending.size) await Promise.allSettled([...pending]);
  }
  function measureInBrowser() {
    const ctx = document.createElement('canvas').getContext('2d');
    return {width(text, size, style) {
      const px = style & 24 ? size / 1.2 : size;
      ctx.font = (style & 2 ? 'italic ' : '') + (style & 1 ? '700 ' : '400 ') + px + 'px ' + (style & 4 ? mono : sans);
      return ctx.measureText(text).width;
    }};
  }
  const browser = typeof document !== 'undefined';
  let browserMeasurer;
  function draw(element, source, width) {
    browserMeasurer ||= measureInBrowser();
    const drawing = render(source, width, browserMeasurer);
    element.classList.add('samare-diagram');
    element.style.setProperty('--diagram-floor', (drawing.width * 0.7) + 'px');
    element.style.setProperty('--diagram-width', drawing.width + 'px');
    element.innerHTML = drawing.svg;
  }
  function preparePrint(copy, width) {
    for (const block of copy.querySelectorAll('.de-diagram.samare-diagram')) {
      const code = block.parentElement.querySelector('.de-pre code');
      if (code && typeof pele !== 'undefined') {
        try { draw(block, code.textContent, width); } catch { /* Keep the visible diagram. */ }
      }
      block.classList.add('samare-print-diagram');
    }
    return styles;
  }
  if (browser) {
    const style = document.createElement('style');
    style.textContent = styles;
    document.head.append(style);
  }
  globalThis.SamareDiagrams = {render, draw, styles, track, ready, preparePrint};
})();
