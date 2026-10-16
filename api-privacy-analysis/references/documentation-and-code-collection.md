# Documentation and Code Collection Rules (Steps 0-2)

> Corresponds to Steps 0 (define scope), 1 (documentation-layer collection), and 2 (code-layer implementation review) of `SKILL.md`. Tool command arguments, data formats, and error handling are in `automated-filter-tools.md`.

## 1. General Principles

1. **Volume decision**: when the target APIs number in single digits and the code is within a few thousand lines, Steps 1/2 are completed by direct human/LLM reading, skipping the tool-based flow; when documentation reaches dozens of entries or the code volume is too large, use the tool-based flow (`scripts/api-filter/`).
2. **The goal is to maximize recall**: Steps 1/2 only produce a candidate set for later steps to analyze in depth; they are not the final conclusion (criteria in Section 3).
3. **Read the rules files directly from `references/` in full**; do not create copies in the project root. If a same-named historical rules file exists in the project root, `references/` takes precedence.
4. **Semantic judgments must be persisted**: the tools perform deterministic retrieval only; every judgment of "is it relevant" or "is it a hit" is made by the LLM and written back via `judge` / `record-code-evidence` / `resolve`, and must not remain only in the conversation transcript.
5. **Semantic judgments must use a formatted prompt**: each judgment organizes its input per the template in Section 6 (matched keywords + verbatim hit content + other hint data) and outputs per the JSON schema specified there; free-form judging in conversation is not allowed, nor is supplying fields from memory.

## 2. Step 0: Define Analysis Scope

**What**: establish the functional domain, documentation/code source paths, and final report filename; determine the `tmp/<domain>analysis-<YYYYMMDD>/` directory name; decide whether to use the tools per Section 1, and if so run `doc-filter.js init --registry tmp/<domain>analysis-<YYYYMMDD>/_api_registry.json` once before Step 1.

**Output**: `_tmp_<domainAbbr>_step0_scope.md`, recording the sub-domain inventory (with the evidence source of each item), the documentation source directory inventory, seed terms and their sources, and excluded directories with reasons.

**Four mandatory checks**:

1. **Sub-domain enumeration with a strict evidence-source priority: local directory structure > web search > own parametric knowledge.**
   - When a local documentation source exists for the target domain, first run `list_dir` on its top-level category directories and take the directory names directly as the sub-domain classification inventory authored from the documentation source (local ground truth, costing a single call).
   - Only sub-domains not reflected in directory names (e.g. component families without standalone documentation) rely on web search to supplement.
   - Falling back to own knowledge is permitted only when neither is feasible, and the output file must then annotate "not cross-checked against local directories / not verified by web search".
2. **Exhaustive enumeration of documentation source directories**: first use `list_dir` to inspect all top-level directories of the project root, judging one by one whether each contains documentation of the target domain (e.g. a supplementary Markdown documentation directory outside the main documentation directory), then pass all of them at once to `--docRoot` of `scan-filenames`/`pairing-check` (comma-separated).
3. **Web search must be genuinely invoked**: when relying on web search for sub-domains, typical APIs, or keywords, one must not substitute own knowledge without noting it; the actual source of each seed term (local directory / web search / own knowledge) must be recorded honestly in the Step 0 output file.
4. **Directories listed by `list_dir` must not be silently dropped**:
   - Each directory either enters the candidate sub-domain inventory or has its exclusion reason written in the Step 0 output file;
   - Relevance must be judged for **all** top-level directories of the documentation source, and even a "one-line exclusion" conclusion must be recorded;
   - When `scan-filenames` returns `uncoveredSubdomains`/`partiallyMatchedSubdomains` warnings, each must be verified and handled before this round of analysis ends.

## 3. Domain Membership Criteria (Shared by Step 1/2 Semantic Judgments)

Corresponds to Core Principles 3a / 3a-1 / 3a-2 / 3b of `SKILL.md`.

### 3.1 The Default Criterion Is "Data Relevance", Not "Primary Functional Category" (3a)

Whether an API belongs to the target domain is judged by whether its input parameters or return values contain fields or operation objects strongly related to the target domain's data, not by the functional label it is nominally filed under.

