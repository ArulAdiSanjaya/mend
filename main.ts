// mend — one patch tool for every AI edit format.
//
// Node 22, standard library only. SPEC.md (version 1) is the whole contract:
//   node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// The working directory is the root of a tree of text files. mend reads a
// patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A,
// JSON text-editor tool calls), finds the lines each edit names at the first
// of three matching tiers, and writes every change or none, printing what it
// changed or why it failed.
//
// Matching tiers (section 5): tier 0 compares lines exactly, tier 1 ignores
// trailing spaces and tabs, tier 2 ignores leading and trailing spaces and
// tabs. At tier 2, added lines are re-indented from the patch's indentation
// to the file's own. --strict tries tier 0 only.
//
// A check is one run in a fresh directory: exit code, stdout and every file
// afterwards must match SPEC.md exactly. Standard error is never compared.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 answer: one line, nothing written. */
class ParseError {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit's failure: a code and the path it concerns. */
class EditFailure {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Section 3: a path is safe when it is not empty, does not start with `/`,
 *  holds no `\`, and none of its `/`-separated segments is empty, `.` or `..`. */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const isWsOnly = (s: string): boolean => /^[ \t]*$/.test(s);

/** Section 3: a file's line break, its lines and whether it ends with a break. */
interface TextFile {
  br: string;
  lines: string[];
  finalBreak: boolean;
}

function readTextFile(text: string): TextFile {
  if (text === '') return { br: '\n', lines: [], finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { br, lines: parts, finalBreak };
}

function writeTextFile(f: TextFile): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

/** The tree as the edits leave it: `now` overlays what the disk holds
 *  (null: deleted), `moves` remembers the move edits that succeeded, so the
 *  report can print `R old -> new` for them. */
class Tree {
  private readonly disk = new Map<string, string | null>();
  private readonly dirs = new Set<string>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];

  private readDisk(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        const st = statSync(p);
        if (st.isFile()) v = readFileSync(p, 'utf8');
        else if (st.isDirectory()) this.dirs.add(p);
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p) as string | null;
  }

  original(p: string): string | null {
    return this.readDisk(p);
  }

  get(p: string): string | null {
    return this.now.has(p) ? (this.now.get(p) as string | null) : this.readDisk(p);
  }

  /** True when the path exists in the tree as a file or as a directory:
   *  a directory at the path means a creation or a move target fails with
   *  `exists` instead of crashing the write phase (SPEC section 2: the new
   *  path does not exist, else `exists`). */
  exists(p: string): boolean {
    if (this.now.has(p)) return this.now.get(p) !== null;
    this.readDisk(p);
    return this.disk.get(p) !== null || this.dirs.has(p);
  }

  /** True when a proper ancestor of `p` is a file in the tree as the edits
   *  have left it: a file at an ancestor blocks any file below it, so a
   *  creation or a move to `p` fails with `exists` (SPEC section 2) instead
   *  of crashing the write phase creating the parent directory. A path
   *  whose ancestor was deleted by an earlier edit is not blocked: the
   *  ancestor is gone from the tree, so the directory can be created. */
  hasFileAncestor(p: string): boolean {
    const parts = p.split('/');
    let prefix = '';
    for (let k = 0; k < parts.length - 1; k++) {
      prefix = prefix === '' ? (parts[k] as string) : `${prefix}/${parts[k] as string}`;
      if (this.get(prefix) !== null) return true;
    }
    return false;
  }
}

/** An edit: applied to the tree, or throws EditFailure and changes nothing. */
type Edit = (tree: Tree, strict: boolean) => void;

// ---------------------------------------------------------------------------
// Section 5: matching lines
// ---------------------------------------------------------------------------

function lineMatches(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** Every 0-based position where O occurs in `lines` at this tier, from `from` on. */
function occurrencesAt(oldLines: string[], lines: string[], tier: number, from: number): number[] {
  const found: number[] = [];
  if (oldLines.length === 0) return found;
  for (let i = from; i + oldLines.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (!lineMatches(oldLines[j] as string, lines[i + j] as string, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) found.push(i);
  }
  return found;
}

/** The first tier at which O occurs at least once (tier 0 only when strict). */
function firstTierWith(
  oldLines: string[],
  lines: string[],
  strict: boolean,
  from: number,
): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const at = occurrencesAt(oldLines, lines, tier, from);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** One line of N: a context line is written as the file's own matched line
 *  (oldIndex into O); any other line is new text, re-indented at tier 2. */
interface OutLine {
  ctx: boolean;
  oldIndex: number;
  text: string;
}

function reindentLine(text: string, oldFirst: string, fileFirst: string): string {
  if (isWsOnly(text)) return text;
  const p = leadWs(oldFirst);
  const f = leadWs(fileFirst);
  return text.startsWith(p) ? f + text.slice(p.length) : text;
}

/** Replace the k matched lines at `pos` with N, context lines from the file. */
function spliceLines(
  lines: string[],
  oldLines: string[],
  out: OutLine[],
  pos: number,
  tier: number,
): string[] {
  const next = lines.slice(0, pos);
  for (const o of out) {
    if (o.ctx) next.push(lines[pos + o.oldIndex] as string);
    else if (tier === 2) next.push(reindentLine(o.text, oldLines[0] as string, lines[pos] as string));
    else next.push(o.text);
  }
  for (let i = pos + oldLines.length; i < lines.length; i++) next.push(lines[i] as string);
  return next;
}

// ---------------------------------------------------------------------------
// Section 4: detecting the format
// ---------------------------------------------------------------------------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if ((lines[first] as string).trim() === '*** Begin Patch') return 'v4a';
  const c = (lines[first] as string).trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs
// ---------------------------------------------------------------------------

interface Hunk {
  start: number; // A in @@ -A[,B] +C[,D] @@
  oldLines: string[];
  newLines: OutLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noNewline: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  noNewlinePlus: boolean;
}

interface UnifiedSection {
  oldPath: string | null | undefined;
  newPath: string | null | undefined;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` / `+++ `: up to the first tab, spaces removed,
 *  `/dev/null` is no file, a leading `a/` or `b/` is removed. */
function dashPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

/** Read one hunk body starting at `i` (the line after the header).
 *  Returns the index after the body. */
function parseHunkBody(lines: string[], i: number, hunk: Hunk): number {
  const n = lines.length;
  const body: string[] = [];
  while (i < n) {
    const l = lines[i] as string;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      i++;
    } else break;
  }
  // Empty lines at the end of a body are not part of it.
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const l = body[k] as string;
    if (l === '') {
      hunk.oldLines.push('');
      hunk.newLines.push({ ctx: true, oldIndex: hunk.oldLines.length - 1, text: '' });
      lastCtxPlus = k;
    } else if (l[0] === ' ') {
      const t = l.slice(1);
      hunk.oldLines.push(t);
      hunk.newLines.push({ ctx: true, oldIndex: hunk.oldLines.length - 1, text: t });
      lastCtxPlus = k;
    } else if (l[0] === '-') {
      hunk.oldLines.push(l.slice(1));
    } else if (l[0] === '+') {
      hunk.newLines.push({ ctx: false, oldIndex: -1, text: l.slice(1) });
      lastCtxPlus = k;
      lastPlus = k;
    }
    // A `\` line refers to the body line before it; only its position
    // against the last context/`+` line matters, checked below.
  }
  const follows = (k: number): boolean =>
    k >= 0 && k + 1 < body.length && (body[k + 1] as string)[0] === '\\';
  hunk.noNewline = follows(lastCtxPlus);
  hunk.noNewlinePlus = follows(lastPlus);
  return i;
}

