#!/usr/bin/env node
'use strict';
/**
 * transform-pairs.js — the Step 8 transformation enumeration tool (same-source groups -> comparison pairs).
 *
 * Positioning: this script handles the **deterministic part** of Algorithm 1 in `api-composition-and-equivalence-channels.md` —
 * within-group member retrieval, the substitutability (REPLACEABLE) and composability (COMPOSABLE) judgments, role-complementarity judgment,
 * stack/queue entry, dedup, loop state management, and persistence.
 *
 * **The script internally calls no LLM.** The two steps LLM_MAY_EQUIV / LLM_MAY_ESCALATE of Algorithm 1
 * are judged by the caller (the current conversation) per the prompt cards of the rules file Section 4, then written back via the judge-pair command —
 * consistent with the division of labor of doc-filter.js / cross-validate.js (the script does objective enumeration; semantic judgment is left to the caller).
 *
 * data flow:
 *   _stageA_groups.json --init--> state file --next-start--> starting point
 *        --transform--> candidate queue (card inputs auto-filled) --[LLM judgment]--> judge-pair
 *        --loop-status--> termination judgment --export--> _stageA_pairs.json + dropped.md
 *
 * loop model:
 *   outer loop — Q is the **composed access queue**; its members come from accesses composed by the inner loop (they must be judged by the LLM as
 *             "meaningful" and possibly equivalent to the baseline). They are taken in order as a baseline; taking only marks used,
 *             **without dequeuing**, so later enqueue dedup can consult Q directly, avoiding the same composition being enqueued repeatedly.
 *   ------- termination criterion: outerPending(U + unused items in Q) === 0; **Q.length must not be used**.
 *   inner loop — the candidate stack **grows but is never cleared**: substitute output enters the stack directly, and later items in the stack serve as targets for further transformation; taking only
 *             advances the cursor and **does not clear the target from the stack**, so the same sequence is not taken repeatedly and "currently in the stack"
 *             stays available for repeat-push dedup. The whole stack is rebuilt with current when the baseline changes.
 *   ------- termination criterion: cursor >= stack.length; **"stack empty" must not be used** (the stack only grows, so it is never empty).
 *   transform — substitute takes APIs only from "the **coordination** group the comparison object belongs to"; compose takes APIs from two classes of group:
 *             (a) the **dependency** group the comparison object belongs to; (b) a **coordination** group the baseline belongs to that the comparison object does not fully belong to.
 *   judgment — the LLM does two things: (1) whether the two sides have any equivalence possibility (pass/weak_pass/drop, lenient conditions);
 *             (2) whether the composition is meaningful (compositeValue). **Meaningless ones enter neither the inner-loop stack nor the outer-loop queue**,
 *             thereby pruning pointless composition branches. An equivalence drop is not the same as meaningless, so dropped ones by default remain in the stack.
 *
 * State layering (see the cmdInit comment and `api-composition-and-equivalence-channels.md` section 2.2):
 *   global persistence layer: started / queued / baseRegistry / producedComposite / enumSeen
 *       — retained across starting points; no inner loop may reset them. Used only for starting-point / enqueue / audit dedup; not involved in candidate filtering.
 *   per-baseline reset layer: current.compared / current.visited
 *       — created wholesale with next-start, discarded when the baseline changes; compared is the **sole** basis for candidate filtering.
 *   The two layers never cross into each other; settled is demoted to audit trail and no longer participates in filtering.
 *
 * subcommands:
 *   init           read the grouping table, initialize the outer-loop queue Q and unused set U, create the state file
 *   next-start     select the next starting point per the outer-loop rule (unused composed sequences in Q first, otherwise a single API from U)
 *   transform      run TRANSFORM on the stack item at the cursor, output the candidates awaiting judgment (substitute enters the stack, compose awaits judgment)
 *   judge-pair     write back the LLM judgment: (1) screen=pass/weak_pass/drop (equivalence possibility, lenient conditions);
 *                 (2) compositeValue=meaningful/meaningless (composition meaningfulness; meaningless ones enter neither stack nor queue)
 *   loop-status    report the Q/U/stack/visited-set state and judge whether the inner and outer loops can terminate
 *   export        export _stageA_pairs.json and _tmp_<abbr>_step8_dropped.md
 *
 * usage example:
 *   node transform-pairs.js init --groups tmp/location-analysis-20261002/_stageA_groups.json \
 *                                --state tmp/location-analysis-20261002/_stageA_transform_state.json
 *   node transform-pairs.js next-start --state <state>
 *   node transform-pairs.js transform  --state <state>
 *   node transform-pairs.js judge-pair --state <state> --verdictFile verdict.json
 *   node transform-pairs.js loop-status --state <state>
 *   node transform-pairs.js export --state <state> --outDir tmp/location-analysis-20261002 --domainAbbr loc
 */

const fs = require('fs');
const path = require('path');
const { resolveJsonInput, printResult, fail, requireArg, runCli } = require('./lib/cli');

// role-complementarity table: composition requires the two members to be complementary on the semantic axis (the two ends of a dependency)
const ROLE_COMPLEMENT = {
  writer: ['reader'],
  reader: ['writer'],
  opener: ['reader', 'result-reader', 'resultReader'],
  'result-reader': ['opener'],
  resultReader: ['opener'],
  trigger: ['listener'],
  listener: ['trigger'],
};

// category -> the expected role axis when composing (for hints only, not used to force filtering)
const CATEGORY_AXIS = {
  A1: 'writer <-> reader',
  A2: 'opener <-> result reader',
  A3: 'trigger <-> responder',
};

// ------------------------- common utilities -------------------------

function seqKey(seq) {
  return seq.join(' + ');
}

/**
 * Whether the inner loop has ended. The candidate stack **grows but is never cleared** (taking only advances the cursor), so "stack empty" cannot be the criterion;
 * instead we check whether the cursor has walked the whole stack. The stack is rebuilt with current when the baseline changes (next-start).
 */
function innerExhausted(cur) {
  if (!cur || !cur.stack || !cur.stack.length) return true;
  return (cur.cursor || 0) >= cur.stack.length;
}

/**
 * Split compound role annotations. A member rw may carry several roles at once (e.g. 'trigger+reader' means it is both an event trigger
 * and a data reader). They must be split and **each** take part in the complementarity judgment: if the compound string is looked up directly in ROLE_COMPLEMENT,
 * the key is missing and yields undefined, so members with compound roles are judged "not complementary" as a whole and compositions are systematically missed
 * (measured: the WeChat identity-and-account domain lost all compose candidates because of this).
 */
