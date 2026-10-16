#!/usr/bin/env node
'use strict';
/**
 * doc-filter.js — the deterministic / semi-automated execution part of the scheme a) documentation-filtering tool.
 *
 * Positioning (important, to avoid misuse): this script only handles the parts the scheme explicitly marks "pure code" or "emits a queue awaiting judgment for the caller
 * (usually the LLM main flow driving this script) to complete the semantic judgment and then write back"; it has no built-in LLM calling capability:
 *   - the "LLM-primary / LLM-assisted" parts (i domain-knowledge query for startup data, ii judging the function body,
 *     iv the semantic-relevance judgment) are done by the caller within its own reasoning, then persisted through this script `seed` / `judge`
 *     commands into the shared registry — this is exactly the same principle as SKILL.md Step 10 "miniapp-autotest is a pure execution engine
 *     that does not understand the concrete validation logic; the right to write the code must stay with the step that finished the design reasoning", applied to this tool:
 *     this script is a pure execution / retrieval engine and does not carry the relevance judgment itself.
 *   - the "pure code" parts (keyword coarse screening, filename scanning, JSON structured return-value extraction, naming-pattern pairing detection)
 *     are done directly by this script.
 *
 * subcommand overview (`node doc-filter.js <command> --help` is not implemented; see the COMMANDS definition below):
 *   init             initialize / confirm that the registry file exists
 *   seed             record the initial keyword / API / return-value sets (i startup data + flow 1-3)
 *   scan-filenames   coarse keyword screening of filenames in a given directory (iii-2); supports comma-separated multiple --docRoot directories,
 *                   optional --contentPattern for a second content-level coarse screen (no JSON parsing, plain text grep)
 *   scan-content    content-level keyword / return-value / description / example-code matching on given doc files, producing the queue awaiting judgment (iv);
 *                  with new-API mining in example-code direction 2 (iv-4-(2)) and generic field blacklist filtering
 *   pairing-check   naming-pattern pairing detection (ii-2): for confirmed APIs, check whether sibling APIs such as onX/offX/stopX/onXChange
 *                   exist; supports comma-separated multiple --docRoot directories
 *   judge           after the caller completes the semantic judgment, persist the docEvidence of an API (ii); supports --newReturns
 *                   to submit complete return-value metadata (propertyName/type/description/callbackType)
 *   batch-judge     the batch version of judge; one process call submits several judgments
 *   pending         list the APIs still in candidate state, awaiting judgment
 *   loop-status     report whether the current confirmed API count has grown since the last call (the loop termination criterion of flow 7)
 */

const fs = require('fs');
const path = require('path');
const { parseArgs, resolveJsonInput, printResult, fail, requireArg, runCli } = require('./lib/cli');
const { ApiRegistry } = require('./lib/registry');

const CALLER = 'docTool';

function loadRegistry(args) {
  const regPath = requireArg(args, 'registry');
  return new ApiRegistry(regPath).load();
}

/** Judge whether a term "may appear verbatim in code", for the K_doc/K_code dual classification rule (scheme 2.5 classification rule). */
function looksCodeLike(term) {
  if (/[\u4e00-\u9fa5]/.test(term)) return false; // contains CJK characters, judged a purely semantic term
  return /^[A-Za-z_$][\w$.]*$/.test(term) || /^scope\./.test(term);
}

// ------------------------- init -------------------------
function cmdInit(args) {
  const regPath = requireArg(args, 'registry');
  if (fs.existsSync(regPath)) {
    printResult({ ok: true, action: 'exists', registry: regPath });
    return;
  }
  const reg = new ApiRegistry(regPath).load();
  reg.save();
  printResult({ ok: true, action: 'created', registry: regPath });
}

// ------------------------- seed -------------------------
// corresponds to i) startup data + flow 1-3: the caller has already completed "ask the LLM for typical APIs / keywords / return values"
// this LLM-primary part; this command only persists the result in pure code per the classification rules.
function cmdSeed(args) {
  const reg = loadRegistry(args);
  const terms = resolveJsonInput(args, 'terms', []); // [{term, sourceApi, belongsTo?}]
  const apis = resolveJsonInput(args, 'apis', []); // [{apiName, kind?, docPath?}] typical APIs, registered only as candidate placeholders
  const returns = resolveJsonInput(args, 'returns', []); // [{propertyName, path?, type, description, sourceApi, callbackType?}]

  const report = { termsAdded: [], apisSeeded: [], returnsAdded: [] };

  for (const t of terms) {
    const explicit = t.belongsTo;
    const codeLike = looksCodeLike(t.term);
    const targets = explicit ? [explicit] : codeLike ? ['K_doc', 'K_code'] : ['K_doc'];
    for (const belongsTo of targets) {
      const entry = reg.addTerm(belongsTo, t.term, t.sourceApi || 'seed', CALLER);
      report.termsAdded.push({ belongsTo, term: entry.term });
    }
  }

  for (const a of apis) {
    reg.ensureApi(a.apiName, CALLER, a.kind || 'function');
    reg.setDocEvidence(
      a.apiName,
      {
        docPath: a.docPath || null,
        description: a.description || null,
        matchedKDoc: [],
        matchedKCode: [],
        matchedR: [],
        exampleCodeMentions: [],
        status: 'candidate',
        evidence: 'from the initial typical-API seed set, awaiting the judge command for the formal judgment',
      },
      CALLER
    );
    report.apisSeeded.push(a.apiName);
  }

  for (const r of returns) {
    const entry = reg.addTerm('R', r.propertyName, r.sourceApi || 'seed', CALLER, {
      path: r.path,
      type: r.type,
      description: r.description,
      callbackType: r.callbackType,
    });
    report.returnsAdded.push(entry.term);
  }

  reg.save();
  printResult({ ok: true, report });
}

// ------------------------- scan-filenames -------------------------
// corresponds to iii)-2: coarse filename screening by regex, returning only the list of hit file paths, without reading the file bodies.
function walkDir(root, results) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) walkDir(full, results);
    else results.push(full);
  }
}

// a methodology gap found and fixed in real analysis: the docs of the target functional domain may be scattered across several independent directories (for instance:
// besides the main doc directory `api_doc/`, the docs of high-value APIs such as `<phone-number-API>` / `<phone-number-API>`
// actually live in a completely independent `miniapp_md/webview/GetPhone.md`); if scan-filenames accepted only a single
// docRoot, the analyst would have to realize at Step 0 that "there are other doc source directories" before launching a second scan — once missed,
// these docs score zero hits throughout Step 1, with no error hint. So --docRoot now supports a comma-separated
// multi-directory list, encouraging the caller to enumerate all known doc sources at Step 0 in one go, rather than assuming a single main directory.

/**
 * Enumerate the first-level subdirectory names under root (non-recursive), for findUncoveredSubtrees to descend recursively.
 * only the directory hierarchy matters — doc sources like api_doc conventionally express the official self-authored subdomain classification via top-level / second-level directory names
 * (e.g. "Open API / User Info", "Open API / Privacy Info Authorization"), which is exactly the local ground truth that SKILL.md Step 0 item 1 requires be trusted first.
 
 */
function listImmediateSubdirs(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => path.join(root, e.name));
}

