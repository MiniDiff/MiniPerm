'use strict';
// Deterministic text utilities for code location: string/comment masking, bracket matching to locate function boundaries,
// line-number conversion, regex-based parsing of aliases / package jumps, and webpack-style numeric module location.
// Purely text processing: no AST parser dependency and no LLM call — corresponding to scheme b)-ii)-3,
// "function slicing: for syntactically complete code this problem is deterministically solvable and needs no LLM".

/**
 * Decide whether the '/' at source[i] starts a regex literal or is a division / compound-assignment operator.
 * A general heuristic is used: skip whitespace backwards and look at the nearest non-whitespace character/keyword — if it is an operator, an opening bracket, a comma,
 * a semicolon, a colon, or a keyword such as return/typeof/case/in/of/instanceof/new/delete/void/throw/else/do/
 * yield/await (or the start of the file/statement), it is judged a regex start; if it is an identifier/number/`)`/`]`/`}`
 * or another "value end" position, it is judged a division operator. This is a classic ambiguity in JS lexical analysis; pure character scanning cannot reach
 * 100% accuracy (that would need full parsing), but this heuristic covers the vast majority of real code patterns.
 */
function isRegexLiteralStart(source, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(source[j])) j--;
  if (j < 0) return true;
  const c = source[j];
  if ('([{,;:=!&|?+-*%^~<>'.includes(c)) return true;
  if (/[A-Za-z0-9_$]/.test(c)) {
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(source[k])) k--;
    const word = source.slice(k + 1, j + 1);
    const keywords = [
      'return', 'typeof', 'case', 'in', 'of', 'instanceof', 'new', 'delete', 'void', 'throw',
      'else', 'do', 'yield', 'await',
    ];
    return keywords.includes(word);
  }
  return false;
}

/**
 * Starting from the '/' that opens the regex literal, find the offset of the matching '/' that truly ends the regex,
 * (that is, the '/' just before the regex flags that follow it). It handles correctly: backslash escapes, and an unescaped '/' inside a character class [...]
 * not counting as a terminator (this is precisely the key for real code like `var Mp = /[;/?:@&=+$,a-zA-Z0-9\-_.!~*'()#%]/;`,
 * where a character class containing both '/' and "'" must not be misread: without recognizing character-class boundaries, the '/' inside the class
 * would be misread as an early regex end, misaligning all subsequent character-class content and flag parsing).
 * Returns -1 when no matching terminator is found (the regex is unclosed, usually meaning a corrupt file or a heuristic misjudgment; the caller should abandon
 * this regex recognition and fall back to treating that '/' as an ordinary character, avoiding swallowing the rest of the file).
 */
function findRegexLiteralEnd(source, startIdx) {
  const n = source.length;
  let i = startIdx + 1;
  let inCharClass = false;
  while (i < n) {
    const c = source[i];
    if (c === '\n') return -1; // a regex literal cannot span lines; a newline means the start-point judgment was wrong
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '[') {
      inCharClass = true;
      i++;
      continue;
    }
    if (c === ']') {
      inCharClass = false;
      i++;
      continue;
    }
    if (c === '/' && !inCharClass) {
      return i;
    }
    i++;
  }
  return -1;
}

/**
 * Replace characters inside string literals / template strings / line comments / block comments / regex literals in the source
 * with spaces while preserving the overall length (newlines are kept as-is, so later line-based location still works).
 * Purpose: so that later bracket counting counts only "real structural brackets", undisturbed by { } inside strings/comments/regexes.
 *
 * Known limitations (a simplified implementation; stated honestly here):
 * 1. `${...}` interpolations inside template strings are also masked wholesale as string content, without recursively restoring their inner
 *    code semantics — in decompiled base-library code, top-level function/module boundaries rarely appear inside template-string interpolations,
 *    so this is an acceptable engineering trade-off.
 * 2. Regex-literal recognition is heuristic (see isRegexLiteralStart); in extreme cases (e.g. exotic
 *    custom operator-overloading syntax, ASI boundary ambiguity) it may misjudge, but this fixed the earlier "regex literals not recognized at all"
 *    problem, which was severe — real testing found that a character-class regex containing a single quote,
 *    `var Mp = /[;/?:@&=+$,a-zA-Z0-9\-_.!~*'()#%]/;`, made the old implementation treat almost the whole file from that point on
 *    as "inside a string" and mask it all to whitespace, so every anchor / function after that point
 *    failed to be sliced at all (reproduced on a large minified base-library file).
 */
