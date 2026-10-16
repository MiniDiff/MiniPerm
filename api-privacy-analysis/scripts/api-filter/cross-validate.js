#!/usr/bin/env node
'use strict';
/**
 * cross-validate.js — the scheme c) cross-validation tool.
 *
 * Positioning: this script is the "outer driver" of the a)<->b)<->c) loop — it holds the global round counter (advanceRound may only
 * be called by this tool) and is responsible for:
 *   1. i) convergence judgment: compare one by one whether each ApiRecord has both docEvidence and codeEvidence,
 *      and give the "candidate classification" of matchType and reasonIfMismatch per the scheme two-branch logic (pure code can only reach
 *      objective factual classifications such as "present on both sides" / "already paired"; deciding whether it is "a false positive from a documentation misjudgment"
 *      or "the target code file range did not cover it" — sub-cause classification requiring semantic understanding — still needs the caller, based on
     the report result, to make the final judgment and then write it back via the resolve command);
 *   2. ii) provenance pruning: call the tiering rules of lib/stats.js; Tier1 executes automatically, Tier2/3 only produce suggestions;
 *   3. produce the per-round summary tables (Markdown), with the two sections "added/removed APIs" and "keyword / return-value health".
 *
 * subcommands:
 *   init          initialize / confirm that the registry file exists
 *   compare       i) run the comparison, producing matchType classifications (doc-only / code-only / matched)
 *   resolve       write back the final judgment for a docOnly/codeOnly record (reasonIfMismatch / finalStatus)
 *   prune         ii) run this round pruning tiering (Tier1 executes automatically, Tier2/3 only produce suggestions)
 *   summary       produce this round summary Markdown (added/removed APIs + health table) and advance the round
 *   check-loop    check whether the convergence condition or the round cap (10 rounds) is reached, deciding whether to continue
 *   export        export all ApiRecords grouped by finalStatus, plus the grouping-hint table and feature patterns, for Step 1 / Step 2
 *                 persisted files (_tmp_<abbr>_step1_api_list.md / _tmp_<abbr>_step2_code_check.md) to draw on
 */

const fs = require('fs');
const path = require('path');
const { parseArgs, resolveJsonInput, printResult, fail, requireArg, runCli } = require('./lib/cli');
const { ApiRegistry } = require('./lib/registry');
const { classifyTier, falsePositiveRate } = require('./lib/stats');

const CALLER = 'validationTool';
const DEFAULT_MAX_ROUNDS = 10;