/**
 * Recursively find the "largest subtree with completely zero hits", rather than looking only at the first-level subdirectories.
 *
 * A detection-granularity defect found and fixed in real analysis: the first implementation only counted the overall hit rate of the **first-level** subdirectories of docRoot,
 * but the subdomain classification of real doc sources usually sits at the **second level or deeper** (e.g. `api_doc/Open API/Biometric Auth/`) —
 * if only the first level is seen, `api_doc/Open API/` as a whole is judged
 * "covered" because inner subdirectories such as "User Info" hit, and its truly zero-hit second-level subdomains "Biometric Auth", "Channels", "WeRun", "Employment Relationship" are
 * hidden, showing no anomaly signal. Example: when analyzing any domain, `Open API/` hit 29 files overall,
 * and with only first-level detection `Open API/` would not appear in uncoveredSubdomains, while its truly
 * completely zero-hit 8+ subdomains "Biometric Auth", "Channels", "WeRun" would be systematically hidden.
 *
 * algorithm: for each directory node, recurse top-down —
 *   - the node overall hit count is 0 (and it has files) -> the whole subtree is reported as one indivisible "uncovered unit",
 *     with no further recursion (no need to report subdirectories; the parent already fully expresses "this whole area has zero hits");
 *   - all files of the node hit -> fully covered; neither reported nor recursed;
 *   - partial hit -> recurse into its subdirectories, looking at finer granularity for a "completely zero-hit" subtree; if no subdirectory remains
 *     to split (it is a leaf folder), **do not simply give up** (see the "partial-hit leaf directory" fix below).
 *
 * a detection-granularity defect found and fixed in real analysis (the second class, an independent risk alongside "completely zero hit"):
 * the original implementation treated "leaf-level partial hit" as normal and simply gave up without reporting — but cases like this were for example:
 * in the `ChatTool/` directory, 6 of 10 files were hit by the pattern (60%, so it would not be misjudged as "zero hit"), yet
 * `wx-<chat-tool-API>.json` was missed because its filename contains no pattern word root; in the `Forwarding/` directory, of 11 files
 * only 1 hit (9%), and `wx-<share-API>.json` was likewise missed — this kind of "partial hit hiding a concrete
 * file omission" is more covert than "completely zero hit", because the directory itself does not trigger the uncoveredSubdomains warning,
 * so an analyst easily assumes "this directory was already covered" and never re-checks the concrete file list inside it.
 * fix: when a leaf directory is a "partial hit", do not silently give up; instead report the **concrete list of unmatched filenames
 * inside that directory** (`partial: true`), for the analyst to verify one by one — whether these files need extra keywords / pattern roots,
 * or are genuinely unrelated to the target domain, is left to a human / the LLM; the tool only exposes the signal and makes no semantic judgment.
 */
function findUncoveredSubtrees(dir, matchedSet) {
  const files = [];
  walkDir(dir, files);
  if (files.length === 0) return []; // empty directory, skip
  const matchedCount = files.filter((f) => matchedSet.has(f)).length;
  if (matchedCount === 0) {
    return [{ subdomain: dir, totalFiles: files.length, matchedFiles: 0 }];
  }
  if (matchedCount === files.length) {
    return [];
  }
  const subdirs = listImmediateSubdirs(dir);
  if (subdirs.length === 0) {
    // leaf-level partial hit: report the concrete list of unmatched files, rather than silently giving up (see the comment above).
    const unmatchedFileNames = files.filter((f) => !matchedSet.has(f)).map((f) => path.basename(f));
    return [
      {
        subdomain: dir,
        totalFiles: files.length,
        matchedFiles: matchedCount,
        partial: true,
        unmatchedFileNames,
      },
    ];
  }
  let results = [];
  for (const sub of subdirs) results = results.concat(findUncoveredSubtrees(sub, matchedSet));
  return results;
}

function cmdScanFilenames(args) {
  const docRootArg = requireArg(args, 'docRoot');
  const patternStr = requireArg(args, 'pattern');
  const contentPatternStr = args.contentPattern; // optional: the content-level coarse screen of scheme a-iii-2
  const outFile = args.out; // optional: the result set may be large (e.g. a full traversal); persisting avoids flooding the context or being corrupted by shell redirection encoding
  const docRoots = String(docRootArg)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const re = new RegExp(patternStr, 'i');
  const all = [];
  const perRootCount = {};
  for (const root of docRoots) {
    const before = all.length;
    walkDir(root, all);
    perRootCount[root] = all.length - before;
  }
  let matched = all.filter((f) => re.test(path.basename(f)) || re.test(f));

  // corresponds to the second-layer coarse screen of scheme a-iii-2: "use search_content to coarse-screen, and take only filenames, not the content ... only get
  // the list of hit filenames, without stuffing the bodies of matched files into the context" — the difference from scan-content is that this step
  // does no JSON.parse / structured field parsing at all; it is only the most primitive plain-text grep, so for a huge corpus
  // (e.g. tens of thousands of doc files) it is faster than scan-content parsing each one; --contentPattern is
  // an optional second-round filter that, on top of the filename coarse-screen result, further matches by file content (raw text, structure not parsed)
  // with a regex, returning only the file path list itself and not the matched body fragments. If this parameter is absent, behavior is identical to before
  // (no content-level filtering), preserving backward compatibility.
  let contentFilteredCount = null;
  if (contentPatternStr) {
    const contentRe = new RegExp(contentPatternStr, 'i');
    const before = matched.length;
    matched = matched.filter((f) => {
      try {
        return contentRe.test(fs.readFileSync(f, 'utf8'));
      } catch (e) {
        return false;
      }
    });
    contentFilteredCount = { beforeContentFilter: before, afterContentFilter: matched.length };
  }

  // A methodology gap found and fixed in real analysis: even knowing the rule "Step 0 should first list_dir and check the subdomain inventory",
  // an analyst may still, in actual execution, write the regex straight from a subjective understanding of the "target domain" without really checking
  // it once — this is not a hypothetical risk but a failure mode reproduced in a real analysis task of this Skill (when analyzing "user-info-class
  // APIs", the regex covered none of the 8+ subdomains "address / group chat / Channels / biometric auth / face verification / employment relationship / WeRun / login session",
  // discovered only later by comparing against historical results). The earlier fix stayed at the "documentation reminder" level (weak binding,
  // easily skipped); this time the tool proactively computes and exposes a structural signal: findUncoveredSubtrees
  // recursively finds, per docRoot, the "largest subtree with completely zero hits" (not just the first level — if only the first level were seen, a top-level directory like `Open API/`
  // would be judged "covered" because some inner subdirectories hit, hiding its truly zero-hit inner subdomains such as "biometric auth" and "Channels"
  // this defect was observed; see the findUncoveredSubtrees function comment).
  const matchedSet = new Set(matched);
  const uncoveredEntries = [];
  for (const root of docRoots) {
    for (const subdir of listImmediateSubdirs(root)) {
      uncoveredEntries.push(...findUncoveredSubtrees(subdir, matchedSet));
    }
  }
  // split into two independent signals: (1) completely zero-hit subtrees (the existing mechanism); (2) leaf-level partial hits whose inside contains unmatched
  // concrete files (a new mechanism; see the "partial-hit leaf directory" fix in the findUncoveredSubtrees comment) —
  // the two are exposed in separate fields, avoiding mixing that leads an analyst to treat "partial hit" as "zero hit" (or conversely,
  // to overlook the more urgently needed "completely zero hit" items because they are fewer in number).
  const fullyUncoveredEntries = uncoveredEntries.filter((e) => !e.partial);
  const partiallyMatchedEntries = uncoveredEntries.filter((e) => e.partial);
  const uncoveredSubdomains = fullyUncoveredEntries.map((e) => e.subdomain);
  const partiallyMatchedSubdomains = partiallyMatchedEntries.map((e) => ({
    subdomain: e.subdomain,
    totalFiles: e.totalFiles,
    matchedFiles: e.matchedFiles,
    unmatchedFileNames: e.unmatchedFileNames,
  }));

  const partialWarning =
    partiallyMatchedSubdomains.length > 0
      ? 'warning: the following ' +
        partiallyMatchedSubdomains.length +
        ' subdirectories have some files unmatched by the current pattern (the directory itself has a partial hit, so it does not trigger the "completely zero hit" warning above, but concrete files inside may be missed because their filenames contain no pattern word root — a observed case: a directory with a 60% hit rate still missed 1 genuinely relevant API), please go through the unmatchedFileNames list in partiallyMatchedSubdomains one by one and verify whether these concrete files need extra keywords; do not skip them just because the directory overall hit rate is not low'
      : null;

  const result = {
    ok: true,
    docRoots,
    perRootCount,
    pattern: patternStr,
    contentPattern: contentPatternStr || null,
    contentFilteredCount,
    totalFiles: all.length,
    matched,
    uncoveredSubdomains,
    uncoveredSubdomainDetail: fullyUncoveredEntries,
    partiallyMatchedSubdomains,
    warning:
      uncoveredSubdomains.length > 0
        ? 'warning: the following ' +
          uncoveredSubdomains.length +
          ' subdirectories (including all their subdirectories) have zero hits overall; please manually verify whether these subdirectories are genuinely unrelated to the target functional domain (they cannot be excluded merely by the literal meaning of the directory name, especially directories whose names do not directly contain the target-domain keyword yet whose content may still be relevant); see the uncoveredSubdomains field — corresponding to the SKILL.md Step 0 mandatory check item 1, "the subdomain enumeration inventory"'
        : null,
    partialWarning,
  };
  if (outFile) {
    const dir = path.dirname(outFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
    // key: uncoveredSubdomains / warning must also appear in the stdout echo of the persisted summary, not only be written into
    // outFile — the scenario observed is exactly "full doc scan is large, takes the --out branch"; if these two fields exist only in
    // an unread persisted file, the analyst will hardly look it up, equivalent to the warning never reaching them. partialWarning
    // must likewise be echoed, otherwise the new "partial-hit subdirectory" signal repeats the fate of "exists only in a persisted file nobody reads".
    printResult({
      ok: true,
      docRoots,
      perRootCount,
      pattern: patternStr,
      contentPattern: contentPatternStr || null,
      contentFilteredCount,
      totalFiles: all.length,
      matchedCount: matched.length,
      uncoveredSubdomains,
      warning: result.warning,
      partiallyMatchedSubdomains,
      partialWarning,
      savedTo: outFile,
    });
    return;
  }
  printResult(result);
}

// ------------------------- scan-content -------------------------
// corresponds to iv): content-level keyword / return-value / description / example-code matching, producing the "queue awaiting judgment" (not written directly into confirmed;
// all are registered as candidate, awaiting the caller using the judge command for the semantic judgment before promotion).

/** Flatten an arbitrarily structured doc JSON into a plain text blob for keyword matching, tolerating several field-naming conventions. */
function flattenDocText(obj, depthLimit) {
  depthLimit = depthLimit == null ? 6 : depthLimit;
  const parts = [];
  function walk(v, depth) {
    if (depth > depthLimit || v == null) return;
    if (typeof v === 'string') {
      parts.push(v);
    } else if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
    } else if (typeof v === 'object') {
      for (const key of Object.keys(v)) {
        parts.push(key);
        walk(v[key], depth + 1);
      }
    }
  }
  walk(obj, 0);
  return parts.join('\n');
}