function splitRoles(rw) {
  if (!rw) return [];
  return String(rw).split(/[+,;/]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * Remaining starting points to be taken in the outer loop. Q **retains all historical members** (taking only marks used),
 * so "queue length" no longer represents the pending count; we must count items "never marked used";
 * if Q.length is misused, the outer loop is considered never terminated.
 */
function outerPending(st) {
  const u = (st.U || []).length;
  const q = (st.Q || []).filter((q) => !q.used).length;
  return u + q;
}

function loadState(args) {
  const p = requireArg(args, 'state');
  if (!fs.existsSync(p)) {
    fail('state file does not exist: ' + p + ' (please run init first)');
  }
  const st = JSON.parse(fs.readFileSync(p, 'utf8'));
  st.__path = p;
  return st;
}

function saveState(st) {
  const p = st.__path;
  const copy = Object.assign({}, st);
  delete copy.__path;
  copy.updatedAt = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify(copy, null, 2), 'utf8');
}

/** Whether the three permission layers (link / code / platform / user) plus the link-layer osGate are all empty. */
function isEmptyPerm(pv) {
  if (!pv) return true;
  return ['code', 'platform', 'user', 'osGate'].every((k) => {
    const v = String(pv[k] == null ? '' : pv[k]).trim();
    return v === '' || v === '-';
  });
}

/** Get a member members_meta (absence allowed; returns an empty object and the call site marks it unknown). */
function metaOf(groups, apiName) {
  for (const g of groups) {
    const m = (g.members_meta || {})[apiName];
    if (m) return m;
  }
  return {};
}

/** A coarse ranking of permission-vector "strength": the more non-empty layers, the stronger (used only for outer-loop starting-point ordering, not as a judgment basis). */
function permStrength(meta) {
  const pv = meta.permVector || {};
  let n = 0;
  for (const k of ['code', 'platform', 'user', 'osGate']) {
    const v = pv[k];
    if (v && v !== '-' && v !== 'None' && v !== 'none' && v !== 'Absent') n++;
  }
  return n;
}

/** Find all groups containing any API of this sequence (corresponding to `g in G with X in g` in TRANSFORM). */
function groupsContaining(groups, seq) {
  return groups.filter((g) => (g.members || []).some((m) => seq.includes(m)));
}

// ------------------------- init -------------------------

function cmdInit(args) {
  const groupsPath = requireArg(args, 'groups');
  const statePath = requireArg(args, 'state');
  if (!fs.existsSync(groupsPath)) {
    fail('grouping table does not exist: ' + groupsPath);
  }
  const gdoc = JSON.parse(fs.readFileSync(groupsPath, 'utf8'));
  const groups = gdoc.groups || [];
  if (!groups.length) {
    fail('the grouping table has no groups, cannot start transformation enumeration');
  }

  // gate check (corresponding to rules section 9.1): missing items only warn, never block; the caller decides whether to fill them in and rerun
  const gate = { missingPermVector: [], missingCapability: [], missingRw: [], pendingGroups: [] };
  const allApis = new Set();
  for (const g of groups) {
    (g.members || []).forEach((m) => allApis.add(m));
    const st = String(g.status || '').toLowerCase();
    if (st.includes('pending') || st.includes('needs-digging') || st.includes('insufficient-evidence')) {
      gate.pendingGroups.push(g.id);
    }
    for (const m of g.members || []) {
      const meta = (g.members_meta || {})[m] || {};
      if (!meta.permVector) gate.missingPermVector.push(g.id + ':' + m);
      if (!meta.capability) gate.missingCapability.push(g.id + ':' + m);
      if (g.relation === 'B1' && !meta.rw) gate.missingRw.push(g.id + ':' + m);
    }
  }

  // outer-loop initial set: U <- A (rule line 70), i.e. **all** APIs may serve as a starting point; termination is Q and U both empty
  // (line 108). "Standard interface" only decides the **priority order** (the point-selection preference of line 106) and must not filter U —
  // otherwise groups unrelated to the connected component of the standard interface (e.g. Wi-Fi / Beacon / compass, groups whose three layers are all empty) would never be
  // traversed, violating the section 9.2 termination condition that "within-group pairwise pairings must all be enumerated".
  // the baseline candidate set (deciding "which starting point suits being a comparison-pair baseline", a separate question from U coverage):
  // take APIs whose **three permission layers (link / code / platform / user) are not all empty**. Reason: the baseline is "the protected side",
  // one whose three layers are all empty has no permission gap to reference — using it as a baseline only produces "zero permission vs zero permission" comparisons,
  // constituting no permission gap and having no benchmarking value. Hence relax to "any API with protection on at least one layer may be a baseline", not only standard interfaces.
  const baseSet = new Set();
  for (const g of groups) {
    for (const m of g.members || []) {
      if (!isEmptyPerm(((g.members_meta || {})[m] || {}).permVector)) baseSet.add(m);
    }
  }
  // coverage guarantee (rule 9.2): APIs whose three layers are all empty are not baselines, but their groups must still be traversed —
  // 9.2 requires all pairwise pairings of members "whose three permission layers are all empty" to be enumerated. So these members are put into U,
  // so every group has at least one reachable starting point; these starting points serve only to complete enumeration (enumOnly) and produce no comparison pairs.
  const enumSet = new Set();
  for (const g of groups) {
    const mm = g.members_meta || {};
    const ms = g.members || [];
    if (!ms.length) continue;
    if (ms.every((m) => isEmptyPerm((mm[m] || {}).permVector))) {
      ms.forEach((m) => enumSet.add(m));
    }
  }
  const rank = (a) => (baseSet.has(a) ? 0 : enumSet.has(a) ? 2 : 1);
  const U = [...allApis].sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;   // usable as baseline -> the rest -> members of all-empty groups
    return permStrength(metaOf(groups, b)) - permStrength(metaOf(groups, a));
  });

  const st = {
    domain: gdoc.domain || '',
    groupsFile: path.basename(groupsPath),
    groupsPath: groupsPath,
    createdAt: new Date().toISOString(),
    groups: groups,
    Q: [],
    U: U,
    started: [],
    queued: [],
    current: null,
    pairs: [],
    dropped: [],
    // ================= state layering: the global persistence layer and the per-baseline reset layer are strictly separated =================
    // two iron rules: (1) writes never cross layers — per-baseline state is never written into global structures, and global structures are never
    //   reset with an inner loop; (2) only the "per-baseline reset layer" participates in candidate filtering, while the "global persistence layer" serves only starting-point / enqueue / audit dedup.
    //
    // [global persistence layer] retained across starting points; no inner-loop start may reset it:
    //   (1) started          sequences already used as a starting point (single or composed), preventing the same one being taken repeatedly.
    //   (2) queued           composed sequences historically enqueued into Q, preventing the same composition being enqueued repeatedly by different starting points (otherwise the outer loop
    //                       never terminates).
    //   (3) baseRegistry    composed sequences already used as a **baseline**. Registered when a composed sequence is taken from Q as a starting point, to answer
    //                       "has this composition already served as a baseline"; unlike started, it only collects compositions.
    //   (4) producedComposite  composed sequences already **produced**: registered each time transform generates a compose candidate,
    //                       **never cleaned** — after composed sequences have each served as a baseline they stay here, so that later regenerating a composition
    //                       can tell "has this already been produced", avoiding repeated enqueue into Q and repeated enumeration.
    //   (5) enumSeen        sequences already traversed by enumeration-type starting points (--enumOnly), used only for dedup across such starting points.
    //
    // [per-baseline reset layer] see st.current in cmdNextStart; cleared wholesale each time a new starting point is established:
    //   (1) current.compared  candidate accesses already compared under this baseline. Cleared when the baseline changes, so different baselines against the same
    //                       access do not shadow each other, and within-group pairwise pairings can be enumerated completely.
    //   (2) current.visited  sequences already pushed under this starting point, preventing infinite loops (a different purpose from compared; must not be merged).
    //
    // settled is demoted to **audit trail**: it still records "some sequence was once judged", but **no longer participates in candidate filtering** — filtering
    // is uniformly carried by current.compared. If one global structure handled both "compared under this baseline" and "globally settled",
    // the former would be wrongly retained after a baseline change, and B2 substitute pairs would be missed on a large scale (each group enumerating only the first starting point pairings).
    settled: {},
    enumSeen: {},
    baseRegistry: {},
    producedComposite: {},
    // APIs usable as a baseline: those whose three permission layers are not all empty (all-empty ones have no permission gap to reference and no benchmarking value as a baseline).
    // persisted so that plan-next-start can independently judge whether the next starting point suits being a baseline.
    baseSet: Object.fromEntries([...baseSet].map((a) => [a, true])),
    counters: { pair: 0, drop: 0 },
    gateWarnings: gate,
  };
  st.__path = statePath;
  saveState(st);

  const gateOk =
    !gate.missingPermVector.length && !gate.missingCapability.length &&
    !gate.missingRw.length && !gate.pendingGroups.length;

  printResult({
    ok: true,
    action: 'initialized',
    state: statePath,
    domain: st.domain,
    groupCount: groups.length,
    apiCount: U.length,
    gatePassed: gateOk,
    gateWarnings: gate,
    hint: gateOk
      ? 'gate passed; you may run next-start to begin the outer loop'
      : 'gate not fully passed (see gateWarnings). Per rule 9.1, missing items mean the corresponding transformation has nothing to pair, or the judgment target type cannot be determined; it is recommended to complete _stageA_groups.json and re-run init',
  });
}

