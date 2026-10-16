'use strict';
/**
 * Shared API registry (corresponding to chapter 2 of the scheme, "unified data model").
 *
 * The three CLI tools (doc-filter.js / code-filter.js / cross-validate.js) all read and write the same persistent JSON file through this module,
 * rather than each maintaining its own list — for details see scheme 2.2 ApiRecord.
 *
 * Key implementation decisions (differences from the original scheme document, for review):
 * 1. The stats of terms (K_doc/K_code/R) (hitCount/confirmedCount/rejectedCount/uniqueContribution/
 *    lastHitRound) are no longer maintained incrementally by each tool calling an interface "on a hit"; instead they are uniformly
 *    re-derived by `recomputeAllTermStats()` from the "single source of truth" fields ApiRecord.docEvidence.matchedXxx and codeEvidence.matchedXxx.
 *    The original read/write permission matrix marked codeTool as "read-only" for K_code/R,
 *    yet the design examples themselves (e.g. the hitCount of <dispatch-gateway>_getgroupmemberinfo clearly comes from code-side retrieval) implied that
 *    "K_code usage statistics should mainly come from the code side", a tension between the two. After switching to full re-derivation, both tools only need to
 *    faithfully register the matched* arrays (already an explicitly allowed action within each "exclusive write region"), and the statistics no longer need
 *    any extra out-of-region writes, fundamentally resolving the contradiction and avoiding the accounting drift incremental maintenance can cause.
 * 2. Term "creation" (addTerm) and "status transition" (setTermStatus, used for pruning) are still strictly restricted by the matrix to
 *    docTool-exclusive / validationTool-exclusive respectively, consistent with the original scheme.
 */

const fs = require('fs');
const path = require('path');

const TOOL_NAMES = ['docTool', 'codeTool', 'validationTool'];
// The pairedApis.relation enum is explicitly defined in scheme 2.1; addPairedApi validates against it, so a caller typo cannot pass in
// an undefined relation type and cause a silent misjudgment downstream (e.g. in Step 3a grouping reference). `crud-pair`
// is the fourth enum value, discovered and added during this real analysis: real permission mapping tables contain
// <cloud-storage-read-API>/<cloud-storage-write-API>/<cloud-storage-delete-API>/<cloud-storage-keys-API>
// this kind of "CRUD over the same user datum" naming family, whereas previously only callback-pair (get/on),
// start-stop (start/stop) and register-callback (register/callback) existed, missing
// the common CRUD naming convention get->set/remove, so these genuinely existing family members could not
// be discovered mechanically at the pairing-check stage and could only be
// remedied by the later extract-object-keys full enumeration — keeping both channels further lowers the missed-detection probability (especially when the target data is scattered across several tables rather than
// concentrated in one already-enumerated mapping table).
// `same-dir-fallback` is the fifth enum value, discovered and added during this real analysis: the naming-pattern pairings (the four above)
// all rely on the premise "a sibling API name can be derived from a known API name", but cases that entirely fail that premise really occurred:
// between `Channels/<channels-key-API>` (confirmed) and `<channels-profile-API>` in the same directory,
// and between `ChatTool/selectGroupMembers` (confirmed) and `<chat-tool-API>` in the same directory, the names form
// none of the derivable relations get/on/off/start/stop/crud, so naming-pattern pairing cannot find them by nature, yet the two
// do belong to the same subdirectory (classification boundary) of the official documentation source — a more naive but equally reliable relevance signal
// "the same documentation subdirectory" is itself the classification basis written by the documentation source authors (same origin as the Step 0 subdomain enumeration list).
const PAIRED_API_RELATIONS = ['callback-pair', 'start-stop', 'register-callback', 'crud-pair', 'same-dir-fallback'];

const CORE_FIELD_WRITERS = ['docTool', 'codeTool'];
const SECTION_WRITERS = {
  docEvidence: ['docTool'],
  codeEvidence: ['codeTool'],
  crossValidation: ['validationTool'],
  groupingHints: ['docTool', 'codeTool'],
};
// The scheme 2.8 read/write permission matrix has two easily confused but genuinely different rows:
// - `groupingHints` (the ApiRecord field itself) — a) appendable / b) appendable / c) read-only
// - `GroupingHintEntry` (2.7, the independent global grouping-hint table) — a) not involved / b) appendable / c) read-only
// The global table write permission is narrower than the field-level one (codeTool only); a code review found that both previously shared the same
// SECTION_WRITERS.groupingHints constant, wrongly widening the global table permission to match the field level (docTool
// could theoretically append too, even though doc-filter.js never actually calls addGlobalGroupingHintEntry,
// so it has not been triggered in practice, but the permission declaration itself contradicted the design matrix; a stricter constant is split out here to align with the design).
const GLOBAL_GROUPING_HINT_WRITERS = ['codeTool'];

