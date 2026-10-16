#!/usr/bin/env node
'use strict';
/**
 * code-filter.js — the deterministic / semi-automated execution part of the scheme b) code-filtering tool.
 *
 * Positioning (same as doc-filter.js): this script only handles the parts that "pure code can solve deterministically"
 * (the scheme text repeatedly stresses b)-ii)-3 "function slicing ... needs no LLM", b)-ii)-3-a "the alias resolver ...
 * is not an LLM prompt"), plus the interface for persisting the semantic judgments the LLM completed ("function judgment", "does it belong to function X").
 * It has no built-in ability to call an LLM; semantic judgment is always done by the caller (the analysis flow driving this script).
 *
 * subcommands:
 *   init                initialize / confirm that the registry file exists (shares the same registry with doc-filter.js)
 *   locate-anchor      ii)-2 anchor retrieval: search a given code file by anchor-type regex and return hit positions
 *   extract-function   ii)-3 function slicing: bracket matching fixes the boundary, plus automatic alias / package-jump tracing; output may have several segments
 *   extract-object-keys  enumerate all top-level keys of an object literal (permission / scope mapping table), for systematically finding
 *                       table members no keyword hit and that were never registered in documentation (a methodology gap found in real analysis)
 *   resolve-alias      expose alias resolution on its own, for targeted human / caller review
 *   analyze-function   the mechanical part of iii) function analysis: count K_code / R / feature-pattern matches on the sliced function code
 *   record-code-evidence  persist the codeEvidence of an API (several CodeLocation segments, matchedKCode/R, status)
 *   feature-add        i)-3 register a CodeFeaturePattern summarized by the LLM
 *   feature-scan       i)-3 check round: scan all located functions with the existing feature rules, reporting hit rate plus a miss list
 *   feature-locate     iv)/v) feature exploitation: scan a given file range with a feature regex for new candidate anchor positions
 *   grouping-add       iv) extra-function feature extraction: register scope mapping tables / grouping hints
 *   pending            list the codeEvidence candidates awaiting judgment
 */

const fs = require('fs');
const { parseArgs, resolveJsonInput, printResult, fail, requireArg, runCli } = require('./lib/cli');
const { ApiRegistry } = require('./lib/registry');
const textUtils = require('./lib/textUtils');

const CALLER = 'codeTool';

function loadRegistry(args) {
  const regPath = requireArg(args, 'registry');
  return new ApiRegistry(regPath).load();
}

function readFileCached(cache, file) {
  if (!cache[file]) cache[file] = fs.readFileSync(file, 'utf8');
  return cache[file];
}

// ------------------------- init -------------------------
function cmdInit(args) {
  const regPath = requireArg(args, 'registry');
  if (fs.existsSync(regPath)) {
    printResult({ ok: true, action: 'exists', registry: regPath });
    return;
  }
  new ApiRegistry(regPath).load().save();
  printResult({ ok: true, action: 'created', registry: regPath });
}

// ------------------------- locate-anchor -------------------------
// Corresponds to ii)-2: the five anchor types are all retrieved by regex, returning hit positions (line + character offset + matched text + context).
const ANCHOR_TYPES = ['functionName', 'stringLiteral', 'scopeMappingTable', 'grouping', 'systemCallPattern'];
// A serious defect found and fixed in real testing: for the two anchor types stringLiteral and scopeMappingTable, the retrieval target
// is itself inside quotes (e.g. "permission:xxxx", or "scope.userInfo": [...], object keys that must be quoted because they contain a dot),
// so if we unconditionally search the masked text with "string content masked out", these two anchor types can never find any result —
// reproduced on real code (the scope permission mapping table in <framework-bundle>): `scope\.userInfo`
// hit 0 times, yet that string really exists at source line 81527. Fix: search the masked text only for functionName / grouping /
// systemCallPattern (whose search target is the code structure itself and needs strings/comments masked to avoid false matches);
// for stringLiteral / scopeMappingTable (whose search target is the text inside the quotes), search the original unmasked
// source instead; the cost is possibly matching same-named text in comments, but that is far less severe than "never finding it".
const ANCHOR_TYPES_SEARCH_ON_RAW_SOURCE = ['stringLiteral', 'scopeMappingTable'];

