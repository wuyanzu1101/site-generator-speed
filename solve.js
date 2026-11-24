// A fast, dependency-free reimplementation of makefun-site 1.0.0's build, written from scratch
// for the site-generator-speed bounty. It returns exactly the output tree makefun-site returns
// for every input: same front matter, template dialect, Markdown subset, slug rule and report,
// byte for byte. Pure JavaScript, no dependencies, no WebAssembly, no native addons, no
// prebuilt binaries, no clock, no environment, no randomness.
//
// Speed comes from: range-based single-pass Markdown rendering (no token objects, no per-character
// regex escaping), a memoised slugifier with an ASCII fast path, a hand-rolled front-matter
// scanner (no split/join round-trips), and templates compiled once per case into plain JS
// functions with direct scope bindings instead of a tree-walking renderer.

const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';

// ---------------------------------------------------------------- text

const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;

/** Append s[a..b) to out, HTML-escaped. */
function escInto(out, s, a, b) {
  if (a >= b) return;
  ESC_RE.lastIndex = a;
  let m;
  let last = a;
  while ((m = ESC_RE.exec(s)) !== null) {
    if (m.index >= b) break;
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(ENT[m[0]]);
    last = m.index + 1;
  }
  if (last < b) out.push(s.slice(last, b));
  ESC_RE.lastIndex = 0;
}