function maskStringsAndComments(source) {
  const out = source.split('');
  const n = source.length;
  let i = 0;
  let state = 'code'; // code | sline | mline | sq | dq | tpl
  while (i < n) {
    const c = source[i];
    const c2 = i + 1 < n ? source[i + 1] : '';
    if (state === 'code') {
      if (c === '/' && c2 === '/') {
        state = 'sline';
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
        continue;
      }
      if (c === '/' && c2 === '*') {
        state = 'mline';
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
        continue;
      }
      if (c === '/' && isRegexLiteralStart(source, i)) {
        const endIdx = findRegexLiteralEnd(source, i);
        if (endIdx !== -1) {
          for (let k = i; k <= endIdx; k++) {
            if (source[k] !== '\n') out[k] = ' ';
          }
          let flagsEnd = endIdx + 1;
          while (flagsEnd < n && /[a-zA-Z]/.test(source[flagsEnd])) {
            out[flagsEnd] = ' ';
            flagsEnd++;
          }
          i = flagsEnd;
          continue;
        }
        // no matching terminator: abandon regex recognition and treat this '/' as an ordinary character, avoiding swallowing a whole file segment
      }
      if (c === "'") {
        state = 'sq';
        out[i] = ' ';
        i++;
        continue;
      }
      if (c === '"') {
        state = 'dq';
        out[i] = ' ';
        i++;
        continue;
      }
      if (c === '`') {
        state = 'tpl';
        out[i] = ' ';
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (state === 'sline') {
      if (c === '\n') {
        state = 'code';
        i++;
        continue;
      }
      out[i] = ' ';
      i++;
      continue;
    }
    if (state === 'mline') {
      if (c === '*' && c2 === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        state = 'code';
        i += 2;
        continue;
      }
      if (c !== '\n') out[i] = ' ';
      i++;
      continue;
    }
    if (state === 'sq' || state === 'dq') {
      const q = state === 'sq' ? "'" : '"';
      if (c === '\\') {
        out[i] = ' ';
        if (i + 1 < n) out[i + 1] = ' ';
        i += 2;
        continue;
      }
      if (c === q) {
        state = 'code';
        out[i] = ' ';
        i++;
        continue;
      }
      if (c !== '\n') out[i] = ' ';
      i++;
      continue;
    }
    if (state === 'tpl') {
      if (c === '\\') {
        out[i] = ' ';
        if (i + 1 < n) out[i + 1] = ' ';
        i += 2;
        continue;
      }
      if (c === '`') {
        state = 'code';
        out[i] = ' ';
        i++;
        continue;
      }
      if (c !== '\n') out[i] = ' ';
      i++;
      continue;
    }
    i++;
  }
  return out.join('');
}

/** Prebuild the per-line start offset array for binary-search line lookup, avoiding rescanning from the start each time (files can reach hundreds of thousands of lines). */
function buildLineIndex(source) {
  const offsets = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

/** Convert a character offset to a 1-based line number using the buildLineIndex() result. */
function lineOfOffset(lineIndex, charIndex) {
  let lo = 0;
  let hi = lineIndex.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineIndex[mid] <= charIndex) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans + 1;
}

/** Convert a 1-based line number to that line start character offset. */
function offsetOfLine(lineIndex, lineNumber) {
  const idx = lineNumber - 1;
  if (idx < 0 || idx >= lineIndex.length) return -1;
  return lineIndex[idx];
}

/**
 * In the masked source (strings/comments masked), do forward bracket matching from startIdx (the position of a '{'),
 * returning the position of the matching '}'; returns -1 if not found.
 */
function matchForwardBrace(masked, startIdx) {
  let bal = 1;
  for (let i = startIdx + 1; i < masked.length; i++) {
    const c = masked[i];
    if (c === '{') bal++;
    else if (c === '}') {
      bal--;
      if (bal === 0) return i;
    }
  }
  return -1;
}

/**
 * Search backwards from charIndex for the "nearest unmatched {", i.e. the opening bracket of the innermost block containing that position.
 * Then match forward to obtain the block complete {startIndex, endIndex} (both character offsets on the masked source,
 * with the same length as the original source, so they can be used directly with source.slice).
 */
function findEnclosingBlockAt(masked, charIndex) {
  let depth = 0;
  let openIdx = -1;
  const from = Math.min(charIndex, masked.length - 1);
  for (let i = from; i >= 0; i--) {
    const c = masked[i];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) {
        openIdx = i;
        break;
      }
      depth--;
    }
  }
  if (openIdx === -1) return null;
  const closeIdx = matchForwardBrace(masked, openIdx);
  if (closeIdx === -1) return null;
  return { startIndex: openIdx, endIndex: closeIdx };
}

