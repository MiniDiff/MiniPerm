/**
 * step8-loop.js — the outer driver of the Step 8 transformation loop (**domain-agnostic, and contains no criteria**).
 *
 * Purpose: chain the single-step commands of transform-pairs.js into a complete double loop, and render candidates as the
 * **substitute card / compose card** of the rules Section 4 for the LLM to judge on the spot. The judgment knowledge **comes entirely from the rules file and from the judgment made at call time**;
 * this file embeds no domain rules and accepts no "criteria module" — if criteria were solidified into code, a new copy would need rewriting for each domain,
 * which contradicts the division of labor that "scripts do only deterministic enumeration and leave semantic judgment to the caller".
 *
 * ── round-trip protocol (each invocation advances one round) ─────────────
 *   1. script: render this round candidates awaiting judgment as cards into cards.md, and write the template file <candidateId>.json
 *   2. LLM: judge item by item per the cards, writing the results as JSONL into verdicts.jsonl (one per line, containing candidateId)
 *      — alternatively, directly edit <candidateId>.json and let the script collect it
 *   3. script: on the next call with --verdicts <file>, first write back, then issue the next batch
 *   4. when phase is complete, export automatically, producing _stageA_pairs.json and the exclusion list
 *
 * ── usage ───────────────────────────────────────────────────────────────
 *   node step8-loop.js --groups <_stageA_groups.json> --state <_stageA_transform_state.json> \
 *                      [--verdicts <verdicts.jsonl>] [--outDir <dir> --domainAbbr <abbr> --tmpDir <tmp>] \
 *                      [--maxCards 40] [--maxLen 3] [--maxCandidates 5000] [--maxInnerSteps 20000]
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const TP = path.join(__dirname, 'transform-pairs.js');
const RULES = path.resolve(__dirname, '..', '..', 'references', 'api-composition-and-equivalence-channels.md');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    a[k] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : 'true';
  }
  return a;
}

function tp(args) {
  const out = execFileSync('node', [TP, ...args], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  try {
    return JSON.parse(out);
  } catch (e) {
    throw new Error('transform-pairs ' + args[0] + ' did not output JSON: ' + out.slice(0, 400));
  }
}

/** Extract the card bodies from the rules file (4.3 substitute card / 4.4 compose card), avoiding creating another template here. */
function loadCardTemplate(kind) {
  if (!fs.existsSync(RULES)) return null;
  const md = fs.readFileSync(RULES, 'utf-8');
  const head = kind === 'compose' ? '### 4.4 Compose Card' : '### 4.3 Substitute Card';
  const next = kind === 'compose' ? '### 4.5' : '### 4.4';
  const i = md.indexOf(head);
  const j = md.indexOf(next, i + 1);
  if (i < 0 || j < 0) return null;
  const block = md.slice(i, j);
  const m = block.match(/```([\s\S]*?)```/);
  return m ? m[1].replace(/\n+$/, '') : null;
}

const EMPTY_VERDICT = {
  screen: '',                 // pass | weak_pass | drop
  confidence: 0,
  rationale: '',
  criteria: { targetType: '', fields: [], tolerance: '', freshness: '' },
  constructionHint: '',
  pending_checks: [],
  evidence_refs: [],
  exclusionEvidence: [],
};