- If return-value fields, request-parameter fields, or the permission-mapping-table group it belongs to (`groupKey`/scope) contain identifying fields of the target domain, or it operates on a specific user/friend identity (data stored/read partitioned by user identity counts even if the content is arbitrary business data), include it as a candidate; do not skip it because of surface category labels (friend interaction, cloud storage, device management, privacy compliance, etc.).
- Within a group enumerated by `extract-object-keys`, once any member is confirmed strongly relevant, the remaining members are by default sent into the semantic-judgment queue for item-by-item verification, and are not excluded wholesale on the literal meaning of the group name.
- **Narrowing**: switch to the primary-functional-category criterion only when the user explicitly asks for "only core …" or "no … class". **Widening**: when the user asks to "expand the search scope / relax filtering / count anything even slightly related", immediately redo the Step 1/2 semantic judgments under the default criterion and re-verify candidates previously excluded on category labels.
- The same criterion applies to Step 8's cross-category equivalence-channel sweep; boundary cases included leniently in Steps 1/2 can serve directly as starting-point clues for Step 8.

### 3.2 Judge Domain Membership, Not Data Value (3a-1)

- Steps 1/2 always answer "does this API belong to the documentation/code set of the target domain" (same documentation directory, same code file, same permission-mapping-table group); "how valuable is the datum once obtained" is Step 12's question.
- APIs whose domain membership holds but whose data value is zero (hardware control / output types, e.g. map-overlay management, WiFi module control) are still judged confirmed; they must not be rejected at Step 1 for "low value / no data returned".
- The order is fixed: ask domain membership first, and only once it holds discuss value — and the value question is left to Step 12.

### 3.3 Recall First; Include Doubtful Cases (3a-2)

- The cost of a wrong inclusion is only extra time spent excluding later; the cost of a wrong exclusion is that the API never enters subsequent analysis, which is irreversible. Therefore uncertain/boundary cases default to confirmed or candidate.
- Only clear evidence of irrelevance (naming, directory, and code structure all unrelated, and not satisfying any inclusion criterion of 3.1/3.2/3.4) justifies rejected; "looks low value" or "not like a typical function" is not grounds for rejected.
- `judge`/`batch-judge` has a built-in `dataValueMisuseWarning` heuristic, but its coverage is incomplete; the executor must still self-check proactively.

### 3.4 Including Auxiliary/Control-Type and Read-Write Dual APIs (3b)

"Data relevance" is a floor, not the only dimension. Semantic judgment must also check two kinds of relation:

1. **Auxiliary/control-type APIs of the privacy/permission state machine**: they do not themselves return the target datum, but are the entry point for querying, triggering, listening to, or redirecting the privacy-authorization state machine that an already-confirmed API depends on (e.g. querying/triggering/listening to a privacy prompt, or agreement redirection), sharing the same privacy state with the confirmed API.
2. **Dual APIs of crud-pair / reverse operations in the same business domain**: they form a reverse read-write / upload-download pair with an already-confirmed API (e.g. read step count ↔ upload step count); their value lies in constituting a comparison sample of "same business domain but permission mechanism of different origin". Where `pairing-check`'s naming rules cannot derive them, semantic judgment must supply them.

**Execution**: besides checking the candidate's own parameters/return values, also check whether the subdirectory of its `docPath` already contains confirmed members (hinting at type 1), and whether its verb prefix forms a read-write reversal with some already-confirmed API (hinting at type 2). `pairing-check`'s `same-dir-fallback` is a tool-side safety net and cannot replace semantic judgment.

## 4. Step 1: Documentation-Layer Collection

**Goal**: collect the documentation of all APIs in the target domain (parameters, return values, Configuration/usage, application/activation and user-authorization fields, etc.) and produce a complete API inventory as the analysis baseline. Auxiliary/control-type APIs (`stop*` / `off*` / pure geometric computation classes) must not be omitted — they are often the key to later discovering equivalence channels.

**Tool-based flow** (stages 2-6 are the loop body, iterated until stage 7 judges no further growth; each stage is labeled "LLM judgment" or "code call", and the two alternate strictly):