function cmdLocateAnchor(args) {
  const codeFile = requireArg(args, 'codeFile');
  const anchorType = requireArg(args, 'anchorType');
  const patternStr = requireArg(args, 'pattern');
  if (!ANCHOR_TYPES.includes(anchorType)) {
    fail('--anchorType must be one of ' + ANCHOR_TYPES.join('/'));
  }
  const source = fs.readFileSync(codeFile, 'utf8');
  const lineIndex = textUtils.buildLineIndex(source);
  const searchOnRaw = ANCHOR_TYPES_SEARCH_ON_RAW_SOURCE.includes(anchorType);
  const searchText = searchOnRaw ? source : textUtils.maskStringsAndComments(source);
  let re;
  try {
    re = new RegExp(patternStr, 'g');
  } catch (e) {
    fail('invalid regular expression: ' + e.message);
  }
  const hits = [];
  let m;
  // functionName/grouping/systemCallPattern are located on the masked text, avoiding false matches inside strings / comments;
  // stringLiteral/scopeMappingTable are located on the original source (see the comment above).
  // in either mode, the output matchedText comes from the original source, preserving the real character content
  // (masking only replaces characters with spaces; length and offsets are identical to the source, so they map directly).
  while ((m = re.exec(searchText)) !== null) {
    const charIndex = m.index;
    const lineNumber = textUtils.lineOfOffset(lineIndex, charIndex);
    hits.push({
      charIndex,
      lineNumber,
      matchedText: source.slice(charIndex, m.index + m[0].length),
      contextBefore: source.slice(Math.max(0, charIndex - 80), charIndex),
      contextAfter: source.slice(m.index + m[0].length, m.index + m[0].length + 80),
    });
    if (m[0].length === 0) re.lastIndex++; // guard against an infinite loop on empty matches
  }
  printResult({ ok: true, codeFile, anchorType, pattern: patternStr, searchedOn: searchOnRaw ? 'rawSource' : 'maskedSource', hitCount: hits.length, hits });
}