/** Parse one section's header and hunks starting at `i`. Returns the index
 *  after the section: the next section's start, or the end of the patch. */
function parseUnifiedSection(lines: string[], i: number, sec: UnifiedSection): number {
  const n = lines.length;
  let dashOld: string | null | undefined;
  let dashNew: string | null | undefined;
  let renOld: string | undefined;
  let renNew: string | undefined;
  let hadPair = false;
  let inHunks = false;
  while (i < n) {
    const l = lines[i] as string;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('@@')) {
      const m = HUNK_HEAD.exec(l);
      if (m === null) throw new ParseError(`error: parse ${i + 1}`);
      const hunk: Hunk = { start: Number(m[1]), oldLines: [], newLines: [], noNewline: false, noNewlinePlus: false };
      i = parseHunkBody(lines, i + 1, hunk);
      sec.hunks.push(hunk);
      inHunks = true;
      continue;
    }
    if (!inHunks) {
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (hadPair) break; // a second pair starts a new section
          dashOld = dashPath(l);
          dashNew = dashPath(lines[i + 1] as string);
          hadPair = true;
          i += 2;
          continue;
        }
        throw new ParseError(`error: parse ${i + 2}`);
      }
      if (l.startsWith('+++ ')) {
        dashNew = dashPath(l);
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        renOld = l.slice(12).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        renNew = l.slice(10).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        sec.creation = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        sec.deletion = true;
        i++;
        continue;
      }
      // index, old mode, new mode, similarity index, dissimilarity index,
      // Index: and any other line are ignored.
      i++;
      continue;
    }
    // After the first hunk: a `--- ` line followed by `+++ ` starts a new
    // section; every other line outside a body is ignored (prose, fences).
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    i++;
  }
  // The `---`/`+++` pair names the paths; else rename from/to; else diff --git.
  sec.oldPath = dashOld !== undefined ? dashOld : renOld !== undefined ? renOld : sec.oldPath;
  sec.newPath = dashNew !== undefined ? dashNew : renNew !== undefined ? renNew : sec.newPath;
  return i;
}