function renderCard(c, baseEnumOnly) {
  const ci = c.cardInput || {};
  const seq = (s) => (s || []).map((a) => a.split('.').pop()).join(' → ');
  const L = [];
  L.push('## ' + c.candidateId + ' ' + (c.transform === 'compose' ? 'compose card' : 'substitute card'));
  L.push('');
  if (baseEnumOnly) {
    L.push('> **This starting point is "enumeration-only"**: it is unsuitable as the baseline of a comparison pair (it is not the standard interface for that capability);'
      + 'it is traversed only to satisfy the within-group pairwise enumeration of rule 9.2. Unless there is an explicit reason, judge all its candidates `drop`.');
    L.push('');
  }
  const tpl = loadCardTemplate(c.transform === 'compose' ? 'compose' : 'substitute');
  L.push('<card>');
  L.push(tpl || '(card template not retrieved; please judge per rules file 4.3 substitute card / 4.4 compose card)');
  L.push('</card>');
  L.push('');
  L.push('**Inputs auto-filled from grouping output**:');
  L.push('');
  L.push('| item | value |');
  L.push('|---|---|');
  L.push('| baseline path s₀ | `' + seq(c.s0) + '` |');
  L.push('| candidate path s₁ | `' + seq(c.s1) + '` |');
  L.push('| transform | ' + (c.transform === 'compose' ? 'compose (B1 dependency)' : 'substitute (B2 coordination)') + ' |');
  L.push('| shared artifact w | ' + (c.gamma.w || '—') + ' |');
  L.push('| artifact category c | ' + (c.gamma.c || '—') + ' ' + (ci.categoryAxis || '') + ' |');
  L.push('| relation type r | ' + (c.gamma.r || '—') + ' |');
  L.push('| same-source group | ' + (c.gamma.groupId || '—') + ' |');
  L.push('| capability nature | s₀=' + (ci.baseCapability || '?') + '，s₁=' + (ci.candidateCapability || '?') + ' |');
  L.push('| added member | `' + (c.addedMember || '').split('.').pop() + '` |');
  L.push('| role complementarity | ' + (ci.roleComplementarity || '—') + ' |');
  L.push('| coupling evidence | ' + (ci.couplingEvidence || '—') + ' |');
  L.push('| parameter sensitivity | ' + (ci.paramSensitivity || '—') + ' |');
  L.push('| read/write inventory | ' + (ci.rwInventory || '—') + ' |');
  L.push('');
  L.push('**Write-back**: fill in the JSON below and write it as one line of `verdicts.jsonl` (must contain `candidateId`),'
    + 'or edit `' + c.candidateId + '.json`:');
  L.push('');
  L.push('```json');
  L.push(JSON.stringify(Object.assign({ candidateId: c.candidateId }, EMPTY_VERDICT), null, 2));
  L.push('```');
  L.push('');
  return L.join('\n');
}