/**
 * Search forward for a "declarative code block": for cases where the anchor lands right on a function name / declaration keyword (e.g. a function-name anchor hitting
 * `<baseline-locate-API>` inside `function <baseline-locate-API>`, where the anchor is before the '{' rather than inside the block).
 * Scan forward from charIndex to the nearest top-level '{', disallowing any top-level ';' / '}' /
 * reopen-without-close situation along the way (a bracket stack enforces "()" pairing, avoiding mistaking the literal braces in a defaulted parameter `(a = {})`
 * for the start of the function body); if none is found within maxLookahead it is deemed not applicable and returns null,
 * leaving the caller to fall back to findEnclosingBlockAt() backward search mode (for cases where the anchor is already inside a block,
 * such as a string anchor or a scope-mapping-table anchor).
 */
function findForwardDeclarationBlock(masked, charIndex, maxLookahead) {
  maxLookahead = maxLookahead || 500;
  let parenDepth = 0;
  const end = Math.min(masked.length, charIndex + maxLookahead);
  for (let i = charIndex; i < end; i++) {
    const c = masked[i];
    if (c === '(') parenDepth++;
    else if (c === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (c === '{' && parenDepth === 0) {
      const closeIdx = matchForwardBrace(masked, i);
      if (closeIdx === -1) return null;
      return { startIndex: i, endIndex: closeIdx };
    } else if ((c === ';' || c === '}') && parenDepth === 0) {
      return null; // hit a statement end / block end, meaning what follows the anchor is not an immediately adjacent function-body declaration
    }
  }
  return null;
}

/** Judge whether a block "opening context" is a control-flow block such as if/for/while/try/catch/else/switch/do. */
function isControlFlowHeader(beforeText) {
  return /(^|[^\w$])(if|for|while|switch|try|catch|else|do)\s*(\([^)]*\))?\s*$/.test(
    beforeText.replace(/\s+$/, '')
  );
}

/**
 * Coarsely classify a block role from its opening context:
 * - main: the body of a regular function declaration / expression / arrow function / object method shorthand
 * - mappingEntry: an object/array literal entry shaped like `key: { ... }` or `key: [ ... ]` (not a function)
 * - helper: everything else (the default fallback, usually a helper logic block called by an upper-layer function)
 * This classification is only a heuristic "candidate role to be confirmed"; whether it is the real target implementation still requires the Step 10 / Step 2 semantic judgment
 * (scheme b)-ii)-4 "function judgment"), and cannot replace that confirmation step.
 */
function classifyBlockRole(beforeText) {
  const tail = beforeText.slice(-200);
  if (/function\s*[\w$]*\s*\([^)]*\)\s*$/.test(tail)) return 'main';
  if (/=>\s*$/.test(tail)) return 'main';
  if (/:\s*function\s*\([^)]*\)\s*$/.test(tail)) return 'main';
  if (/:\s*\([^)]*\)\s*=>\s*$/.test(tail)) return 'main';
  if (/[\w$]+\s*:\s*$/.test(tail)) return 'mappingEntry';
  return 'helper';
}

/**
 * Core "function slicing" implementation: starting from the anchor character position, first try "search forward for a declarative code block" (for function-name /
 * declaration-keyword anchors, where the anchor is before the '{'); on failure, fall back to "expand outward layer by layer for the nearest function-level block"
 * (for string / scope-mapping-table anchors, where the anchor is already inside some block), while skipping pure control-flow blocks
 * (e.g. an anchor that happens to sit inside an if branch). Corresponds to scheme b)-ii)-3: no LLM needed, pure bracket counting plus
 * heuristic role classification.
 *
 * @param {string} source the original source (unmasked)
 * @param {number} charIndex the anchor character offset
 * @param {number} maxExpand the maximum outward expansion depth, to avoid an infinite loop on anomalous files
 * @returns {{startIndex:number,endIndex:number,role:string,expandedHops:number,note?:string}|null}
 */