/**
 * Generic no-privacy-value field blacklist: these fields appear in almost every callback; they are protocol-layer boilerplate rather than
 * function-related data, matching the design intent of the scheme 2.4 callbackType field, "filter generic no-privacy-value fields such as errCode / errMsg".
 * Used only to filter "newReturnCandidates" (the new return-value candidates about to be presented to the caller for judgment);
 * it does not affect historical records already in the R set, nor does it stop the caller from explicitly registering these fields via seed / judge
 * (if a domain genuinely needs them, they can still be added manually).
 */
const GENERIC_RETURN_FIELD_BLOCKLIST = new Set([
  'errMsg', 'errCode', 'errno', 'err_code', 'err_msg', 'error', 'success', 'fail', 'complete',
]);

/**
 * Parse tab-separated return values out of the text fields of the "real Chinese doc corpus" (such as the Chinese field names params / return value / return params).
 * A real corpus sample (the actual format confirmed by sampling the full api_doc/ collection, kept in sync with this function comment):
 *
 *   "...\nobject.success 回调函数\n\n参数\n\nObject res\n\n属性\t类型\t说明\t最低版本\n
 *    userInfo\tUserInfo\tuser info object\t2.10.4\nrawData\tstring\t...\t2.10.4\n..."
 *
 * that is: after the marker "Object res" / "Object result" / "Object response" appears, a header row follows
 * (containing the two column names "property" and "type", and not the "required" column — a table with a "required" column is an input parameter table, not a return value table,
 * so it must be excluded), and then each following row is tab-separated <property, type, description[, minimum version]>.
 *
 * This is a key defect fix found when this tool really interfaced with the full api_doc/ corpus: the original implementation assumed return values existed as
 * structured JSON / arrays under English field names (e.g. doc.returns / doc.success.properties), but in the real corpus
 * such structured fields do not exist at all; the return-value information is compressed inside the large text field params, as a plain-text table
 * mixed in after the input parameter table — without parsing this format, returnFields is always an empty array on the real corpus,
 * and the newReturnCandidates signal fails completely (K_doc / K_code keyword matching is unaffected because it scans the full text,
 * but the return-value thread, an independent evidence lead, becomes useless).
 */
function parseChineseParamTableBlob(text) {
  if (typeof text !== 'string' || !text) return [];
  const results = [];
  const sections = [];

  // prefer matching the marker form "object.xxx callback function ... Object res", which carries callback-type context,
  // and infer callbackType from it; if not found, degrade to matching the bare "Object res/result/response" marker.
  const markerRe = /object\.?(success|fail|complete)?\s*回调函数[\s\S]{0,80}?Object\s+(res(?:ult|ponse)?)\b/gi;
  let m;
  while ((m = markerRe.exec(text)) !== null) {
    sections.push({ start: m.index + m[0].length, callbackType: (m[1] || 'success').toLowerCase() });
  }
  if (sections.length === 0) {
    const bareRe = /Object\s+(res(?:ult|ponse)?)\b/gi;
    while ((m = bareRe.exec(text)) !== null) {
      sections.push({ start: m.index + m[0].length, callbackType: 'success' });
    }
  }

  for (const sec of sections) {
    const chunk = text.slice(sec.start);
    const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
    let headerIdx = -1;
    for (let i = 0; i < Math.min(lines.length, 5); i++) {
      if (lines[i].includes('属性') && lines[i].includes('类型')) {
        headerIdx = i;
        break;
      }
    }
    if (headerIdx === -1) continue;
    if (lines[headerIdx].includes('必填')) continue; // an input parameter table (with a required column), not a return value table; skip

    for (let i = headerIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (/^(object[.\s]|合法值)/i.test(line)) break; // hit the next marker block / nested enum description; end this table
      const cols = line.split('\t').map((c) => c.trim());
      if (cols.length < 2) break; // no longer a tab-separated table row, so the table has ended
      const [propertyName, type, description] = cols;
      if (!propertyName || !/^[A-Za-z_$][\w$.]*$/.test(propertyName)) break; // the field name is invalid, so the table has ended
      results.push({
        propertyName,
        path: propertyName,
        type: type || 'unknown',
        description: description || '',
        callbackType: sec.callbackType,
      });
    }
  }
  return results;
}

/**
 * Try to extract structured return-value triples from the doc JSON. Dual-path strategy:
 * 1. structured JSON path: tolerating common English field names (type / returns / res / success, etc.) — kept for
 *    other structured doc sources that may exist; when interfacing with the real api_doc/ corpus it hit nothing (that corpus is
 *    entirely Chinese-field raw text of "docContent_html / Configuration / description / params / example code / ..."),
 *    but keeping this path costs nothing and preserves forward compatibility.
 * 2. Chinese text-table path (the real main path): for common Chinese field values such as "params" / "return value" / "return params", call
 *    parseChineseParamTableBlob to parse the tab table; this is the actually effective path inferred back from the real corpus.
 * The two path results are merged and deduplicated (by propertyName, with the structured path taking precedence as it is usually more precise).
 * Returns an empty array when nothing is extracted (no error, so keyword matching still works).
 */
