#!/usr/bin/env node
'use strict';
/**
 * render-reports.js — render Stage A structured output as Markdown reports for manual inspection.
 *
 * subcommands:
 *   groups  --groups <_stageA_groups.json>  --out <md>            same-source grouping report (Steps 3-6)
 *   pairs   --pairs  <_stageA_pairs.json> [--groups <json>] [--droppedFile <path>] --out <md>
 *                                                                  comparison-pair sequence report (Step 8)
 *   step1   --factsFile <json> --out <md>                          documentation-layer API inventory (Step 1)
 *   step2   --factsFile <json> --out <md>                          code-layer implementation inventory (Step 2)
 *
 * purely deterministic rendering: performs no semantic judgment and calls no LLM. The facts file schema is in
 * references/documentation-and-code-collection.md, section 6.
 */

const fs = require('fs');
const path = require('path');
const { printResult, fail, requireArg, runCli } = require('./lib/cli');

const CAT = { A1: 'A1 shared data object', A2: 'A2 shared underlying resource', A3: 'A3 shared event channel' };
const REL = { B1: 'B1 dependency', B2: 'B2 coordination' };

function esc(s) {
  return String(s === undefined || s === null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
function dash(s) {
  const v = String(s === undefined || s === null ? '' : s).trim();
  return !v || v === '-' ? '—' : esc(v);
}
function code(s) {
  return '`' + esc(s) + '`';
}
function seq(a) {
  return (a || []).join(' → ');
}
function readJson(p) {
  if (!fs.existsSync(p)) fail('file does not exist: ' + p);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function write(out, lines) {
  const dir = path.dirname(out);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(out, lines.join('\n') + '\n', 'utf8');
}
function table(head, rows) {
  const l = ['| ' + head.join(' | ') + ' |', '|' + head.map(() => '---').join('|') + '|'];
  rows.forEach((r) => l.push('| ' + r.join(' | ') + ' |'));
  return l;
}

// ------------------------- groups -------------------------
function cmdGroups(args) {
  const doc = readJson(requireArg(args, 'groups'));
  const out = requireArg(args, 'out');
  const groups = doc.groups || [];
  const L = [];
  const apiSet = new Set();
  groups.forEach((g) => (g.members || []).forEach((m) => apiSet.add(m)));

  L.push('# Same-source grouping result (Steps 3-6)' + (doc.domain ? ' —— ' + doc.domain : ''));
  L.push('');
  L.push('> generated at: ' + (doc.generatedAt || '') + ' | **' + groups.length + '** same-source groups, covering **' + apiSet.size + '** APIs');
  L.push('>');
  L.push('> grouping rule: every "shared artifact x relation type" combination is one group; the same API may belong to several groups by sharing different artifacts.');
  L.push('> three artifact classes: **A1** data object (including shared state fields and **shared return-value fields**), **A2** underlying resource, **A3** event channel;');
  L.push('> two relation types: **B1** dependency (ordered causality, compose), **B2** coordination (independent production, substitute).');
  L.push('');

  L.push('## 1. Overview');
  L.push('');
  L.push(...table(['id', 'artifact category', 'relation type', 'shared artifact', 'member count', 'members'],
    groups.map((g) => [
      '**' + g.id + '**', CAT[g.category] || g.category, REL[g.relation] || g.relation,
      esc(g.sharedArtifact), String((g.members || []).length),
      (g.members || []).map((m) => code(m)).join('、'),
    ])));
  L.push('');

  L.push('## 2. API-to-group reverse lookup (which groups an API belongs to)');
  L.push('');
  const belong = {};
  groups.forEach((g) => (g.members || []).forEach((m) => { (belong[m] = belong[m] || []).push(g.id); }));
  const rows = Object.keys(belong).sort().map((a) => [code(a), String(belong[a].length), belong[a].join('、')]);
  L.push(...table(['API', 'group count', 'groups'], rows));
  L.push('');

  if ((doc.ungrouped || []).length) {
    L.push('## 3. APIs in no group (confirmed but no shared artifact)');
    L.push('');
    L.push('These APIs are members of the target domain, but no shared artifact with other APIs was found (return-value fields / state / resource / channel), so they fall into no group; they are listed for checking whether a group was missed.');
    L.push('');
    L.push(...table(['API', 'reason not grouped'], doc.ungrouped.map((u) => [code(u.api), esc(u.reason)])));
    L.push('');
  }

  L.push('## ' + ((doc.ungrouped || []).length ? '4' : '3') + '. Group details');
  L.push('');
  ['A1', 'A2', 'A3'].forEach((c) => {
    const gs = groups.filter((g) => g.category === c);
    if (!gs.length) return;
    L.push('### ' + (CAT[c] || c));
    L.push('');
    gs.forEach((g) => {
      L.push('#### ' + g.id + ' · ' + (REL[g.relation] || g.relation) + ' — ' + esc(g.sharedArtifact));
      L.push('');
      if (g.relationDetail) L.push('- relation: ' + esc(g.relationDetail));
      L.push('');
      const meta = g.members_meta || {};
      L.push(...table(['member', 'role rw', 'capability nature', 'user layer', 'platform layer', 'code layer', 'standard interface', 'note'],
        (g.members || []).map((m) => {
          const mm = meta[m] || {};
          const pv = mm.permVector || {};
          return [code(m), dash(mm.rw), dash(mm.capability), dash(pv.user), dash(pv.platform), dash(pv.code),
            mm.standard ? 'yes' : '', dash(mm.note)];
        })));
      L.push('');
      if ((g.evidence || []).length) {
        L.push('- evidence: ' + g.evidence.map((e) => code(e)).join('; '));
      }
      if (g.note) L.push('- note: ' + esc(g.note));
      L.push('');
    });
  });
  write(out, L);
  printResult({ ok: true, action: 'rendered', out, groups: groups.length, apis: apiSet.size });
}

// ------------------------- pairs -------------------------
function cmdPairs(args) {
  const doc = readJson(requireArg(args, 'pairs'));
  const out = requireArg(args, 'out');
  const pairs = doc.pairs || [];
  const L = [];
  const byTf = {};
  pairs.forEach((p) => { byTf[p.transform] = (byTf[p.transform] || 0) + 1; });

  L.push('# Comparison-pair sequence (Step 8)' + (doc.domain ? ' —— ' + doc.domain : ''));
  L.push('');
  L.push('> generated at: ' + (doc.generatedAt || '') + ' | **' + pairs.length + '** comparison pairs (substitute ' +
    (byTf.substitute || 0) + ', compose ' + (byTf.compose || 0) + ')');
  L.push('>');
  L.push('> a comparison pair `p = <s0, s1, gamma, mu>`: `s0` is the baseline and `s1` the candidate (both parameter-free API sequence skeletons);');
  L.push('> `gamma = (shared artifact, category, relation type)` is the transformation basis, and `mu` the equivalence basis given by the LLM coarse screen.');
  L.push('> this stage is only a **coarse screen**: certainly non-equivalent ones are excluded, all suspected-equivalent ones are kept, and equivalence is settled by Stage B empirical testing.');
  L.push('');
  L.push('## 1. Overview');
  L.push('');
  L.push(...table(['id', 'transform', 'baseline s0', 'candidate s1', 'gamma (category/relation - group)', 'screen', 'confidence'],
    pairs.map((p) => {
      const g = p.gamma || {};
      return ['**' + p.id + '**', p.transform === 'compose' ? 'compose' : 'substitute', code(seq(p.s0)), code(seq(p.s1)),
        esc((g.c || '') + '/' + (g.r || '') + ' · ' + (g.groupId || '')), esc(p.screen),
        p.confidence === undefined ? '—' : String(p.confidence)];
    })));
  L.push('');
  L.push('## 2. Details');
  L.push('');
  pairs.forEach((p) => {
    const g = p.gamma || {};
    const mu = p.mu || {};
    const cri = mu.criteria || {};
    L.push('### ' + p.id + ' ' + (p.transform === 'compose' ? 'compose' : 'substitute') + ' `' + seq(p.s0) + '`  vs  `' + seq(p.s1) + '`');
    L.push('');
    L.push('- **transformation basis gamma**: shared artifact ' + esc(g.w) + '; category ' + (CAT[g.c] || g.c) + '; relation type ' + (REL[g.r] || g.r) + '; from group ' + (g.groupId || '—'));
    L.push('- **equivalence rationale**: ' + esc(mu.rationale));
    const cr = [];
    if (cri.targetType) cr.push('target type = ' + (cri.targetType === 'effect' ? 'effect' : 'data'));
    if ((cri.fields || []).length) cr.push('field set = ' + cri.fields.join(', '));
    if (cri.tolerance) cr.push('error bound = ' + cri.tolerance);
        L.push('- **comparison criteria**: ' + (cr.length ? esc(cr.join('; ')) : '—'));
    L.push('- **construction hint**: ' + dash(mu.constructionHint));
    if ((p.pendingChecks || []).length) {
      L.push('- **pending empirical checks**:');
      p.pendingChecks.forEach((c) => L.push('  - ' + esc(c)));
    }
    if ((p.evidenceRefs || []).length) L.push('- **evidence**: ' + p.evidenceRefs.map((e) => code(e)).join('; '));
    L.push('');
  });
  if (args.droppedFile) {
    L.push('## 3. Excluded candidates');
    L.push('');
    L.push('candidates screened as `drop` (with exclusion rationale and verification actions) are in: `' + args.droppedFile + '`.');
    L.push('');
  }
  write(out, L);
  printResult({ ok: true, action: 'rendered', out, pairs: pairs.length });
}

// ------------------------- step1 -------------------------
function cmdStep1(args) {
  const f = readJson(requireArg(args, 'factsFile'));
  const out = requireArg(args, 'out');
  const conf = f.confirmed || [];
  const rej = f.rejected || [];
  const L = [];
  L.push('# Step 1 documentation-layer API inventory' + (f.domain ? ' —— ' + f.domain : ''));
  L.push('');
  L.push('> generated at: ' + (f.generatedAt || '') + ' | doc roots: ' + (f.docRoots || []).map((d) => code(d)).join('、'));
  if (f.summary) {
    const s = f.summary;
    L.push('>');
    L.push('> whole-collection docs ' + (s.scanned || '—') + ' -> filename hits ' + (s.filenameMatched || '—') + ' -> content-level hits ' +
      (s.contentMatched || '—') + ' → **confirmed ' + conf.length + '**，rejected ' + rej.length);
  }
  L.push('>');
  L.push('> the criterion is **domain membership** (whether it belongs to the target domain doc set), not data value; doubtful cases are all included.');
  L.push('');
  L.push('## 1. confirmed inventory (' + conf.length + ')');
  L.push('');
  const dirs = {};
  conf.forEach((c) => { (dirs[c.dir || '—'] = dirs[c.dir || '—'] || []).push(c); });
  L.push('by documentation directory: ' + Object.keys(dirs).sort().map((d) => code(d) + ' ' + dirs[d].length).join('，'));
  L.push('');
  Object.keys(dirs).sort().forEach((d) => {
    L.push('### ' + d);
    L.push('');
    L.push(...table(['API', 'description', 'user-layer scope', 'platform layer', 'code layer', 'return fields', 'inclusion basis'],
      dirs[d].map((c) => [
        code(c.api), esc(String(c.description || '').length > 64 ? String(c.description).slice(0, 64) + '…' : c.description), c.scope ? code(c.scope) : '—', c.platform ? 'activation must be requested' : '—',
        c.codeDecl ? 'app.json declaration' : '—', esc(Object.keys(c.returns || {}).join('、') || '—'), esc(c.evidence),
      ])));
    L.push('');
  });
  L.push('## 2. rejected inventory (' + rej.length + '; for checking whether anything was wrongly excluded)');
  L.push('');
  const rd = {};
  rej.forEach((r) => { (rd[r.dir || '—'] = rd[r.dir || '—'] || []).push(r); });
  L.push('<details><summary>expand rejected details</summary>');
  L.push('');
  Object.keys(rd).sort().forEach((d) => {
    L.push('**' + d + '**（' + rd[d].length + '）：' + rd[d].map((r) => code(r.api)).join('、'));
    L.push('');
    const reasons = {};
    rd[d].forEach((r) => { reasons[r.reason] = (reasons[r.reason] || 0) + 1; });
    L.push('exclusion reasons: ' + Object.keys(reasons).map((k) => esc(k) + '（' + reasons[k] + '）').join('；'));
    L.push('');
  });
  L.push('</details>');
  write(out, L);
  printResult({ ok: true, action: 'rendered', out, confirmed: conf.length, rejected: rej.length });
}

// ------------------------- step2 -------------------------
function cmdStep2(args) {
  const f = readJson(requireArg(args, 'factsFile'));
  const out = requireArg(args, 'out');
  const apis = f.apis || [];
  const L = [];
  L.push('# Step 2 code-layer implementation inventory' + (f.domain ? ' —— ' + f.domain : ''));
  L.push('');
  L.push('> generated at: ' + (f.generatedAt || '') + ' | code roots: ' + (f.codeFiles || []).map((d) => code(d)).join('、'));
  L.push('>');
  L.push('> this inventory answers: for each confirmed API, **where its implementation is**, **which permission mapping tables it is registered in**, **whether there is a JS-layer permission check**.');
  L.push('> "no check" only means no check branch was seen at the JS layer; the check may have sunk into the native layer, so this alone cannot establish that there is no permission control.');
  L.push('');
  if ((f.tables || []).length) {
    L.push('## 1. Permission mapping tables');
    L.push('');
    L.push(...table(['table', 'location', 'content'],
      f.tables.map((t) => [esc(t.name), code(t.file + ':' + t.startLine + (t.endLine ? '-' + t.endLine : '')), esc(t.desc)])));
    L.push('');
  }
  L.push('## 2. Per-API implementation and checks');
  L.push('');
  const checkCount = {};
  apis.forEach((a) => { checkCount[a.check || '—'] = (checkCount[a.check || '—'] || 0) + 1; });
  L.push('JS-layer check statistics: ' + Object.keys(checkCount).map((k) => k + ' ' + checkCount[k]).join('，'));
  L.push('');
  L.push(...table(['API', 'implementation location', 'table registration', 'JS-layer permission check', 'native method', 'note'],
    apis.map((a) => [
      code(a.api),
      (a.locations || []).map((x) => code(x.file + ':' + x.line + (x.endLine ? '-' + x.endLine : ''))).join('<br>') || '—',
      (a.mapEntries || []).map((x) => esc(x.text)).join('<br>') || '—',
      esc((a.check || '—') + (a.checkDetail ? '：' + a.checkDetail : '')),
      esc((a.native || []).join('、') || '—'),
      esc(a.notes || ''),
    ])));
  L.push('');
  if ((f.findings || []).length) {
    L.push('## 3. Code-layer findings (must be recorded; whether they constitute a vulnerability is decided by later steps)');
    L.push('');
    f.findings.forEach((x, i) => L.push((i + 1) + '. ' + x));
    L.push('');
  }
  write(out, L);
  printResult({ ok: true, action: 'rendered', out, apis: apis.length });
}

runCli({ groups: cmdGroups, pairs: cmdPairs, step1: cmdStep1, step2: cmdStep2 }, process.argv.slice(2));
