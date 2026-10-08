// Unit tests for the Markdown renderer. Pure Node, no browser: md.js is a classic
// script with a UMD wrapper, so it can be required directly.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';

const MD_PATH = process.env.MD_PATH || '../dist/md.js';
const require = createRequire(import.meta.url);
const LiteMd = require(MD_PATH);
const { render, MAX_BYTES } = LiteMd;

const ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

test('exports render and the size limit, as a module and as a browser global', () => {
  assert.equal(typeof render, 'function');
  assert.equal(MAX_BYTES, 512 * 1024);
  const sandbox = {};
  sandbox.self = sandbox;
  vm.runInNewContext(readFileSync(new URL(MD_PATH, import.meta.url), 'utf8'), sandbox);
  assert.equal(typeof sandbox.LiteMd.render, 'function');
  assert.equal(sandbox.LiteMd.render('**x**'), '<p><strong>x</strong></p>');
});

/* ------------------------------------------------------------ golden output */

const GOLDEN = [
  ['empty input', '', ''],
  ['whitespace only', '  \n\t\n', ''],
  ['null and undefined', null, ''],
  ['headings', '# A\n## B ##\n###### F\n####### seven', '<h1>A</h1><h2>B</h2><h6>F</h6><p>####### seven</p>'],
  ['heading needs a space', '#nospace', '<p>#nospace</p>'],
  ['soft wrapped paragraph', 'one\ntwo', '<p>one\ntwo</p>'],
  ['two paragraphs', 'one\n\ntwo', '<p>one</p><p>two</p>'],
  ['hard break with two spaces', 'a  \nb', '<p>a<br>\nb</p>'],
  ['hard break with backslash', 'a\\\nb', '<p>a<br>b</p>'],
  ['windows line endings', 'a\r\nb\r\n\r\nc', '<p>a\nb</p><p>c</p>'],
  ['emphasis', '**b** __b__ *i* _i_ ~~s~~', '<p><strong>b</strong> <strong>b</strong> <em>i</em> <em>i</em> <s>s</s></p>'],
  ['bold italic', '***both***', '<p><em><strong>both</strong></em></p>'],
  ['nested emphasis', '**bold *and italic* text**', '<p><strong>bold <em>and italic</em> text</strong></p>'],
  ['snake_case stays text', 'snake_case_name and __init__.py', '<p>snake_case_name and <strong>init</strong>.py</p>'],
  ['spaced stars stay text', 'a * b * c', '<p>a * b * c</p>'],
  ['intraword star emphasis', '2*3*4', '<p>2<em>3</em>4</p>'],
  ['inline code', 'use `a < b` here', '<p>use <code>a &lt; b</code> here</p>'],
  ['code with backtick inside', '``a ` b``', '<p><code>a ` b</code></p>'],
  ['markers inside code stay', '`**x** _y_`', '<p><code>**x** _y_</code></p>'],
  ['unmatched backtick', 'a ` b', '<p>a ` b</p>'],
  ['backslash escapes', '\\*not em\\* and \\# and \\`x\\`', '<p>*not em* and # and `x`</p>'],
  ['hr variants', '---\n\n***\n\n* * *\n\n___', '<hr><hr><hr><hr>'],
  ['two dashes is text', '--', '<p>--</p>'],
  ['link', '[go](https://a.com/x?y=1&z=2 "t")', '<p><a href="https://a.com/x?y=1&amp;z=2" target="_blank" rel="noopener noreferrer">go</a></p>'],
  ['link text keeps emphasis and code', '[**b** `c`](https://a.com)', '<p><a href="https://a.com" target="_blank" rel="noopener noreferrer"><strong>b</strong> <code>c</code></a></p>'],
  ['angle autolink', '<https://a.com/p>', '<p><a href="https://a.com/p" target="_blank" rel="noopener noreferrer">https://a.com/p</a></p>'],
  ['bare url drops trailing punctuation', 'Visit https://a.com/x.', '<p>Visit <a href="https://a.com/x" target="_blank" rel="noopener noreferrer">https://a.com/x</a>.</p>'],
  ['bare url in parentheses', '(see https://a.com/x)', '<p>(see <a href="https://a.com/x" target="_blank" rel="noopener noreferrer">https://a.com/x</a>)</p>'],
  ['bare url keeps balanced parentheses', 'https://en.wikipedia.org/wiki/Foo_(bar)', '<p><a href="https://en.wikipedia.org/wiki/Foo_(bar)" target="_blank" rel="noopener noreferrer">https://en.wikipedia.org/wiki/Foo_(bar)</a></p>'],
  ['bare url with underscores is not emphasis', 'https://a.com/a_b_c', '<p><a href="https://a.com/a_b_c" target="_blank" rel="noopener noreferrer">https://a.com/a_b_c</a></p>'],
  ['bare url inside brackets', '[https://a.com]', '<p>[<a href="https://a.com" target="_blank" rel="noopener noreferrer">https://a.com</a>]</p>'],
  ['remote image becomes a label', '![the logo](https://t.com/p.png)', '<p><span class="md-image-label">[Image: the logo]</span></p>'],
  ['bullet list', '- a\n- b\n* c', '<ul><li>a</li><li>b</li><li>c</li></ul>'],
  ['ordered list keeps its start', '3. a\n4. b', '<ol start="3"><li>a</li><li>b</li></ol>'],
  ['ordered list from one has no start', '1) a\n2) b', '<ol><li>a</li><li>b</li></ol>'],
  ['blank lines between items stay one list', '1. a\n\n2. b\n\n3. c', '<ol><li>a</li><li>b</li><li>c</li></ol>'],
  ['nested list, three levels', '- a\n  - b\n    - c\n- d', '<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>'],
  ['nested list under ordered, 4 spaces', '1. a\n    - b\n2. c', '<ol><li>a<ul><li>b</li></ul></li><li>c</li></ol>'],
  ['nested list under ordered, 2 spaces', '1. a\n  - b\n2. c', '<ol><li>a<ul><li>b</li></ul></li><li>c</li></ol>'],
  ['tab indented nested list', '- a\n\t- b', '<ul><li>a<ul><li>b</li></ul></li></ul>'],
  ['bullet then ordered are two lists', '- a\n1. b', '<ul><li>a</li></ul><ol><li>b</li></ol>'],
  ['lazy continuation', '- a\ncontinued', '<ul><li>a\ncontinued</li></ul>'],
  ['two paragraphs in one item', '- a\n\n  b', '<ul><li><p>a</p><p>b</p></li></ul>'],
  ['fenced code inside an item', '- run:\n  ```sh\n  ls -l\n  ```\n- next', '<ul><li>run:<pre class="md-code"><span class="md-code-language">sh</span><code>ls -l</code></pre></li><li>next</li></ul>'],
  ['list interrupts a paragraph', 'Steps:\n1. one\n2. two', '<p>Steps:</p><ol><li>one</li><li>two</li></ol>'],
  ['a year at line start is not a list', 'text\n2024. was a year', '<p>text\n2024. was a year</p>'],
  ['task list', '- [ ] todo\n- [x] done\n- [X] also', '<ul class="md-task-list"><li class="md-task"><input type="checkbox" disabled> todo</li><li class="md-task"><input type="checkbox" disabled checked> done</li><li class="md-task"><input type="checkbox" disabled checked> also</li></ul>'],
  ['blockquote', '> a\n> b', '<blockquote><p>a\nb</p></blockquote>'],
  ['nested blockquote', '> a\n> > b', '<blockquote><p>a</p><blockquote><p>b</p></blockquote></blockquote>'],
  ['blockquote with list', '> - a\n> - b', '<blockquote><ul><li>a</li><li>b</li></ul></blockquote>'],
  ['fenced code keeps markers and escapes html', '```js\nlet a = <b>**x**;\n```', '<pre class="md-code"><span class="md-code-language">js</span><code>let a = &lt;b&gt;**x**;</code></pre>'],
  ['tilde fence', '~~~\nx\n~~~', '<pre class="md-code"><code>x</code></pre>'],
  ['closing fence may be longer', '```\nx\n`````', '<pre class="md-code"><code>x</code></pre>'],
  ['unclosed fence runs to the end', '```\ncode\nmore', '<pre class="md-code"><code>code\nmore</code></pre>'],
  ['fence language is sanitized', '```js title="x"\n1\n```', '<pre class="md-code"><span class="md-code-language">js</span><code>1</code></pre>'],
  ['table with alignment and an escaped pipe', '| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n| x \\| y | **z** | 4 |',
    '<div class="md-table-wrap"><table><thead><tr><th class="md-al-left">a</th><th class="md-al-center">b</th><th class="md-al-right">c</th></tr></thead><tbody><tr><td class="md-al-left">1</td><td class="md-al-center">2</td><td class="md-al-right">3</td></tr><tr><td class="md-al-left">x | y</td><td class="md-al-center"><strong>z</strong></td><td class="md-al-right">4</td></tr></tbody></table></div>'],
  ['table without outer pipes', 'a | b\n--|--\n1 | 2', '<div class="md-table-wrap"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>'],
  ['table pads short rows and drops extra cells', '| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |', '<div class="md-table-wrap"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td></td></tr><tr><td>1</td><td>2</td></tr></tbody></table></div>'],
  ['header and delimiter must have the same width', '| a | b |\n|---|', '<p>| a | b |\n|---|</p>'],
  ['table ends at a blank line', '| a |\n|---|\n| 1 |\n\nafter', '<div class="md-table-wrap"><table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table></div><p>after</p>'],
  ['raw html is shown as text', '<div onclick="x">hi</div>', '<p>&lt;div onclick=&quot;x&quot;&gt;hi&lt;/div&gt;</p>'],
  ['attachment line without a callback is a label', `![a.pdf](attach:${ID})`, '<div class="md-attach"><span class="md-attach-label">a.pdf</span></div>'],
  ['attachment inside a sentence is an image label', `see ![x](attach:${ID}) here`, '<p>see <span class="md-image-label">[Image: x]</span> here</p>'],
];