// ------------------------- next-start / plan-next-start -------------------------

/**
 * Select the next starting point (pure function, no state change): if Q is non-empty take the head composed sequence; if Q is empty take the higher-ranked one in U.
 * Shared by next-start and plan-next-start, so the two selection logics cannot drift apart.
 * @returns {{base: string[]|null, source: string|null, Q: any[], U: string[]}} the consumed Q/U are the remaining values
 */
function pickNextStart(st) {
  const Q = st.Q || [];
  const U = [...(st.U || [])];
  const started = st.started || [];
  // composed access queue: taken **in order** as a baseline; taking only marks used and **does not shift it out of the queue**.
  // the queue therefore retains all historical members — when the inner loop composes the same sequence again, consulting Q directly tells us
  // "already produced and queued", so it is not enqueued again; if taking dequeued it, that record would vanish and the same composition would be
  // enqueued repeatedly by different baselines, making the outer loop hard to terminate.
  for (const item of Q) {
    const k = seqKey(item.seq);
    if (!item.used && !started.includes(k)) {
      item.used = true;          // marked "already used as a baseline", but **kept in the queue**
      return { base: item.seq, source: 'Q(composed sequence)', Q: Q, U: U };
    }
  }
  // U is the pending set of single APIs: taking consumes it (a single element has no "repeated production" problem)
  while (U.length) {
    const api = U.shift();
    if (!started.includes(api)) {
      return { base: [api], source: 'U(single API)', Q: Q, U: U };
    }
  }
  return { base: null, source: null, Q: Q, U: U };
}

function cmdNextStart(args) {
  const st = loadState(args);

  if (st.current && !innerExhausted(st.current)) {
    printResult({
      ok: true,
      action: 'in-progress',
      note: 'the current inner loop has not finished (the stack still holds targets not yet transformed); please continue running transform; to force switching the starting point, add --force',
      base: st.current.base,
      stackSize: st.current.stack.length,
    });
    if (!args.force) return;
  }
  if (st.current && st.current.pending && st.current.pending.length && !args.force) {
    printResult({
      ok: false,
      action: 'blocked',
      note: 'there are still ' + st.current.pending.length + ' candidates awaiting judge-pair write-back; please write them back first',
      pendingIds: st.current.pending.map((c) => c.candidateId),
    });
    return;
  }

  // outer-loop rule: if Q is non-empty take the head composed sequence; if Q is empty take the higher-ranked one in U (empty Q does not terminate)
  const picked = pickNextStart(st);
  st.Q = picked.Q;
  st.U = picked.U;
  const base = picked.base;
  const source = picked.source;

  if (!base) {
    st.current = null;
    saveState(st);
    printResult({
      ok: true,
      action: 'terminated',
      note: 'both Q and U are empty, the outer loop terminates. Please run loop-status to re-check the termination conditions, then export',
      pairCount: st.pairs.length,
      dropCount: st.dropped.length,
    });
    return;
  }

  const baseKey = seqKey(base);
  st.started.push(baseKey);
  st.settled = st.settled || {};
  st.settled[baseKey] = true;        // audit trail only, **not involved in candidate filtering**
  // global persistence layer: a composed sequence used as a baseline -> registered into baseRegistry. producedComposite is **deliberately not cleared here** —
  // after composed sequences have each served as a baseline they remain there, so regenerating the same composition later can find "already produced".
  st.baseRegistry = st.baseRegistry || {};
  st.producedComposite = st.producedComposite || {};
  if (base.length > 1) st.baseRegistry[baseKey] = true;
  // enumOnly: this API is unsuitable as a comparison-pair baseline (e.g. not the standard interface for that capability); it is traversed only to satisfy the section 9.2 requirement
  // that "within-group pairwise pairings must all be enumerated". Its candidates are all enumeration-only audit trail.
  const enumOnly = String(args.enumOnly || '').toLowerCase() === 'true';
  // per-baseline reset layer: compared is created wholesale with this inner loop and discarded when the baseline changes, so different baselines against the same access
  // do not shadow each other. The baseline itself is pre-registered, avoiding self-looping.
  const compared = {};
  compared[baseKey] = true;
  // the candidate stack **grows but is never cleared**: transformation output always enters the stack, and later these pushed items serve as **targets** for further transformation;
  // taking only advances the cursor and **does not clear the target from the stack**, so the same sequence is not taken repeatedly and it is guaranteed that
  // "currently in the stack" is always available for repeat-push dedup. The whole stack is cleared only **when the baseline changes**.
  st.current = { base: base, stack: [base], cursor: 0, visited: [baseKey], pending: [],
                 compared: compared, enumOnly: enumOnly, fromQ: source !== 'U(single API)' };
  saveState(st);

  printResult({
    ok: true,
    action: 'new-start',
    source: source,
    base: base,
    baseKey: seqKey(base),
    remaining: { Q: st.Q.length, U: st.U.length },
    hint: 'run transform to apply transformations to this starting point',
  });
}

/**
 * plan-next-start: preview the next starting point **without consuming it**, and state "whether it suits being a comparison-pair baseline".
 *
 * Rationale: the caller must know whether the starting point is a legal baseline before choosing which criteria to use — using a non-standard interface as baseline produces
 * reversed comparison pairs (which should be enumeration-only audit trail), and this judgment must be made before the real next-start, because once next-start
 * establishes the starting point, the script-side enumOnly marker is already fixed.
 *
 * the legalBase criteria (corresponding to the point-selection preference of rule 2.1):
 *   a single API -> whether it is annotated standard:true;
 *   a composed sequence -> whether it was ever enqueued because a judgment held (st.queued).
 * everything else is "enumeration-only": it is traversed only to satisfy the section 9.2 within-group pairwise enumeration, and its judgments are audit trail only.
 */