| Stage | Type | Action |
|---|---|---|
| 0 | LLM | Before any `doc-filter.js` invocation, establish initial understanding of the target domain, producing initial keywords, typical APIs (including guessed `apiName`/`kind`), and the initial return-value set R. Evidence priority per Section 2 item 1 |
| 1 | Code | Organize the three sets into JSON (use `--termsFile`/`--apisFile`/`--returnsFile` for content containing Chinese) and call `seed` once to persist |
| 2 | Code | `scan-filenames --docRoot <all documentation directories> --pattern <regex>`, returning only matched paths; add `--contentPattern` for a second coarse filter when the corpus is very large |
| 3 | Code | Organize matched paths into `--filesFile` and call `scan-content`; hits are registered automatically as `candidate`, while new APIs in the same namespace found in the sample code of confirmed APIs are also mined |
| 4 | LLM | Read the verbatim `docPath` of each candidate and judge whether it belongs to the target domain (criteria in Section 3, prompt in Section 6.1); also judge which fields in `newReturnCandidates` are relevant |
| 5 | Code | `judge`/`batch-judge` writes back `docEvidence.status` (`confirmed`/`rejected`/`candidate`); prefer the batch form when there are dozens of candidates |
| 6 | Code+LLM | After stage 5 adds confirmed members to set A, call `pairing-check --docRoot <multiple directories>` (checking naming siblings such as `onX`/`stopX`/`offX`/`onXChange`; a hit is registered as candidate); `newlyPaired` returns to stage 4 for semantic judgment |
| 7 | Code | `loop-status` compares whether the confirmed count has grown: if grown, return to stage 2/3/6; when it no longer grows and no candidate remains in `pending`, converge |

**Connection to Step 2**: the confirmed inventory after Step 1 converges is the starting input of Step 2; the K_code set accumulated throughout is the sole source of code-side retrieval anchors for `code-filter.js`. If Step 2 finds that some genuine functional feature word never entered K_code, return to stage 5 (the `matchedKCode` field of `judge`/`batch-judge`) to seed it; do not start a separate independent word list.

**Output**: `_tmp_<domainAbbr>_step1_api_list.md` (a narrative inventory including the iteration process; the structured result of `export` is a data source and cannot serve directly as the deliverable).

## 5. Step 2: Code-Layer Implementation Review

**Goal**: locate, one by one in the implementation code, each API's real implementation function, permission-check branches, and permission-bit mapping table.

**Review points**:

- Prioritize finding **judgment functions / mapping tables / formatting functions shared by multiple APIs** — the most direct clue for later discovering cross-API equivalence relations.
- The same codebase may contain **multiple independent parallel permission/reporting mapping tables** (e.g. an admission table before invocation and a compliance reporting table after invocation); do not stop after finding the first one. Agreement between two tables is stronger double confirmation and must be noted in the conclusion.
- When encountering "a rendering/UI component internally invoking a data interface" (including `<view-data-writer>`/`this.data` assignment inside a component method body), apply the two-level reachability model in `doc-code-cross-validation.md`, "Reachability Determination for Component-Specific APIs", evaluating "the component itself" and "the independent API invoked inside the component" separately; do not conclude "readable from the JS side" merely because of `<view-data-writer>` — this is a core hypothesis that Step 10 must validate empirically.
- The rendering-layer component family is itself a candidate for Step 1 and must not be ignored wholesale at the documentation-collection stage merely because it is not a traditional "callable API".

**Tool-based flow** (stages 5-8 feature summarization/checking and stages 9-11 feature utilization each form a sub-loop, iterated until convergence):