// ------------------------- extract-function -------------------------
// Corresponds to ii)-3: bracket counting fixes the function boundary (zero LLM), and when the boundary content looks like "key: short alias" it automatically tries alias / package-jump tracing.
function cmdExtractFunction(args) {
  const codeFile = requireArg(args, 'codeFile');
  const charIndex = args.charIndex !== undefined ? parseInt(args.charIndex, 10) : undefined;
  const lineArg = args.line !== undefined ? parseInt(args.line, 10) : undefined;
  const maxExpand = args.maxExpand ? parseInt(args.maxExpand, 10) : 20;

  const source = fs.readFileSync(codeFile, 'utf8');
  const lineIndex = textUtils.buildLineIndex(source);

  let idx = charIndex;
  if (idx === undefined) {
    if (lineArg === undefined) fail('one of --charIndex or --line is required');
    idx = textUtils.offsetOfLine(lineIndex, lineArg);
    if (idx === -1) fail('line number ' + lineArg + ' is out of file range');
  }

  const block = textUtils.extractEnclosingFunction(source, idx, maxExpand);
  if (!block) {
    printResult({ ok: true, codeFile, found: false, note: 'no code block containing this position was found (it may not be inside any {}, or the file brackets do not balance)' });
    return;
  }

  const startLine = textUtils.lineOfOffset(lineIndex, block.startIndex);
  const endLine = textUtils.lineOfOffset(lineIndex, block.endIndex);
  const snippet = source.slice(block.startIndex, block.endIndex + 1);

  // The "scopeMappingTable/grouping" anchor scenario of CodeLocation.role in scheme 2.3: the caller has explicitly stated
  // that this position was found via a scope mapping table / grouping anchor, but the classifyBlockRole heuristic only sees "is this code block
  // exactly the property value of something else", so for a top-level mapping-table assignment like `var n = {...}` (not a property value of any outer object)
  // it misjudges it as 'helper' — reproduced in real testing: a large permission mapping table was classified 'helper' as a whole,
  // disconnected from the semantics "this is obviously a mapping table". Here, if the caller explicitly declares anchorType as
  // scopeMappingTable/grouping and the heuristic gives the weaker 'helper' judgment, it is actively upgraded to
  // 'mappingEntry'; if the heuristic already gave the more specific 'main' (meaning this position is actually a function implementation,
  // perhaps because the caller passed the wrong anchorType), it is not overwritten; the classification conflict is only recorded in notes for human review,
  // avoiding a weaker prior overriding a more specific deterministic judgment.
  let role = block.role;
  const roleUpgradeNotes = [];
  if ((args.anchorType === 'scopeMappingTable' || args.anchorType === 'grouping') && role === 'helper') {
    role = 'mappingEntry';
    roleUpgradeNotes.push('role was upgraded per --anchorType="' + args.anchorType + '" from the heuristic "helper" to "mappingEntry"');
  } else if ((args.anchorType === 'scopeMappingTable' || args.anchorType === 'grouping') && role === 'main') {
    roleUpgradeNotes.push('note: --anchorType="' + args.anchorType + '" conflicts with the heuristic role="main"; it was not overwritten automatically, please confirm manually whether this position is a mapping-table entry or a real function implementation');
  }

  const location = {
    file: codeFile,
    startLine,
    endLine,
    role,
    anchorType: args.anchorType || null,
    anchorEvidence: args.anchorEvidence || null,
    aliasChain: [],
  };

  const segments = [location];
  const notes = [...roleUpgradeNotes];
  if (block.note) notes.push(block.note);

  // if the boundary content looks like "apiName: dz.w" (role=mappingEntry, or a very short main block that seems to be only an alias forwarder),
  // automatically try alias / package-jump tracing — corresponding to the scheme example "<group-member-API>: dz.w".
  const aliasCandidateMatch = snippet.match(/:\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*[,}]/);
  if (aliasCandidateMatch && (location.role === 'mappingEntry' || snippet.length < 120)) {
    const aliasExpr = aliasCandidateMatch[1];
    const resolved = textUtils.resolveAliasChain(source, aliasExpr);
    if (resolved) {
      // Scheme 2.3: role="registration" specifically means "only an alias pointer inside the top-level API registry" — this current segment
      // {key: alias} is exactly such a pure pointer entry (the real implementation is elsewhere and has been traced via aliasChain resolution),
      // so it should no longer be marked with the generic 'mappingEntry' / 'helper'; the more precise 'registration' replaces them,
      // forming a clear contrast with the subsequently appended "real implementation" segment (role='main').
      location.role = 'registration';
      location.aliasChain.push({ ref: aliasExpr, resolvedTo: 'module:' + resolved.resolvedModule });
      const modDef = textUtils.findModuleDefinition(source, resolved.resolvedModule);
      if (modDef) {
        const modStartLine = textUtils.lineOfOffset(lineIndex, modDef.startIndex);
        const modEndLine = textUtils.lineOfOffset(lineIndex, modDef.endIndex);
        segments.push({
          file: codeFile,
          startLine: modStartLine,
          endLine: modEndLine,
          role: 'main',
          anchorType: 'stringLiteral',
          anchorEvidence: resolved.matchedText,
          aliasChain: [{ ref: aliasExpr, resolvedTo: 'module:' + resolved.resolvedModule }],
        });
        notes.push('the alias "' + aliasExpr + '" was resolved automatically to module ' + resolved.resolvedModule + ' (' + resolved.pattern + ') and appended as a second CodeLocation; this segment role is marked registration');
      } else {
        notes.push('the alias "' + aliasExpr + '" resolved to module number ' + resolved.resolvedModule + ', but the module definition body could not be located in the current file; it may be in another file and needs a human or the LLM to help locate it (this segment role is still marked registration, because it really is an alias pointer, even though the target has not been traced yet)');
      }
    } else {
      notes.push('a suspected alias reference "' + aliasExpr + '" was detected, but the regex could not parse a clear assignment pattern (possibly destructuring assignment / dynamic property access); fall back to the LLM to judge "is this an alias reference, and where should we look"');
    }
  }

  printResult({
    ok: true,
    codeFile,
    found: true,
    segments,
    notes,
    snippetPreview: snippet.length > 4000 ? snippet.slice(0, 4000) + '\n/* ...truncated; read the file by startLine/endLine for the full content... */' : snippet,
  });
}