function cmdPlanNextStart(args) {
  const st = loadState(args);
  if (st.current && !innerExhausted(st.current)) {
    printResult({
      ok: true, action: 'in-progress',
      note: 'the current inner loop has not finished (the stack still holds targets not yet transformed); please finish taking candidates first; to force switching the starting point, use skip-start',
      base: st.current.base, stackSize: st.current.stack.length,
    });
    return;
  }
  const picked = pickNextStart(st);
  if (!picked.base) {
    printResult({
      ok: true, action: 'terminated',
      note: 'both Q and U are empty, the outer loop terminates. Please run loop-status to re-check the termination conditions, then export',
      pairCount: st.pairs.length, dropCount: st.dropped.length,
    });
    return;
  }
  const baseSet = st.baseSet || st.standardSet || {};   // compatible with older state files
  const queued = st.queued || [];
  // legal baseline: a single API must have three-layer permissions not all empty; a composed sequence must have been enqueued because a judgment held.
  const legalBase = picked.base.length === 1
    ? !!baseSet[picked.base[0]]
    : queued.includes(seqKey(picked.base));
  printResult({
    ok: true,
    action: 'planned',
    base: picked.base,
    baseKey: seqKey(picked.base),
    source: picked.source,
    legalBase: legalBase,
    // fed straight back into next-start, saving the caller from re-deriving it
    nextStartArgs: { enumOnly: legalBase ? 'false' : 'true' },
    remaining: { Q: picked.Q.length, U: picked.U.length },
    hint: legalBase
      ? 'this starting point can serve as a baseline: establish it with next-start --enumOnly false, then take and judge candidates one by one'
      : 'this starting point is not a standard interface: establish it with next-start --enumOnly true, and its candidates serve only as enumeration audit trail',
  });
}

/**
 * next-candidate: take **one** undecided candidate from the current starting point (advancing the inner loop via transform automatically when needed).
 *
 * Rationale: transform emits a whole batch of candidates at once, so the caller must maintain the index of "which have been judged, which have not",
 * and distinguish the three states "stack empty / batch empty / still undecided" — orchestration logic unrelated to the algorithm, yet very easy to get wrong.
 * After pushing this down, the caller inner loop is fixed as: take one -> judge one -> write back one, until the action is inner-done.
 */
function cmdNextCandidate(args) {
  const st = loadState(args);
  if (!st.current) fail('no starting point is in progress; please run next-start first');
  const cur = st.current;

  // this batch is not fully judged -> take the next one
  // note: the pointer (pendingCursor) **must** advance here; we must not always return pending[0].
  // the caller may first render the whole batch of candidates as cards and write them back later, in which case judge-pair has not been called yet and
  // pending does not shrink, so always taking the head would take the same one repeatedly.
  if (cur.pending && cur.pending.length) {
    cur.pendingCursor = (cur.pendingCursor || 0) % cur.pending.length;
    const c = cur.pending[cur.pendingCursor];
    cur.pendingCursor = (cur.pendingCursor + 1) % cur.pending.length;
    saveState(st);
    printResult({
      ok: true, action: 'candidate', candidate: c,
      base: cur.base, enumOnly: !!cur.enumOnly,
      remaining: cur.pending.length - 1,
      verdictFile: { candidateId: c.candidateId },
      hint: 'after judging, write back via judge-pair --verdictFile (put only this one entry in the file)',
    });
    return;
  }

  // this batch is fully judged -> advance the inner loop until new candidates are produced or the stack is exhausted
  for (let i = 0; i < 2000; i++) {
    const before = st.pairs.length + st.dropped.length;
    const res = runTransformInternal(st, args);
    if (res.done) {
      saveState(st);
      printResult({
        ok: true, action: 'inner-done',
        note: 'the stack is exhausted, the inner loop of this starting point has ended. Run plan-next-start to select the next starting point',
        base: cur.base,
      });
      return;
    }
    if (res.blocked) {
      saveState(st);
      printResult({ ok: false, action: 'blocked', note: res.blocked, base: cur.base });
      return;
    }
    if ((st.current.pending || []).length) {
      const p = st.current.pending;
      st.current.pendingCursor = (st.current.pendingCursor || 0) % p.length;
      const c = p[st.current.pendingCursor];
      st.current.pendingCursor = (st.current.pendingCursor + 1) % p.length;
      saveState(st);
      printResult({
        ok: true, action: 'candidate', candidate: c,
        base: st.current.base, enumOnly: !!st.current.enumOnly,
        remaining: p.length - 1,
        verdictFile: { candidateId: c.candidateId },
        hint: 'after judging, write back via judge-pair --verdictFile (put only this one entry in the file)',
      });
      return;
    }
    if (st.pairs.length + st.dropped.length === before && i > 200) {
      // several consecutive rounds produced neither candidates nor judgments: treat the inner loop as unable to advance, avoiding silent spinning
      saveState(st);
      printResult({
        ok: true, action: 'inner-done',
        note: 'the inner loop can no longer produce candidates (no new output for ' + i + ' consecutive rounds); treat as stack exhausted', base: cur.base,
      });
      return;
    }
  }
  fail('the inner loop advanced more than 2000 rounds without ending; check the grouping size, or use --maxLen to tighten the sequence length cap');
}

// ------------------------- transform -------------------------

/**
 * skip-start: mark the current starting point as "already used" and dequeue it directly, without draining its inner-loop stack.
 * Purpose: when the caller judges this API unsuitable as a baseline (the point-selection preference of rule 2.1, e.g. not the standard interface for that capability),
 * use this to advance the outer loop cleanly — otherwise the stack must be drained before switching, needlessly enumerating many reversed candidates.
 */
function cmdSkipStart(args) {
  const st = loadState(args);
  if (!st.current) fail('no starting point is in progress; please run next-start first');
  const base = st.current.base;
  const key = seqKey(base);
  if (!st.started.includes(key)) st.started.push(key);
  const skippedStack = (st.current.stack || []).length;
  st.current = null;
  saveState(st);
  printResult({
    ok: true,
    action: 'skipped',
    base: base,
    note: 'this starting point has been dequeued (the inner loop was not executed; the ' + skippedStack + ' stack items were discarded with it); run next-start to continue the outer loop',
    remaining: { Q: st.Q.length, U: st.U.length },
  });
}

function cmdTransform(args) {
  const st = loadState(args);
  if (!st.current) fail('no starting point is in progress; please run next-start first');
  const cur = st.current;

  if (cur.pending && cur.pending.length) {
    printResult({
      ok: false,
      action: 'blocked',
      note: 'candidates are still awaiting judge-pair write-back; please write them back before continuing transform',
      pending: cur.pending.map((c) => ({ candidateId: c.candidateId, s1: c.s1, transform: c.transform })),
    });
    return;
  }
  if (!cur.stack.length || cur.cursor >= cur.stack.length) {
    printResult({
      ok: true,
      action: 'inner-done',
      note: 'the cursor has walked the whole candidate stack; the inner loop of this starting point has ended. Run next-start to select the next starting point',
      base: cur.base,
    });
    return;
  }

  const res = runTransformInternal(st, args);
  if (res.blocked) {
    printResult({ ok: false, action: 'blocked', note: res.blocked });
    return;
  }
  if (res.done) {
    printResult({
      ok: true, action: 'inner-done',
      note: 'the stack is exhausted, the inner loop of this starting point has ended. Run next-start to select the next starting point', base: cur.base,
    });
    return;
  }
  printResult({
    ok: true,
    action: 'transformed',
    base: cur.base,
    poppedFromStack: res.X,
    candidateCount: st.current.pending.length,
    candidates: st.current.pending,
    remaining: { Q: st.Q.length, U: st.U.length },
    stackSize: st.current.stack.length,
    visitedCount: st.current.visited.length,
    nextAction: st.current.pending.length
      ? 'after the caller judges item by item per the cards, write back via judge-pair --verdictFile (next-candidate can be used to take them one by one)'
      : 'no candidates this round; continue transform',
  });
  saveState(st);
}