function parseUnified(lines: string[]): Edit[] {
  const sections: UnifiedSection[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i] as string;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(l);
      if (m === null) throw new ParseError(`error: parse ${i + 1}`);
      const sec: UnifiedSection = {
        oldPath: m[1] as string,
        newPath: m[2] as string,
        creation: false,
        deletion: false,
        hunks: [],
      };
      i = parseUnifiedSection(lines, i + 1, sec);
      sections.push(sec);
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: UnifiedSection = {
        oldPath: undefined,
        newPath: undefined,
        creation: false,
        deletion: false,
        hunks: [],
      };
      i = parseUnifiedSection(lines, i, sec);
      sections.push(sec);
    } else if (l.startsWith('@@')) {
      // SPEC section 6: any other line starting with `@@` is a parse error,
      // and so is a hunk before any section.
      throw new ParseError(`error: parse ${i + 1}`);
    } else {
      i++;
    }
  }
  return sections.map(unifiedEdit);
}

/** Apply one section's hunks to a file's lines, tracking the line drift d. */
function applyHunks(
  text: string,
  hunks: Hunk[],
  strict: boolean,
  path: string,
): string {
  let f = readTextFile(text);
  let d = 0;
  for (const h of hunks) {
    if (h.oldLines.length === 0) {
      const at = Math.min(Math.max(h.start + d, 0), f.lines.length);
      const added = h.newLines.filter((o) => !o.ctx).map((o) => o.text);
      const next = [...f.lines.slice(0, at), ...added, ...f.lines.slice(at)];
      const finalBreak = at === f.lines.length ? !h.noNewline : f.finalBreak;
      f = { br: f.br, lines: next, finalBreak };
    } else {
      const found = firstTierWith(h.oldLines, f.lines, strict, 0);
      if (found === null) throw new EditFailure('no-match', path);
      const target = h.start - 1 + d;
      let pos = found.at[0] as number;
      let best = Math.abs(pos - target);
      for (const p of found.at) {
        const dist = Math.abs(p - target);
        if (dist < best) {
          best = dist;
          pos = p;
        }
      }
      const next = spliceLines(f.lines, h.oldLines, h.newLines, pos, found.tier);
      const runsToEnd = pos + h.oldLines.length === f.lines.length;
      const finalBreak = runsToEnd ? !h.noNewline : f.finalBreak;
      f = { br: f.br, lines: next, finalBreak };
    }
    d += h.newLines.length - h.oldLines.length;
  }
  return writeTextFile(f);
}