/** s, HTML-escaped (fast path when nothing needs escaping). */
function escStr(s) {
  if (!ESC_TEST.test(s)) return s;
  const out = [];
  escInto(out, s, 0, s.length);
  return out.join('');
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(d) {
  return `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
}

const NON_ASCII = /[^\x00-\x7F]/;
const MARKS = /\p{M}/gu;
const NON_ALNUM_RUN = /[^a-z0-9]+/g;

/** The slug of s: NFKD, combining marks dropped, A-Z lowered, each run of characters other
 *  than a-z and 0-9 one "-", none at either end, at most 64 characters (a "-" left at the cut
 *  dropped), "untitled" when nothing is left. */
function slugifyRaw(s) {
  if (!NON_ASCII.test(s)) {
    let out = s.toLowerCase().replace(NON_ALNUM_RUN, '-');
    if (out.charCodeAt(0) === 45) out = out.slice(1);
    if (out.charCodeAt(out.length - 1) === 45) out = out.slice(0, -1);
    if (out.length > 64) {
      out = out.slice(0, 64);
      if (out.charCodeAt(out.length - 1) === 45) out = out.slice(0, -1);
    }
    return out === '' ? 'untitled' : out;
  }
  const plain = s.normalize('NFKD').replace(MARKS, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

const slugCache = new Map();
function slugify(s) {
  let r = slugCache.get(s);
  if (r === undefined) {
    r = slugifyRaw(s);
    slugCache.set(s, r);
  }
  return r;
}

/** slug made unique against taken (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** Whether code c is a JavaScript \s whitespace character. */
function isWSCode(c) {
  return (
    c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff
  );
}

/** ASCII whitespace (9, 10, 11, 12, 13, 32) for the fast path of wordsOf. */
const WS128 = new Uint8Array(128);
for (const c of [9, 10, 11, 12, 13, 32]) WS128[c] = 1;

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws =
      c < 128
        ? WS128[c] === 1
        : c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare (never opening on " or [). */
function fmString(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo))
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1)
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * One front-matter line, text[p..e), its 0-based line number, into data; an error string, or
 * null when the line is blank, a comment, or a good key line.
 */
function fmLine(text, p, e, lineNo, data) {
  let i = p;
  let blank = true;
  while (i < e) {
    const c = text.charCodeAt(i);
    if (c !== 32 && c !== 9) {
      blank = false;
      break;
    }
    i++;
  }
  if (blank) return null;
  if (text.charCodeAt(p) === 35) return null; // '#': a comment
  // key: [a-z_]+, then ':', then either end or one ' ' and the value
  let k = p;
  while (k < e) {
    const c = text.charCodeAt(k);
    if (!((c >= 97 && c <= 122) || c === 95)) break;
    k++;
  }
  if (k === p || k >= e || text.charCodeAt(k) !== 58) return `line ${lineNo + 1} is not "key: value"`;
  const key = text.slice(p, k);
  let raw;
  if (k + 1 === e) raw = '';
  else if (text.charCodeAt(k + 1) === 32) {
    let r = e;
    while (r > k + 2 && (text.charCodeAt(r - 1) === 32 || text.charCodeAt(r - 1) === 9)) r--;
    raw = text.slice(k + 2, r);
  } else return `line ${lineNo + 1} is not "key: value"`;
  if (!FM_KEYS.has(key)) return `unknown key "${key}"`;
  if (Object.hasOwn(data, key)) return `key "${key}" is given twice`;
  if (raw === '') return `key "${key}" has no value`;
  const v = fmValue(key, raw);
  if ('error' in v) return v.error;
  data[key] = v.value;
  return null;
}

/** A source's front matter and body: { data, body }, or { error } with the first reason. */
function parseFrontMatter(text) {
  let e = text.indexOf('\n', 0);
  if (e === -1) e = text.length;
  if (e !== 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) return { error: 'no front matter' };
  const data = {};
  let p = e + 1;
  let lineNo = 1;
  let closed = false;
  let bodyStart = text.length;
  while (p <= text.length) {
    e = text.indexOf('\n', p);
    if (e === -1) e = text.length;
    if (e - p === 3 && text.charCodeAt(p) === 45 && text.charCodeAt(p + 1) === 45 && text.charCodeAt(p + 2) === 45) {
      closed = true;
      bodyStart = e === text.length ? text.length : e + 1;
      break;
    }
    const err = fmLine(text, p, e, lineNo, data);
    if (err !== null) return { error: err };
    if (e === text.length) break;
    p = e + 1;
    lineNo++;
  }
  if (!closed) return { error: 'the front matter is not closed' };
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- Markdown

/** Whether s[j] is one of the characters a backslash escapes. */
function isEscapableCode(c) {
  return (
    c === 92 || c === 96 || c === 42 || c === 95 || c === 91 || c === 93 || c === 40 || c === 41 || c === 35 || c === 43 || c === 45 || c === 46 || c === 33 || c === 62
  );
}

/** The first index from `from` where s holds `what` outside a backslash escape, or -1. */
function findUnesc(s, what, from, end) {
  const wlen = what.length;
  for (let j = from; j + wlen <= end; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < end && isEscapableCode(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && isEscapableCode(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The characters that start an inline construct or need HTML escaping. */
const INLINE_SPECIAL = /[\\`*\[&<>"']/g;

/** s[a..b) rendered inline into out; env.link(target) is a link's href. The scanner reads each
 *  character once: plain text between matches holds neither an inline special nor an HTML
 *  special, so it is pushed raw. */
function inl(out, s, a, b, env) {
  let run = a;
  INLINE_SPECIAL.lastIndex = a;
  let m;
  while ((m = INLINE_SPECIAL.exec(s)) !== null && m.index < b) {
    const j = m.index;
    const c = s.charCodeAt(j);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      // an HTML special: flush the plain text before it, then the entity
      if (run < j) out.push(s.slice(run, j));
      out.push(ENT[s[j]]);
      run = j + 1;
      INLINE_SPECIAL.lastIndex = run;
      continue;
    }
    if (c === 92) {
      // backslash: before an escapable character it writes that character
      if (j + 1 < b && isEscapableCode(s.charCodeAt(j + 1))) {
        if (run < j) out.push(s.slice(run, j));
        out.push(s[j + 1]);
        run = j + 2;
        INLINE_SPECIAL.lastIndex = run;
        continue;
      }
      INLINE_SPECIAL.lastIndex = j + 1;
      continue;
    }
    if (c === 96) {
      // backtick: a code span closed by the next backtick, with at least one character between
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < b && k > j + 1) {
        if (run < j) out.push(s.slice(run, j));
        out.push('<code>');
        escInto(out, s, j + 1, k);
        out.push('</code>');
        run = k + 1;
        INLINE_SPECIAL.lastIndex = run;
        continue;
      }
      INLINE_SPECIAL.lastIndex = j + 1;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnesc(s, '**', j + 2, b);
        if (k > j + 2) {
          if (run < j) out.push(s.slice(run, j));
          out.push('<strong>');
          inl(out, s, j + 2, k, env);
          out.push('</strong>');
          run = k + 2;
          INLINE_SPECIAL.lastIndex = run;
          continue;
        }
        INLINE_SPECIAL.lastIndex = j + 2;
        continue;
      }
      const k = findSingleStar(s, j + 1, b);
      if (k > j + 1) {
        if (run < j) out.push(s.slice(run, j));
        out.push('<em>');
        inl(out, s, j + 1, k, env);
        out.push('</em>');
        run = k + 1;
        INLINE_SPECIAL.lastIndex = run;
        continue;
      }
      INLINE_SPECIAL.lastIndex = j + 1;
      continue;
    }
    // '[': a link when ] is followed at once by (target) with a non-empty, whitespace-free target
    const k = findUnesc(s, ']', j + 1, b);
    let q = -1;
    if (k !== -1 && s.charCodeAt(k + 1) === 40) {
      const r = s.indexOf(')', k + 2);
      if (r !== -1 && r < b) q = r;
    }
    if (q !== -1) {
      const target = s.slice(k + 2, q);
      if (target !== '' && !/\s/.test(target)) {
        if (run < j) out.push(s.slice(run, j));
        out.push('<a href="');
        out.push(escStr(env.link(target)));
        out.push('">');
        inl(out, s, j + 1, k, env);
        out.push('</a>');
        run = q + 1;
        INLINE_SPECIAL.lastIndex = run;
        continue;
      }
    }
    INLINE_SPECIAL.lastIndex = j + 1;
  }
  if (run < b) out.push(s.slice(run, b));
  INLINE_SPECIAL.lastIndex = 0;
}