function loadRegistry(args) {
  const regPath = requireArg(args, 'registry');
  return new ApiRegistry(regPath).load();
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

// ------------------------- compare -------------------------
// Corresponds to the i) convergence condition. Aggregation rule (explicitly required by the scheme): the code-side comparison unit is the "aggregated API" —
// no matter how many segments codeEvidence.locations has under one apiName, it counts as one code-side confirmation of that API;
// the aggregation already happened in b) record-code-evidence via "multiple appends under the same apiName",
// so this command reads the aggregated result directly and does not concatenate on the fly.
/**
 * Two problems found and fixed during real review:
 *
 * (1) Dead code: the original implementation had a special `docRejected` check inside the `hasDoc && !hasCode` branch,
 *    but `hasDoc` is itself defined as `docEvidence && status !== 'rejected'` — once `hasDoc`
 *    is true, `status` necessarily is not `'rejected'`, making that branch unreachable. The genuinely "documentation side has explicitly
 *    rejected it, and the code side does not have it either" scenario actually fell into the vague `unresolved` bucket of "no valid evidence on either side"
 *    below, losing the more precise "knowledge gap" hint it deserved. The judgment is now reorganized around the three states on each of the doc and code sides,
 *    (absent/rejected/active), so every real combination hits an appropriate branch.
 *
 * (2) The matched type was never finalized automatically: the original `cmdCompare` unconditionally wrote `finalStatus` as
 *    "reuse the previous value if any, otherwise default to candidate", even for matchType==='matched' (the two sides already corroborate each other,
 *    the "success" case that needs no manual triage at all), so a matched record finalStatus
 *    stayed forever at the placeholder 'candidate', while `check-loop` `unresolvedCount` happens to treat
 *    `finalStatus==='candidate'` as the "unresolved" marker: as soon as any matched record exists
 *    (the most common case), the loop can never truly `stop-converged` and can only be
 *    hard-stopped by the round cap, and `export` also wrongly puts these APIs that should be confirmed into the stillCandidate bucket.
 *    Fix: for matched, and for "both sides explicitly judged rejected" (not an empty shell, genuinely settled),
 *    the two cases needing no manual triage, this function returns `autoFinalStatus` for `cmdCompare` to adopt directly.
 */
function classifyMismatchHint(rec) {
  const docStatus = rec.docEvidence ? rec.docEvidence.status : 'absent';
  const codeStatus = rec.codeEvidence ? rec.codeEvidence.status : 'absent';
  const hasDoc = docStatus !== 'absent' && docStatus !== 'rejected';
  const hasCode = codeStatus !== 'absent' && codeStatus !== 'rejected';

  if (hasDoc && hasCode) {
    return { matchType: 'matched', reasonIfMismatch: null, autoFinalStatus: 'confirmed' };
  }

  if (hasDoc && !hasCode) {
    if (codeStatus === 'rejected') {
      return {
        matchType: 'docOnly',
        reasonIfMismatch:
          'the code side once hit a candidate location for this API but it was judged rejected (not "never found", but "found yet judged not a real implementation") — a human or the caller must judge whether the code-side rejected judgment was wrong, or whether the documentation side has it but the code does not implement it / has deprecated it',
        suggestedSubReason: 'code-side-explicit-rejection',
      };
    }
    return {
      matchType: 'docOnly',
      reasonIfMismatch:
        'the documentation has this API but the code side did not locate it — a human or the caller must judge the concrete cause: (1) the code file range does not cover the file containing this API (widen the code search scope); (2) anchor / alias resolution failed (switch the anchor strategy); (3) the API is deprecated and genuinely absent from the code (downgrade it to a known gap)',
      suggestedSubReason: 'undetermined-needs-triage',
    };
  }

  if (!hasDoc && hasCode) {
    if (docStatus === 'rejected') {
      return {
        matchType: 'codeOnly',
        reasonIfMismatch:
          'the documentation side itself judged this API rejected (perhaps a naming-pair detection false hit or a semantic judgment of irrelevance), yet the code side did locate an implementation — a human or the caller must judge: (1) whether the original documentation-side rejected judgment was wrong (the API may exist but was misjudged due to an unclear description); (2) whether the code-side anchor / feature regex was too broad and produced a false positive',
        suggestedSubReason: 'doc-side-explicit-rejection',
      };
    }
    return {
      matchType: 'codeOnly',
      reasonIfMismatch:
        'the code side found this API via a feature anchor but it is absent from the documentation list — a human or the caller must judge: (1) a genuine "documentation missing" finding (adopt it directly and merge into set A, corresponding to the Step 7 "API-entry-level documentation missing" tag); (2) a false positive from an overly broad feature regex (judge it discarded)',
      suggestedSubReason: 'undetermined-needs-triage',
    };
  }

  // hasDoc=false && hasCode=false: further distinguish "both sides explicitly checked and judged rejected" (already settled,
  // no need to trigger triage) from "no evidence at all on either side" (a genuine empty-shell record, usually a data-pipeline anomaly,
  // needing manual investigation; it must not be finalized automatically, nor should autoFinalStatus silently erase this anomaly signal).
  if (docStatus === 'rejected' && codeStatus === 'rejected') {
    return {
      matchType: 'unresolved',
      reasonIfMismatch: 'both the documentation side and the code side have been explicitly judged rejected (not "never checked", but both sides checked and confirmed irrelevant); it has been finalized automatically and no longer triggers triage',
      autoFinalStatus: 'rejected',
    };
  }
  return { matchType: 'unresolved', reasonIfMismatch: 'no valid evidence on either side; probably a leftover empty-shell record' };
}

function cmdCompare(args) {
  const reg = loadRegistry(args);
  const results = { matched: [], docOnly: [], codeOnly: [], unresolved: [] };

  for (const rec of reg.listApis()) {
    const hint = classifyMismatchHint(rec);
    const existingFinal = rec.crossValidation ? rec.crossValidation.finalStatus : null;
    // Records already explicitly finalized by a human or the caller via resolve (confirmed/rejected/reconsider/
    // knownGap) must not be silently overwritten by the autoFinalStatus recomputed this time — even if this round matchType
    // classifies the record into matched / both-sides-rejected, an "auto-finalizable" case, it is applied only when no
    // explicit final state existed before (finalStatus is null, or still the candidate placeholder 'candidate' written by compare itself),
    // respecting judgments a human already made (e.g. an analyst may have manually marked a matched record
    // as reconsider, asking for re-verification; it must not be auto-reverted to confirmed by the next compare round).
    const alreadyResolvedByHuman = existingFinal && existingFinal !== 'candidate';
    const finalStatus = alreadyResolvedByHuman ? existingFinal : hint.autoFinalStatus || 'candidate';
    reg.setCrossValidation(
      rec.apiName,
      {
        matchType: hint.matchType,
        reasonIfMismatch: hint.reasonIfMismatch,
        finalStatus,
      },
      CALLER
    );
    results[hint.matchType === 'unresolved' ? 'unresolved' : hint.matchType].push({
      apiName: rec.apiName,
      reasonIfMismatch: hint.reasonIfMismatch,
      suggestedSubReason: hint.suggestedSubReason,
      finalStatus,
    });
  }

  reg.save();
  printResult({
    ok: true,
    round: reg.getCurrentRound(),
    matchedCount: results.matched.length,
    docOnlyCount: results.docOnly.length,
    codeOnlyCount: results.codeOnly.length,
    unresolvedCount: results.unresolved.length,
    results,
  });
}

// ------------------------- resolve -------------------------
// The caller, based on the classification produced by compare, completes the final judgment requiring semantic understanding and then writes it back.
function cmdResolve(args) {
  const reg = loadRegistry(args);
  const apiName = requireArg(args, 'apiName');
  const finalStatus = requireArg(args, 'finalStatus'); // confirmed | rejected | reconsider | knownGap
  const reasonIfMismatch = args.reasonIfMismatch;

  if (!['confirmed', 'rejected', 'reconsider', 'knownGap'].includes(finalStatus)) {
    fail('--finalStatus must be one of confirmed/rejected/reconsider/knownGap');
  }

  const rec = reg.getApi(apiName);
  if (!rec) fail('ApiRecord does not exist: ' + apiName);

  reg.setCrossValidation(
    apiName,
    {
      matchType: rec.crossValidation ? rec.crossValidation.matchType : 'unresolved',
      reasonIfMismatch: reasonIfMismatch || (rec.crossValidation ? rec.crossValidation.reasonIfMismatch : null),
      finalStatus,
    },
    CALLER
  );

  // The "genuine documentation-missing finding" inside the codeOnly branch should be merged directly into set A (scheme c)-i)-2 (1)):
  // if this API had no docEvidence and is judged confirmed this time, add a minimal docEvidence placeholder,
  // clearly marking that its discovery path was the code side rather than the documentation side, so downstream does not mistake it for having a real documentation source.
  //
  // A permission-matrix violation found and fixed during real review: this previously called setDocEvidence directly and hard-coded the last
  // `by` argument as the string 'docTool' — equivalent to c) forging a) identity to bypass the "docEvidence is
  // read-only for validationTool" matrix constraint, and it left a history entry saying "docTool performed this write"
  // that is a false audit record (the real trigger is always validationTool). It now calls the exception method that registry.js opened specifically for this
  // scenario, which validates and records honestly (that method is itself regarded in the scheme 2.8 matrix as the sole exception channel for the c)-i)-2-(1)
  // scenario, not a regular docEvidence write).
  if (finalStatus === 'confirmed' && !rec.docEvidence && rec.codeEvidence) {
    reg.markDocMissingConfirmedByValidation(apiName, CALLER);
  }

  reg.save();
  printResult({ ok: true, apiName, finalStatus });
}

// ------------------------- prune -------------------------
function cmdPrune(args) {
  const reg = loadRegistry(args);
  const zeroHitRoundsThreshold = args.zeroHitRoundsThreshold ? parseInt(args.zeroHitRoundsThreshold, 10) : 3;

  reg.recomputeAllTermStats();
  const round = reg.getCurrentRound();

  const autoExecuted = [];
  const suggested = [];
  const kept = [];

  for (const belongsTo of ['K_doc', 'K_code', 'R']) {
    for (const entry of reg.listTerms(belongsTo, 'active')) {
      const verdict = classifyTier(entry.stats, round, zeroHitRoundsThreshold);
      if (verdict.tier === 'tier1-suspend') {
        reg.setTermStatus(belongsTo, entry.term, 'suspended', CALLER, '[Tier1 automatic suspension] ' + verdict.reason);
        autoExecuted.push({ belongsTo, term: entry.term, reason: verdict.reason });
      } else if (verdict.tier === 'tier2-suggest-suspend') {
        suggested.push({ belongsTo, term: entry.term, action: 'suspend', reason: verdict.reason, stats: entry.stats });
      } else if (verdict.tier === 'tier2-suggest-downgrade') {
        suggested.push({ belongsTo, term: entry.term, action: 'downgrade', reason: verdict.reason, stats: entry.stats });
      } else {
        kept.push({ belongsTo, term: entry.term, tier: verdict.tier, reason: verdict.reason });
      }
    }
  }

  reg.save();
  printResult({
    ok: true,
    round,
    autoExecutedCount: autoExecuted.length,
    autoExecuted,
    suggestedCount: suggested.length,
    suggested,
    keptCount: kept.length,
    note: 'Tier2 suggestions only become suspended after a human or the main agent confirms them via the apply-suggestion command; Tier3 (physical removal) can only be initiated proactively by a human, and this command produces no Tier3 suggestion',
  });
}

/** After a human confirms a Tier2 suggestion, actually perform the suspension (still suspended, reversible, not the Tier3 removed). */
function cmdApplySuggestion(args) {
  const reg = loadRegistry(args);
  const belongsTo = requireArg(args, 'belongsTo');
  const term = requireArg(args, 'term');
  reg.setTermStatus(belongsTo, term, 'suspended', CALLER, '[Tier2 suspension after human confirmation]');
  reg.save();
  printResult({ ok: true, belongsTo, term, status: 'suspended' });
}

/** Tier3: physical removal that only a human initiates proactively; the tool itself (the prune command) never suggests this tier automatically. */
function cmdRemoveTerm(args) {
  const reg = loadRegistry(args);
  const belongsTo = requireArg(args, 'belongsTo');
  const term = requireArg(args, 'term');
  const note = args.note || 'Tier3 removal initiated proactively by a human';
  reg.setTermStatus(belongsTo, term, 'removed', CALLER, '[Tier3 human-initiated removal] ' + note);
  reg.save();
  printResult({ ok: true, belongsTo, term, status: 'removed' });
}

// ------------------------- summary -------------------------
function buildApiChangeTable(reg, prevSnapshot) {
  const rows = [];
  for (const rec of reg.listApis()) {
    const finalStatus = rec.crossValidation ? rec.crossValidation.finalStatus : null;
    const prev = prevSnapshot ? prevSnapshot.apis[rec.apiName] : null;
    const prevFinal = prev ? prev.finalStatus : null;
    if (finalStatus !== prevFinal) {
      rows.push({
        apiName: rec.apiName,
        change: prevFinal ? prevFinal + ' -> ' + finalStatus : '(new) -> ' + finalStatus,
        reason: (rec.docEvidence && rec.docEvidence.evidence) || (rec.codeEvidence && rec.codeEvidence.evidence) || (rec.crossValidation && rec.crossValidation.reasonIfMismatch) || '',
      });
    }
  }
  return rows;
}

function buildHealthTable(reg) {
  reg.recomputeAllTermStats();
  const round = reg.getCurrentRound();
  const rows = [];
  for (const belongsTo of ['K_doc', 'K_code', 'R']) {
    for (const entry of reg.listTerms(belongsTo)) {
      if (entry.status === 'removed') continue;
      const verdict = classifyTier(entry.stats, round);
      let action = 'keep';
      if (entry.status === 'suspended') action = 'suspended';
      else if (verdict.tier === 'tier1-suspend') action = 'auto-suspended (Tier1, executed)';
      else if (verdict.tier === 'tier2-suggest-suspend') action = 'suspension suggested (' + verdict.reason + ')';
      else if (verdict.tier === 'tier2-suggest-downgrade') action = 'downgrade suggested (' + verdict.reason + ')';
      else if (verdict.tier === 'keep-caution') action = 'keep (unique contribution > 0, must not touch)';

      rows.push({
        term: entry.term,
        belongsTo,
        hitCount: entry.stats.hitCount,
        confirmedCount: entry.stats.confirmedCount,
        falsePositiveRate: (falsePositiveRate(entry.stats) * 100).toFixed(1) + '%',
        uniqueContribution: entry.stats.uniqueContribution,
        action,
      });
    }
  }
  return rows;
}

function renderMarkdown(round, apiRows, healthRows) {
  let md = '### Round ' + round + ' summary\n\n';
  md += '#### Added / removed APIs\n\n';
  md += '| API | status change | judgment rationale |\n|---|---|---|\n';
  if (apiRows.length === 0) md += '| (no change) | - | - |\n';
  for (const r of apiRows) {
    md += '| ' + r.apiName + ' | ' + r.change + ' | ' + String(r.reason).replace(/\|/g, '\\|').slice(0, 200) + ' |\n';
  }
  md += '\n#### Keyword / return-value health\n\n';
  md += '| term | bucket | hits | confirmed | false-positive rate | unique contribution | suggested action |\n|---|---|---|---|---|---|---|\n';
  for (const h of healthRows) {
    md +=
      '| "' + h.term + '" | ' + h.belongsTo + ' | ' + h.hitCount + ' | ' + h.confirmedCount + ' | ' + h.falsePositiveRate + ' | ' + h.uniqueContribution + ' | ' + h.action + ' |\n';
  }
  md += '\n> Pending human confirmation: for the terms marked "suspension suggested" / "downgrade suggested" above, please confirm via the `apply-suggestion` command whether to execute; Tier1 was already executed automatically and is for information only.\n';
  return md;
}

function cmdSummary(args) {
  const reg = loadRegistry(args);
  const outFile = args.out; // optional: persist to tmp/<domain>analysis-<date>/round_<N>_summary.md
  const round = reg.getCurrentRound();
  const prevSnapshot = reg.getSnapshot(round - 1);

  const apiRows = buildApiChangeTable(reg, prevSnapshot);
  const healthRows = buildHealthTable(reg);
  const md = renderMarkdown(round, apiRows, healthRows);

  reg.save();

  if (outFile) {
    const dir = path.dirname(outFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outFile, md, 'utf8');
  }

  printResult({ ok: true, round, apiChangeCount: apiRows.length, markdown: md, savedTo: outFile || null });
}

// ------------------------- check-loop -------------------------
// Convergence judgment: whether confirmed set A (the confirmed count) is still growing versus the previous round snapshot; the round cap is a hard backstop.
function cmdCheckLoop(args) {
  const reg = loadRegistry(args);
  const maxRounds = args.maxRounds ? parseInt(args.maxRounds, 10) : DEFAULT_MAX_ROUNDS;
  const round = reg.getCurrentRound();
  const prevSnapshot = reg.getSnapshot(round - 1);

  const confirmedNow = reg.listApis((a) => a.crossValidation && a.crossValidation.finalStatus === 'confirmed').length;
  const confirmedPrev = prevSnapshot
    ? Object.values(prevSnapshot.apis).filter((a) => a.finalStatus === 'confirmed').length
    : -1;

  // A problem found and fixed during real review: unresolvedCount previously checked not only finalStatus==='candidate'
  // but also stacked two independent conditions, matchType==='unresolved' and (matchType!=='matched' && !finalStatus);
  // these were "defensive patches" before the cmdCompare fix, but after the fix they became inconsistent and even
  // contradictory: `matchType==='unresolved'` would still count, as unresolved, records just auto-finalized by classifyMismatchHint to
  // finalStatus='rejected' (the "both sides explicitly judged rejected" scenario),
  // contradicting their genuinely finalized state; and `!finalStatus` can never hold after the compare fix (compare
  // now always writes a non-empty string into finalStatus), making it a dead condition. finalStatus is now the single,
  // consistent authoritative signal of "whether finalized" (matched / both-sides-rejected are auto-finalized by compare to
  // confirmed/rejected; docOnly/codeOnly/true-empty-shell unresolved keep the 'candidate' placeholder until explicitly resolved),
  // so no extra matchType side-channel judgment is needed.
  const unresolvedCount = reg.listApis((a) => !a.crossValidation || a.crossValidation.finalStatus === 'candidate').length;

  const hitRoundCap = round >= maxRounds;
  const converged = confirmedNow <= confirmedPrev && unresolvedCount === 0;

  let decision;
  if (hitRoundCap) decision = 'stop-round-cap';
  else if (converged) decision = 'stop-converged';
  else decision = 'continue';

  printResult({
    ok: true,
    round,
    maxRounds,
    confirmedNow,
    confirmedPrev,
    unresolvedCount,
    decision,
    note:
      decision === 'continue'
        ? 'not yet converged and the round cap is not reached; proceed to the next a)/b) supplementary investigation round'
        : decision === 'stop-round-cap'
        ? 'reached the hard round cap (' + maxRounds + ' rounds); stop the loop to avoid keyword drift causing false non-convergence and slowing the flow'
        : 'the confirmed API count no longer grows and there are no pending records; judged converged, stop the loop',
  });
}

/** Manually advance to the next round (taking a snapshot); called only when check-loop judges continue. */
function cmdAdvanceRound(args) {
  const reg = loadRegistry(args);
  const newRound = reg.advanceRound(CALLER);
  reg.save();
  printResult({ ok: true, newRound });
}

// ------------------------- export -------------------------
// For the Step 1 (documentation-layer collection) / Step 2 (code-layer implementation check) persisted files to draw on: export all ApiRecords grouped by
// finalStatus, with the global grouping-hint table and code feature patterns attached. This command is a read-only summary that modifies no
// field, so it is not subject to the `by` permission matrix. Note: the export is "structured facts", not directly the Step 1 / Step 2
// required tmp persisted file itself — procedural narrative such as "after how many rounds / which finding triggered the expansion" still needs the caller
// to write, combining the per-round summary output (see SKILL.md, "tool usage" section, item 4).
function cmdExport(args) {
  const reg = loadRegistry(args);
  const outFile = args.out; // optional: persist to tmp/<domain>analysis-<YYYYMMDD>/_tmp_<abbr>_filter_export.json

  const bucketOf = (rec) => (rec.crossValidation && rec.crossValidation.finalStatus) || 'stillCandidate';
  const buckets = { confirmed: [], knownGap: [], rejected: [], reconsider: [], stillCandidate: [] };

  for (const rec of reg.listApis()) {
    const key = bucketOf(rec);
    const target = buckets[key] || buckets.stillCandidate;
    target.push({
      apiName: rec.apiName,
      kind: rec.kind,
      pairedApis: rec.pairedApis,
      docPath: rec.docEvidence ? rec.docEvidence.docPath : null,
      docDescription: rec.docEvidence ? rec.docEvidence.description : null,
      docStatus: rec.docEvidence ? rec.docEvidence.status : null,
      codeLocations: rec.codeEvidence ? rec.codeEvidence.locations : [],
      codeStatus: rec.codeEvidence ? rec.codeEvidence.status : null,
      groupingHints: rec.groupingHints,
      matchType: rec.crossValidation ? rec.crossValidation.matchType : null,
      reasonIfMismatch: rec.crossValidation ? rec.crossValidation.reasonIfMismatch : null,
    });
  }

  const result = {
    ok: true,
    round: reg.getCurrentRound(),
    summary: {
      totalApis: reg.listApis().length,
      confirmedCount: buckets.confirmed.length,
      knownGapCount: buckets.knownGap.length,
      rejectedCount: buckets.rejected.length,
      reconsiderCount: buckets.reconsider.length,
      stillCandidateCount: buckets.stillCandidate.length,
    },
    confirmed: buckets.confirmed,
    knownGap: buckets.knownGap,
    rejected: buckets.rejected,
    reconsider: buckets.reconsider,
    stillCandidate: buckets.stillCandidate,
    groupingHints: reg.listGroupingHints(),
    featurePatterns: reg.listFeaturePatterns().map((f) => ({
      featureId: f.featureId,
      featureType: f.featureType,
      patternDescription: f.patternDescription,
      derivedFromApis: f.derivedFromApis,
      matchedFunctionsCount: f.matchedFunctionsCount,
    })),
    warnings:
      buckets.stillCandidate.length > 0
        ? [
            'there are still ' +
              buckets.stillCandidate.length +
              ' APIs still in candidate state without a completed resolve; it is recommended to finish resolving them before writing the Step1/Step2 persisted files from this, to avoid omitting pending items',
          ]
        : [],
  };

  if (outFile) {
    const dir = path.dirname(outFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
  }

  printResult(Object.assign({}, result, { savedTo: outFile || null }));
}

// ------------------------- command dispatch -------------------------
const COMMANDS = {
  init: cmdInit,
  compare: cmdCompare,
  resolve: cmdResolve,
  prune: cmdPrune,
  'apply-suggestion': cmdApplySuggestion,
  'remove-term': cmdRemoveTerm,
  summary: cmdSummary,
  'check-loop': cmdCheckLoop,
  'advance-round': cmdAdvanceRound,
  export: cmdExport,
};

function main() {
  runCli(COMMANDS, process.argv.slice(2));
}

main();