/**
 * The TRANSFORM body (algorithm lines 11-15): modifies st in place, prints nothing.
 * shared by cmdTransform and cmdNextCandidate.
 * @returns {{done:boolean, blocked?:string, X?:string[], candidates?:any[]}}
 */
function runTransformInternal(st, args) {
  const cur = st.current;
  if (cur.pending && cur.pending.length) {
    return { done: false, blocked: 'candidates are still awaiting judge-pair write-back; please write them back before continuing transform' };
  }
  // inner-loop termination condition: the cursor has walked the whole candidate stack (the stack only grows; newly pushed items are taken in later rounds)
  if (!cur.stack.length || cur.cursor >= cur.stack.length) {
    return { done: true };
  }
  // take the **target** of this round transformation (the comparison object) X: only advance the cursor, **do not clear it from the stack**
  const X = cur.stack[cur.cursor];
  cur.cursor += 1;
  const groups = st.groups;
  const candidates = [];
  const baseMeta = metaOf(groups, cur.base[cur.base.length - 1]);

  // == substitute (SUBSTITUTE) ============================================
  // candidate APIs are taken only from groups that **X belongs to and whose relation type is coordination (B2)**.
  // coordination means "mutually substitutable", so substitution happens only inside such groups.
  for (const g of groupsContaining(groups, X)) {
    if (g.relation !== 'B2') continue;
    const members = (g.members || []).filter((m) => !X.includes(m));   // g.members \ X
    for (const m of members) {
      const mMeta = (g.members_meta || {})[m] || {};
      // replace one by one the elements of X that "belong to this group"; elements not belonging to it are kept as-is.
      // replacing only the last position would swap an element unrelated to this group, producing misplaced candidates.
      X.forEach((xi, idx) => {
        if (!(g.members || []).includes(xi)) return;
        const s1 = X.slice();
        s1[idx] = m;
        candidates.push(buildCandidate({
          st, g, X, s1, member: m, transform: 'substitute',
          mMeta, baseMeta, roleNote: 'coordination group, substitute position ' + (idx + 1) + ' of the sequence (' + xi + ')',
        }));
      });
    }
  }

  // == compose (COMPOSE) ==================================================
  // candidate APIs are taken from **two classes of group**:
  //   (a) groups that X belongs to and whose relation type is **dependency (B1)** — the two ends of a dependency can be chained;
  //   (b) groups that the baseline belongs to, whose relation type is **coordination (B2)**, and that **contain no member of X** —
  //       coordination groups are meant for substitution, but their members can equally serve as **append items** combined with X, forming a new access path;
  //       requiring "contains no X" avoids producing the same sequence again via the substitute transform above.
  const composeSources = [];
  for (const g of groupsContaining(groups, X)) {
    if (g.relation === 'B1') composeSources.push({ g: g, from: 'a' });
  }
  for (const g of groupsContaining(groups, cur.base)) {
    if (g.relation !== 'B2') continue;
    // "the group does not contain the comparison object" = **the group must contain no member of X**.
    // X is the access about to be compared with the baseline (the comparison object). Semantics: if some coordination group of the baseline already has
    // a member of X, that group and X are on the **same capability dimension**, so taking a member from it only duplicates a capability X already has;
    // what must be completed are the other dimensions X **lacks**, so members must come from other coordination groups of the baseline that **do not contain X**.
    // example: the baseline <multi-dimension-API> has both recording and network-sending capabilities; its coordination groups are the "recording group" and the "network sending group".
    // substitution yields X=[<capture-stream-API>] (recording only), lacking network sending versus the baseline; here the recording group contains camera -> excluded
    // (choosing another recording member would only duplicate), the network sending group does not contain camera -> take a member from it, giving [camera, send].
    // note that X is the sequence **after substitution** and usually no longer contains baseline members, so this condition is not always false.
    if ((g.members || []).some((m) => X.includes(m))) continue;
    composeSources.push({ g: g, from: 'b' });
  }
  for (const src of composeSources) {
    const g = src.g;
    // roles are collected after splitting compound annotations (e.g. 'trigger+reader' -> ['trigger','reader'])
    const xRoles = [];
    for (const a of X) {
      const rw = ((g.members_meta || {})[a] || metaOf(groups, a)).rw;
      for (const r of splitRoles(rw)) if (!xRoles.includes(r)) xRoles.push(r);
    }
    for (const m of (g.members || [])) {
      if (X.includes(m)) continue;                 // exclude members already in the sequence
      const mMeta = (g.members_meta || {})[m] || {};
      const mRoles = splitRoles(mMeta.rw);
      let complementary = true;
      let roleNote = CATEGORY_AXIS[g.category] || '';
      if (mRoles.length && xRoles.length) {
        // require only **role complementarity** (rule 1.2 / algorithm 1 line 97), and **no longer** restrict "if that role is already occupied then
        // it cannot be appended" — that is a tightening beyond the rules and would miss compositions such as "two readers read the same state".
        // both the X side and the candidate side pair up their split roles one by one; if any pair holds, they are complementary.
        const hasComplement = xRoles.some(
          (r) => mRoles.some((mr) => (ROLE_COMPLEMENT[r] || []).includes(mr)));
        complementary = hasComplement;
        roleNote += '; X-side roles [' + xRoles.join(',') + '] vs candidate roles [' + mRoles.join(',') + ']' +
          (complementary ? ' -> complementary' : ' -> not complementary');
      } else {
        // prefer leniency: do not exclude when role annotations are missing; let it pass and mark it for verification
        roleNote += '; role annotation missing, let through by the prefer-leniency rule (complementarity must be verified when judging)';
      }
      if (!complementary) continue;
      // an appended item must **add something**: bring a (role, capability) combination X does not yet have. Being complementary to some member of X
      // is not enough — if X already has that role-capability combination, appending only repeats an existing dimension and the composition is worthless.
      //   valuable: X=[<capture-stream-API>](reader,ACQUIRE) appended with <egress-API>(writer,ACT-Egress) -> adds the network-sending dimension;
      //           X=[read cloud storage] appended with [write cloud storage](writer,ACQUIRE) -> adds the write side, closing the loop.
      //   worthless: X=[<capture-stream-API>](reader,ACQUIRE) appended with <capture-API>(reader,ACQUIRE) -> still read + acquire;
      //           X=[<egress-API>,<capture-stream-API>] appended with <capture-API>(reader,ACQUIRE) -> reader+ACQUIRE already provided by camera.
      // when a role or capability annotation is missing, the missing side participates in the comparison via a placeholder (prefer leniency), without pointless tightening.
      const capOf = (mt) => (mt.capability || '').trim() || 'unknown';
      const occupied = new Set();
      for (const a of X) {
        const mt = (g.members_meta || {})[a] || metaOf(groups, a);
        const rs = splitRoles(mt.rw);
        const cap = capOf(mt);
        if (rs.length) rs.forEach((r) => occupied.add(r + '|' + cap));
        else occupied.add('?|' + cap);
      }
      const mCap = capOf(mMeta);
      const candRoles = mRoles.length ? mRoles : ['?'];
      if (!candRoles.some((r) => !occupied.has(r + '|' + mCap))) continue;   // nothing added, skip
      // dependency order: writer / opener / trigger first, reader / responder after
      const isPre = mRoles.some((r) => ['writer', 'opener', 'trigger'].includes(r));
      const s1 = isPre ? [m].concat(X) : X.concat([m]);
      const srcNote = src.from === 'a'
        ? 'source (a) the dependency group the comparison object belongs to'
        : 'source (b) a coordination group the baseline belongs to (this group does not contain the comparison object)';
      candidates.push(buildCandidate({
        st, g, X, s1, member: m, transform: 'compose',
        mMeta, baseMeta, roleNote: roleNote + '；' + srcNote,
        composeFrom: src.from,
      }));
    }
  }

  // length cap (an engineering backstop, default 3, adjustable via --maxLen): with large shared groups, the number of sequences from per-position substitution / appending grows multiplicatively.
  const maxLen = args.maxLen ? parseInt(args.maxLen, 10) : 3;
  // dedup: consult only the **two layers**, and the two never cross into each other (see the state-layering note in init).
  st.enumSeen = st.enumSeen || {};
  st.producedComposite = st.producedComposite || {};
  cur.compared = cur.compared || {};
  const isEnum = !!cur.enumOnly;
  const capped = candidates.filter((c) => {
    if (c.s1.length > maxLen) return false;
    // trivial-solution filter: if a candidate sequence already **contains all members of the baseline**, it naturally has the baseline capability, and its
    // equivalence to the baseline is trivial and does not constitute a valuable equivalence channel (it amounts to saying "the baseline plus something else is still the baseline").
    // typical triggers: using the baseline itself as an append item, or substituting back around to the baseline.
    if (cur.base.every((a) => c.s1.includes(a))) return false;
    const k = seqKey(c.s1);
    // (1) enumeration-type starting point (--enumOnly): consult the global enumSeen, dedup across enumeration-type starting points — the same sequence under several
    //    such starting points is regenerated verbatim, piling up many synonymous exclusion entries.
    if (isEnum) {
      if (st.enumSeen[k]) return false;
      st.enumSeen[k] = true;
      return true;
    }
    // (2) legal baseline: consult only **this baseline** compared (the per-baseline reset layer), **no longer the global settled**.
    //    after a baseline change, compared is discarded wholesale with the inner loop, so the new baseline can re-compare against all accesses — within-group
    //    pairwise pairings can therefore be enumerated completely; within one baseline it never re-compares the same access.
    //    the original implementation filtered by the global settled, mistaking "B was judged under baseline A" for "B need not be judged under baseline C",
    //    so each B2 group enumerated only the first starting point pairings (measured on real domains).
    //    * criterion (non-negotiable): equivalence **depends on the baseline and is not transitive** — change the baseline and the comparison object changes,
    //      so a candidate judged non-equivalent (drop) under the old baseline may turn out equivalent against the new one. Hence **even drop
    //      conclusions must not be reused across baselines**; any fast path of "globally settled, skip" introduces missed detections.
    //      the growth in candidate volume is the inherent cost of complete enumeration; it can only be contained by --maxLen on sequence length, not traded away by dedup.
    //    accordingly, the exception "starting points from Q skip settled dedup" is removed — per-baseline dedup naturally allows
    //    sibling branches to reappear under a new baseline, so no back door is needed.
    return !cur.compared[k];
  });

  // dedup (corresponding to algorithm line 13, B not in V): sequences already pushed under this starting point (visited), sequences currently in the stack,
  // and sequences duplicated within the same batch are all no longer generated / pushed, otherwise the inner loop cannot be drained.
  const fresh = [];
  const inStack = new Set(cur.stack.map(seqKey));
  for (const c of capped) {
    const k = seqKey(c.s1);
    if (cur.visited.includes(k) || inStack.has(k)) continue;
    if (fresh.some((f) => seqKey(f.s1) === k)) continue;
    cur.visited.push(k);
    fresh.push(c);
  }

  // ids are assigned after dedup, ensuring candidateId is contiguous with no gaps —
  // otherwise candidates discarded by dedup would consume ids and judge-pair write-back would easily target the wrong one.
  for (const c of fresh) {
    st.counters.candidate = (st.counters.candidate || 0) + 1;
    c.candidateId = 'C' + st.counters.candidate;
    // global persistence layer: a composed sequence is registered as soon as it is **produced** and never cleaned — after composed sequences have each served as a baseline they remain here,
    // so regenerating the same composition later can find "already produced", avoiding repeated enumeration and repeated enqueue into Q.
    if (c.transform === 'compose') {
      st.producedComposite[seqKey(c.s1)] = true;
      c.awaitingValue = true;        // waits for the LLM to judge "is the composition meaningful" before deciding whether to push
    } else {
      cur.stack.push(c.s1);          // substitute candidate: pushed directly, as a target for later transformations
    }
  }

  // pushing: all candidates enter this round pending queue; whether they enter the **stack** (becoming a target for later transformations) splits into two cases —
  //   substitute candidates: pushed directly (substitution adds no branch dimension; kept as raw material for later composition);
  //   compose candidates: **not pushed yet**; first the LLM judges "is this composition meaningful" (the judge-pair
  //     compositeValue); only meaningful ones are pushed and may enter the outer-loop queue. Judged meaningless ones enter neither the stack
  //     nor the queue, cut directly from this round output, to avoid pointless expansion of composition branches.
  cur.pending = fresh;
  cur.pendingCursor = 0;   // a new batch of candidates; the take pointer resets to zero
  return { done: false, X: X, candidates: fresh };
}