function extractReturnFields(doc) {
  const candidates = [];
  const seen = new Set();
  const push = (c) => {
    if (!seen.has(c.propertyName)) {
      seen.add(c.propertyName);
      candidates.push(c);
    }
  };

  // path 1: structured JSON (tolerating other doc source formats that may exist)
  const roots = [];
  for (const key of ['returns', 'return', 'res', 'result', 'success', 'response']) {
    if (doc[key]) roots.push({ node: doc[key], callbackType: 'success' });
  }
  if (doc.fail) roots.push({ node: doc.fail, callbackType: 'fail' });
  if (doc.complete) roots.push({ node: doc.complete, callbackType: 'complete' });
  if (doc.params && Array.isArray(doc.params)) {
    for (const p of doc.params) {
      if (p && (p.in === 'res' || p.name === 'res' || p.name === 'result')) roots.push({ node: p, callbackType: 'success' });
    }
  }
  function collectProps(node, callbackType) {
    if (!node) return;
    const props = node.properties || node.props || node.fields;
    if (Array.isArray(props)) {
      for (const p of props) {
        if (p && (p.name || p.property)) {
          push({
            propertyName: p.name || p.property,
            path: p.path || p.name || p.property,
            type: p.type || 'unknown',
            description: p.description || p.desc || '',
            callbackType,
          });
        }
        collectProps(p, callbackType);
      }
    } else if (props && typeof props === 'object') {
      for (const [name, meta] of Object.entries(props)) {
        push({
          propertyName: name,
          path: name,
          type: (meta && meta.type) || 'unknown',
          description: (meta && (meta.description || meta.desc)) || '',
          callbackType,
        });
        collectProps(meta, callbackType);
      }
    }
  }
  for (const r of roots) collectProps(r.node, r.callbackType);

  // path 2: Chinese text table (the real main path for the corpus) — iterate the common Chinese field names carrying return-value descriptions
  for (const key of ['参数', '返回值', '返回参数', 'Object res', '返回']) {  // Chinese field names of the real corpus
    if (typeof doc[key] === 'string') {
      for (const c of parseChineseParamTableBlob(doc[key])) push(c);
    }
  }

  return candidates;
}

/**
 * Extract example-code text from the doc JSON. The real api_doc/ corpus uses the Chinese field name "example code" (plain text,
 * restored from HTML into readable JS/WXML source) and no English field names — the original implementation only tried
 * example / examples / demo / sampleCode / code and other English field names, which are always empty on the real corpus,
 * making the exampleCodeMentions signal completely ineffective. The Chinese field name is added here as the main source, while English names are kept
 * for compatibility with other possible doc sources.
 */
function extractExampleCode(doc) {
  const texts = [];
  for (const key of ['示例代码', '代码示例', 'example', 'examples', 'demo', 'sampleCode', 'code']) {  // Chinese names first: the real corpus only has these
    const v = doc[key];
    if (typeof v === 'string') texts.push(v);
    else if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === 'string') texts.push(item);
        else if (item && typeof item.code === 'string') texts.push(item.code);
      }
    }
  }
  return texts.join('\n');
}

/**
 * Guess the apiName: prefer the doc own title / name / apiName field; otherwise fall back to the filename (extension stripped).
 * Real doc corpora often have title shaped like "Open API / User Info / wx.<profile-API>" (with the full breadcrumb path),
 * which would pollute the apiName primary key if used as-is; hence when title contains the " / " separator, only the last segment is taken as apiName
 * — a real defect fix found after running this tool against the real doc corpus (the original implementation assumed title was already a clean API name).
 */