function assertToolName(by) {
  if (!TOOL_NAMES.includes(by)) {
    throw new Error('unknown caller identity by="' + by + '", must be ' + TOOL_NAMES.join('/'));
  }
}

function nowIso() {
  return new Date().toISOString();
}

function emptyRegistry() {
  return {
    meta: { currentRound: 0, createdAt: nowIso(), lastUpdatedAt: nowIso() },
    apis: {},
    terms: { K_doc: {}, K_code: {}, R: {} },
    featurePatterns: [],
    groupingHints: [],
    snapshots: {},
  };
}

function emptyApiRecord(apiName, kind) {
  return {
    apiName,
    kind: kind || 'function',
    pairedApis: [],
    docEvidence: null,
    codeEvidence: null,
    crossValidation: null,
    groupingHints: [],
    history: [],
  };
}

class ApiRegistry {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = null;
  }

  load() {
    if (fs.existsSync(this.filePath)) {
      const txt = fs.readFileSync(this.filePath, 'utf8');
      this.data = JSON.parse(txt);
    } else {
      this.data = emptyRegistry();
    }
    return this;
  }

  save() {
    this.data.meta.lastUpdatedAt = nowIso();
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    return this;
  }

  // ---------------------------------------------------------------------
  // round management (2.9)
  // ---------------------------------------------------------------------
  getCurrentRound() {
    return this.data.meta.currentRound;
  }

  /** Only validationTool (the c) tool) increments it, and takes a snapshot before incrementing for the next round round-summary diff. */
  advanceRound(by) {
    assertToolName(by);
    if (by !== 'validationTool') {
      throw new Error('advanceRound may only be called by validationTool (the global round is driven uniformly by the c) cross-validation tool)');
    }
    const round = this.data.meta.currentRound;
    this.data.snapshots[String(round)] = this._buildSnapshot();
    this.data.meta.currentRound = round + 1;
    return this.data.meta.currentRound;
  }

  _buildSnapshot() {
    const apis = {};
    for (const [name, rec] of Object.entries(this.data.apis)) {
      apis[name] = {
        docStatus: rec.docEvidence ? rec.docEvidence.status : null,
        codeStatus: rec.codeEvidence ? rec.codeEvidence.status : null,
        finalStatus: rec.crossValidation ? rec.crossValidation.finalStatus : null,
      };
    }
    return { round: this.data.meta.currentRound, apis };
  }

  getSnapshot(round) {
    return this.data.snapshots[String(round)] || null;
  }

  // ---------------------------------------------------------------------
  // ApiRecord CRUD
  // ---------------------------------------------------------------------
  getApi(apiName) {
    return this.data.apis[apiName] || null;
  }

  listApis(filterFn) {
    const all = Object.values(this.data.apis);
    return filterFn ? all.filter(filterFn) : all;
  }

  /** Create an ApiRecord (returns the existing record if present, without overwriting). Callable by docTool/codeTool. */
  ensureApi(apiName, by, kind) {
    assertToolName(by);
    if (!CORE_FIELD_WRITERS.includes(by)) {
      throw new Error('ensureApi may only be called by docTool/codeTool, received by="' + by + '"');
    }
    if (!this.data.apis[apiName]) {
      this.data.apis[apiName] = emptyApiRecord(apiName, kind);
      this._pushHistory(apiName, by, 'created', 'ApiRecord created for the first time');
    }
    return this.data.apis[apiName];
  }

  setKind(apiName, kind, by) {
    const rec = this.ensureApi(apiName, by);
    rec.kind = kind;
    return rec;
  }

  addPairedApi(apiName, pairedApiName, relation, by) {
    if (!PAIRED_API_RELATIONS.includes(relation)) {
      throw new Error('pairedApis.relation must be one of ' + PAIRED_API_RELATIONS.join('/') + ', received: "' + relation + '" (enum defined in scheme 2.1)');
    }
    const rec = this.ensureApi(apiName, by);
    if (!rec.pairedApis.some((p) => p.apiName === pairedApiName)) {
      rec.pairedApis.push({ apiName: pairedApiName, relation });
      this._pushHistory(apiName, by, 'pairedApiAdded', pairedApiName + '(' + relation + ')');
    }
    return rec;
  }

  /** Write/overwrite the docEvidence of an ApiRecord (docTool exclusive write region). */
  setDocEvidence(apiName, evidence, by) {
    assertToolName(by);
    if (by !== 'docTool') throw new Error('docEvidence may only be written by docTool, received by="' + by + '"');
    const rec = this.ensureApi(apiName, by);
    rec.docEvidence = Object.assign(
      { addedRound: this.getCurrentRound() },
      rec.docEvidence,
      evidence
    );
    this._pushHistory(apiName, by, 'docEvidenceUpdated', 'status=' + evidence.status);
    return rec;
  }

  /**
   * The **sole exception** explicitly declared by the scheme 2.8 matrix: validationTool, in the c)-i)-2-(1) scenario
   * ("an API found on the code side by a feature anchor that is absent from the documentation list and judged a genuine documentation-missing finding
   * should be merged directly into set A without documentation-side confirmation"), needs to add a minimal docEvidence placeholder,
   * clearly marking that the API discovery path was the code side rather than the documentation side.
   *
   * The previous implementation (abandoned) had cross-validate.js call setDocEvidence directly and hard-code `by`
   * as the string 'docTool' — this had two real problems: (1) the exposed
   * setDocEvidence(by) check only inspects "the string the caller declares", not "who is physically calling",
   * effectively letting c) forge a) identity to bypass the matrix; (2) it left a false audit record in history saying "docTool performed
   * this write" (the real trigger was validationTool), misleading future troubleshooting.
   *
   * Fix: use a separate method, with `by` honestly validated as 'validationTool' (no more lying),
   * and history also honestly records validationTool as the trigger, while the action name
   * `docEvidenceForcedByValidation` is distinguished from the regular `docEvidenceUpdated`,
   * so the audit record itself shows "this is the matrix-permitted exception channel, not a regular a) write".
   */
  markDocMissingConfirmedByValidation(apiName, by) {
    assertToolName(by);
    if (by !== 'validationTool') {
      throw new Error('markDocMissingConfirmedByValidation may only be called by validationTool (this is the sole exception the scheme 2.8 matrix declares for the c)-i)-2-(1) scenario, received by="' + by + '"）');
    }
    const rec = this.data.apis[apiName];
    if (!rec) {
      throw new Error('ApiRecord does not exist: "' + apiName + '", cannot mark the documentation-missing placeholder');
    }
    if (rec.docEvidence) {
      throw new Error('API "' + apiName + '" already has docEvidence and must not go through the documentation-missing exception channel (that channel is only for the case where the documentation side never registered this API)');
    }
    rec.docEvidence = {
      docPath: null,
      description: null,
      matchedKDoc: [],
      matchedKCode: [],
      matchedR: [],
      exampleCodeMentions: [],
      status: 'confirmed',
      addedRound: this.getCurrentRound(),
      evidence: '[documentation-missing finding, not from documentation] hit only on the code side; judged by c) cross-validation as a real finding and merged into set A, corresponding to the Step 7 "API-entry-level documentation missing" tag',
    };
    this._pushHistory(apiName, by, 'docEvidenceForcedByValidation', 'scheme 2.8 matrix exception: c) marks the documentation-missing placeholder on behalf of a); the real trigger is validationTool');
    return rec;
  }

  /** Write/overwrite the codeEvidence of an ApiRecord (codeTool exclusive write region). */
  setCodeEvidence(apiName, evidence, by) {
    assertToolName(by);
    if (by !== 'codeTool') throw new Error('codeEvidence may only be written by codeTool, received by="' + by + '"');
    const rec = this.ensureApi(apiName, by);
    rec.codeEvidence = Object.assign(
      { addedRound: this.getCurrentRound() },
      rec.codeEvidence,
      evidence
    );
    this._pushHistory(apiName, by, 'codeEvidenceUpdated', 'status=' + evidence.status);
    return rec;
  }

  /**
   * Write the crossValidation of an ApiRecord (validationTool exclusive write region).
   * Note: validationTool may not create a new ApiRecord (in the read/write permission matrix, apiName/kind are
   * "read-only" for validationTool); the record must already have been created by docTool/codeTool (ensureApi);
   * otherwise it throws, telling the caller to check whether doc-filter/code-filter was run first, or whether c) was mistakenly treated as the first-registration entry.
   */
  setCrossValidation(apiName, cv, by) {
    assertToolName(by);
    if (by !== 'validationTool')
      throw new Error('crossValidation may only be written by validationTool, received by="' + by + '"');
    const rec = this.data.apis[apiName];
    if (!rec) {
      throw new Error(
        'ApiRecord does not exist: "' + apiName + '" - validationTool may not create new records; please register this API first via docTool/codeTool ensureApi'
      );
    }
    rec.crossValidation = Object.assign(
      { resolvedInRound: this.getCurrentRound() },
      rec.crossValidation,
      cv
    );
    this._pushHistory(apiName, by, 'crossValidationUpdated', 'finalStatus=' + cv.finalStatus);
    return rec;
  }

  addGroupingHint(apiName, hint, by) {
    assertToolName(by);
    if (!SECTION_WRITERS.groupingHints.includes(by))
      throw new Error('groupingHints may only be appended by docTool/codeTool, received by="' + by + '"');
    const rec = this.ensureApi(apiName, by);
    rec.groupingHints.push(hint);
    return rec;
  }

  _pushHistory(apiName, by, action, note) {
    const rec = this.data.apis[apiName];
    if (!rec) return;
    rec.history.push({ round: this.getCurrentRound(), by, action, note: note || '' });
  }

  // ---------------------------------------------------------------------
  // global grouping-hint table (2.7; independent of ApiRecord, for groupKey reverse lookup)
  // ---------------------------------------------------------------------
  addGlobalGroupingHintEntry(entry, by) {
    assertToolName(by);
    if (!GLOBAL_GROUPING_HINT_WRITERS.includes(by))
      throw new Error('the global grouping-hint table (GroupingHintEntry) may only be appended by codeTool, received by="' + by + '" (scheme 2.8 matrix: a) documentation filtering is "not involved" with this table, unlike the field-level groupingHints, whose permission differs - do not confuse the two)');
    let existing = this.data.groupingHints.find((g) => g.groupKey === entry.groupKey);
    if (!existing) {
      existing = { groupKey: entry.groupKey, evidenceType: entry.evidenceType, location: entry.location, memberApis: [] };
      this.data.groupingHints.push(existing);
    }
    for (const api of entry.memberApis || []) {
      if (!existing.memberApis.includes(api)) existing.memberApis.push(api);
    }
    return existing;
  }

  // ---------------------------------------------------------------------
  // keyword / return-value collections (2.5 / 2.4)
  // ---------------------------------------------------------------------
  /**
   * Create a term (K_doc/K_code/R); callable only by docTool; ignored if it already exists (existing stats/history are not overwritten),
   * but if meta is passed and the target entry lacks the corresponding fields, they are still filled in (see below).
   *
   * @param {object} [meta] meaningful only for belongsTo="R", corresponding to the scheme 2.4 ReturnValueEntry fields
   *   type/path/description/callbackType ({propertyName} is itself the term and need not be passed again).
   *   Fill-in rule: written in full on first creation; if the entry already exists but currently "has only a bare term and lacks these fields"
   *   (e.g. previously registered only via the judge matchedR bare string array, with no metadata attached), then passing meta this time
   *   fills in the missing fields without overwriting existing non-empty ones, so a later incomplete call cannot wipe a previously more complete record.
   */
  addTerm(belongsTo, term, sourceApi, by, meta) {
    assertToolName(by);
    if (by !== 'docTool') throw new Error('addTerm may only be called by docTool (term creation is the documentation-filter tool responsibility)');
    const bucket = this.data.terms[belongsTo];
    if (!bucket) throw new Error('unknown term bucket belongsTo="' + belongsTo + '"');
    if (bucket[term]) {
      if (belongsTo === 'R' && meta) this._fillReturnMeta(bucket[term], meta);
      return bucket[term];
    }
    const entry = {
      term,
      belongsTo,
      sourceApi,
      addedRound: this.getCurrentRound(),
      status: 'active',
      stats: { hitCount: 0, confirmedCount: 0, rejectedCount: 0, uniqueContribution: 0, lastHitRound: null },
      history: [{ round: this.getCurrentRound(), action: 'added', note: 'source API: ' + sourceApi }],
    };
    if (belongsTo === 'R') this._fillReturnMeta(entry, meta || {});
    bucket[term] = entry;
    return entry;
  }

  /** Fill in missing fields only; existing non-empty fields are not overwritten (see the addTerm comment). */
  _fillReturnMeta(entry, meta) {
    if (!entry.path && meta.path) entry.path = meta.path;
    if (!entry.path && !meta.path) entry.path = entry.path || entry.term;
    if ((!entry.type || entry.type === 'unknown') && meta.type) entry.type = meta.type;
    if (!entry.type) entry.type = 'unknown';
    if (!entry.description && meta.description) entry.description = meta.description;
    if (!entry.description) entry.description = entry.description || '';
    if ((!entry.callbackType || entry.callbackType === 'unspecified') && meta.callbackType) {
      entry.callbackType = meta.callbackType;
    }
    if (!entry.callbackType) entry.callbackType = 'unspecified';
  }

  getTerm(belongsTo, term) {
    const bucket = this.data.terms[belongsTo];
    return bucket ? bucket[term] || null : null;
  }

  listTerms(belongsTo, statusFilter) {
    const bucket = this.data.terms[belongsTo];
    if (!bucket) return [];
    const all = Object.values(bucket);
    return statusFilter ? all.filter((t) => t.status === statusFilter) : all;
  }

  /** Pruning status transition, callable only by validationTool (including Tier1 automatic suspension / Tier2 suspension after human confirmation / Tier3 removal). */
  setTermStatus(belongsTo, term, status, by, note) {
    assertToolName(by);
    if (by !== 'validationTool')
      throw new Error('setTermStatus (pruning status transition) may only be called by validationTool');
    const entry = this.getTerm(belongsTo, term);
    if (!entry) throw new Error('term does not exist: ' + belongsTo + '/' + term);
    const action =
      status === 'suspended' ? (entry.status === 'suspended' ? 'reactivated' : 'suspended') : status;
    entry.status = status;
    entry.history.push({ round: this.getCurrentRound(), action, note: note || '' });
    return entry;
  }

  /**
   * Re-derive the K_doc/K_code/R stats from the matched* fields of all ApiRecords.
   * See the file-header comment "key implementation decision 1". Returns a term -> stats map, and also writes it back to term.stats as a cache.
   */
  recomputeAllTermStats() {
    // collect which APIs each (belongsTo, term) hit, plus the confirmed/rejected status and round of those APIs
    const hits = {}; // key: belongsTo + '\u0000' + term -> [{apiName, statusConfirmed, statusRejected, round}]
    const pushHit = (belongsTo, term, apiName, isConfirmed, isRejected, round) => {
      const key = belongsTo + '\u0000' + term;
      if (!hits[key]) hits[key] = [];
      hits[key].push({ apiName, isConfirmed, isRejected, round });
    };

    // the union of "all hit terms" per confirmed API, used for the unique-contribution judgment
    const confirmedApiTermUnion = {}; // apiName -> Set("belongsTo\u0000term")

    for (const rec of Object.values(this.data.apis)) {
      const finalStatus = rec.crossValidation ? rec.crossValidation.finalStatus : null;
      // An asymmetry found and fixed during real review: the isRejectedFinal fallback branch previously required
      // "docEvidence must exist and be rejected" to count (`rec.docEvidence && rec.docEvidence.status
      // === 'rejected'`), whereas the isConfirmedFinal fallback branch used OR logic of "either side confirming suffices"
      // - this asymmetry meant that an API "hit only on the code side, with codeEvidence.status=rejected, but that never had docEvidence"
      // (e.g. a candidate dug out by feature-locate and judged a false positive from an overly broad feature regex) contributed
      // K_code/R hits that were never counted in rejectedCount, systematically understating the real false-positive rate of those terms and weakening
      // the c)-ii) Tier2 pruning mechanism (noise terms that should have been recommended for suspension were missed because the denominator was biased).
      // Fix: switch to "either side hitting suffices", symmetric with isConfirmedFinal, while keeping the original semantics that "confirmed takes precedence over
      // rejected" (when the two sides conflict, confirmation on either side means it must not be judged rejected).
      const anySideConfirmed =
        (rec.docEvidence && rec.docEvidence.status === 'confirmed') ||
        (rec.codeEvidence && rec.codeEvidence.status === 'confirmed');
      const anySideRejected =
        (rec.docEvidence && rec.docEvidence.status === 'rejected') ||
        (rec.codeEvidence && rec.codeEvidence.status === 'rejected');
      const isConfirmedFinal = finalStatus === 'confirmed' || (!finalStatus && anySideConfirmed);
      const isRejectedFinal =
        finalStatus === 'rejected' || (!finalStatus && !anySideConfirmed && anySideRejected);

      const collectTermsOn = (evidence) => {
        if (!evidence) return;
        const round = evidence.addedRound;
        for (const t of evidence.matchedKDoc || []) pushHit('K_doc', t, rec.apiName, isConfirmedFinal, isRejectedFinal, round);
        for (const t of evidence.matchedKCode || []) pushHit('K_code', t, rec.apiName, isConfirmedFinal, isRejectedFinal, round);
        for (const t of evidence.matchedR || []) pushHit('R', t, rec.apiName, isConfirmedFinal, isRejectedFinal, round);
        if (isConfirmedFinal) {
          if (!confirmedApiTermUnion[rec.apiName]) confirmedApiTermUnion[rec.apiName] = new Set();
          for (const t of evidence.matchedKDoc || []) confirmedApiTermUnion[rec.apiName].add('K_doc\u0000' + t);
          for (const t of evidence.matchedKCode || []) confirmedApiTermUnion[rec.apiName].add('K_code\u0000' + t);
          for (const t of evidence.matchedR || []) confirmedApiTermUnion[rec.apiName].add('R\u0000' + t);
        }
      };
      collectTermsOn(rec.docEvidence);
      collectTermsOn(rec.codeEvidence);
    }

    // first compute hitCount/confirmedCount/rejectedCount/lastHitRound
    const result = {};
    for (const belongsTo of ['K_doc', 'K_code', 'R']) {
      for (const entry of Object.values(this.data.terms[belongsTo])) {
        const key = belongsTo + '\u0000' + entry.term;
        const list = hits[key] || [];
        const uniqueApis = new Set(list.map((h) => h.apiName));
        const confirmedApis = new Set(list.filter((h) => h.isConfirmed).map((h) => h.apiName));
        const rejectedApis = new Set(list.filter((h) => h.isRejected).map((h) => h.apiName));
        const lastRound = list.reduce((m, h) => (h.round != null && h.round > m ? h.round : m), -1);
        entry.stats.hitCount = uniqueApis.size;
        entry.stats.confirmedCount = confirmedApis.size;
        entry.stats.rejectedCount = rejectedApis.size;
        entry.stats.lastHitRound = lastRound >= 0 ? lastRound : entry.stats.lastHitRound;
        result[key] = entry.stats;
      }
    }

    // then compute uniqueContribution: for each confirmed API, if its active-term union has size 1,
    // that sole term gets uniqueContribution += 1
    for (const belongsTo of ['K_doc', 'K_code', 'R']) {
      for (const entry of Object.values(this.data.terms[belongsTo])) entry.stats.uniqueContribution = 0;
    }
    for (const [apiName, termSet] of Object.entries(confirmedApiTermUnion)) {
      const activeTerms = [...termSet].filter((key) => {
        const [belongsTo, term] = key.split('\u0000');
        const entry = this.getTerm(belongsTo, term);
        return entry && entry.status === 'active';
      });
      if (activeTerms.length === 1) {
        const [belongsTo, term] = activeTerms[0].split('\u0000');
        const entry = this.getTerm(belongsTo, term);
        if (entry) entry.stats.uniqueContribution += 1;
      }
    }

    return result;
  }

  // ---------------------------------------------------------------------
  // simple list access for code feature patterns / the global grouping-hint table
  // ---------------------------------------------------------------------
  addFeaturePattern(pattern, by) {
    assertToolName(by);
    if (by !== 'codeTool') throw new Error('CodeFeaturePattern may only be written by codeTool');
    this.data.featurePatterns.push(pattern);
    return pattern;
  }

  listFeaturePatterns() {
    return this.data.featurePatterns;
  }

  listGroupingHints() {
    return this.data.groupingHints;
  }
}

module.exports = { ApiRegistry, emptyRegistry, emptyApiRecord, SECTION_WRITERS };