| Stage | Type | Action |
|---|---|---|
| 0 | Handoff | Reuse the same `_api_registry.json` from Step 1, receiving the confirmed inventory, K_code, and set R |
| 1 | LLM | Select from the confirmed inventory the 10 APIs most representative of the target domain (covering different `kind` values as far as possible) as the first-round feature-summarization sample |
| 2 | Code | For each sample, first `locate-anchor` (five anchor types: function name / string / scope mapping table / group / system-call characteristic), then hand the hit position to `extract-function` for bracket-counting extraction (zero LLM; on hitting `apiName: short alias` it automatically traces aliases/package jumps and may return multiple `segments`) |
| 3 | LLM | Judge whether the extracted code is the target implementation of that API: hit / needs wider range / needs a different anchor / entirely unrelated (prompt in Section 6.2). Judge only "does it implement this API", not data value; control/output types with zero data returned are treated as "hit" as long as the implementation exists. If widening is needed, return to stage 2 to increase `--maxExpand` or switch anchors |
| 4 | Code | `record-code-evidence` (`append` mode deduplicates and merges by `file+startLine+endLine`) writes back `codeEvidence` |
| 5 | LLM | Read the sample function bodies and summarize four classes of `CodeFeaturePattern` (keyword-corresponding feature / return-value-corresponding feature / system data-fetch operation feature / permission-judgment feature), written as executable regexes |
| 6 | Code | `feature-add` registers each feature |
| 7 | Code | `feature-scan` checking round (not omissible): scan already-located functions with all features, count the hit rate, collect `unmatchedFunctions` |
| 8 | LLM | If `unmatchedFunctions` is non-empty, use them as samples for a second round of feature summarization (do not assume the first-round features are already general); return to stage 6 to register and rerun stage 7 until no new features are needed |
| 9 | Code | `feature-locate`: scan a wider range using stable features as new anchors, exclude known ranges, and output new candidate positions (`apiName` left empty) |
| 10 | LLM | Infer, for each stage-9 candidate position, which existing documented API it corresponds to, or whether it is a new discovery never appearing in the documentation inventory (prompt in Section 6.3) |
| 11 | Code | `record-code-evidence`: additional positions of known APIs are appended; entirely new discoveries are registered via the "documentation missing" path (`codeEvidence` persisted first, documentation side left empty pending cross-validation confirmation) |
| 12 | LLM+Code | After locating any permission/scope mapping table or group information, **first enumerate all top-level keys of that table with `extract-object-keys`** (do not settle for the few hits of keyword matching; manual checking is equivalent to reading the whole table line by line), compare against the Step 1 confirmed inventory, and judge item by item whether each is a real API (`record-code-evidence` registering codeOnly) or noise (ignore); if confirmed to be the grouping/mapping table itself, additionally register with `grouping-add` |
| 13 | Wrap-up | `cross-validate.js` `compare`→`resolve`→`prune`→`summary`→`check-loop` (looping until convergence or a 10-round cap). `matched` and "both sides judged irrelevant" are terminated automatically by `compare`; `docOnly`/`codeOnly`/empty-shell records require the LLM to judge the reason and then write back `finalStatus` via `resolve` — a `codeOnly` conclusion can serve directly as evidence of a "documentation missing" finding, and a `docOnly` conclusion indicates that the code search range must be widened or the anchor switched |

**Output**: `_tmp_<domainAbbr>_step2_code_check.md` (narrative review record).

## 6. LLM Judgment Prompt Specification (Shared by Step 1/2 Semantic Judgments)

> Corresponds to Section 1, General Principle 5. Every judgment of "is it relevant" or "is it a hit" organizes its input per the template in this section and outputs per the schema.

### 6.0 General Requirements

1. **The three input elements are all mandatory**:
   - **Matched keywords** — which words/anchors/feature regexes produced this hit (including the word-list source: `seed` / `K` / `K_code` / `R` / `feature` / `pairing-check` sibling-naming rules);
   - **Verbatim hit content** — on the documentation side, the full document corresponding to `docPath` (or an excerpt including parameters, return values, Configuration, permission fields); on the code side, the function body extracted by `extract-function` (including `file:startLine-endLine`, possibly multiple `segments`);
   - **Other hint data** — see the "hint data" block of 6.1/6.2/6.3 respectively.
2. **The output must be a single JSON object**, with field values constrained by each section's schema, directly consumable by `judge` / `batch-judge` / `record-code-evidence` / `resolve`; prose output is not allowed, nor is attaching conclusions outside the JSON.
3. **Judge only from the material given**: do not supplement documentation fields, return values, or code line numbers from your own memory; when the material is insufficient, set `verdict` to `candidate` (documentation side) or `needs-more-context` (code side) and state in `note` what is missing.
4. **The criteria are those of Section 3**; the prompt only organizes the criteria and material clearly, and must not itself relax or tighten the criteria.

---

### 6.1 Documentation Side: Domain Membership Judgment (Step 1, Stage 4)

**Prompt Template**

````text
[Task]
You are the documentation filter for mini-program API privacy analysis. Judge whether the candidate API documentation below belongs to the target functional domain.
Answer only "does it belong to the documentation set of this domain", not "how valuable is the data" (value judgment is left to later steps).

[Input]
Target functional domain:
{{domain}}