function guessApiName(doc, filePath) {
  const raw = doc.title || doc.name || doc.apiName || path.basename(filePath, path.extname(filePath));
  if (typeof raw === 'string' && raw.includes('/')) {
    const parts = raw.split('/').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return raw;
}

/**
 * Mine candidates of "suspected new API names" from example-code text, corresponding to scheme a-iv-4-(2): "once some api is judged to be
 * a relevant api, check its example code and judge the other apis it contains" — this is the opposite direction from direction 1 (exampleCodeMentions,
 * checking whether the current doc example code mentions a known API): from the example code of an already confirmed relevant API, mine
 * new API names not yet in knownApiNames that appear to be under the same namespace, for the caller to judge whether they are also relevant.
 *
 * To control noise (irrelevant calls in the example code such as `JSON.stringify` / `console.log` / `Object.assign` also match
 * the "namespace.method(" shape), only candidates whose prefix hits knownNamespaces (the namespace prefix set extracted from currently confirmed API names,
 * e.g. "wx") are kept — APIs of the same functional domain almost always share one namespace prefix, and this
 * restriction costs almost no recall while filtering out the vast majority of generic JS / browser built-in call noise.
 */
function extractNovelApiMentions(exampleText, knownApiNames, knownNamespaces) {
  if (!exampleText || knownNamespaces.size === 0) return [];
  const callPatternRe = /\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g;
  const found = new Set();
  let m;
  while ((m = callPatternRe.exec(exampleText)) !== null) {
    const ns = m[1];
    if (!knownNamespaces.has(ns)) continue;
    const full = ns + '.' + m[2];
    if (!knownApiNames.includes(full)) found.add(full);
  }
  return [...found];
}

function cmdScanContent(args) {
  const reg = loadRegistry(args);
  const files = resolveJsonInput(args, 'files', null);
  if (!files) fail('--files is required (a JSON array of doc file absolute/relative paths, usually from the output of scan-filenames)');
  const outFile = args.out; // optional: candidates may be numerous; persisting avoids flooding the context or being corrupted by shell redirection encoding

  const activeKDoc = reg.listTerms('K_doc', 'active').map((t) => t.term);
  const activeKCode = reg.listTerms('K_code', 'active').map((t) => t.term);
  const activeR = reg.listTerms('R', 'active').map((t) => t.term);
  const allTermsForDoc = [...new Set([...activeKDoc, ...activeKCode])];
  const knownApiNames = reg.listApis().map((a) => a.apiName);
  // namespace prefix set: take "the segment before the dot" from confirmed API names, e.g. "wx.<profile-API>" -> "wx",
  // used for noise filtering of direction-2 new API candidates (see the extractNovelApiMentions comment).
  const knownNamespaces = new Set(
    reg
      .listApis((a) => a.docEvidence && a.docEvidence.status === 'confirmed')
      .map((a) => a.apiName.split('.')[0])
      .filter((ns) => /^[A-Za-z_$][\w$]*$/.test(ns))
  );

  const candidates = [];
  const alreadyJudgedSkipped = [];
  const novelApiCandidatesFound = [];
  // A silent-loss defect found and fixed in real analysis: previously, files whose "filename hit the pattern (from scan-filenames)
  // but scored zero content-level hits on keywords / return values / example code" were skipped directly in the `continue` branch, producing
  // no record, writing nothing to the registry, and appearing in no field of the result — a observed case:
  // `wx-<channels-profile-API>.json`, whose filename contains "channels" / "profile", was correctly
  // hit by scan-filenames and passed into this command, but since return values / keywords scored zero at the content level it was silently dropped, and this API then
  // disappeared from the entire analysis flow, being in neither confirmed nor rejected; only later, by manually comparing one by one
  // the scan-filenames matched list against the scan-content candidates list, was this "vanished intermediate state" discovered.
  // fix: explicitly collect these files and expose them as contentUnmatchedFiles in the result, reminding the caller that files whose "filename
  // looks relevant but the content scan scored zero hits" must not be treated as "excluded"; they need manual spot checks (they may be truly irrelevant, or
  // they may be false negatives caused by content parsing format / insufficient keyword coverage).
  const contentUnmatchedFiles = [];

  for (const filePath of files) {
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      continue;
    }
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch (e) {
      doc = { description: raw };
    }
    const flatText = flattenDocText(doc);
    const apiName = guessApiName(doc, filePath);

    const matchedKDoc = allTermsForDoc.filter((t) => flatText.includes(t));
    const returnFields = extractReturnFields(doc);
    const matchedR = returnFields.filter((f) => activeR.includes(f.propertyName)).map((f) => f.propertyName);
    const newReturnCandidates = returnFields.filter(
      (f) => !activeR.includes(f.propertyName) && !GENERIC_RETURN_FIELD_BLOCKLIST.has(f.propertyName)
    );
    const exampleText = extractExampleCode(doc);
    const exampleCodeMentions = knownApiNames.filter(
      (n) => n !== apiName && exampleText.includes(n)
    );

    const hasSignal = matchedKDoc.length > 0 || matchedR.length > 0;

    // direction 2: even if the current doc itself has no keyword / return-value signal, as long as it is an "already confirmed API", also check
    // whether its example code mentions new APIs in the namespace — this mining does not depend on the hasSignal judgment and is not affected by
    // "continue skipping signal-less docs" (whether to continue is decided separately below; the mining logic runs before continue).
    const existingRecForNovel = reg.getApi(apiName);
    const isConfirmedForNovel = existingRecForNovel && existingRecForNovel.docEvidence && existingRecForNovel.docEvidence.status === 'confirmed';
    if (isConfirmedForNovel && exampleText) {
      const novel = extractNovelApiMentions(exampleText, knownApiNames, knownNamespaces);
      for (const novelName of novel) {
        const novelRec = reg.ensureApi(novelName, CALLER, 'function');
        if (!novelRec.docEvidence) {
          reg.setDocEvidence(
            novelName,
            {
              docPath: null,
              description: null,
              matchedKDoc: [],
              matchedKCode: [],
              matchedR: [],
              exampleCodeMentions: [apiName],
              status: 'candidate',
              evidence: 'example-code direction-2 mining hit: a new same-namespace API mention was found in the example code of the confirmed API "' + apiName + '"; no independent documentation source; awaiting human / LLM judgment (scheme a-iv-4-(2))',
            },
            CALLER
          );
          novelApiCandidatesFound.push({ novelApiName: novelName, foundInExampleOf: apiName });
        }
      }
    }

    if (!hasSignal && exampleCodeMentions.length === 0) {
      contentUnmatchedFiles.push({ docPath: filePath, guessedApiName: apiName });
      continue;
    }

    // a defect fix found in real multi-round testing: if this API was already judged confirmed/rejected by judge/batch-judge,
    // when a later round rescans the same doc and hits the same keyword, the existing semantic judgment must never be silently overwritten back to
    // candidate — that would silently lose the human judgment result in the next scan-content round. Records already judged only get
    // matchedKDoc / matchedR appended as reference information; status / evidence are not modified, and the result explicitly marks
    // alreadyJudged, so the caller can see at a glance "this is not a new candidate, it is a recurrence of an old hit".
    const existingRec = reg.getApi(apiName);
    const existingStatus = existingRec && existingRec.docEvidence ? existingRec.docEvidence.status : null;
    const isAlreadyJudged = existingStatus === 'confirmed' || existingStatus === 'rejected';

    candidates.push({
      apiName,
      docPath: filePath,
      description: (doc.description || doc.desc || '').slice(0, 500),
      matchedKDoc,
      matchedR,
      newReturnCandidates,
      exampleCodeMentions,
      reason: matchedKDoc.length ? 'keyword-hit' : matchedR.length ? 'returnvalue-hit' : 'example-code-mention',
      alreadyJudged: isAlreadyJudged,
      existingStatus: existingStatus,
    });

    if (isAlreadyJudged) {
      // merge only keyword evidence; do not touch status, to avoid overwriting the existing judgment
      reg.setDocEvidence(
        apiName,
        {
          matchedKDoc: [...new Set([...(existingRec.docEvidence.matchedKDoc || []), ...matchedKDoc])],
          matchedR: [...new Set([...(existingRec.docEvidence.matchedR || []), ...matchedR])],
          status: existingStatus,
        },
        CALLER
      );
      alreadyJudgedSkipped.push(apiName);
      continue;
    }

    // register as a candidate, awaiting the judge command semantic judgment before promotion — not confirmed directly by this command.
    reg.ensureApi(apiName, CALLER, 'function');
    reg.setDocEvidence(
      apiName,
      {
        docPath: filePath,
        description: (doc.description || doc.desc || '').slice(0, 2000),
        matchedKDoc,
        matchedKCode: [],
        matchedR,
        exampleCodeMentions,
        status: 'candidate',
        evidence: 'content-level match hit, awaiting human / LLM judgment (registered automatically by scan-content)',
      },
      CALLER
    );
  }

  reg.save();
  const newCandidateCount = candidates.length - alreadyJudgedSkipped.length;
  const resultBody = {
    ok: true,
    candidateCount: candidates.length,
    newCandidateCount,
    alreadyJudgedCount: alreadyJudgedSkipped.length,
    novelApiCandidateCount: novelApiCandidatesFound.length,
    novelApiCandidatesFound,
    contentUnmatchedCount: contentUnmatchedFiles.length,
    contentUnmatchedWarning:
      contentUnmatchedFiles.length > 0
        ? 'hint: the following ' +
          contentUnmatchedFiles.length +
          ' files had filenames judged possibly relevant by the upstream scan-filenames, but scored zero hits on content-level keywords / return values / example code, so they did not enter the candidate queue — this does not mean they are confirmed irrelevant, only that the current keyword coverage does not reach them; see the contentUnmatchedFiles field; spot checks are recommended'
        : null,
  };
  if (outFile) {
    const dir = path.dirname(outFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      outFile,
      JSON.stringify(Object.assign({}, resultBody, { candidates, contentUnmatchedFiles }), null, 2),
      'utf8'
    );
    // contentUnmatchedWarning must also be echoed to stdout (not only exist in the persisted file), for the same reason as
    // the warning / partialWarning echo requirement of scan-filenames.
    printResult(Object.assign({}, resultBody, { savedTo: outFile }));
    return;
  }
  printResult(Object.assign({}, resultBody, { candidates, contentUnmatchedFiles }));
}

// ------------------------- pairing-check -------------------------
// corresponds to ii)-2 naming-pattern pairing detection: independent of keyword matching; for any get/start/choose/register-class API in set A,
// always check whether its on/off/stop/callback sibling names exist in the given doc directory; a hit registers it as a candidate unconditionally.
//
// the rule table was expanded after really interfacing with the WeChat mini-program permission mapping table source (matching this Skill "maximize coverage"
// requirement): the really located permission mapping table (the <framework-bundle> scope table) contains at the same time
// <sensor-start-API>/<sensor-stop-API>/<sensor-change-listener>/<sensor-off-listener>、
// <sensor-start-API>/<sensor-stop-API>/<sensor-change-listener>/<sensor-off-listener>、
// <sensor-start-API>/<sensor-stop-API>/<sensor-change-listener>/<sensor-off-listener>、
// <sensor-start-API>/<sensor-stop-API>/<sensor-change-listener>/<sensor-off-listener>
// this kind of real naming family where "one start* source API corresponds to three siblings (stop* / on*Change / off*Change)" — the original implementation
// generated only one sibling candidate group per verb prefix (start* checked only stop*), entirely missing the other two real siblings on*Change / off*Change,
// two really existing sibling APIs; even if pairing-check luckily hit stop*, on*Change / off*Change would still be
// systematically missed. Likewise, for get*, besides on{verb}{rest} / on{rest}, the sibling of <baseline-locate-API> in the real corpus is
// <locate-change-API> ("on" + rest + "Change", not <locate-listener-API> / <locate-listener-API>), which also needs adding.
// since generating candidates for non-existent files costs nothing (baseNames lookup misses simply skip, consuming no LLM call),
// expanding the candidate set only raises recall and introduces no extra judgment cost.
function makeSibling(nsPrefix, name, relation) {
  return { apiName: nsPrefix + name, relation };
}