function extractEnclosingFunction(source, charIndex, maxExpand) {
  maxExpand = maxExpand || 20;
  const masked = maskStringsAndComments(source);

  const fwd = findForwardDeclarationBlock(masked, charIndex);
  if (fwd) {
    const before = source.slice(Math.max(0, fwd.startIndex - 160), fwd.startIndex);
    const role = classifyBlockRole(before);
    return { startIndex: fwd.startIndex, endIndex: fwd.endIndex, role, expandedHops: 0, mode: 'forward-declaration' };
  }

  let idx = charIndex;
  let lastBlock = null;
  for (let hop = 0; hop < maxExpand; hop++) {
    const block = findEnclosingBlockAt(masked, idx);
    if (!block) break;
    lastBlock = block;
    const before = source.slice(Math.max(0, block.startIndex - 160), block.startIndex);
    if (isControlFlowHeader(before)) {
      idx = block.startIndex - 1;
      continue;
    }
    const role = classifyBlockRole(before);
    return { startIndex: block.startIndex, endIndex: block.endIndex, role, expandedHops: hop, mode: 'backward-enclosing' };
  }
  if (lastBlock) {
    return {
      startIndex: lastBlock.startIndex,
      endIndex: lastBlock.endIndex,
      role: 'helper',
      expandedHops: maxExpand,
      note: 'reached the maximum expansion depth (' + maxExpand + '); may still be inside a control-flow block; manual or semantic review is recommended',
    };
  }
  return null;
}

/**
 * Alias / package-jump resolution (scheme b)-ii)-3-a): given a reference expression shaped like "dz.w",
 * extract the base identifier ("dz"), find its assignment source in the source, and prefer matching webpack-style
 * require/import alias patterns such as `dz = o(1234)` / `dz=r(1234)`.
 * Returns null when no clear assignment pattern can be parsed (e.g. destructuring assignment, dynamic property access),
 * leaving the upper layer to decide whether to fall back to the LLM to judge "is this an alias reference, and where should we look".
 */
function resolveAliasChain(source, aliasExpr) {
  const base = String(aliasExpr).split('.')[0].trim();
  if (!base || !/^[A-Za-z_$][\w$]*$/.test(base)) return null;
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const directRe = new RegExp('\\b' + escaped + '\\s*=\\s*[A-Za-z_$][\\w$]*\\((\\d+)\\)');
  const m1 = source.match(directRe);
  if (m1) {
    return { resolvedModule: m1[1], matchedText: m1[0], pattern: 'direct-require-call' };
  }

  const destructureRe = new RegExp(
    '\\{[^}]*\\b' + escaped + '\\b[^}]*\\}\\s*=\\s*[A-Za-z_$][\\w$]*\\((\\d+)\\)'
  );
  const m2 = source.match(destructureRe);
  if (m2) {
    return {
      resolvedModule: m2[1],
      matchedText: m2[0],
      pattern: 'destructuring',
      note: 'destructuring assignment pattern; a second confirmation is recommended',
    };
  }

  return null;
}

/**
 * Locate a webpack-style numeric module definition body: shaped like `55793: (e,t,r)=>{...}` or `55793:function(e,t,r){...}`.
 * After finding the module-number label, do forward bracket matching from the first '{' after it.
 */
function findModuleDefinition(source, moduleNumber) {
  const masked = maskStringsAndComments(source);
  const labelRe = new RegExp('(^|[,{\\n])\\s*' + moduleNumber + '\\s*:\\s*');
  const m = masked.match(labelRe);
  if (!m) return null;
  const afterLabel = m.index + m[0].length;
  const braceIdx = masked.indexOf('{', afterLabel);
  if (braceIdx === -1) return null;
  const closeIdx = matchForwardBrace(masked, braceIdx);
  if (closeIdx === -1) return null;
  return { startIndex: braceIdx, endIndex: closeIdx, labelIndex: m.index };
}