// ------------------------- extract-object-keys -------------------------
// Systematically enumerate all top-level members of a permission / scope mapping table, corresponding to a methodology gap found in real analysis:
// previously table members could only be found by "keyword hits", so if a member name never entered the initial keyword seed it would never be
// discovered systematically (for instance: the cloud-storage family APIs such as <cloud-storage-peer-API> under the jsapi_wxfriend_interaction group
// could never be found by keyword scanning when the Step 1 seed words contained nothing like "cloudStorage" / "friend");
// usage: first use locate-anchor to find the anchor position of any known member inside the table (e.g.
// "scope.userInfo"), then point this command --line/--charIndex at that position; it automatically expands outward to find the whole table
// boundary and enumerates all keys, producing a list for the caller to compare against the Step 1 doc-side confirmed inventory to obtain the unregistered-member list.
function cmdExtractObjectKeys(args) {
  const codeFile = requireArg(args, 'codeFile');
  const charIndex = args.charIndex !== undefined ? parseInt(args.charIndex, 10) : undefined;
  const lineArg = args.line !== undefined ? parseInt(args.line, 10) : undefined;
  const maxExpand = args.maxExpand ? parseInt(args.maxExpand, 10) : 20;

  const source = fs.readFileSync(codeFile, 'utf8');
  const lineIndex = textUtils.buildLineIndex(source);

  let idx = charIndex;
  if (idx === undefined) {
    if (lineArg === undefined) fail('one of --charIndex or --line is required (pointing at any known member inside the table, or at the table itself)');
    idx = textUtils.offsetOfLine(lineIndex, lineArg);
    if (idx === -1) fail('line number ' + lineArg + ' is out of file range');
  }

  const block = textUtils.extractEnclosingFunction(source, idx, maxExpand);
  if (!block) {
    printResult({ ok: true, codeFile, found: false, note: 'no code block containing this position was found (it may not be inside any {}, or the file brackets do not balance)' });
    return;
  }

  const entries = textUtils.extractObjectTopLevelKeys(source, block.startIndex, block.endIndex);
  const startLine = textUtils.lineOfOffset(lineIndex, block.startIndex);
  const endLine = textUtils.lineOfOffset(lineIndex, block.endIndex);

  printResult({
    ok: true,
    codeFile,
    found: true,
    startLine,
    endLine,
    role: block.role,
    totalKeys: entries.length,
    keys: entries,
    note:
      block.role !== 'mappingEntry' && entries.length < 2
        ? 'warning: the sliced block role is "' + block.role + '" and the top-level key count is very small; it may not be the object-literal mapping table itself. Check whether --line/--charIndex lands precisely on an entry inside the table'
        : undefined,
  });
}

// ------------------------- resolve-alias -------------------------
function cmdResolveAlias(args) {
  const codeFile = requireArg(args, 'codeFile');
  const aliasExpr = requireArg(args, 'aliasExpr');
  const source = fs.readFileSync(codeFile, 'utf8');
  const resolved = textUtils.resolveAliasChain(source, aliasExpr);
  if (!resolved) {
    printResult({
      ok: true,
      resolved: false,
      note: 'the regex could not parse a clear assignment pattern; it is recommended to fall back to the LLM to judge "is this an alias reference, and where should we look"',
    });
    return;
  }
  const modDef = textUtils.findModuleDefinition(source, resolved.resolvedModule);
  const lineIndex = textUtils.buildLineIndex(source);
  printResult({
    ok: true,
    resolved: true,
    resolvedModule: resolved.resolvedModule,
    matchedText: resolved.matchedText,
    pattern: resolved.pattern,
    moduleLocation: modDef
      ? {
          startLine: textUtils.lineOfOffset(lineIndex, modDef.startIndex),
          endLine: textUtils.lineOfOffset(lineIndex, modDef.endIndex),
        }
      : null,
  });
}