function deriveSiblingNames(apiName) {
  const m = apiName.match(/^(wx\.)?([A-Za-z]+?)([A-Z][A-Za-z0-9]*)$/);
  if (!m) return [];
  const nsPrefix = m[1] || '';
  const verb = m[2];
  const rest = m[3];
  const verbCap = verb.charAt(0).toUpperCase() + verb.slice(1);
  const siblings = [];

  if (/^get/i.test(verb)) {
    siblings.push(makeSibling(nsPrefix, 'on' + verbCap + rest, 'callback-pair')); // onGetWifiList
    siblings.push(makeSibling(nsPrefix, 'on' + rest, 'callback-pair')); // onWifiList
    siblings.push(makeSibling(nsPrefix, 'on' + rest + 'Change', 'callback-pair')); // onLocationChange (a really verified case)
  }
  if (/^start/i.test(verb)) {
    siblings.push(makeSibling(nsPrefix, 'stop' + verbCap + rest, 'start-stop')); // stopStartXxx (rare, but kept for symmetry)
    siblings.push(makeSibling(nsPrefix, 'stop' + rest, 'start-stop')); // stopAccelerometer
    siblings.push(makeSibling(nsPrefix, 'on' + rest + 'Change', 'start-stop')); // onAccelerometerChange (a really verified case)
    siblings.push(makeSibling(nsPrefix, 'off' + rest + 'Change', 'start-stop')); // offAccelerometerChange (a really verified case)
  }
  if (/^choose/i.test(verb)) {
    siblings.push(makeSibling(nsPrefix, 'on' + verbCap + rest, 'callback-pair'));
    siblings.push(makeSibling(nsPrefix, 'on' + rest, 'callback-pair'));
  }
  if (/^request/i.test(verb)) {
    siblings.push(makeSibling(nsPrefix, 'on' + rest + 'Change', 'callback-pair'));
    siblings.push(makeSibling(nsPrefix, 'off' + rest + 'Change', 'callback-pair')); // symmetric complement to on*Change
  }
  if (/^register/i.test(verb)) {
    siblings.push(makeSibling(nsPrefix, 'on' + verbCap + rest, 'register-callback'));
    siblings.push(makeSibling(nsPrefix, 'on' + rest, 'register-callback'));
    siblings.push(makeSibling(nsPrefix, 'callback' + rest, 'register-callback'));
    siblings.push(makeSibling(nsPrefix, 'un' + verb + rest, 'register-callback')); // unregisterXxx, a common reverse operation
  }
  // CRUD naming-family detection, found and added in real analysis (corresponding to the new crud-pair enum value in scheme 2.1):
  // the permission mapping table contains the add/delete/read/update naming convention of "the same data partitioned by user identity":
  // <cloud-storage-read-API> / <cloud-storage-write-API> / <cloud-storage-delete-API> / <cloud-storage-keys-API>,
  // the previous rule table covered none of the get->set/remove direction, so such really existing family members, even once
  // the get* member entered set A, had their set* / remove* / *Keys siblings mechanically undiscoverable by naming pairing.
  // consistent with the other branches: generating candidates for non-existent files costs nothing; expansion only raises recall, not cost.
  // note: verb itself is always lowercase "get" in this branch (guaranteed by the outer /^get/i.test(verb) check),
  // so concatenation uniformly uses verb (lowercase) rather than verbCap (capitalized), because setXxx / removeXxx / getXxxKeys
  // are all complete replacement / append operations, not compound words like "on" / "un" that need to keep the original verb capitalized prefix.
  if (/^get/i.test(verb)) {
    siblings.push(makeSibling(nsPrefix, 'set' + rest, 'crud-pair')); // getUserCloudStorage -> setUserCloudStorage
    siblings.push(makeSibling(nsPrefix, 'remove' + rest, 'crud-pair')); // getUserCloudStorage -> removeUserCloudStorage
    siblings.push(makeSibling(nsPrefix, verb + rest + 'Keys', 'crud-pair')); // getUserCloudStorage -> getUserCloudStorageKeys
  }
  return siblings;
}

function cmdPairingCheck(args) {
  const reg = loadRegistry(args);
  const docRootArg = requireArg(args, 'docRoot');
  const docRoots = String(docRootArg)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allFiles = [];
  for (const root of docRoots) walkDir(root, allFiles);
  const baseNames = new Set(allFiles.map((f) => path.basename(f, path.extname(f))));

  const confirmedApis = reg
    .listApis()
    .filter((a) => a.docEvidence && a.docEvidence.status !== 'rejected');

  const newlyPaired = [];
  for (const rec of confirmedApis) {
    const bareApiName = rec.apiName.replace(/^wx\./, '');
    for (const sib of deriveSiblingNames(bareApiName)) {
      const bareSib = sib.apiName;
      const found = [...baseNames].find(
        (n) => n.toLowerCase() === bareSib.toLowerCase() || n.toLowerCase().includes(bareSib.toLowerCase())
      );
      if (found) {
        // fix (from a code defect found in reality, see references/automated-filter-tools.md section 6, 6.5 / 6.6):
        // `found` is a really existing filename (possibly the fuzzy containment match result of the template-guessed name bareSib, e.g.
        // bareSib="<beacon-listener-API>" fuzzily hitting the real file "<beacon-service-listener>"); found itself must be used
        // as the apiName registered into the registry; the template-concatenated name bareSib must not continue to be used.
        //
        // 6.6 supplementary fix (from a second-layer defect really found in hardware-management-class analysis): the 6.5 fix wrote fullSibName as
        // `rec.apiName.startsWith('wx.') ? 'wx.' + found : found` — that judgment basis is wrong:
        // whether to concatenate the "wx." prefix should depend on whether the found filename itself already carries that prefix, not on whether
        // the source API triggering this pairing (rec.apiName) starts with "wx.". The doc naming of this project uniformly follows
        // the "<namespace>-<method>" format (e.g. "wx-<sensor-change-listener>" -> "wx.<sensor-change-listener>",
        // "CameraContext-<record-stop-API>" -> "CameraContext.<record-stop-API>"); the namespace itself may be "wx",
        // or it may be some component class name — found already fully contains this namespace prefix, so simply replacing the first "-" of found with "."
        // correctly restores the apiName; there is no need (and it is wrong) to concatenate "wx." again. A observed double-prefix ghost record:
        // when the source API "wx.<sensor-start-API>" paired with the real file "wx-<sensor-change-listener>", the old logic, because
        // rec.apiName started with "wx.", concatenated "wx.wx-<sensor-change-listener>" (coexisting with the correct
        // "wx.<sensor-change-listener>" in the registry, forming a duplicate ghost record); the source API
        // "wx.<record-start-API>" paired with the real file "CameraContext-<record-stop-API>" likewise wrongly concatenated to
        // "wx.CameraContext-<record-stop-API>" (the correct value is "CameraContext.<record-stop-API>", with no wx. prefix).
        const dashIndex = found.indexOf('-');
        const fullSibName =
          dashIndex > 0
            ? found.slice(0, dashIndex) + '.' + found.slice(dashIndex + 1)
            : rec.apiName.startsWith('wx.')
              ? 'wx.' + found
              : found;
        reg.addPairedApi(rec.apiName, fullSibName, sib.relation, CALLER);
        const sibRec = reg.ensureApi(fullSibName, CALLER, 'event');
        if (!sibRec.docEvidence) {
          reg.setDocEvidence(
            fullSibName,
            {
              docPath: allFiles.find((f) => path.basename(f, path.extname(f)) === found) || null,
              description: null,
              matchedKDoc: [],
              matchedKCode: [],
              matchedR: [],
              exampleCodeMentions: [],
              status: 'candidate',
              evidence:
                'naming-pattern pairing detection hit (' + sib.relation + ', from ' + rec.apiName + '); registered as a candidate unconditionally, regardless of keyword matching',
            },
            CALLER
          );
          reg.addPairedApi(fullSibName, rec.apiName, sib.relation, CALLER);
          newlyPaired.push({ from: rec.apiName, to: fullSibName, relation: sib.relation });
        }
      }
    }
  }
  // the "same-directory fallback" detection, found and added in real analysis (same-dir-fallback; see registry.js
  // PAIRED_API_RELATIONS comment): naming-pattern pairing requires "a sibling API name can be derived from a known API name", but really
  // reproduced misses entirely fail that premise — `Channels/<channels-profile-API>` and the already confirmed
  // `<channels-key-API>` in the same directory, `ChatTool/<chat-tool-API>` and the already confirmed
  // `selectGroupMembers` in the same directory — none of their names derive any get/on/off/crud relation. Here we switch to a more naive but equally
  // reliable signal: as long as a file sits in the same doc subdirectory as an already confirmed API (the classification boundary drawn by the doc source authors themselves),
  // and that file apiName was never registered, register it as a candidate unconditionally — again following the principle that "for
  // non-existent records the cost is zero; this only raises recall and adds no misjudgment cost" (whether it is truly relevant is still left to the later
  // judge semantic judgment).
  const dirsWithConfirmedApi = new Set();
  for (const rec of confirmedApis) {
    if (rec.docEvidence && rec.docEvidence.docPath) {
      dirsWithConfirmedApi.add(path.dirname(rec.docEvidence.docPath));
    }
  }
  const sameDirFallbackFound = [];
  for (const dir of dirsWithConfirmedApi) {
    let siblingFiles;
    try {
      siblingFiles = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(dir, e.name));
    } catch (e) {
      continue;
    }
    for (const filePath of siblingFiles) {
      let doc;
      try {
        doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (e) {
        doc = {};
      }
      const guessedName = guessApiName(doc, filePath);
      const existing = reg.getApi(guessedName);
      if (existing && existing.docEvidence) continue; // already registered (whether confirmed/rejected/candidate), skip
      reg.ensureApi(guessedName, CALLER, 'function');
      reg.setDocEvidence(
        guessedName,
        {
          docPath: filePath,
          description: (doc.description || doc.desc || '').slice(0, 2000) || null,
          matchedKDoc: [],
          matchedKCode: [],
          matchedR: [],
          exampleCodeMentions: [],
          status: 'candidate',
          evidence:
            'same-directory fallback detection hit (same-dir-fallback): it belongs to the same documentation-source classification subdirectory as an already confirmed relevant API in directory "' + dir + '"; the naming pattern cannot derive this relation, so it is registered as a candidate unconditionally, regardless of keyword matching',
        },
        CALLER
      );
      sameDirFallbackFound.push({ apiName: guessedName, dir, docPath: filePath });
    }
  }

  reg.save();
  printResult({ ok: true, newlyPaired, sameDirFallbackFound, sameDirFallbackCount: sameDirFallbackFound.length });
}