function buildCandidate(o) {
  const { st, g, X, s1, member, transform, mMeta, baseMeta, roleNote, composeFrom } = o;
  const base = st.current.base;
  // the transformation type is an **inherent property** of a candidate, decided only by "is the candidate sequence longer than the baseline" (longer = compose, same length = substitute);
  // it must not inherit the kind of the last transformation: s1 may be a cumulative result of "compose first, then substitute",
  // where the last transformation is a substitute yet the sequence has grown; inheriting it would leave compose candidates un-enqueued and the outer loop coverage incomplete.
  const effTransform = s1.length > base.length ? 'compose' : 'substitute';
  // gamma likewise: the group of the last transformation is not necessarily the shared group of "the added member and the rest of the sequence". E.g. a sequence first gets a listener via an event-channel group
  // then has its trigger substituted via an underlying-resource group; the last group is the resource group (A2/B2), while the sequence holds because of the event channel
  // (A3/B1). Here the group is re-determined by the intersection of the added member and the rest of the sequence; if none, the last transformation group is kept.
  let gg = g;
  if (s1.length > 1) {
    const rest = s1.filter((a) => a !== member);
    const shared = (st.groups || []).filter(
      (x) => (x.members || []).includes(member) && rest.some((r) => (x.members || []).includes(r)));
    if (shared.length === 1) gg = shared[0];
    else if (shared.length > 1 && !shared.includes(g)) {
      // when several groups can explain it, take the one whose relation type matches the effective transformation (B1 for compose, B2 for substitute)
      const want = effTransform === 'compose' ? 'B1' : 'B2';
      gg = shared.find((x) => x.relation === want) || g;
    }
  }
  return {
    candidateId: null,        // assigned centrally by cmdTransform after dedup, to avoid gaps
    transform: effTransform,
    lastTransform: transform, // kind of the last transformation, for inspection only
    composeFrom: composeFrom || null,   // a = the dependency group of the comparison object; b = a coordination group of the baseline (not containing the comparison object)
    s0: base,
    s1: s1,
    derivedFrom: X,
    addedMember: member,
    gamma: { w: gg.sharedArtifact || '', c: gg.category || '', r: gg.relation || '', groupId: gg.id },
    // below are the "card inputs auto-filled from grouping output", for the caller to judge directly without extracting them
    cardInput: {
      sharedArtifact: gg.sharedArtifact || '',
      category: gg.category || '',
      categoryAxis: CATEGORY_AXIS[gg.category] || '',
      relation: gg.relation || '',
      relationDetail: gg.relationDetail || '',
      roleComplementarity: roleNote,
      baseCapability: baseMeta.capability || 'unknown',
      candidateCapability: mMeta.capability || 'unknown',
      baseRw: baseMeta.rw || 'unknown',
      candidateRw: mMeta.rw || 'unknown',
      basePermVector: baseMeta.permVector || {},
      candidatePermVector: mMeta.permVector || {},
      evidence: gg.evidence || [],
      paramSensitivity: mMeta.paramSensitivity || '(not recorded in the grouping table; if this candidate needs specific parameter values to align, note it in pending_checks)',
    },
    card: effTransform === 'substitute' ? 'substitute card (rules file 4.3)' : 'compose card (rules file 4.4)',
  };
}