// ------------------------- analyze-function -------------------------
// The mechanical part of iii) function analysis: count the K_code / R / feature-pattern hits on the sliced function source,
// so the caller (the LLM) can combine these clues into the final "does it belong to function X" semantic judgment.
function cmdAnalyzeFunction(args) {
  const reg = loadRegistry(args);
  const file = requireArg(args, 'codeFile');
  const startLine = parseInt(requireArg(args, 'startLine'), 10);
  const endLine = parseInt(requireArg(args, 'endLine'), 10);
  const source = fs.readFileSync(file, 'utf8');
  const lineIndex = textUtils.buildLineIndex(source);
  const startOffset = textUtils.offsetOfLine(lineIndex, startLine);
  const endOffsetLineStart = textUtils.offsetOfLine(lineIndex, endLine + 1);
  const endOffset = endOffsetLineStart === -1 ? source.length : endOffsetLineStart;
  const snippet = source.slice(startOffset, endOffset);

  const activeKCode = reg.listTerms('K_code', 'active');
  const activeR = reg.listTerms('R', 'active');
  const matchedKCode = activeKCode.filter((t) => snippet.includes(t.term)).map((t) => t.term);
  const matchedR = activeR.filter((t) => snippet.includes(t.term)).map((t) => t.term);

  const featurePatterns = reg.listFeaturePatterns();
  const matchedFeatures = [];
  for (const fp of featurePatterns) {
    try {
      const re = new RegExp(fp.regexOrTemplate);
      const m = snippet.match(re);
      if (m) matchedFeatures.push({ featureId: fp.featureId, featureType: fp.featureType, matchedText: m[0].slice(0, 200) });
    } catch (e) {
      // ignore patterns that cannot be parsed as a regex (template-type features may be only natural-language descriptions, left to the LLM to judge)
    }
  }

  printResult({
    ok: true,
    file,
    startLine,
    endLine,
    matchedKCode,
    matchedR,
    matchedFeatures,
    snippetPreview: snippet.length > 4000 ? snippet.slice(0, 4000) + '\n/* ...truncated... */' : snippet,
  });
}

// ------------------------- record-code-evidence -------------------------
function cmdRecordCodeEvidence(args) {
  const reg = loadRegistry(args);
  const apiName = requireArg(args, 'apiName');
  const status = requireArg(args, 'status'); // confirmed | candidate | rejected
  const locations = resolveJsonInput(args, 'locations', []);
  const matchedKCode = resolveJsonInput(args, 'matchedKCode', []);
  const matchedR = resolveJsonInput(args, 'matchedR', []);
  const evidence = args.evidence || '';
  const mode = args.mode || 'append'; // append | replace

  if (!['confirmed', 'candidate', 'rejected'].includes(status)) {
    fail('--status must be one of confirmed/candidate/rejected');
  }

  const existing = reg.getApi(apiName);
  let finalLocations = locations;
  if (mode === 'append' && existing && existing.codeEvidence) {
    const existed = existing.codeEvidence.locations || [];
    const seen = new Set(existed.map((l) => l.file + ':' + l.startLine + '-' + l.endLine));
    const merged = existed.slice();
    for (const loc of locations) {
      const key = loc.file + ':' + loc.startLine + '-' + loc.endLine;
      if (!seen.has(key)) {
        merged.push(loc);
        seen.add(key);
      }
    }
    finalLocations = merged;
  }

  reg.setCodeEvidence(
    apiName,
    {
      locations: finalLocations,
      matchedKCode: [...new Set([...(existing && existing.codeEvidence ? existing.codeEvidence.matchedKCode : []), ...matchedKCode])],
      matchedR: [...new Set([...(existing && existing.codeEvidence ? existing.codeEvidence.matchedR : []), ...matchedR])],
      status,
      evidence,
    },
    CALLER
  );

  // The same real operational trap detection as applyJudge in doc-filter.js (see that file comment for details): after changing
  // codeEvidence.status, if this API already had an explicit finalStatus from resolve and it now conflicts,
  // crossValidation does not sync automatically, so proactively remind the caller to run resolve once more.
  let staleFinalStatusWarning = null;
  if (existing && existing.crossValidation && existing.crossValidation.finalStatus) {
    const oldFinal = existing.crossValidation.finalStatus;
    const isStale =
      (status === 'confirmed' && (oldFinal === 'rejected' || oldFinal === 'knownGap')) ||
      (status === 'rejected' && oldFinal === 'confirmed');
    if (isStale) {
      staleFinalStatusWarning =
        'warning: this API was previously resolved by cross-validate.js to finalStatus="' +
        oldFinal +
        '", and this record-code-evidence changed codeEvidence.status to "' +
        status +
        '", but finalStatus is not updated automatically — please explicitly call cross-validate.js resolve --apiName "' +
        apiName +
        '" --finalStatus ' +
        status +
        ' to sync the update';
    }
  }

  reg.save();
  printResult({ ok: true, apiName, status, locationCount: finalLocations.length, staleFinalStatusWarning });
}