// ------------------------- judge -------------------------
// corresponds to the ii) judgment: the caller (the LLM) has read the full API documentation and completed the semantic judgment; this command only persists it.

// a criterion-confusion case found in real location-class analysis (corresponding to SKILL.md core principles 3a-1 / 3a-2,
// references/automated-filter-tools.md section 6, 6.6): the Step1/Step2 semantic judgment should answer
// "does this API belong to the target domain documentation / code set" (domain membership), but it was observed that a judge used
// "does this API carry sensitive data / transmit data back" (data value, an issue that should only be handled at Step 12)
// to replace the domain-membership judgment — for instance: <map-control-API> / <map-view-API> / <map-view-API> / <map-view-API>
// (coordinates / angles specified by the developer), wx.<wifi-control-API> / <wifi-control-API> / <wifi-control-API> / <wifi-control-API> (WiFi module
// control): 28 genuinely relevant in-domain APIs in total were, because the evidence said "static rendering content is not user location data"
// or "does not return location data itself" — data-value reasons — wrongly rejected as a whole. The regex list here is only
// a lightweight heuristic hint: a hit does not mean the judgment is necessarily wrong, and a miss does not guarantee it is right; it cannot
// replace the semantic judge proactively self-checking against 3a-1 / 3a-2 — see the rules file section 6.6 "usage and limitations".
const DATA_VALUE_ONLY_REJECTION_PATTERNS = [
  /开发者(指定|传入|指明)/,
  /纯(渲染|几何|控制|展示|配置)/,
  /静态(渲染|配置|内容)/,
  /不(返回|回传|产生|涉及)[^，,。]*(数据|信息)/,
  /非[^，,。]*(数据本身|地理坐标|位置数据|用户数据|敏感数据)/,
  /(无|零)(数据回传|回传|返回值)/,
  /不返回[^，,。]*本身/,
  // English counterparts: this English skill writes evidence in English.
  /developer[ -](specified|provided|supplied)/i,
  /purely?\s+(rendering|geometric|control|display|configuration)/i,
  /static\s+(rendering|configuration|content)/i,
  /does not (return|transmit|produce|involve)[^,.]*(data|information)/i,
  /not (the data itself|geographic coordinates|location data|user data|sensitive data)/i,
  /(no|zero) (data (transmit|return)|return value)/i,
  /does not return [^,.]* itself/i,
];

function detectDataValueMisuseRisk(evidence) {
  if (!evidence || typeof evidence !== 'string') return null;
  const hit = DATA_VALUE_ONLY_REJECTION_PATTERNS.some((re) => re.test(evidence));
  if (!hit) return null;
  return (
    'hint: the wording of this rejected rationale (e.g. "developer-specified / pure rendering / does not return ... data itself") appears to rely only on "data value"' +
    'judgment (whether the API carries sensitive data), rather than "domain membership" (whether the API belongs to the target functional domain documentation / code set) —' +
    'per SKILL.md core principles 3a-1 / 3a-2, control / output class APIs, even if they carry no sensitive data themselves, as long as they belong to the target domain set in documentation / code,' +
    'should still be judged confirmed at Step1/Step2, with the data-value judgment deferred to Step12 (see data-value-framework.md, "two parallel analysis threads").' +
    'please re-check whether this API really does not belong to the target domain (e.g. directory / naming family / shared artifact are all unrelated), rather than excluding it merely for low data value;' +
    'if the exclusion rationale really is domain irrelevance (not data value), this hint can be ignored.'
  );
}

/**
 * The core logic of persisting a single judgment, shared by cmdJudge (single-item CLI) and cmdBatchJudge (batch).
 *
 * @param {object} item
 * @param {string[]} [item.matchedKDoc] semantic / CJK keywords; a hit enters K_doc
 * @param {string[]} [item.matchedKCode] code-side English identifiers; a hit enters both K_doc and K_code
 * @param {string[]} [item.matchedR] return-value property names confirmed relevant (bare strings; only the hit is registered;
 *   if this R term never had type / description metadata before, it is not filled in here — when complete metadata is needed, use
 *   newReturns below)
 * @param {object[]} [item.newReturns] corresponds to scheme a-iv-2-(3) "return values of new APIs that are not in the return-value set
 *   are sent to the LLM for judgment ... if relevant, add them to the return-value set R" — each item is a complete
 *   {propertyName, path?, type?, description?, callbackType?}, usually taken directly from
 *   the newReturnCandidates field of the scan-content output (moved in as-is once judged relevant),
 *   compared with the bare strings of matchedR, this persists metadata such as type / description completely into the R set,
 *   without loss (a defect fix found in real testing: previously, with only the matchedR channel, new return values could only enter
 *   the R set in the incomplete form of "a property name only, no type description").
 */