/** A fence opening at body[p..e): its language, or null. */
function fenceOpen(body, p, e) {
  if (body.charCodeAt(p) !== 96 || body.charCodeAt(p + 1) !== 96 || body.charCodeAt(p + 2) !== 96) return null;
  let j = p + 3;
  const langStart = j;
  while (j < e) {
    const c = body.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const lang = body.slice(langStart, j);
  while (j < e && (body.charCodeAt(j) === 32 || body.charCodeAt(j) === 9)) j++;
  return j === e ? lang : null;
}

/** Whether the line body[p..e) closes a fence: three backticks, then spaces or tabs only. */
function fenceClose(body, p, e) {
  if (body.charCodeAt(p) !== 96 || body.charCodeAt(p + 1) !== 96 || body.charCodeAt(p + 2) !== 96) return false;
  for (let j = p + 3; j < e; j++) {
    const c = body.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text range, or null (a heading's text is never empty). */
function headingOf(body, p, e) {
  let k = 0;
  while (k < 6 && p + k < e && body.charCodeAt(p + k) === 35) k++;
  if (k === 0 || p + k >= e) return null;
  const c = body.charCodeAt(p + k);
  if (c !== 32 && c !== 9) return null;
  let start = p + k;
  while (start < e && (body.charCodeAt(start) === 32 || body.charCodeAt(start) === 9)) start++;
  let end = e;
  while (end > start && (body.charCodeAt(end - 1) === 32 || body.charCodeAt(end - 1) === 9)) end--;
  if (start === end) return null;
  return { depth: k, start, end };
}

/** Whether the line body[p..e) is a thematic break: --- or ***, then spaces or tabs only. */
function isHR(body, p, e) {
  if (e - p < 3) return false;
  const a = body.charCodeAt(p);
  const b = body.charCodeAt(p + 1);
  const c = body.charCodeAt(p + 2);
  if (!((a === 45 && b === 45 && c === 45) || (a === 42 && b === 42 && c === 42))) return false;
  for (let j = p + 3; j < e; j++) {
    const d = body.charCodeAt(j);
    if (d !== 32 && d !== 9) return false;
  }
  return true;
}

/** Whether the line body[p..e) ends a paragraph: blank, fence, heading or thematic break.
 *  One scan: blank lines and indented text start with a space or tab, fences with a backtick,
 *  headings with '#', breaks with '-' or '*'; anything else cannot end a paragraph. */
function lineKind(body, p, e) {
  if (p === e) return 0;
  const c0 = body.charCodeAt(p);
  if (c0 === 32 || c0 === 9) {
    let i = p;
    while (i < e && (body.charCodeAt(i) === 32 || body.charCodeAt(i) === 9)) i++;
    return i === e ? 0 : 4;
  }
  if (c0 === 96) return fenceOpen(body, p, e) !== null ? 1 : 4;
  if (c0 === 35) return headingOf(body, p, e) !== null ? 2 : 4;
  if (c0 === 45 || c0 === 42) return isHR(body, p, e) ? 3 : 4;
  return 4;
}

/** Whether the line body[p..e) ends a paragraph: blank, fence, heading or thematic break. */
function endsPara(body, p, e) {
  return lineKind(body, p, e) !== 4;
}

/** The line body[p..e) trimmed of spaces and tabs at both ends, as [start, end). */
function trimRange(body, p, e) {
  let s = p;
  let t = e;
  while (s < t && (body.charCodeAt(s) === 32 || body.charCodeAt(s) === 9)) s++;
  while (t > s && (body.charCodeAt(t - 1) === 32 || body.charCodeAt(t - 1) === 9)) t--;
  return [s, t];
}

/** A bullet list item at body[p..e): its text start, or -1. */
function bulletAt(body, p, e) {
  const c = body.charCodeAt(p);
  if ((c === 45 || c === 42) && body.charCodeAt(p + 1) === 32) return p + 2;
  return -1;
}

/** An ordered list item at body[p..e): { start, textStart }, or null. */
function orderedAt(body, p, e) {
  let d = 0;
  while (d < 9 && p + d < e) {
    const c = body.charCodeAt(p + d);
    if (c < 48 || c > 57) break;
    d++;
  }
  if (d === 0 || body.charCodeAt(p + d) !== 46 || body.charCodeAt(p + d + 1) !== 32) return null;
  return { start: Number(body.slice(p, p + d)), textStart: p + d + 2 };
}

/** Whether the line body[p..e) continues a list item: two or more spaces, then a non-space. */
function continuedAt(body, p, e) {
  let n = 0;
  while (p + n < e && body.charCodeAt(p + n) === 32) n++;
  if (n < 2 || p + n >= e) return false;
  return !isWSCode(body.charCodeAt(p + n));
}

/** Render the inline HTML of the lines' texts joined by "\n" into a string. */
function inlineJoined(parts, env) {
  const text = parts.join('\n');
  const out = [];
  inl(out, text, 0, text.length, env);
  return out.join('');
}

/**
 * `body` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of
 * contents (every level 2 and 3 heading: level, id and its inline HTML) and its excerpt (the
 * first paragraph's inline HTML, or "").
 */
function renderMarkdown(body, env) {
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  const n = body.length;
  let pos = 0;
  while (pos < n) {
    let e = body.indexOf('\n', pos);
    if (e === -1) e = n;
    const kind = lineKind(body, pos, e);
    if (kind === 0) {
      pos = e + 1;
      continue;
    }
    if (kind === 1) {
      const lang = fenceOpen(body, pos, e);
      out.push(lang === '' ? '<pre><code>' : `<pre><code class="language-${lang}">`);
      pos = e + 1;
      while (pos < n) {
        e = body.indexOf('\n', pos);
        if (e === -1) e = n;
        if (fenceClose(body, pos, e)) {
          pos = e + 1;
          break;
        }
        escInto(out, body, pos, e);
        out.push('\n');
        pos = e + 1;
      }
      out.push('</code></pre>\n');
      continue;
    }
    if (kind === 2) {
      const hd = headingOf(body, pos, e);
      const id = uniqueSlug(slugify(body.slice(hd.start, hd.end)), ids);
      const inner = [];
      inl(inner, body, hd.start, hd.end, env);
      const html = inner.join('');
      out.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>\n`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      pos = e + 1;
      continue;
    }
    if (kind === 3) {
      out.push('<hr>\n');
      pos = e + 1;
      continue;
    }
    if (body.charCodeAt(pos) === 62) {
      // blockquote: the lines opening on '>', each with the '>' and one space after it dropped
      const parts = [];
      while (pos < n) {
        e = body.indexOf('\n', pos);
        if (e === -1) e = n;
        if (body.charCodeAt(pos) !== 62) break;
        let s = pos + 1;
        if (body.charCodeAt(s) === 32) s++;
        const [ts, te] = trimRange(body, s, e);
        if (ts < te) parts.push(body.slice(ts, te));
        pos = e + 1;
      }
      if (parts.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else out.push(`<blockquote>\n<p>${inlineJoined(parts, env)}</p>\n</blockquote>\n`);
      continue;
    }
    const bStart = bulletAt(body, pos, e);
    const oStart = bStart === -1 ? orderedAt(body, pos, e) : null;
    if (bStart !== -1 || oStart !== null) {
      const isOrdered = oStart !== null;
      const start = isOrdered ? oStart.start : 1;
      const items = [];
      while (pos < n) {
        e = body.indexOf('\n', pos);
        if (e === -1) e = n;
        let m = -1;
        if (isOrdered) {
          const o = orderedAt(body, pos, e);
          if (o !== null) m = o.textStart;
        } else m = bulletAt(body, pos, e);
        if (m !== -1) {
          const [ts, te] = trimRange(body, m, e);
          items.push([body.slice(ts, te)]);
          pos = e + 1;
        } else if (continuedAt(body, pos, e)) {
          const [ts, te] = trimRange(body, pos, e);
          items[items.length - 1].push(body.slice(ts, te));
          pos = e + 1;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      out.push(isOrdered && start !== 1 ? `<ol start="${start}">\n` : `<${tag}>\n`);
      for (const parts of items) out.push(`<li>${inlineJoined(parts, env)}</li>\n`);
      out.push(`</${tag}>\n`);
      continue;
    }
    // paragraph: this line and the lines after it up to a blank line, a fence, a heading or a
    // thematic break, each trimmed, joined by "\n"
    const lines = [];
    {
      const [ts, te] = trimRange(body, pos, e);
      lines.push(body.slice(ts, te));
      pos = e + 1;
    }
    while (pos < n) {
      e = body.indexOf('\n', pos);
      if (e === -1) e = n;
      if (endsPara(body, pos, e)) break;
      const [ts, te] = trimRange(body, pos, e);
      lines.push(body.slice(ts, te));
      pos = e + 1;
    }
    const html = inlineJoined(lines, env);
    if (excerpt === null) excerpt = html;
    out.push(`<p>${html}</p>\n`);
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenizeTpl(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) {
      text += src.slice(i);
      break;
    }
    const nx = src[open + 1];
    if (nx !== '{' && nx !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (nx === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? n : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? n : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTpl(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenizeTpl(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : (parent.else ?? parent.then);
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's
 *  items joined by ", ", else "". */
function tv(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) s += ', ';
      s += tv(v[i]);
    }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function tr(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * A path's value as JavaScript source, read from the current scope: its first name from the
 * innermost loop that binds it (a `_v_` local), else from the page's values (`R`), with a
 * fallback to `R` when a loop variable a caller may have bound is not bound here; each next
 * name is an own property of the value so far (null-guarded, non-objects stop the walk).
 * `stack` is the enclosing for-variable names, innermost last; `lvSet` the loop-variable
 * names of the whole case (plus "loop").
 */
function pathExpr(path, stack, lvSet) {
  const first = path[0];
  let bound = false;
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i] === first) {
      bound = true;
      break;
    }
  }
  let base;
  if (bound || first === 'loop') base = `_v_${first}`;
  else if (lvSet.has(first)) base = `(_v_${first} !== undefined ? _v_${first} : R.${first})`;
  else base = `R.${first}`;
  for (let k = 1; k < path.length; k++) base = `((_t = ${base}) == null || typeof _t !== 'object' ? undefined : _t.${path[k]})`;
  return base;
}

/** `nodes` compiled to JavaScript source, appended to `code`. */
function genNodes(nodes, stack, lvSet, indexOfName, code) {
  for (const nd of nodes) {
    if (nd.kind === 'text') code.push(`out.push(${JSON.stringify(nd.text)});`);
    else if (nd.kind === 'var') code.push(`out.push(esc(tv(${pathExpr(nd.path, stack, lvSet)})));`);
    else if (nd.kind === 'raw') code.push(`out.push(tv(${pathExpr(nd.path, stack, lvSet)}));`);
    else if (nd.kind === 'if') {
      code.push(`if (tr(${pathExpr(nd.path, stack, lvSet)}) !== ${nd.not}) {`);
      genNodes(nd.then, stack, lvSet, indexOfName, code);
      code.push('}');
      if (nd.else !== null) {
        code.push('else {');
        genNodes(nd.else, stack, lvSet, indexOfName, code);
        code.push('}');
      }
    } else if (nd.kind === 'for') {
      const v = `_v_${nd.name}`;
      code.push(`{ const _xs = ${pathExpr(nd.path, stack, lvSet)}; if (Array.isArray(_xs)) { for (let _k = 0; _k < _xs.length; _k++) { const _sv = ${v}; ${v} = _xs[_k]; const _svl = _v_loop; _v_loop = { index: _k + 1, first: _k === 0, last: _k === _xs.length - 1, length: _xs.length };`);
      genNodes(nd.body, [...stack, nd.name], lvSet, indexOfName, code);
      code.push(`_v_loop = _svl; ${v} = _sv; } } }`);
    } else if (nd.kind === 'include') {
      const idx = indexOfName.get(nd.name);
      if (idx !== undefined) {
        const args = [...lvSet].map((n) => `_v_${n}`).join(', ');
        code.push(`if (d < 8) F[${idx}](out, R, F, d + 1, esc, tv, tr${args ? ', ' + args : ''});`);
      }
    }
  }
  return code;
}

/**
 * The parsed templates compiled to functions: each takes (out, R, F, d, esc, tv, tr, ...loop
 * bindings) and appends its rendering to out. Returns { F, byName, lvNames }.
 */
function compileTemplates(parsed) {
  const names = [...parsed.keys()];
  const indexOfName = new Map(names.map((n, i) => [n, i]));
  const lvSet = new Set(['loop']);
  const walk = (nodes) => {
    for (const nd of nodes) {
      if (nd.kind === 'for') {
        lvSet.add(nd.name);
        walk(nd.body);
      } else if (nd.kind === 'if') {
        walk(nd.then);
        if (nd.else) walk(nd.else);
      }
    }
  };
  for (const nodes of parsed.values()) walk(nodes);
  const lvNames = [...lvSet];
  const params = lvNames.map((n) => `_v_${n}`).join(', ');
  const fns = new Array(names.length);
  for (let i = 0; i < names.length; i++) {
    const code = [`function(out, R, F, d, esc, tv, tr${params ? ', ' + params : ''}) {\nlet _t;\n`];
    genNodes(parsed.get(names[i]), [], lvSet, indexOfName, code);
    code.push('}');
    fns[i] = new Function(`return ${code.join('')}`)();
  }
  return { F: fns, byName: new Map(names.map((n, i) => [n, fns[i]])), lvNames };
}

// ---------------------------------------------------------------- links and paths

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

// ---------------------------------------------------------------- the build

/** One site's output tree: path -> text. */
export function run(input) {
  const output = {};
  const report = [];
  const broken = new Set();
  const base = input.site.base_url.replace(/\/+$/, '');

  // Templates, parsed in code-unit order of name; one that does not parse is left out.
  const names = Object.keys(input.templates).sort();
  const parsed = new Map();
  for (const name of names) {
    try {
      parsed.set(name, parseTpl(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const { F, byName, lvNames } = compileTemplates(parsed);
  const lvUndef = new Array(lvNames.length).fill(undefined);

  // Sources, in code-unit order of path; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push(f);
  }

  // Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!byName.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, each source's body rendered to HTML, its links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest date first, and equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => (y.data.date < x.data.date ? -1 : y.data.date > x.data.date ? 1 : 0) || (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by slug, each named as first met in the posts' order, ordered by count.
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    const seen = new Set();
    for (const name of p.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    const seen = new Set();
    s.tagRefs = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      s.tagRefs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0));

  // Cards, pages and rendering.
  const linkOf = (s) =>
    s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
  const cardCache = new Map();
  const cardOf = (s) => {
    let c = cardCache.get(s);
    if (c === undefined) {
      c = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
      cardCache.set(s, c);
    }
    return c;
  };
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p));
  // One root-values object per case, its page/posts/pager/tag fields rewritten (never deleted,
  // so its shape stays stable) for each render.
  const R = { site, tags: allTags, recent, page: undefined, posts: undefined, pager: undefined, tag: undefined };
  const render = (name, page, posts, pager, tag) => {
    const fn = byName.get(name);
    if (fn === undefined) return null;
    const out = [];
    R.page = page;
    R.posts = posts;
    R.pager = pager;
    R.tag = tag;
    fn(out, R, F, 0, escStr, tv, tr, ...lvUndef);
    return out.join('');
  };

  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, pageOf(s), undefined, undefined, undefined);
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render(
      'index',
      undefined,
      posts.slice((k - 1) * per, k * per).map((p) => cardOf(p)),
      { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
      undefined,
    );
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', undefined, undefined, undefined, { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', undefined, undefined, undefined, undefined);
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not parse, sorted,
  // then the counts.
  const lines = [...report, ...broken].sort();
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