/**
 * Enumerate all top-level key-value entries of an object literal (e.g. a permission / scope mapping table).
 *
 * Background (a methodology gap found in real analysis): early manual analysis could read the code line by line and copy every entry of a permission mapping table
 * (including members never registered in documentation, e.g. under the `jsapi_wxfriend_interaction` group,
 * the cloud-storage family APIs `<cloud-storage-peer-API>` / `<cloud-storage-peer-API>` / `<cloud-storage-read-API>`),
 * but the automated tool could previously only retrieve code "by known keyword hits", so if a table member name
 * never appeared in the initial keyword seed it would never be discovered systematically — this is exactly the missing enumeration tool for scheme c)-i)-2(1),
 * the scenario "a real finding located on the code side by a feature anchor but absent from documentation". This function lets an analyst
 * perform "indiscriminate full enumeration" on any located object literal (usually after `locate-anchor` / `extract-function` finds the table range),
 * then compare the enumeration against the Step 1 doc-side confirmed inventory to systematically find unregistered members.
 *
 * Implementation: track brace / bracket / paren depth on the masked text (so string value content cannot disturb depth counting);
 * a top-level comma (depth 0, i.e. directly within the given objectBody range and not nested deeper) is the entry separator;
 * within each entry, the first top-level colon is the key/value split point, and the text before it is the key (trimmed of leading/trailing whitespace and
 * surrounding quotes). No full JS parsing is done — it is pure text plus depth counting — so "a key that is itself a complex computed expression"
 * is naturally unsupported (the real analysis targets — permission mapping tables / scope tables — never use that form, so it is acceptable).
 *
 * @param {string} source the original source
 * @param {number} blockStartIndex the character offset of the object literal outer '{'
 * @param {number} blockEndIndex the character offset of the object literal outer '}' (paired with startIndex)
 * @returns {{key:string, rawKeyText:string, valuePreview:string}[]}
 */
function extractObjectTopLevelKeys(source, blockStartIndex, blockEndIndex) {
  const masked = maskStringsAndComments(source);
  const maskedBody = masked.slice(blockStartIndex + 1, blockEndIndex);
  const originalBody = source.slice(blockStartIndex + 1, blockEndIndex);
  const n = maskedBody.length;

  const entries = [];
  let depth = 0;
  let segStart = 0;

  function pushSegment(segEnd) {
    const maskedSeg = maskedBody.slice(segStart, segEnd);
    // within this entry, find the first top-level colon (depth 0 relative to the entry itself) as the key/value split point
    let localDepth = 0;
    let colonIdx = -1;
    for (let k = 0; k < maskedSeg.length; k++) {
      const c = maskedSeg[k];
      if (c === '{' || c === '[' || c === '(') localDepth++;
      else if (c === '}' || c === ']' || c === ')') localDepth--;
      else if (c === ':' && localDepth === 0) {
        colonIdx = k;
        break;
      }
    }
    if (colonIdx === -1) return; // this segment has no top-level colon (probably an empty segment from trailing whitespace / a trailing comma); skip it
    let rawKeyText = originalBody.slice(segStart, segStart + colonIdx).trim();
    let key = rawKeyText;
    if (
      (key.startsWith('"') && key.endsWith('"') && key.length >= 2) ||
      (key.startsWith("'") && key.endsWith("'") && key.length >= 2)
    ) {
      key = key.slice(1, -1);
    }
    const valuePreview = originalBody
      .slice(segStart + colonIdx + 1, segEnd)
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 100);
    if (key) entries.push({ key, rawKeyText, valuePreview });
  }

  for (let i = 0; i < n; i++) {
    const c = maskedBody[i];
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ',' && depth === 0) {
      pushSegment(i);
      segStart = i + 1;
    }
  }
  pushSegment(n); // the last entry (or the empty segment after a trailing comma; pushSegment skips it internally when no colon is found)

  return entries;
}

module.exports = {
  maskStringsAndComments,
  buildLineIndex,
  lineOfOffset,
  offsetOfLine,
  matchForwardBrace,
  findEnclosingBlockAt,
  isControlFlowHeader,
  classifyBlockRole,
  extractEnclosingFunction,
  resolveAliasChain,
  findModuleDefinition,
  extractObjectTopLevelKeys,
};