// ------------------------- judge-pair -------------------------

function cmdJudgePair(args) {
  const st = loadState(args);
  if (!st.current) fail('no starting point is in progress');
  const verdicts = resolveJsonInput(args, 'verdict', null);
  if (!verdicts) fail('missing the judgment result; pass it via --verdictFile <path> (an array, each item containing candidateId plus the card output fields)');
  const list = Array.isArray(verdicts) ? verdicts : [verdicts];

  const cur = st.current;
  const applied = [];
  const unknown = [];

  for (const v of list) {
    const cid = v.candidateId;
    const idx = (cur.pending || []).findIndex((c) => c.candidateId === cid);
    if (idx < 0) {
      unknown.push(cid);
      continue;
    }
    const c = cur.pending[idx];
    // (1) per-baseline reset layer: record "this baseline has already compared against this access". **It must be registered whether or not enumOnly is set** —
    //    it carries candidate filtering; without registration, the next transform under the same baseline regenerates the same candidate and the inner loop
    //    can never be drained. When the baseline changes, the structure is discarded wholesale with current, so other baselines enumeration is unaffected.
    cur.compared = cur.compared || {};
    cur.compared[seqKey(c.s1)] = true;
    // (2) global persistence layer (audit trail only, not involved in filtering): judgments of enumeration-type starting points are trail only and are not counted,
    //    so as not to pollute the audit view of "which sequences were substantially judged".
    if (!cur.enumOnly) {
      st.settled = st.settled || {};
      st.settled[seqKey(c.s1)] = true;
    }
    const screen = String(v.screen || '').toLowerCase();
    if (!['pass', 'weak_pass', 'drop'].includes(screen)) {
      fail('illegal screen value for candidate ' + cid + ': "' + v.screen + '" (should be pass|weak_pass|drop)');
    }

    // -- LLM judgment one: is this **composition** meaningful? --
    // applies only to compose. Those judged meaningless (compositeValue=meaningless):
    //   **do not enter the inner-loop stack** (no longer a target for later transformations), **do not enter the outer-loop queue**, cut directly.
    // this is the main means of suppressing composition branch expansion: composition count grows factorially with sequence length (a 33-member group over three-element sequences
    // can reach 30000); without this pruning, a large domain cannot actually finish.
    // when compositeValue is absent it is treated as "meaningful" (prefer leniency), to avoid silent misses from a missing field.
    if (c.transform === 'compose') {
      const val = String(v.compositeValue || '').toLowerCase();
      if (val === 'meaningless') {
        st.counters.drop++;
        st.dropped.push({
          id: 'D' + st.counters.drop,
          s0: c.s0, s1: c.s1, transform: c.transform, gamma: c.gamma,
          rationale: v.rationale || 'composition is meaningless (compositeValue=meaningless)',
          confidence: v.confidence,
          exclusionEvidence: v.exclusionEvidence || v.evidence_refs || [],
        });
        applied.push({ candidateId: cid, screen: screen,
                       recordedAs: 'dropped(composite-meaningless)',
                       enteredStack: false, enqueuedToQ: false });
        cur.pending.splice(idx, 1);
        continue;
      }
      // meaningful -> enter the inner-loop stack, becoming a target for later transformations. This judgment is unrelated to equivalence:
      // a composition non-equivalent (drop) to the current baseline may still have independent meaning and must stay in the stack for further exploration.
      cur.stack.push(c.s1);
    }

    if (screen === 'drop') {
      st.counters.drop++;
      st.dropped.push({
        id: 'D' + st.counters.drop,
        s0: c.s0, s1: c.s1, transform: c.transform, gamma: c.gamma,
        rationale: v.rationale || '',
        confidence: v.confidence,
        // principle A: an exclusion must state what verification action was performed
        exclusionEvidence: v.exclusionEvidence || v.evidence_refs || [],
      });
      // pruning of composed sequences has moved up to "meaningless means not pushed" (see above). Here, only when explicitly passing
      // --pruneDroppedComposite are compositions "non-equivalent to the baseline" additionally removed from the stack, as a terminating backstop.
      // off by default: non-equivalent is not the same as meaningless; they are kept so the composition own later branches are not missed.
      let pruned = false;
      if (c.s1.length > 1 && args.pruneDroppedComposite) {
        const key = seqKey(c.s1);
        const at = cur.stack.findIndex((x) => seqKey(x) === key);
        if (at >= 0) { cur.stack.splice(at, 1); pruned = true; }
      }
      applied.push({ candidateId: cid, screen: screen, recordedAs: 'dropped', prunedFromStack: pruned });
    } else {
      st.counters.pair++;
      const pid = 'P' + st.counters.pair;
      st.pairs.push({
        id: pid,
        s0: c.s0, s1: c.s1,
        gamma: c.gamma,
        mu: {
          rationale: v.rationale || '',
          criteria: v.criteria || {},
          constructionHint: v.constructionHint || '',
        },
        transform: c.transform,
        screen: screen,
        confidence: v.confidence,
        pendingChecks: v.pending_checks || v.pendingChecks || [],
        evidenceRefs: v.evidence_refs || v.evidenceRefs || [],
      });
      // algorithm line 18: compose-type ones whose judgment holds are enqueued into Q
      let enqueued = false;
      // enqueue: composed sequences judged by the LLM as "meaningful and possibly equivalent to the baseline" enter Q, for the outer loop to take as a baseline.
      // queue dedup: Q **retains all historical members** (taking only marks used, never dequeues), so consulting Q directly tells us
      // "whether it was already produced and queued", with no need for a separate history set.
      const qk = seqKey(c.s1);
      if (c.transform === 'compose' && !st.started.includes(qk) &&
          !st.Q.some((q) => seqKey(q.seq) === qk)) {
        st.Q.push({ seq: c.s1, fromGroup: c.gamma.groupId, used: false });
        st.queued = st.queued || [];
        if (!st.queued.includes(qk)) st.queued.push(qk);
        enqueued = true;
      }
      applied.push({ candidateId: cid, screen: screen, recordedAs: pid, enqueuedToQ: enqueued });
    }
    cur.pending.splice(idx, 1);
  }

  saveState(st);
  printResult({
    ok: true,
    action: 'judged',
    applied: applied,
    unknownCandidateIds: unknown,
    stillPending: (cur.pending || []).map((c) => c.candidateId),
    totals: { pairs: st.pairs.length, dropped: st.dropped.length, Q: st.Q.length, U: st.U.length },
    nextStep: (cur.pending || []).length
      ? 'candidates are still awaiting write-back'
      : (innerExhausted(cur) ? 'the inner loop of this starting point has ended; run next-start' : 'continue transform'),
  });
}