Keywords matched this time:
- Matched terms: {{matchedTerms}}          # e.g. location, latitude/longitude, latitude, <scope-id>
- Word-list source: {{termSource}}          # seed initial terms / K keyword set / R return-field set / pairing-check sibling naming
- Hit stage: {{hitStage}}            # scan-filenames / scan-content / pairing-check / same-dir-fallback
- Hit location: {{hitWhere}}            # filename / description / return field / sample code

Verbatim candidate documentation:
- docPath: {{docPath}}
- apiName / kind: {{apiName}} / {{kind}}
- Functional description: {{description}}
- Request parameters: {{params}}
- Return value fields: {{returnFields}}
- Configuration / usage: {{configuration}}
- Permission fields (scope / activation application / declaration): {{permissionFields}}
- Sample code: {{example}}

Other hint data:
- Already-confirmed members in the same subdirectory: {{sameDirConfirmed}}     # hints at 3.4 type 1: auxiliary/control type
- The confirmed return-field set R: {{R}}
- Read-write reversal (verb-prefix dual) candidates with confirmed APIs: {{dualPairs}}   # hints at 3.4 type 2
- Permission mapping table group / groupKey / scope: {{groupKey}}
- Precedents of the same kind of judgment in this round (to avoid self-contradiction): {{precedents}}
- New return-value fields derived but unconfirmed in the previous round: {{newReturnCandidates}}

[Criteria]
Criteria:
- 3.1 Data relevance: parameters or return values containing identifying fields of the target domain (or accessed/stored partitioned by user identity) are included; do not skip them because of surface functional labels.
- 3.2 Domain membership: ask only whether it belongs to this domain's documentation set; if membership holds while value is zero (hardware control/output types), still judge confirmed.
- 3.3 Recall first: doubtful cases are always confirmed or candidate; only when naming/directory/structure are all unrelated and no inclusion criterion is met may it be rejected.
- 3.4 Auxiliary/control types (querying/triggering/listening to/redirecting the privacy state machine that a confirmed API depends on) and read-write dual types are both included.

[Output]
Output: strictly output a single JSON object, with no additional text:
{
  "apiName": "<string>",
  "docPath": "<string>",
  "verdict": "confirmed | candidate | rejected",
  "standard": ["3.1" | "3.2" | "3.4-1" | "3.4-2"],
  "reason": "<one sentence, must quote the specific field or fragment in the source>",
  "evidence": {
    "matchedTerms": ["<matched term>"],
    "fields": ["<matched parameter/return field>"],
    "quotes": ["<verbatim fragment>"]
  },
  "sameDirConfirmed": ["<APIs already confirmed in the same directory>"],
  "dualPair": "<the confirmed API forming a read-write reversal; null if none>",
  "newReturnCandidates": ["<return fields newly found in this document and relevant to the target domain>"],
  "newTerms": ["<new keywords for the next round of scan-content / code-filter>"],
  "confidence": "high | medium | low",
  "note": "<state here when material is insufficient or manual re-check is needed>"
}
````

**Write-back**: `verdict` → `docEvidence.status` of `judge` / `batch-judge`; `newTerms` → input to the next round of `scan-content`; `newReturnCandidates` → the stage-4 return-value judgment queue.

---

### 6.2 Code Side: Implementation Judgment (Step 2, Stage 3)

**Prompt Template**

````text
[Task]
You are an analyzer of mini-program framework code. Judge whether the extracted code below is the real implementation of the target API.
Judge only "does it implement this API", not data value (control/output types with zero data returned count as a hit as long as the implementation exists).

[Input]
Target API:
{{apiName}} (kind={{kind}}, already confirmed on the documentation side)

Anchors and keywords matched this time:
- locate-anchor anchor type: {{anchorType}}   # function name / string / scope mapping table / group / system-call characteristic
- Matched terms (K_code): {{matchedKCode}}
- Matched feature regexes (CodeFeaturePattern): {{matchedFeatures}}
- Excerpt range: {{file}}:{{startLine}}-{{endLine}}, segments={{segmentCount}}

Verbatim hit code:
{{codeBody}}