for (const [name, input, expected] of GOLDEN) {
  test(`renders: ${name}`, () => {
    assert.equal(render(input), expected);
  });
}

test('the attachment callback receives the name and id of a standalone attachment line', () => {
  const calls = [];
  const html = render(`before\n![report.pdf](attach:${ID})\nafter\n\n![remote](https://t.com/a.png)`, {
    attachment: (name, id) => { calls.push([name, id]); return `<b>${name}</b>`; },
  });
  assert.deepEqual(calls, [['report.pdf', ID]]);
  assert.equal(html, '<p>before</p><div class="md-attach"><b>report.pdf</b></div><p>after</p><p><span class="md-image-label">[Image: remote]</span></p>');
});

test('private-use characters in a note cannot reach the placeholder store', () => {
  const open = String.fromCharCode(0xE000);
  const close = String.fromCharCode(0xE001);
  const hard = String.fromCharCode(0xE003);
  const replacement = String.fromCharCode(0xFFFD);
  assert.equal(render(`x${open}0${close}y${hard}`), `<p>x${replacement}0${replacement}y${replacement}</p>`);
});

test('nesting deeper than the limit is shown as text instead of recursing', () => {
  const html = render('> '.repeat(40) + 'deep');
  assert.match(html, /deep/);
  assert.match(html, /&gt;/);
  assert.equal((html.match(/<blockquote>/g) || []).length, LiteMd.MAX_DEPTH);
});