// ------------------------- loop-status -------------------------

function cmdLoopStatus(args) {
  const st = loadState(args);
  const cur = st.current || {};
  const innerDone = innerExhausted(st.current);
  const outerDone = outerPending(st) === 0;

  // termination conditions (rule 9.2): beyond the two loops terminating, four further items need human confirmation
  const manualChecks = [
    'the worked example has been re-checked (rules section 8, five-part record)',
    'single-path flaw identification is complete (rules section 6; patterns A/B/E are not produced by transformation)',
    'cross-group / cross-functional-domain investigation is complete (rules section 7, pattern D)',
    'all pairwise pairings of members whose "three permission layers are all empty" have been enumerated (if nothing was found, record "checked, nothing found" too)',
  ];

  printResult({
    ok: true,
    action: 'status',
    outer: { Q: st.Q.length, U: st.U.length, startedCount: st.started.length, done: outerDone },
    inner: cur.base
      ? { base: cur.base, stackSize: (cur.stack || []).length, visitedCount: (cur.visited || []).length,
          comparedCount: Object.keys(cur.compared || {}).length,
          pendingJudge: (cur.pending || []).length, done: innerDone }
      : { note: 'no starting point is in progress' },
    // layer visibility: the two label groups sizes should be independent — the global layer only grows, while the per-baseline layer resets to zero with next-start and then
    // accumulates again. If perBase is observed not reset after a baseline change, the two layers have crossed.
    layers: {
      globalPersistent: {
        started: (st.started || []).length,
        queued: (st.queued || []).length,
        baseRegistry: Object.keys(st.baseRegistry || {}).length,
        producedComposite: Object.keys(st.producedComposite || {}).length,
        enumSeen: Object.keys(st.enumSeen || {}).length,
      },
      perBaseReset: cur.base
        ? { compared: Object.keys(cur.compared || {}).length,
            visited: (cur.visited || []).length }
        : null,
    },
    totals: { pairs: st.pairs.length, dropped: st.dropped.length },
    loopTerminated: outerDone && innerDone,
    manualChecksBeforeExport: manualChecks,
    hint: outerDone && innerDone
      ? 'the double loop has terminated; after confirming the four manual checks above, run export'
      : (innerDone ? 'run next-start' : 'run transform'),
  });
}

// ------------------------- export -------------------------

function cmdExport(args) {
  const st = loadState(args);
  const outDir = requireArg(args, 'outDir');
  const abbr = args.domainAbbr || 'dom';
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  if (outerPending(st) > 0) {
    if (!args.force) {
      fail('the outer loop has not terminated (pending starting points=' + outerPending(st) +
        ', of which U=' + st.U.length + ', Q unused=' + (st.Q || []).filter((q) => !q.used).length +
        '). If intermediate results must be exported anyway, add --force');
    }
  }

  const pairsDoc = {
    domain: st.domain,
    generatedAt: new Date().toISOString().slice(0, 10),
    groupsFile: st.groupsFile,
    pairs: st.pairs,
  };
  const pairsPath = path.join(outDir, '_stageA_pairs.json');
  fs.writeFileSync(pairsPath, JSON.stringify(pairsDoc, null, 2), 'utf8');

  // exclusion list (Markdown, for manual review; principle A requires stating what verification action was performed at exclusion time)
  const lines = [];
  lines.push('# Step 8 excluded candidate list (' + (st.domain || '') + ')');
  lines.push('');
  lines.push('> this list covers candidates with `screen = drop`. Per principle A of "negative conclusions and pending management",');
  lines.push('> each entry must state what verification action was performed at exclusion time; a code-layer comparison alone is medium-weight evidence,');
  lines.push('> so if the candidate was originally judged a pass-level lead, it must not be terminally excluded on this static judgment alone.');
  lines.push('');
  lines.push('| id | baseline s0 | candidate s1 | transform | gamma (c/r) | exclusion rationale | verification action at exclusion |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const d of st.dropped) {
    lines.push('| ' + [
      d.id,
      '`' + seqKey(d.s0) + '`',
      '`' + seqKey(d.s1) + '`',
      d.transform,
      (d.gamma.c || '') + '/' + (d.gamma.r || ''),
      (d.rationale || '').replace(/\|/g, '\\|'),
      (Array.isArray(d.exclusionEvidence) ? d.exclusionEvidence.join('；') : String(d.exclusionEvidence || ''))
        .replace(/\|/g, '\\|'),
    ].join(' | ') + ' |');
  }
  if (!st.dropped.length) lines.push('| - | - | - | - | - | no candidates were excluded this time | - |');
  lines.push('');
  // the exclusion list is process material: with --tmpDir it lands in the tmp grouping directory, while the key output (the contract file) stays in outDir
  const dropDir = args.tmpDir || outDir;
  if (!fs.existsSync(dropDir)) fs.mkdirSync(dropDir, { recursive: true });
  const dropPath = path.join(dropDir, '_tmp_' + abbr + '_step8_dropped.md');
  fs.writeFileSync(dropPath, lines.join('\n'), 'utf8');

  // statistics: for Step 12 to cite, and to check whether "composition enumeration left gaps"
  const byTransform = { substitute: 0, compose: 0 };
  const byCategory = {};
  for (const p of st.pairs) {
    byTransform[p.transform] = (byTransform[p.transform] || 0) + 1;
    const c = p.gamma.c || '?';
    byCategory[c] = (byCategory[c] || 0) + 1;
  }

  printResult({
    ok: true,
    action: 'exported',
    pairsFile: pairsPath,
    droppedFile: dropPath,
    pairCount: st.pairs.length,
    droppedCount: st.dropped.length,
    byTransform: byTransform,
    byCategory: byCategory,
    reminder: [
      '_stageA_pairs.json is the sole external contract file of Stage A; Stage B (Steps 9-12) starts from it as the only input',
      'after export, three process records must still be completed: the worked example re-check record, the composition enumeration record table, and the same-resource operation branch consistency table',
      'this step does not produce the data-value tiering table (that is the Step 12 responsibility)',
    ],
  });
}

// ------------------------- CLI -------------------------

runCli({
  init: cmdInit,
  'next-start': cmdNextStart,
  'plan-next-start': cmdPlanNextStart,
  'next-candidate': cmdNextCandidate,
  'skip-start': cmdSkipStart,
  transform: cmdTransform,
  'judge-pair': cmdJudgePair,
  'loop-status': cmdLoopStatus,
  export: cmdExport,
}, process.argv.slice(2));