function applyJudge(reg, item) {
  const apiName = item.apiName;
  const verdict = item.verdict;
  if (!apiName) throw new Error('every item of a batch judgment must contain apiName');
  if (!['confirmed', 'rejected', 'candidate'].includes(verdict)) {
    throw new Error('the verdict of apiName="' + apiName + '" must be one of confirmed/rejected/candidate, received: ' + verdict);
  }
  const matchedKDoc = item.matchedKDoc || [];
  const matchedKCode = item.matchedKCode || [];
  const matchedR = item.matchedR || [];
  const newReturns = item.newReturns || [];
  const evidence = item.evidence || '';
  const docPath = item.docPath;
  const description = item.description;
  const kind = item.kind;

  if (kind) reg.setKind(apiName, kind, CALLER);

  // scheme 2.5 classification rule: "any English identifier that may appear verbatim in code ... must be classified into both K_doc and
  // K_code" — words explicitly declared in matchedKCode are double-written by the logic below; here, for words in matchedKDoc that "look
  // like code identifiers", a copy is also added to K_code as a safety net for caller misclassification (a robustness improvement;
  // it does not change the behavior of explicit caller declarations, only remedies words the caller should have put in matchedKCode but put in matchedKDoc).
  for (const t of matchedKDoc) {
    reg.addTerm('K_doc', t, apiName, CALLER);
    if (looksCodeLike(t)) reg.addTerm('K_code', t, apiName, CALLER);
  }
  for (const t of matchedKCode) {
    reg.addTerm('K_doc', t, apiName, CALLER);
    reg.addTerm('K_code', t, apiName, CALLER);
  }
  for (const r of matchedR) reg.addTerm('R', r, apiName, CALLER);
  const newReturnNames = [];
  for (const r of newReturns) {
    if (!r || !r.propertyName) continue;
    reg.addTerm('R', r.propertyName, apiName, CALLER, {
      path: r.path,
      type: r.type,
      description: r.description,
      callbackType: r.callbackType,
    });
    newReturnNames.push(r.propertyName);
  }
  const allMatchedR = [...matchedR, ...newReturnNames];

  const existing = reg.getApi(apiName);
  reg.setDocEvidence(
    apiName,
    {
      docPath: docPath || (existing && existing.docEvidence && existing.docEvidence.docPath) || null,
      description: description || (existing && existing.docEvidence && existing.docEvidence.description) || null,
      matchedKDoc: [...new Set([...(existing && existing.docEvidence ? existing.docEvidence.matchedKDoc : []), ...matchedKDoc])],
      matchedKCode: [...new Set([...(existing && existing.docEvidence ? existing.docEvidence.matchedKCode : []), ...matchedKCode])],
      matchedR: [...new Set([...(existing && existing.docEvidence ? existing.docEvidence.matchedR : []), ...allMatchedR])],
      exampleCodeMentions: (existing && existing.docEvidence && existing.docEvidence.exampleCodeMentions) || [],
      status: verdict,
      evidence,
    },
    CALLER
  );

  // an operational trap repeatedly reproduced in real analysis: judge / batch-judge only write docEvidence and never touch
  // crossValidation.finalStatus (correct by the permission matrix design; a) may not directly finalize the classification conclusion). But if this
  // API was already resolved once before and left an explicit finalStatus (even if rejected / confirmed),
  // after this re-judgment of docEvidence.status, the old finalStatus is not updated automatically — the cross-validate.js
  // compare logic of "respect the human-finalized judgment" keeps the old value as-is, even though it now contradicts the latest judgment.
  // for example: wx.<authorize-API> was judged rejected and resolved early on, then re-judged as
  // confirmed under relaxed criteria; without a proactive reminder the caller easily forgets to call resolve in sync, causing a "re-judged but not applied"
  // record to lie dormant for a long time with no error. Here we detect this proactively and warn in the result, turning "an easily forgotten step"
  // into "the tool reminds you proactively", no longer relying purely on human memory of the rules document.
  let staleFinalStatusWarning = null;
  if (existing && existing.crossValidation && existing.crossValidation.finalStatus) {
    const oldFinal = existing.crossValidation.finalStatus;
    const isStale =
      (verdict === 'confirmed' && (oldFinal === 'rejected' || oldFinal === 'knownGap')) ||
      (verdict === 'rejected' && oldFinal === 'confirmed');
    if (isStale) {
      staleFinalStatusWarning =
        'warning: this API was previously resolved by cross-validate.js to finalStatus="' +
        oldFinal +
        '", and this judge changed docEvidence.status to "' +
        verdict +
        '", but finalStatus is not updated automatically (compare respects the old human final state and does not overwrite it) —' +
        'please explicitly call cross-validate.js resolve --apiName "' +
        apiName +
        '" --finalStatus ' +
        verdict +
        ' after this round to sync the update; otherwise the final conclusion of this record stays at the outdated old judgment';
    }
  }

  // detect whether the evidence wording of this rejected judgment appears to substitute the data-value criterion for the domain-membership judgment
  // (see SKILL.md core principles 3a-1 / 3a-2, references/automated-filter-tools.md section 6, 6.6).
  // detected only for rejected — confirmed / candidate carry no risk of "wrongly excluded by the data-value criterion".
  const dataValueMisuseWarning = verdict === 'rejected' ? detectDataValueMisuseRisk(evidence) : null;

  return { apiName, verdict, staleFinalStatusWarning, dataValueMisuseWarning };
}

function cmdJudge(args) {
  const reg = loadRegistry(args);
  const apiName = requireArg(args, 'apiName');
  const verdict = requireArg(args, 'verdict'); // confirmed | rejected | candidate
  const matchedKDoc = resolveJsonInput(args, 'matchedKDoc', []);
  const matchedKCode = resolveJsonInput(args, 'matchedKCode', []);
  const matchedR = resolveJsonInput(args, 'matchedR', []);
  const newReturns = resolveJsonInput(args, 'newReturns', []);
  const result = applyJudge(reg, {
    apiName,
    verdict,
    matchedKDoc,
    matchedKCode,
    matchedR,
    newReturns,
    evidence: args.evidence || '',
    docPath: args.docPath,
    description: args.description,
    kind: args.kind,
  });
  reg.save();
  printResult({ ok: true, ...result });
}

// ------------------------- batch-judge -------------------------
// a real need found in real testing: the candidate APIs of a single functional domain often number dozens to hundreds, and walking the CLI one by one
// is inefficient and needlessly increases shell invocations, so a batch interface is provided — one process call persists all judgments.
function cmdBatchJudge(args) {
  const reg = loadRegistry(args);
  const items = resolveJsonInput(args, 'items', null);
  if (!items) fail('--items/--itemsFile is required (a JSON array, each item shaped like {apiName,verdict,matchedKDoc?,matchedKCode?,matchedR?,newReturns?,evidence?,docPath?,description?,kind?}）');

  const results = [];
  const errors = [];
  for (const item of items) {
    try {
      results.push(applyJudge(reg, item));
    } catch (e) {
      errors.push({ apiName: item.apiName, error: e.message });
    }
  }
  reg.save();
  // in batch scenarios, a single staleFinalStatusWarning / dataValueMisuseWarning is easily scattered across a large
  // results array and overlooked, so an aggregated non-empty warning list is put at the top level of the result, ensuring the caller can see at a glance
  // "how many judgments in this batch need a resolve / need the domain-membership judgment re-checked", without flipping through the results
  // array item by item.
  const staleFinalStatusWarnings = results
    .filter((r) => r.staleFinalStatusWarning)
    .map((r) => ({ apiName: r.apiName, warning: r.staleFinalStatusWarning }));
  const dataValueMisuseWarnings = results
    .filter((r) => r.dataValueMisuseWarning)
    .map((r) => ({ apiName: r.apiName, warning: r.dataValueMisuseWarning }));
  printResult({
    ok: true,
    appliedCount: results.length,
    errorCount: errors.length,
    results,
    errors,
    staleFinalStatusWarningCount: staleFinalStatusWarnings.length,
    staleFinalStatusWarnings,
    dataValueMisuseWarningCount: dataValueMisuseWarnings.length,
    dataValueMisuseWarnings,
  });
}

// ------------------------- pending -------------------------
function cmdPending(args) {
  const reg = loadRegistry(args);
  const list = reg
    .listApis((a) => a.docEvidence && a.docEvidence.status === 'candidate')
    .map((a) => ({ apiName: a.apiName, docPath: a.docEvidence.docPath, reason: a.docEvidence.evidence }));
  printResult({ ok: true, count: list.length, pending: list });
}

// ------------------------- loop-status -------------------------
// corresponds to flow 7 "loop 456 until the api set stops growing": count the current confirmed APIs and compare with the last record.
function cmdLoopStatus(args) {
  const reg = loadRegistry(args);
  const confirmedCount = reg.listApis((a) => a.docEvidence && a.docEvidence.status === 'confirmed').length;
  const prev = reg.data.meta.lastDocLoopConfirmedCount;
  reg.data.meta.lastDocLoopConfirmedCount = confirmedCount;
  reg.save();
  const grew = prev === undefined || confirmedCount > prev;
  printResult({ ok: true, confirmedCount, previousCount: prev === undefined ? null : prev, grew });
}

// ------------------------- command dispatch -------------------------
const COMMANDS = {
  init: cmdInit,
  seed: cmdSeed,
  'scan-filenames': cmdScanFilenames,
  'scan-content': cmdScanContent,
  'pairing-check': cmdPairingCheck,
  judge: cmdJudge,
  'batch-judge': cmdBatchJudge,
  pending: cmdPending,
  'loop-status': cmdLoopStatus,
};

function main() {
  runCli(COMMANDS, process.argv.slice(2));
}

main();