// ------------------------- feature-add -------------------------
function cmdFeatureAdd(args) {
  const reg = loadRegistry(args);
  const featureId = requireArg(args, 'featureId');
  const featureType = requireArg(args, 'featureType');
  const patternDescription = args.patternDescription || '';
  const regexOrTemplate = requireArg(args, 'regexOrTemplate');
  const derivedFromApis = resolveJsonInput(args, 'derivedFromApis', []);
  const round = reg.getCurrentRound();

  reg.addFeaturePattern(
    { featureId, featureType, patternDescription, regexOrTemplate, derivedFromApis, round, matchedFunctionsCount: 0 },
    CALLER
  );
  reg.save();
  printResult({ ok: true, featureId, round });
}

// ------------------------- feature-scan -------------------------
// Corresponds to the i)-3 check round: run all existing feature regexes over all currently located functions,
// update matchedFunctionsCount for each feature, and collect the list of functions that "matched no feature at all",
// for the caller to use as input samples for the next feature-summary round — "this verification action should be mandatory, not omittable".
function cmdFeatureScan(args) {
  const reg = loadRegistry(args);
  const featurePatterns = reg.listFeaturePatterns();
  const fileCache = {};
  const unmatchedFunctions = [];
  const perFeatureCounts = {};
  for (const fp of featurePatterns) perFeatureCounts[fp.featureId] = 0;

  const apisWithCode = reg.listApis((a) => a.codeEvidence && a.codeEvidence.locations && a.codeEvidence.locations.length);

  for (const rec of apisWithCode) {
    for (const loc of rec.codeEvidence.locations) {
      let source;
      try {
        source = readFileCached(fileCache, loc.file);
      } catch (e) {
        continue;
      }
      const lineIndex = textUtils.buildLineIndex(source);
      const startOffset = textUtils.offsetOfLine(lineIndex, loc.startLine);
      const endOffsetLineStart = textUtils.offsetOfLine(lineIndex, loc.endLine + 1);
      const endOffset = endOffsetLineStart === -1 ? source.length : endOffsetLineStart;
      const snippet = source.slice(startOffset, endOffset);

      let anyMatched = false;
      for (const fp of featurePatterns) {
        try {
          const re = new RegExp(fp.regexOrTemplate);
          if (re.test(snippet)) {
            perFeatureCounts[fp.featureId]++;
            anyMatched = true;
          }
        } catch (e) {
          // feature patterns that are not regex form (natural-language descriptions) skip the mechanical scan
        }
      }
      if (!anyMatched && featurePatterns.length > 0) {
        unmatchedFunctions.push({ apiName: rec.apiName, file: loc.file, startLine: loc.startLine, endLine: loc.endLine });
      }
    }
  }

  for (const fp of featurePatterns) fp.matchedFunctionsCount = perFeatureCounts[fp.featureId];
  reg.save();

  printResult({
    ok: true,
    totalFeatures: featurePatterns.length,
    perFeatureCounts,
    unmatchedFunctionCount: unmatchedFunctions.length,
    unmatchedFunctions,
    note:
      unmatchedFunctions.length > 0
        ? 'there are functions that matched no feature at all; per the scheme, use these as samples for the next feature-summary round (from round=' + (reg.getCurrentRound()) + ')'
        : 'all located functions matched at least one feature, so the multi-round verification of feature consolidation can be considered converged',
  });
}