/* ---------------------------------------------------------------- safety */

const ALLOWED_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 's', 'code', 'pre', 'ul', 'ol', 'li', 'blockquote', 'hr', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div', 'span', 'a', 'input']);
const ALLOWED_ATTRS = new Set(['href', 'target', 'rel', 'class', 'type', 'disabled', 'checked', 'start']);

// A real parse of the tags: every tag and attribute must be one the renderer is
// known to emit, every href must be http(s), and no stray angle bracket may remain.
function assertSafe(html, label) {
  const tagRe = /<(\/?)([a-zA-Z0-9]+)([^<>]*)>/g;
  for (const m of html.matchAll(tagRe)) {
    assert.ok(ALLOWED_TAGS.has(m[2].toLowerCase()), `${label}: unexpected tag <${m[2]}> in ${html}`);
    for (const a of m[3].matchAll(/\s+([^\s=]+)(?:="([^"]*)")?/g)) {
      assert.ok(ALLOWED_ATTRS.has(a[1]), `${label}: unexpected attribute ${a[1]} in ${html}`);
      if (a[1] === 'href') assert.match(a[2], /^https?:\/\/[^\s<>"]+$/i, `${label}: unsafe href ${a[2]}`);
    }
    assert.equal(m[3].replace(/\s+[^\s=]+(?:="[^"]*")?/g, '').trim(), '', `${label}: malformed tag ${m[0]}`);
  }
  assert.ok(!/[<>]/.test(html.replace(tagRe, '')), `${label}: raw angle bracket left in text: ${html}`);
}

const XSS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg/onload=alert(1)>',
  '[x](javascript:alert(1))',
  '[x](JaVaScRiPt:alert(1))',
  '[x]( javascript:alert(1))',
  '[x](java&#9;script:alert(1))',
  '[x](&#106;avascript:alert(1))',
  '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '[x](vbscript:msgbox(1))',
  '[x](//evil.example/path)',
  '[x](/relative)',
  '[x](mailto:a@b.c)',
  '[x](https://a.com" onmouseover="alert(1))',
  '[x](https://a.com "title" onmouseover="alert(1)")',
  '<https://a.com" onmouseover="alert(1)>',
  '<javascript:alert(1)>',
  'https://a.com/"onmouseover="alert(1)',
  '![x](javascript:alert(1))',
  '![<img src=x onerror=alert(1)>](https://a.com/p.png)',
  '[<img src=x onerror=alert(1)>](https://a.com)',
  '[x](https://a.com "<script>alert(1)</script>")',
  '`<script>alert(1)</script>`',
  '```\n<script>alert(1)</script>\n```',
  '```"><script>alert(1)</script>\n```',
  '# <script>alert(1)</script>',
  '| <script> | b |\n|---|---|\n| <img onerror=1> | 2 |',
  '> <script>alert(1)</script>',
  '- <script>alert(1)</script>',
  '- [ ] <script>alert(1)</script>',
  '\\<script>alert(1)</script>',
  '&lt;script&gt;alert(1)&lt;/script&gt;',
  `![<img src=x onerror=alert(1)>](attach:${ID})`,
  '**<img src=x onerror=alert(1)>**',
  '_<script>_',
];

test('hostile input never produces an unexpected tag, attribute or href', () => {
  for (const input of XSS) assertSafe(render(input), JSON.stringify(input));
});

test('only http and https text becomes a link', () => {
  const nonLinks = [
    '[x](javascript:alert(1))', '[x](JaVaScRiPt:alert(1))', '[x](data:text/html,hi)', '[x](vbscript:x)',
    '[x](//evil.example)', '[x](/relative)', '[x](mailto:a@b.c)', '[x](java&#9;script:alert(1))',
  ];
  for (const input of nonLinks) assert.ok(!render(input).includes('<a '), `${input} became a link`);
  for (const ok of ['[x](https://a.com)', '[x](HTTP://A.COM)', '<https://a.com>', 'https://a.com']) {
    assert.match(render(ok), /<a href="https?:\/\/[^"]+" target="_blank" rel="noopener noreferrer">/i, ok);
  }
});

/* ------------------------------------------------------------ performance */

function line(n, unit) { return unit.repeat(n); }

const HOSTILE = {
  'open brackets': line(200000, '['),
  'stars': line(200000, '*'),
  'underscores': line(200000, '_'),
  'tildes': line(200000, '~'),
  'backticks': line(200000, '`'),
  'backtick runs of unique lengths': Array.from({ length: 900 }, (_, i) => '`'.repeat(i + 1) + ' ').join(''),
  'pipes': line(100000, '|'),
  'pipe cells': line(60000, '| a '),
  'table of many columns': `${line(20000, '|a')}\n${line(20000, '|-')}\n${line(20000, '|b')}`,
  'unclosed link destinations': line(80000, '[a](b'),
  'unclosed image destinations': line(70000, '![a](b'),
  'angle brackets': line(200000, '<'),
  'bare url starts': line(60000, 'http://'),
  'unmatched bold': line(100000, '**a '),
  'unmatched italics': line(150000, '*a'),
  'unmatched underscores': line(150000, '_a'),
  'backslashes': line(200000, '\\'),
  'only spaces': line(500000, ' '),
  'spaces then text': `# a${line(300000, ' ')}b`,
  'hr lookalike': `${line(100000, '- ')}x`,
  'deep quotes': `${line(5000, '>')} x`,
  'deep list indentation': Array.from({ length: 600 }, (_, i) => `${' '.repeat(i * 2)}- x`).join('\n'),
  'many list items': line(100000, '- a\n'),
  'many blank lines in a list': `- a\n${line(200000, '\n')}  b`,
  'many fences': line(60000, '```\n'),
  'many headings': line(60000, '# h\n'),
  'many table rows': `| a |\n|---|\n${line(60000, '| x |\n')}`,
  'long single line': line(100000, 'word '),
  'nested brackets': `${line(60000, '[')}${line(60000, ']')}(https://a.com)`,
};

for (const [name, input] of Object.entries(HOSTILE)) {
  test(`stays fast on ${name}`, () => {
    assert.ok(Buffer.byteLength(input) <= MAX_BYTES, `${name} fixture is over the size limit and would not exercise the parser`);
    const started = performance.now();
    const html = render(input);
    const ms = performance.now() - started;
    assert.equal(typeof html, 'string');
    assert.ok(ms < 1000, `${name} took ${Math.round(ms)}ms`);
  });
}

/* ---------------------------------------------------------- size limit */

test('input at the limit is rendered, one byte over falls back to plain text', () => {
  const atLimit = 'a'.repeat(MAX_BYTES);
  assert.ok(render(atLimit).startsWith('<p>aaa'));
  const over = render(`${atLimit}b`);
  assert.match(over, /^<p class="md-notice">/);
  assert.match(over, /<pre class="md-plain">a+b<\/pre>$/);
});

test('the limit counts UTF-8 bytes, not characters', () => {
  assert.ok(render('é'.repeat(MAX_BYTES / 2)).startsWith('<p>'));
  assert.match(render('é'.repeat(MAX_BYTES / 2 + 1)), /^<p class="md-notice">/);
});

test('the plain text fallback is escaped', () => {
  const html = render(`<script>x</script>${'a'.repeat(MAX_BYTES)}`);
  assert.match(html, /&lt;script&gt;/);
  assert.ok(!html.includes('<script>'));
});