function unifiedEdit(sec: UnifiedSection): Edit {
  return (tree, strict) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && oldP !== undefined && !isSafePath(oldP)) throw new EditFailure('unsafe', oldP);
    if (newP !== null && newP !== undefined && !isSafePath(newP)) throw new EditFailure('unsafe', newP);
    const isCreation = sec.creation || oldP === null;
    const isDeletion = !isCreation && (sec.deletion || newP === null);
    if (isCreation) {
      // Both paths /dev/null: a creation of no file. The section names no
      // file to create, so the edit changes nothing (SPEC section 6 lists
      // creation first; /dev/null means no file, so there is nothing to
      // write and no path to report).
      if (newP === null || newP === undefined) return;
      const p = newP as string;
      if (tree.exists(p)) throw new EditFailure('exists', p);
      if (tree.hasFileAncestor(p)) throw new EditFailure('exists', p);
      const added: string[] = [];
      for (const h of sec.hunks) {
        for (const o of h.newLines) if (!o.ctx) added.push(o.text);
      }
      let noBreak = false;
      for (let k = sec.hunks.length - 1; k >= 0; k--) {
        const h = sec.hunks[k] as Hunk;
        if (h.newLines.some((o) => !o.ctx)) {
          noBreak = h.noNewlinePlus;
          break;
        }
      }
      tree.now.set(p, added.length === 0 ? '' : added.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (isDeletion) {
      const p = oldP as string;
      if (tree.get(p) === null) throw new EditFailure('missing', p);
      tree.now.set(p, null);
      return;
    }
    const isMove = (oldP as string) !== (newP as string);
    if (isMove) {
      const p = oldP as string;
      const q = newP as string;
      const text = tree.get(p);
      if (text === null) throw new EditFailure('missing', p);
      if (tree.exists(q)) throw new EditFailure('exists', q);
      if (tree.hasFileAncestor(q)) throw new EditFailure('exists', q);
      const out = applyHunks(text, sec.hunks, strict, p);
      tree.now.set(p, null);
      tree.now.set(q, out);
      tree.moves.push([p, q]);
      return;
    }
    const p = oldP as string;
    const text = tree.get(p);
    if (text === null) throw new EditFailure('missing', p);
    tree.now.set(p, applyHunks(text, sec.hunks, strict, p));
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks
// ---------------------------------------------------------------------------

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return (tree, strict) => {
    if (!isSafePath(path)) throw new EditFailure('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.exists(path)) throw new EditFailure('exists', path);
      if (tree.hasFileAncestor(path)) throw new EditFailure('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new EditFailure('missing', path);
    const f = readTextFile(text);
    const found = firstTierWith(oldLines, f.lines, strict, 0);
    if (found === null) throw new EditFailure('no-match', path);
    if (found.at.length > 1) throw new EditFailure('ambiguous', path);
    const out = spliceLines(
      f.lines,
      oldLines,
      newLines.map((t) => ({ ctx: false, oldIndex: -1, text: t })),
      found.at[0] as number,
      found.tier,
    );
    tree.now.set(path, writeTextFile({ br: f.br, lines: out, finalBreak: f.finalBreak }));
  };
}

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0; // index after the previous block's >>>>>>> REPLACE line
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if ((lines[i] as string).trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    // The path is the nearest line before SEARCH, after the previous block,
    // that is not blank and does not start with three backticks.
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j] as string;
      if (isBlank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseError(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let j = i + 1;
    const oldLines: string[] = [];
    let foundEq = false;
    while (j < n) {
      if ((lines[j] as string).trimEnd() === '=======') {
        foundEq = true;
        j++;
        break;
      }
      oldLines.push(lines[j] as string);
      j++;
    }
    if (!foundEq) throw new ParseError(`error: parse ${searchLine}`);
    const newLines: string[] = [];
    let foundEnd = false;
    while (j < n) {
      if ((lines[j] as string).trimEnd() === '>>>>>>> REPLACE') {
        foundEnd = true;
        j++;
        break;
      }
      newLines.push(lines[j] as string);
      j++;
    }
    if (!foundEnd) throw new ParseError(`error: parse ${searchLine}`);
    prevEnd = j;
    prevPath = path;
    edits.push(searchReplaceEdit(path, oldLines, newLines));
    i = j;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null; // null: no anchor
  eof: boolean;
  body: string[]; // raw body lines, trailing blank lines trimmed at section end
}

function chunkLines(chunk: VChunk): { oldLines: string[]; newLines: OutLine[] } {
  const oldLines: string[] = [];
  const newLines: OutLine[] = [];
  for (const l of chunk.body) {
    if (l === '' || l[0] === ' ') {
      // An empty line, or a line starting with a space, is a context line.
      const t = l === '' ? '' : l.slice(1);
      oldLines.push(t);
      newLines.push({ ctx: true, oldIndex: oldLines.length - 1, text: t });
    } else if (l[0] === '-') {
      oldLines.push(l.slice(1));
    } else if (l[0] === '+') {
      newLines.push({ ctx: false, oldIndex: -1, text: l.slice(1) });
    }
  }
  return { oldLines, newLines };
}

const V4A_HEADERS = ['*** Add File:', '*** Delete File:', '*** Update File:'];
const isV4aHeader = (l: string): boolean => V4A_HEADERS.some((h) => l.startsWith(h));

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFailure('unsafe', path);
    if (tree.exists(path)) throw new EditFailure('exists', path);
    if (tree.hasFileAncestor(path)) throw new EditFailure('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFailure('unsafe', path);
    if (tree.get(path) === null) throw new EditFailure('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[]): Edit {
  return (tree, strict) => {
    if (!isSafePath(path)) throw new EditFailure('unsafe', path);
    if (moveTo !== null && !isSafePath(moveTo)) throw new EditFailure('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new EditFailure('missing', path);
    if (moveTo !== null && tree.exists(moveTo)) throw new EditFailure('exists', moveTo);
    if (moveTo !== null && tree.hasFileAncestor(moveTo)) throw new EditFailure('exists', moveTo);
    let f = readTextFile(text);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        // First line at or after the cursor equal to the anchor, at the
        // first tier where one is; a single line on both sides.
        const found = firstTierWith([chunk.anchor], f.lines, strict, cursor);
        if (found === null) throw new EditFailure('no-match', path);
        cursor = (found.at[0] as number) + 1;
      }
      const { oldLines, newLines } = chunkLines(chunk);
      if (oldLines.length === 0) {
        const at = chunk.eof ? f.lines.length : cursor;
        const added = newLines.filter((o) => !o.ctx).map((o) => o.text);
        f = {
          br: f.br,
          lines: [...f.lines.slice(0, at), ...added, ...f.lines.slice(at)],
          finalBreak: f.finalBreak,
        };
        cursor = at + added.length;
      } else {
        const found = firstTierWith(oldLines, f.lines, strict, cursor);
        if (found === null) throw new EditFailure('no-match', path);
        let at = found.at;
        if (chunk.eof) at = at.filter((p) => p + oldLines.length === f.lines.length);
        if (at.length === 0) throw new EditFailure('no-match', path);
        const pos = at[0] as number;
        const next = spliceLines(f.lines, oldLines, newLines, pos, found.tier);
        f = { br: f.br, lines: next, finalBreak: f.finalBreak };
        cursor = pos + newLines.length;
      }
    }
    const out = writeTextFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

/** Parse one V4A section starting at `i` (its header line). Returns the
 *  index after the section. */
function parseV4aSection(lines: string[], i: number, end: number, edits: Edit[]): number {
  const header = lines[i] as string;
  const headerLine = i + 1;
  if (header.startsWith('*** Add File:')) {
    const path = header.slice('*** Add File:'.length).trim();
    i++;
    const fileLines: string[] = [];
    while (i < end) {
      const s = lines[i] as string;
      if (isV4aHeader(s)) break;
      if (s.startsWith('+')) {
        fileLines.push(s.slice(1));
        i++;
      } else if (s === '') {
        fileLines.push('');
        i++;
      } else if (isBlank(s)) {
        // A whitespace-only line is neither a '+' line nor an empty line
        // (SPEC s8), so it is a parse error — unless it is a blank line at
        // the end of the section, which is not part of it.
        let j = i + 1;
        while (j < end && isBlank(lines[j] as string)) j++;
        if (j >= end || isV4aHeader(lines[j] as string)) break;
        throw new ParseError(`error: parse ${i + 1}`);
      } else {
        throw new ParseError(`error: parse ${i + 1}`);
      }
    }
    while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
    edits.push(v4aAddEdit(path, fileLines));
    return i;
  }
  if (header.startsWith('*** Delete File:')) {
    const path = header.slice('*** Delete File:'.length).trim();
    i++;
    // A Delete File section has no lines; blank lines here are between sections.
    while (i < end && isBlank(lines[i] as string)) i++;
    if (i < end && !isV4aHeader(lines[i] as string)) throw new ParseError(`error: parse ${i + 1}`);
    edits.push(v4aDeleteEdit(path));
    return i;
  }
  // *** Update File:
  const path = header.slice('*** Update File:'.length).trim();
  i++;
  let moveTo: string | null = null;
  if (i < end && (lines[i] as string).startsWith('*** Move to:')) {
    moveTo = (lines[i] as string).slice('*** Move to:'.length).trim();
    i++;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  const isBodyLine = (l: string): boolean =>
    l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+';
  while (i < end) {
    const l = lines[i] as string;
    if (isV4aHeader(l)) break;
    // SPEC s8 grants surrounding-whitespace tolerance only to
    // *** Begin Patch and *** End Patch, so this line matches exactly.
    if (l === '*** End of File') {
      if (cur === null) throw new ParseError(`error: parse ${i + 1}`);
      cur.eof = true;
      cur = null;
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      chunks.push(cur);
      i++;
      continue;
    }
    if (isBlank(l) && cur === null && chunks.length > 0) {
      // Blank lines after a chunk ended (before the next chunk or section)
      // are not part of any chunk; skip them.
      i++;
      continue;
    }
    if (isBodyLine(l)) {
      if (cur === null) {
        if (chunks.length > 0) throw new ParseError(`error: parse ${i + 1}`);
        cur = { anchor: null, eof: false, body: [] };
        chunks.push(cur);
      }
      (cur as VChunk).body.push(l);
      i++;
      continue;
    }
    throw new ParseError(`error: parse ${i + 1}`);
  }
  // Blank lines at the end of a section (before the next section or
  // *** End Patch) are not part of it. A blank line before a chunk's
  // *** End of File is a body line of that chunk, not a blank at the end
  // of the section, so it is kept when the last chunk ends that way.
  if (chunks.length > 0 && !(chunks[chunks.length - 1] as VChunk).eof) {
    const last = chunks[chunks.length - 1] as VChunk;
    while (last.body.length > 0 && isBlank(last.body[last.body.length - 1] as string)) {
      last.body.pop();
    }
  }
  if (chunks.length === 0 && moveTo === null) {
    throw new ParseError(`error: parse ${headerLine}`);
  }
  edits.push(v4aUpdateEdit(path, moveTo, chunks));
  return i;
}

function parseV4a(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseError('error: parse 1');
  if ((lines[first] as string).trim() !== '*** Begin Patch') {
    throw new ParseError(`error: parse ${first + 1}`);
  }
  let last = lines.length - 1;
  while (last >= 0 && isBlank(lines[last] as string)) last--;
  if (last < 0 || (lines[last] as string).trim() !== '*** End Patch') {
    throw new ParseError(`error: parse ${lines.length + 1}`);
  }
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i] as string;
    if (isBlank(l)) {
      i++;
      continue;
    }
    if (!isV4aHeader(l)) throw new ParseError(`error: parse ${i + 1}`);
    i = parseV4aSection(lines, i, last, edits);
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits
// ---------------------------------------------------------------------------

/** One JSON edit object, or null when it is not one: a wrong command, or a
 *  missing or mistyped key, is a parse fault. */
function jsonEditObject(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;
  const readExisting = (tree: Tree): string => {
    if (!isSafePath(p)) throw new EditFailure('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new EditFailure('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafePath(p)) throw new EditFailure('unsafe', p);
      if (tree.exists(p)) throw new EditFailure('exists', p);
      if (tree.hasFileAncestor(p)) throw new EditFailure('exists', p);
      tree.now.set(p, text); // file_text is written byte for byte
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = readExisting(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count++;
      if (count === 0) throw new EditFailure('no-match', p);
      if (count > 1) throw new EditFailure('ambiguous', p);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + toLf(newStr) + text.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = splitPatch(o.new_str);
    return (tree) => {
      const before = readExisting(tree);
      const f = readTextFile(before);
      if (line < 0 || line > f.lines.length) throw new EditFailure('no-match', p);
      const next = [...f.lines.slice(0, line), ...add, ...f.lines.slice(line)];
      tree.now.set(p, writeTextFile({ br: f.br, lines: next, finalBreak: f.finalBreak }));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseError('error: parse 1');
  const edits: Edit[] = [];
  if ((lines[first] as string).trimStart().startsWith('[')) {
    // One JSON array of edit objects; any fault is at the array's first line.
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseError(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new ParseError(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEditObject(x);
      if (e === null) throw new ParseError(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  // JSON Lines: one edit object a line, blank lines ignored.
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEditObject(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseError(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function parsePatch(kind: string, text: string, lines: string[]): Edit[] {
  if (kind === 'unified') return parseUnified(lines);
  if (kind === 'search-replace') return parseSearchReplace(lines);
  if (kind === 'v4a') return parseV4a(lines);
  return parseJson(text, lines);
}

// ---------------------------------------------------------------------------
// Sections 1, 2 and 10: the command line, the output, order and atomicity
// ---------------------------------------------------------------------------

const byteOrder = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

function run(args: string[]): { code: number; out: string[] } {
  const usage = (): { code: number; out: string[] } => ({ code: 2, out: ['error: usage'] });
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) return usage();
        const v = a.slice(9);
        if (!FORMATS.includes(v)) return usage();
        format = v;
      } else if (a === '--check') {
        if (check) return usage();
        check = true;
      } else if (a === '--strict') {
        if (strict) return usage();
        strict = true;
      } else {
        return usage();
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return usage();
  const patchArg = pos.length === 0 || pos[0] === '-' ? null : (pos[0] as string);
  let text = '';
  try {
    text = readFileSync(patchArg ?? 0, 'utf8');
  } catch {
    if (patchArg !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = parsePatch(kind, text, lines);
    if (edits.length === 0) throw new ParseError('error: parse 1');
  } catch (e) {
    if (e instanceof ParseError) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFailure[] = [];
  for (const edit of edits) {
    // A failed edit changes nothing: roll the tree back to before it.
    const snapNow = new Map(tree.now);
    const snapMoves = [...tree.moves];
    try {
      edit(tree, strict);
    } catch (e) {
      if (!(e instanceof EditFailure)) throw e;
      tree.now.clear();
      for (const [k, v] of snapNow) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...snapMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [
        ...fails.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${fails.length} of ${edits.length} edits`,
      ],
    };
  }
  // One line per path whose state changed, in byte order of the paths. A
  // move edit prints `R old -> new` (sorted by the new path) instead of its
  // `D` and `A` pair. A file whose bytes are unchanged is not listed.
  const rows: Array<{ key: string; text: string }> = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p) as string | null;
    if (was === now) continue;
    if (was === null) rows.push({ key: p, text: `A ${p}` });
    else if (now === null) rows.push({ key: p, text: `D ${p}` });
    else rows.push({ key: p, text: `M ${p}` });
  }
  for (const [oldP, newP] of tree.moves) {
    const di = rows.findIndex((r) => r.text === `D ${oldP}`);
    const ai = rows.findIndex((r) => r.text === `A ${newP}`);
    if (di >= 0 && ai >= 0) {
      rows.splice(Math.max(di, ai), 1);
      rows.splice(Math.min(di, ai), 1);
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
    }
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  if (!check) {
    // Delete first, then write: a path may move into (or out of) a
    // directory another path of this patch occupied.
    const touched = [...tree.now.keys()].sort(byteOrder);
    for (const p of touched) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of touched) {
      const v = tree.now.get(p) as string | null;
      if (v === null) continue;
      if (tree.original(p) === v) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, v);
    }
  }
  return {
    code: 0,
    out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`],
  };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