// ------------------------- feature-locate -------------------------
// Corresponds to iv)/v) feature exploitation: treat a feature regexOrTemplate as a new anchor and scan a given file range,
// slice the function at each new hit and produce a candidate position list (apiName left empty for the caller to infer / judge, then
// register formally via record-code-evidence — the scheme text "b) infer the api corresponding to the newly added function" is a semantic task).
//
// A serious defect found and fixed in real analysis (same root cause as the stringLiteral/scopeMappingTable fix in locate-anchor
// earlier): this command previously searched unconditionally only the text processed by maskStringsAndComments, but
// among CodeFeaturePattern four featureTypes (systemDataFetch / permissionCheck / keywordUsage /
// returnValueUsage), most features actually summarized in practice inherently need to match string literal content itself
// (e.g. the backend interface identifier or return field name inside `apiName: "<dispatch-gateway>_xxx"`), not merely a bare identifier structure —
// once the characters targeted by a feature regex fall inside a string, maskStringsAndComments replaces that content with
// whitespace, so the feature can never find any result, with no error or warning, and it is misread as "this feature genuinely
// has no further findings in the whole file range". Example: 3 features summarized from real function bodies (systemDataFetch /
// returnValueUsage / permissionCheck, all relying on matching the <dispatch-gateway>_ prefix string or sensitive field names)
// scored 0 hits across 4 code files (including files with no known-excluded ranges); switching to a control feature that does not rely on string content
// (the pure bare identifier `withCredentials\s*:`) immediately found 3 new candidates in the same file (2 of them later confirmed as
// relevant findings: the real core implementation of wx.<profile-API>, and the dispatch gateway module shared by the whole <dispatch-gateway>_* family).
// Fix: search both the masked text and the original source once each, merging and deduplicating by character offset — purely structural
// features give identical results in both searches (unaffected); features depending on string content can only hit in the raw search,
// thereby guaranteeing no more "silent false negatives". The trade-off matches the one made for locate-anchor: the raw search may additionally
// hit same-named text inside comments, but that is far less severe than "never finding it".
function cmdFeatureLocate(args) {
  const reg = loadRegistry(args);
  const featureId = requireArg(args, 'featureId');
  const codeFile = requireArg(args, 'codeFile');
  const maxExpand = args.maxExpand ? parseInt(args.maxExpand, 10) : 20;

  const fp = reg.listFeaturePatterns().find((f) => f.featureId === featureId);
  if (!fp) fail('feature not found, featureId="' + featureId + '"');

  const source = fs.readFileSync(codeFile, 'utf8');
  const masked = textUtils.maskStringsAndComments(source);
  const lineIndex = textUtils.buildLineIndex(source);

  let reMasked, reRaw;
  try {
    reMasked = new RegExp(fp.regexOrTemplate, 'g');
    reRaw = new RegExp(fp.regexOrTemplate, 'g');
  } catch (e) {
    fail('the regexOrTemplate of feature "' + featureId + '" is not a valid regex; feature-locate supports regex-form features only');
  }

  // already-known, already-registered function position ranges, to avoid re-counting a confirmed API own hit as a "new candidate"
  const knownRanges = [];
  for (const rec of reg.listApis()) {
    if (rec.codeEvidence) {
      for (const loc of rec.codeEvidence.locations || []) {
        if (loc.file === codeFile) knownRanges.push([loc.startLine, loc.endLine]);
      }
    }
  }
  const isKnown = (line) => knownRanges.some(([s, e]) => line >= s && line <= e);

  // collect the character-offset sets hit by both searches (the key to merging and deduplication: deduplicate by charIndex; for a purely structural hit,
  // masked/raw give exactly the same charIndex, so it is naturally counted once); also record, for each hit,
  // its match length on the text it was found in, so matchedText can later be taken straight from source without re-running
  // the regex once. For structural features the masked match length equals the raw one (because masking only replaces
  // characters and never changes length), so it can be reused directly.
  const hitLengths = new Map(); // charIndex -> matchLength
  function collectHits(re, text) {
    let m;
    while ((m = re.exec(text)) !== null) {
      if (!hitLengths.has(m.index)) hitLengths.set(m.index, m[0].length);
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  collectHits(reMasked, masked);
  collectHits(reRaw, source);

  const candidates = [];
  for (const [charIndex, matchLength] of hitLengths) {
    const lineNumber = textUtils.lineOfOffset(lineIndex, charIndex);
    if (isKnown(lineNumber)) continue;
    const block = textUtils.extractEnclosingFunction(source, charIndex, maxExpand);
    if (block) {
      candidates.push({
        matchedLine: lineNumber,
        matchedText: source.slice(charIndex, charIndex + matchLength),
        candidateLocation: {
          file: codeFile,
          startLine: textUtils.lineOfOffset(lineIndex, block.startIndex),
          endLine: textUtils.lineOfOffset(lineIndex, block.endIndex),
          role: block.role,
          anchorType: 'systemCallPattern',
          anchorEvidence: 'feature-exploitation hit: ' + featureId,
          aliasChain: [],
        },
      });
    }
  }

  // deduplicate (the same function block may be hit several times by the same feature)
  const dedup = [];
  const seen = new Set();
  for (const c of candidates) {
    const key = c.candidateLocation.startLine + '-' + c.candidateLocation.endLine;
    if (!seen.has(key)) {
      seen.add(key);
      dedup.push(c);
    }
  }

  printResult({
    ok: true,
    featureId,
    codeFile,
    newCandidateCount: dedup.length,
    candidates: dedup,
    note: 'the apiName of each candidate is to be inferred and judged by the caller, then registered via record-code-evidence (corresponding to scheme b)-i)-4-b/c)',
  });
}

// ------------------------- grouping-add -------------------------
// Corresponds to iv) extra-function feature extraction: scope permission mapping tables / grouping hints, registered into the global grouping table and linked to concrete APIs.
function cmdGroupingAdd(args) {
  const reg = loadRegistry(args);
  const groupKey = requireArg(args, 'groupKey');
  const evidenceType = requireArg(args, 'evidenceType'); // scopeMappingTable | functionalGrouping
  const location = resolveJsonInput(args, 'location', null);
  const memberApis = resolveJsonInput(args, 'memberApis', []);

  if (!['scopeMappingTable', 'functionalGrouping'].includes(evidenceType)) {
    fail('--evidenceType must be one of scopeMappingTable/functionalGrouping');
  }

  reg.addGlobalGroupingHintEntry({ groupKey, evidenceType, location, memberApis }, CALLER);
  for (const apiName of memberApis) {
    reg.addGroupingHint(apiName, { groupKey, evidenceType, evidence: location ? JSON.stringify(location) : '' }, CALLER);
  }
  reg.save();
  printResult({ ok: true, groupKey, memberApis });
}

// ------------------------- pending -------------------------
function cmdPending(args) {
  const reg = loadRegistry(args);
  const list = reg
    .listApis((a) => a.codeEvidence && a.codeEvidence.status === 'candidate')
    .map((a) => ({ apiName: a.apiName, locations: a.codeEvidence.locations, evidence: a.codeEvidence.evidence }));
  printResult({ ok: true, count: list.length, pending: list });
}

// ------------------------- command dispatch -------------------------
const COMMANDS = {
  init: cmdInit,
  'locate-anchor': cmdLocateAnchor,
  'extract-function': cmdExtractFunction,
  'extract-object-keys': cmdExtractObjectKeys,
  'resolve-alias': cmdResolveAlias,
  'analyze-function': cmdAnalyzeFunction,
  'record-code-evidence': cmdRecordCodeEvidence,
  'feature-add': cmdFeatureAdd,
  'feature-scan': cmdFeatureScan,
  'feature-locate': cmdFeatureLocate,
  'grouping-add': cmdGroupingAdd,
  pending: cmdPending,
};

function main() {
  runCli(COMMANDS, process.argv.slice(2));
}

main();