Other hint data:
- Already registered implementation locations of this API (if any): {{knownLocations}}
- This API's registration in the permission/scope/jsapi mapping table: {{registry}}
- Implementation shapes of APIs in the same family (for recognizing wrapper patterns by comparison): {{siblingPatterns}}
- Hit/miss status of this function in the feature-checking round: {{featureHitStats}}
- Known uniform invocation wrapper names (such as <wrapper-fn-A> / <wrapper-fn-B>): {{wrappers}}

[Criteria]
Decision conventions:
- "hit" = this function (or its enclosing wrapper) is the implementation entry or a necessary path of this API.
- "needs wider range" = only the outer wrapper or a fragment was extracted; increase --maxExpand.
- "needs a different anchor" = clearly a same-named but unrelated function; switch anchors and re-locate.
- "entirely unrelated" = naming, call chain, and semantics are all unrelated to the target API.
- Record permission checks as fact only: "no check seen" at the JS layer does not mean there is no permission control; the check may have sunk into the native layer.

[Output]
Output: strictly output a single JSON object, with no additional text:
{
  "apiName": "<string>",
  "anchor": {"type": "<anchor type>", "value": "<anchor value>"},
  "verdict": "implements-known | implements-new | helper-or-alias | needs-more-context | unrelated",
  "interfaceName": "<identified interface name; for implements-new, fill in the new interface name>",
  "location": {"file": "<string>", "startLine": 0, "endLine": 0},
  "permissionCheck": {
    "jsLayer": "present | absent | conditional | not located",
    "detail": "<check function name or branch condition>",
    "line": "<line range>"
  },
  "registry": [{"table": "<permission/scope/jsapi mapping table name>", "key": "<registration key>", "position": "<file:line>"}],
  "features": [{"type": "keyword|returnValue|systemFetch|permissionCheck", "regex": "<executable regex>"}],
  "expandHint": "enlarge | switch-anchor | none",
  "confidence": "high | medium | low",
  "note": "<state here when insufficient or manual re-check is needed>"
}
````

**Write-back**: `verdict=implements-known|implements-new` → `record-code-evidence` (`append` mode deduplicates by `file+startLine+endLine`); `features` → `feature-add`; `expandHint=enlarge|switch-anchor` → return to stage 2.

---

### 6.3 Code Side: Candidate Position Attribution (Step 2, Stage 10)

**Prompt Template**

````text
[Task]
You are an analyzer of mini-program framework code. The position below was discovered by feature scanning (feature-locate), with apiName left empty.
Judge which already-documented API it corresponds to, whether it is a new interface never recorded in the documentation, or whether it is noise.

Candidate position:
[Input]
- Position: {{file}}:{{startLine}}-{{endLine}}
- Matched features: {{matchedFeatures}}
- Verbatim code:
{{codeBody}}

Other hint data:
- Confirmed inventory on the documentation side (for comparison): {{confirmedApiList}}
- Functions already located near this position: {{nearbyFunctions}}
- The full set of known permission/scope mapping table registration keys: {{registryKeys}}
- Known noise patterns (e.g. bundled framework code, polyfills, logging wrappers): {{knownNoise}}

[Criteria]
Decision conventions:
- It matches the semantics/call chain of some confirmed API → known-api.
- It is an interface with independent semantics that can be invoked but is not recorded in the documentation → new-api (register via the "documentation missing" path).
- Bundling/framework/utility function without independent semantics → noise.
- Information insufficient to distinguish → needs-more-context, stating which code range needs supplementing.

[Output]
Output: strictly output a single JSON object, with no additional text:
{
  "location": {"file": "<string>", "startLine": 0, "endLine": 0},
  "verdict": "known-api | new-api | noise | needs-more-context",
  "apiName": "<for known-api, the confirmed API name; for new-api, the inferred name; null otherwise>",
  "reason": "<one sentence, must quote a code fragment>",
  "evidence": {"quotes": ["<code fragment>"], "matchedFeatures": ["<feature>"]},
  "registry": [{"table": "<string>", "key": "<string>", "position": "<file:line>"}],
  "confidence": "high | medium | low",
  "note": "<when insufficient, state the code range needing supplement>"
}
````

**Write-back**: `known-api` → append a new location for that API; `new-api` → register as codeOnly (`codeEvidence` persisted first, documentation side left empty pending confirmation by `cross-validate.js` `resolve`); `noise` → ignore and record in the Step 2 output for reference; `needs-more-context` → return to stage 2 to widen the excerpt range.
