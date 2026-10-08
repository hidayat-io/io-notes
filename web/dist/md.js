// LiteMd: a small, safe Markdown renderer (GFM subset) shared by the app and the
// public share page. Every piece of text from a note is escaped before any markup
// is added, and the only URLs that become links use http or https.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LiteMd = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_BYTES = 512 * 1024;
  const MAX_DEPTH = 20;
  const MAX_URL = 2048;
  const NOTICE = 'This note is too large to render as Markdown. Showing plain text instead.';

  const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
  const byteLength = (s) => (encoder ? encoder.encode(s).length : s.length * 3);

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

  // Four private-use characters carry placeholders and hard line breaks through the
  // inline passes. They are built from char codes so the source stays readable, and
  // render() replaces any that appear in a note before parsing starts.
  const OPEN = String.fromCharCode(0xE000);
  const CLOSE = String.fromCharCode(0xE001);
  const BREAK = String.fromCharCode(0xE003);
  const REPLACEMENT = String.fromCharCode(0xFFFD);
  const PRIVATE = new RegExp('[' + OPEN + '-' + BREAK + ']', 'g');
  const PLACEHOLDER = new RegExp(OPEN + '(\\d+)' + CLOSE, 'g');
  const BREAK_ALL = new RegExp(BREAK, 'g');
  const BARE_URL = new RegExp('https?://[^\\s<>"\'' + OPEN + '-' + BREAK + ']+', 'iy');
  const AUTOLINK = /<(https?:\/\/[^\s<>"]+)>/iy;
  const ASCII_PUNCT = /^[!-/:-@[-`{-~]$/;
  const WORD = /[A-Za-z0-9_]/;

  const ATTACH = /^ {0,3}!\[([^\]]*)\]\(attach:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)[ \t]*$/;
  const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+|$)/;
  const FENCE = /^( {0,3})(`{3,}|~{3,})/;
  const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
  const QUOTE = /^ {0,3}>/;
  const LIST = /^( {0,3})([-*+]|\d{1,9}[.)])(?:[ \t]+|$)/;
  const TASK = /^\[([ xX])\](?:[ \t]+|$)/;
  const DELIM_CELL = /^:?-+:?$/;

  /* ------------------------------------------------------------------ inline */

  function makeStore() {
    const items = [];
    return {
      put(html) {
        items.push(html);
        return OPEN + (items.length - 1) + CLOSE;
      },
      restore(s) {
        return s.replace(PLACEHOLDER, (_, i) => items[Number(i)]).replace(BREAK_ALL, '<br>');
      },
    };
  }

  // Code spans and backslash escapes become placeholders first, so nothing inside
  // them is ever read as Markdown. Backtick runs are indexed once, which keeps the
  // search for a matching run linear however many unmatched runs there are.
  function protect(text, store) {
    const runs = [];
    for (let i = 0; i < text.length;) {
      if (text.charCodeAt(i) === 96) {
        let j = i;
        while (j < text.length && text.charCodeAt(j) === 96) j++;
        runs.push({ start: i, len: j - i });
        i = j;
      } else i++;
    }
    if (!runs.length && text.indexOf('\\') === -1) return text;
    const nextSame = new Array(runs.length).fill(-1);
    const seen = new Map();
    for (let k = runs.length - 1; k >= 0; k--) {
      nextSame[k] = seen.has(runs[k].len) ? seen.get(runs[k].len) : -1;
      seen.set(runs[k].len, k);
    }
    let out = '';
    let i = 0;
    let k = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\' && i + 1 < text.length) {
        const next = text[i + 1];
        if (next === '\n') { out += BREAK; i += 2; continue; }
        if (ASCII_PUNCT.test(next)) { out += store.put(esc(next)); i += 2; continue; }
      }
      if (ch === '`') {
        while (k < runs.length && runs[k].start < i) k++;
        const open = runs[k];
        const match = nextSame[k];
        if (match !== -1) {
          const close = runs[match];
          let code = text.slice(open.start + open.len, close.start).replace(/\n/g, ' ');
          if (code.length > 2 && code[0] === ' ' && code[code.length - 1] === ' ' && code.trim() !== '') code = code.slice(1, -1);
          out += store.put('<code>' + esc(code) + '</code>');
          i = close.start + close.len;
        } else {
          out += text.slice(open.start, open.start + open.len);
          i = open.start + open.len;
        }
        continue;
      }
      out += ch;
      i++;
    }
    return out;
  }

  // Applied to text that is already escaped, so the only tags that can appear are
  // the ones inserted here. Bold may contain a lone star or underscore (italic
  // inside bold); the alternation is deterministic, so each attempt stays linear.
  function emphasis(s) {
    return s
      .replace(/\*\*(?=[^\s*])((?:[^*\n]|\*(?!\*))*?[^\s*])\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^A-Za-z0-9_])__(?=[^\s_])((?:[^_\n]|_(?!_))*?[^\s_])__(?![A-Za-z0-9_])/g, '$1<strong>$2</strong>')
      .replace(/(?<![*\\])\*(?=[^\s*])([^*\n]*[^\s*])\*(?!\*)/g, '<em>$1</em>')
      .replace(/(^|[^A-Za-z0-9_])_(?=[^\s_])([^_\n]*[^\s_])_(?![A-Za-z0-9_])/g, '$1<em>$2</em>')
      .replace(/~~(?=[^\s~])([^~\n]*[^\s~])~~/g, '<s>$1</s>');
  }

  const isHttpUrl = (url) => /^https?:\/\/[^\s<>"]+$/i.test(url);
  const anchor = (url, innerHtml) => '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + innerHtml + '</a>';

  // Reads "(destination "optional title")" starting at the "(". Returns null for
  // anything that is not a plain, bounded destination.
  function parseDestination(text, open) {
    let i = open + 1;
    while (text[i] === ' ' || text[i] === '\t') i++;
    const begin = i;
    let depth = 0;
    for (; i < text.length && i - begin <= MAX_URL; i++) {
      const c = text[i];
      if (c === '(') { if (++depth > 32) return null; continue; }
      if (c === ')') { if (depth === 0) break; depth--; continue; }
      if (c === ' ' || c === '\t' || c === '\n' || c === '[' || c === '<') break;
    }
    const url = text.slice(begin, i);
    if (!url || i - begin > MAX_URL) return null;
    while (text[i] === ' ' || text[i] === '\t') i++;
    if (text[i] === '"' || text[i] === "'") {
      const quote = text[i];
      const stop = text.indexOf(quote, i + 1);
      if (stop === -1 || stop - i > 512) return null;
      i = stop + 1;
      while (text[i] === ' ' || text[i] === '\t') i++;
    }
    if (text[i] !== ')') return null;
    return { url, end: i + 1 };
  }

  // Links, images and autolinks. Matching brackets are paired in one pass; link
  // text only gets emphasis (no nested links), so recursion never goes deeper.
  function links(text, store) {
    if (!/[[<]|https?:/i.test(text)) return text;
    const close = new Map();
    const stack = [];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '[') stack.push(i);
      else if (text[i] === ']' && stack.length) close.set(stack.pop(), i);
    }
    let out = '';
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      const image = ch === '!' && text[i + 1] === '[';
      if (ch === '[' || image) {
        const open = image ? i + 1 : i;
        const end = close.get(open);
        if (end !== undefined && text[end + 1] === '(') {
          const dest = parseDestination(text, end + 1);
          if (dest) {
            const label = text.slice(open + 1, end);
            if (image) {
              out += store.put('<span class="md-image-label">[Image: ' + esc(label) + ']</span>');
              i = dest.end;
              continue;
            }
            if (isHttpUrl(dest.url)) {
              out += store.put(anchor(dest.url, store.restore(emphasis(esc(label)))));
              i = dest.end;
              continue;
            }
          }
        }
        out += ch;
        i++;
        continue;
      }
      if (ch === '<') {
        AUTOLINK.lastIndex = i;
        const m = AUTOLINK.exec(text);
        if (m) {
          out += store.put(anchor(m[1], esc(m[1])));
          i += m[0].length;
          continue;
        }
      }
      if ((ch === 'h' || ch === 'H') && (i === 0 || !WORD.test(text[i - 1]))) {
        BARE_URL.lastIndex = i;
        const m = BARE_URL.exec(text);
        if (m) {
          let url = m[0];
          for (;;) {
            const last = url[url.length - 1];
            const unbalanced = last === ')' && (url.match(/\)/g) || []).length > (url.match(/\(/g) || []).length;
            if (/[.,;:!?*_~\]]/.test(last) || unbalanced) url = url.slice(0, -1);
            else break;
          }
          if (isHttpUrl(url)) {
            out += store.put(anchor(url, esc(url)));
            i += url.length;
            continue;
          }
        }
      }
      out += ch;
      i++;
    }
    return out;
  }

  function inline(raw) {
    const store = makeStore();
    let text = protect(String(raw), store);
    text = links(text, store);
    return store.restore(emphasis(esc(text)));
  }

  /* ------------------------------------------------------------------ blocks */

  const isBlank = (line) => line.trim() === '';

  function expandIndent(line) {
    const m = /^[ \t]+/.exec(line);
    return m && m[0].indexOf('\t') !== -1 ? m[0].replace(/\t/g, '    ') + line.slice(m[0].length) : line;
  }

  function indentOf(line) {
    let n = 0;
    while (n < line.length && line[n] === ' ') n++;
    return n;
  }

  function isHr(line) {
    if (indentOf(line) > 3) return false;
    const mark = line.trim()[0];
    if (mark !== '-' && mark !== '*' && mark !== '_') return false;
    let count = 0;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === mark) count++;
      else if (c !== ' ' && c !== '\t') return false;
    }
    return count >= 3;
  }

  function stripClosingHashes(s) {
    let i = s.length;
    while (i > 0 && s[i - 1] === '#') i--;
    if (i === s.length) return s;
    if (i === 0) return '';
    return s[i - 1] === ' ' || s[i - 1] === '\t' ? s.slice(0, i).trimEnd() : s;
  }

  function fenceOpen(line) {
    const m = FENCE.exec(line);
    if (!m) return null;
    const info = line.slice(m[0].length).trim();
    if (m[2][0] === '`' && info.indexOf('`') !== -1) return null;
    return { indent: m[1].length, char: m[2][0], len: m[2].length, lang: info.split(/\s/)[0].replace(/[^A-Za-z0-9_+.#-]/g, '').slice(0, 30) };
  }

  function listMarker(line) {
    const m = LIST.exec(line);
    if (!m) return null;
    return { indent: m[1].length, marker: m[2], ordered: m[2][0] >= '0' && m[2][0] <= '9', rest: line.slice(m[0].length) };
  }

  function canInterruptParagraph(line) {
    const m = listMarker(line);
    if (!m || m.rest.trim() === '') return false;
    return !m.ordered || parseInt(m.marker, 10) === 1;
  }

  function startsBlock(line) {
    return fenceOpen(line) !== null || HEADING.test(line) || isHr(line) || QUOTE.test(line) || ATTACH.test(line);
  }

  function splitRow(line) {
    let s = line.trim();
    if (s[0] === '|') s = s.slice(1);
    const cells = [];
    let cell = '';
    let closed = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\' && s[i + 1] === '|') { cell += '\\|'; i++; continue; }
      if (c === '|') { cells.push(cell.trim()); cell = ''; closed = true; continue; }
      cell += c;
      closed = false;
    }
    if (!closed || cell.trim() !== '') cells.push(cell.trim());
    return cells;
  }

  function delimiterRow(line) {
    if (line.indexOf('-') === -1) return null;
    const cells = splitRow(line);
    if (!cells.length) return null;
    const aligns = [];
    for (const cell of cells) {
      if (!DELIM_CELL.test(cell)) return null;
      const left = cell[0] === ':';
      const right = cell[cell.length - 1] === ':';
      aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : '');
    }
    return aligns;
  }

  function tableAt(lines, i) {
    if (i + 1 >= lines.length || lines[i].indexOf('|') === -1) return null;
    const header = splitRow(lines[i]);
    const aligns = delimiterRow(expandIndent(lines[i + 1]));
    return aligns && aligns.length === header.length ? { header, aligns } : null;
  }

  function renderTable(lines, i, t) {
    const cellHtml = (tag, text, align) => '<' + tag + (align ? ' class="md-al-' + align + '"' : '') + '>' + inline(text) + '</' + tag + '>';
    let html = '<div class="md-table-wrap"><table><thead><tr>' + t.header.map((c, k) => cellHtml('th', c, t.aligns[k])).join('') + '</tr></thead><tbody>';
    let j = i + 2;
    while (j < lines.length) {
      const line = expandIndent(lines[j]);
      if (isBlank(line) || startsBlock(line)) break;
      const row = splitRow(line);
      html += '<tr>' + t.header.map((_, k) => cellHtml('td', row[k] || '', t.aligns[k])).join('') + '</tr>';
      j++;
    }
    return { html: html + '</tbody></table></div>', next: j };
  }

  function renderItemBlocks(blocks) {
    const paragraphs = blocks.filter((b) => b.t === 'p').length;
    return blocks.map((b, k) => (b.t === 'p' ? (paragraphs === 1 && k === 0 ? b.inner : '<p>' + b.inner + '</p>') : b.html)).join('');
  }

  function parseList(lines, start, depth, opts) {
    const first = listMarker(expandIndent(lines[start]));
    const ordered = first.ordered;
    const base = first.indent;
    const startNumber = ordered ? parseInt(first.marker, 10) : 1;
    const items = [];
    let anyTask = false;
    let i = start;

    while (i < lines.length) {
      const head = listMarker(expandIndent(lines[i]));
      if (!head || head.indent - base >= 2 || head.ordered !== ordered) break;
      const body = [{ text: head.rest, lazy: false }];
      i++;
      let ended = false;
      while (i < lines.length && !ended) {
        const line = expandIndent(lines[i]);
        if (isBlank(line)) {
          let k = i + 1;
          while (k < lines.length && isBlank(lines[k])) k++;
          if (k >= lines.length) { i = k; ended = true; break; }
          const next = expandIndent(lines[k]);
          if (indentOf(next) - base >= 2) {
            for (let b = i; b < k; b++) body.push({ text: '', lazy: false });
            i = k;
            continue;
          }
          const sibling = listMarker(next);
          if (sibling && sibling.indent - base < 2 && sibling.ordered === ordered) { i = k; break; }
          ended = true;
          break;
        }
        if (indentOf(line) - base >= 2) { body.push({ text: line, lazy: false }); i++; continue; }
        if (listMarker(line)) break;
        if (!startsBlock(line)) { body.push({ text: line.trim(), lazy: true }); i++; continue; }
        break;
      }
      const indented = body.slice(1).filter((b) => !b.lazy && b.text !== '').map((b) => indentOf(b.text));
      const strip = indented.length ? Math.min(...indented) : 0;
      const bodyLines = body.map((b, k) => (k === 0 || b.lazy ? b.text : b.text.slice(Math.min(strip, indentOf(b.text)))));
      let checked = null;
      const task = TASK.exec(bodyLines[0]);
      if (task) {
        checked = task[1] !== ' ';
        bodyLines[0] = bodyLines[0].slice(task[0].length);
        anyTask = true;
      }
      const inner = renderItemBlocks(parseBlocks(bodyLines, depth + 1, opts));
      items.push(checked === null ? '<li>' + inner + '</li>' : '<li class="md-task"><input type="checkbox" disabled' + (checked ? ' checked' : '') + '> ' + inner + '</li>');
      if (ended) break;
    }

    const tag = ordered ? 'ol' : 'ul';
    const attrs = (ordered && startNumber !== 1 ? ' start="' + startNumber + '"' : '') + (anyTask ? ' class="md-task-list"' : '');
    return { html: '<' + tag + attrs + '>' + items.join('') + '</' + tag + '>', next: i };
  }

  function defaultAttachment(name) {
    return '<span class="md-attach-label">' + esc(name) + '</span>';
  }

  // Returns blocks as { t: 'p', inner } for paragraphs and { t: 'x', html } for the
  // rest, so a list item can show a lone paragraph without the <p> wrapper.
  function parseBlocks(lines, depth, opts) {
    if (depth >= MAX_DEPTH) return [{ t: 'x', html: '<p>' + esc(lines.join('\n')) + '</p>' }];
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = expandIndent(lines[i]);
      if (isBlank(line)) { i++; continue; }

      const attach = ATTACH.exec(line);
      if (attach) {
        const render = opts && typeof opts.attachment === 'function' ? opts.attachment : defaultAttachment;
        out.push({ t: 'x', html: '<div class="md-attach">' + render(attach[1], attach[2]) + '</div>' });
        i++;
        continue;
      }

      const fence = fenceOpen(line);
      if (fence) {
        const code = [];
        i++;
        while (i < lines.length) {
          const l = expandIndent(lines[i]);
          const close = FENCE_CLOSE.exec(l);
          if (close && close[1][0] === fence.char && close[1].length >= fence.len) { i++; break; }
          code.push(l.slice(Math.min(fence.indent, indentOf(l))));
          i++;
        }
        const lang = fence.lang ? '<span class="md-code-language">' + esc(fence.lang) + '</span>' : '';
        out.push({ t: 'x', html: '<pre class="md-code">' + lang + '<code>' + esc(code.join('\n')) + '</code></pre>' });
        continue;
      }

      const heading = HEADING.exec(line);
      if (heading) {
        const level = heading[1].length;
        out.push({ t: 'x', html: '<h' + level + '>' + inline(stripClosingHashes(line.slice(heading[0].length).trim())) + '</h' + level + '>' });
        i++;
        continue;
      }

      if (isHr(line)) { out.push({ t: 'x', html: '<hr>' }); i++; continue; }

      if (QUOTE.test(line)) {
        const inner = [];
        while (i < lines.length && QUOTE.test(expandIndent(lines[i]))) {
          inner.push(expandIndent(lines[i]).replace(/^ {0,3}> ?/, ''));
          i++;
        }
        const blocks = parseBlocks(inner, depth + 1, opts);
        out.push({ t: 'x', html: '<blockquote>' + blocks.map((b) => (b.t === 'p' ? '<p>' + b.inner + '</p>' : b.html)).join('') + '</blockquote>' });
        continue;
      }

      if (listMarker(line)) {
        const list = parseList(lines, i, depth, opts);
        out.push({ t: 'x', html: list.html });
        i = list.next;
        continue;
      }

      const table = tableAt(lines, i);
      if (table) {
        const rendered = renderTable(lines, i, table);
        out.push({ t: 'x', html: rendered.html });
        i = rendered.next;
        continue;
      }

      const para = [];
      while (i < lines.length) {
        const l = expandIndent(lines[i]);
        if (isBlank(l) || (para.length && (startsBlock(l) || canInterruptParagraph(l)))) break;
        para.push(l);
        i++;
      }
      const text = para.map((l, k) => {
        const trailing = l.length - l.trimEnd().length;
        return l.trim() + (trailing >= 2 && k < para.length - 1 ? BREAK : '');
      }).join('\n');
      out.push({ t: 'p', inner: inline(text) });
    }
    return out;
  }

  /* ------------------------------------------------------------------ public */

  function render(source, opts) {
    const text = String(source == null ? '' : source);
    if (byteLength(text) > MAX_BYTES) {
      return '<p class="md-notice">' + NOTICE + '</p><pre class="md-plain">' + esc(text) + '</pre>';
    }
    const lines = text.replace(PRIVATE, REPLACEMENT).replace(/\r\n?/g, '\n').split('\n');
    return parseBlocks(lines, 0, opts).map((b) => (b.t === 'p' ? '<p>' + b.inner + '</p>' : b.html)).join('');
  }

  return { render, MAX_BYTES, MAX_DEPTH };
});