/** Parse the verdicts written back by the LLM: supports JSONL (one per line) or a JSON array. */
function parseVerdicts(file) {
  const raw = fs.readFileSync(file, 'utf-8').trim();
  if (!raw) return [];
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch (e) {
    arr = raw.split('\n').map((l) => l.trim())
      .filter((l) => l && !l.startsWith('//') && !l.startsWith('#'))
      .map((l) => JSON.parse(l));
  }
  if (!Array.isArray(arr)) arr = [arr];
  return arr.map((v) => {
    const screen = String(v.screen || '').toLowerCase();
    if (!['pass', 'weak_pass', 'drop'].includes(screen)) {
      throw new Error('invalid screen for candidate ' + v.candidateId + ': "' + v.screen + '"');
    }
    if (!v.candidateId) throw new Error('the verdict is missing candidateId');
    return v;
  });
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const state = a.state;
  if (!state) throw new Error('missing --state');
  // --groups is needed only for the first init; later rounds recover from the state file
  if (!fs.existsSync(state) && !a.groups) throw new Error('missing --groups (the first run must specify the grouping table)');

  const dir = path.dirname(path.resolve(state));
  const cardsFile = path.join(dir, '_step8_cards.md');
  const tmplDir = path.join(dir, '_step8_cards');
  const verdictsFile = a.verdicts
    ? path.resolve(a.verdicts)
    : path.join(dir, '_step8_verdicts.jsonl');
  const maxCards = parseInt(a.maxCards || '40', 10);
  const maxCandidates = parseInt(a.maxCandidates || '5000', 10);
  const maxInner = parseInt(a.maxInnerSteps || '20000', 10);

  let round = 0, applied = 0;

  // ① write back the previous round verdicts (if any)
  if (fs.existsSync(verdictsFile)) {
    const vs = parseVerdicts(verdictsFile);
    if (vs.length) {
      const tmp = path.join(dir, '_step8_loop_verdict.json');
      for (const v of vs) {
        fs.writeFileSync(tmp, JSON.stringify([v]));
        tp(['judge-pair', '--state', state, '--verdictFile', tmp]);
        applied++;
      }
      fs.unlinkSync(tmp);
      fs.unlinkSync(verdictsFile);   // already consumed, to avoid repeated write-back next round
    }
  }

  if (a.init !== 'false' && !fs.existsSync(state)) {
    const r = tp(['init', '--groups', a.groups, '--state', state]);
    if (!r.gatePassed) {
      console.error('gate not fully passed: ' + JSON.stringify(r.gateWarnings).slice(0, 500));
    }
  }

  // ② this round: take candidates until maxCards is reached or the inner / outer loop ends
  const batch = [];
  let enumOnly = false, base = null, phase = 'cards', note = '';
  /**
   * establish the next starting point.
   * @returns {null|{base, enumOnly}} null means the outer loop has terminated;
   *          when in-progress (the previous starting point inner loop is unfinished) it returns an 'in-progress' marker and does not set a new starting point.
   */
  function advanceStart() {
    const plan = tp(['plan-next-start', '--state', state]);
    if (plan.action === 'terminated') return null;
    // the inner loop of the previous starting point has not finished: a new starting point cannot be set, otherwise the same candidate would be carded twice
    if (plan.action === 'in-progress') return { inProgress: true, base: plan.base };
    if (plan.action !== 'planned') throw new Error('plan-next-start exception: ' + JSON.stringify(plan));
    const ns = tp(['next-start', '--state', state, '--enumOnly', String(plan.nextStartArgs.enumOnly)]);
    if (ns.action !== 'new-start') throw new Error('next-start exception: ' + JSON.stringify(ns));
    round++;
    return { base: ns.base, enumOnly: !plan.legalBase };
  }

  try {
    let cur = advanceStart();
    while (cur && batch.length < maxCards && round < maxInner) {
      if (!cur.inProgress) { base = cur.base; enumOnly = cur.enumOnly; }
      const nc = tp(['next-candidate', '--state', state, ...(a.maxLen ? ['--maxLen', a.maxLen] : [])]);
      if (nc.action === 'candidate') {
        if (!base) { base = nc.base; enumOnly = !!nc.enumOnly; }
        batch.push(nc.candidate);
        continue;
      }
      if (nc.action === 'inner-done') {
        cur = advanceStart();     // this starting point is exhausted; move to the next
        continue;
      }
      phase = 'error';
      note = JSON.stringify(nc);
      break;
    }
    if (!cur) { phase = 'complete'; note = 'both Q and U are empty, the outer loop terminates'; }
    if (round >= maxInner) { phase = 'error'; note = 'reached the --maxInnerSteps cap (' + maxInner + ')'; }
  } catch (e) {
    phase = 'error';
    note = e.message;
  }

  // ③ render the cards
  if (phase === 'cards' && batch.length) {
    if (!fs.existsSync(tmplDir)) fs.mkdirSync(tmplDir, { recursive: true });
    const head = [
      '# Step 8 candidates awaiting judgment (' + batch.length + ')',
      '',
      '> baseline `s0` = ' + (base || []).map((x) => x.split('.').pop()).join(' → ')
        + (enumOnly ? ' (**enumeration-only starting point**: unless there is an explicit reason, judge all drop)' : ' (legal baseline)'),
      '> ',
      '> card bodies are quoted from `api-composition-and-equivalence-channels.md` 4.3 Substitute Card / 4.4 Compose Card.'
        + 'criteria are not solidified in the script — **judge on the spot per the cards**.',
      '> write-back: write each JSON as one line of `verdicts.jsonl`, or directly edit `_step8_cards/<id>.json`.',
      '',
    ];
    const body = batch.map((c) => renderCard(c, enumOnly)).join('\n---\n\n');
    fs.writeFileSync(cardsFile, head.join('\n') + body);
    for (const c of batch) {
      fs.writeFileSync(path.join(tmplDir, c.candidateId + '.json'),
                       JSON.stringify(Object.assign({ candidateId: c.candidateId }, EMPTY_VERDICT), null, 2));
    }
  }

  if (phase === 'complete') {
    const e = tp(['export', '--state', state, '--outDir', a.outDir || '.',
                  '--domainAbbr', a.domainAbbr || 'out', '--tmpDir', a.tmpDir || '.', '--force']);
    console.log(JSON.stringify({
      ok: true, phase: 'complete', note: note,
      appliedThisRound: applied,
      export: { pairs: e.pairCount, dropped: e.droppedCount, byTransform: e.byTransform },
    }, null, 2));
    return;
  }

  const st = JSON.parse(fs.readFileSync(state, 'utf-8'));
  console.log(JSON.stringify({
    ok: phase !== 'error',
    phase: phase,
    note: note || undefined,
    base: base,
    enumOnly: enumOnly,
    appliedThisRound: applied,
    cardCount: batch.length,
    cardsFile: batch.length ? cardsFile : undefined,
    templateDir: batch.length ? tmplDir : undefined,
    verdictsFile: verdictsFile,
    totals: { pairs: st.pairs.length, dropped: st.dropped.length },
    nextCommand: 'node step8-loop.js --state ' + state + ' --verdicts ' + verdictsFile
      + (a.maxLen ? ' --maxLen ' + a.maxLen : ''),
  }, null, 2));
}

try {
  main();
} catch (e) {
  console.error('[step8-loop] ' + e.message);
  process.exit(1);
}
