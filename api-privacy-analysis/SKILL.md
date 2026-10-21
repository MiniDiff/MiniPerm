---
name: api-privacy-analysis-en
description: This skill should be used when analyzing a category of platform/framework APIs (e.g. location, user-profile, or device-management APIs of mini-program platforms, or privacy-sensitive interfaces of other application platforms) to determine their real privacy/permission exposure — covering permission-layer classification, parameter-driven data-value analysis, cross-API data-flow tracing, documentation-vs-code discrepancy checks, and cross-API/cross-category equivalence and bypass channel discovery. Trigger this skill whenever the user asks to analyze what data an API can obtain, whether an API's permission requirement matches its actual code behavior, whether multiple APIs can be combined to bypass or replicate a higher-permission API's data, or to produce a permission/data-value comparison across a family of APIs.
---

# API Privacy and Permission Analysis

## Overview

A general-purpose pipeline for analyzing the privacy and permission exposure of APIs within a functional domain: dual-source collection from documentation and code → convergence loop of shared-source grouping / three-layer permission annotation / parameter-sensitivity analysis / data-flow analysis → documentation-code cross-validation → transformation into comparison pairs → scenario construction, equivalence determination and empirical validation → tiered summary by data value. Execution details of each step live in the corresponding files under `references/`; this file defines only the workflow, contracts, and constraints.

## When to Use

- Analyze what data an API (or a group of APIs) can obtain, and whether it is equivalent to another API;
- Judge whether the permission layering of a functional domain is sound, or check whether documented claims match the code implementation;
- Find alternative ways to substitute for or bypass a high-permission API (single-API idioms or multi-API compositions);
- Enumerate every path that yields a given data category, and rank them by data value and permission requirement.

## Core Principles

0. **Every step must be executed according to the corresponding rules file under `references/`; before executing that step, actually open and read that rules file in full.** Do not infer criteria from memory of a previous run, the shape of existing artifacts, or the form of the evidence at hand — the literal definition in the rules file is authoritative. The rules file for each step is listed in the `references/` table at the end of this document.

1. **Never evaluate a single API in isolation**: permission annotation must be combined with the implementation code, and must also check composed invocations, cross-method state coupling, and straight-through scenarios.
2. **Documentation is only the starting point; code is the final arbiter**: every documentation claim must be cross-checked against code item by item.
3. **The same datum may be reachable through multiple paths with widely differing permissions**: the analysis is not limited to APIs nominally belonging to the category; alternative channels in other categories that can reconstruct the same datum must also be examined.
3a. **Domain membership is by default judged by data relevance**, not by an API's primary functional category (unless the user explicitly asks to narrow it).
3a-1. **Steps 1/2 decide domain membership, not data value**; value is deferred to Step 12.
3a-2. **Steps 1/2 prioritize recall**; doubtful cases are included by default (confirmed or candidate) and are not excluded by default.
3b. **Auxiliary/control-type and read-write dual APIs** must be included even if they do not themselves carry the target datum.
4. **Read the general rules directly from this skill's `references/`**; do not create copies in the project root.
5. **Permission layer and data value are orthogonal dimensions**: judge them separately (per `data-value-framework.md`) before cross-comparing.
6. **Every conclusion must be annotated with evidence strength** (direct code evidence / indirect documentary support / speculation). When evidence is insufficient, annotate it honestly — neither assert a conclusion dogmatically nor skip the entry.
7. **Validation code performs diagnostic observation only** (whether a permission declaration exists, whether a prompt is triggered, whether `authSetting` leaves a trace). For security-sensitive scenarios such as payment, identity verification, and biometrics, do not generate implementations that could be directly used for fraud or forgery.
8. **When cleaning up temporary or stale material, prefer moving it into `tmp/`**; do not use deletion operations that require user confirmation unless the user explicitly asks.
9. **Do not use colored emoji in artifacts**: use `!` for warnings, `√` for holds, `×` for does-not-hold, and bracketed text labels for everything else (e.g. `[event]`); `★`, circled numerals, and box-drawing characters are exempt.
10. **Negative conclusions and pending-decision management run through every step**; see the next section.

## Negative Conclusions and Pending-Decision Management (Presumption of Guilt)

Applies to the dismissal of any suspected flaw at any step, and to conclusions of the form "no risk / equivalent / already covered / low priority / not applicable".

- **Default stance**: when suspecting that an API or path exhibits a permission-data mismatch, an equivalence channel, or other risk, presume that it exists. Dismissal is permitted only when evidence adequately proves its absence; "the available evidence cannot prove its existence" is not grounds for dismissal.
- **Evidence tiers (increasing weight; no single lower tier suffices on its own to support dismissal)**: (i) documentation description; (ii) code implementation (failure to find a check branch at the JS layer is only strong indirect evidence — the check may have sunk into the native layer); (iii) actual execution results (the primary basis for dismissing a suspected flaw).
- **Multi-round execution validation**: before dismissal, the validation code must undergo the same multi-round correction as Steps 10↔11 (at most 3 rounds). A single-round failure or an undecidable result is neither treated as "does not exist" nor abandoned: one must first determine whether it is a mechanical error, an environment limitation, or a genuine disagreement about validation logic. Dismissal is permitted only when the validation code has credibly executed up to the core hypothesis under test and the result clearly indicates non-existence; the validation actions performed must be recorded.
- **Pending-decision list**: suspected risks that remain unconfirmable after multiple correction rounds due to environment limitations, and any skipped / downgraded / doubtful item produced by any step, must be registered in a pending-decision list that runs through the whole process (recording the producing step, evidence status, and resolution conditions). They must not default to "does not exist" or be silently removed; clear them item by item before the Step 12 report.

## Execution Conventions: Persistence, Naming, and Code Handling

1. **Persist every step (mandatory)**: upon completing any of Steps 0/1/2/3-6/7/8/9/10/11/12 (each convergence round of the loop counts separately), first write the step's complete findings to `tmp/<domain>analysis-<YYYYMMDD>/_tmp_<domainAbbr>_step<N>_<content>.md`, then proceed; if a previous step is found not to have been persisted, write it immediately. The stage contract files (`_stageA_groups.json`, `_stageA_pairs.json`, `_stageB_equiv_verdicts.md`, `_stageB_codegen_runs.md`) are additional required structured artifacts and cannot be replaced by scattered step files.
2. **Naming rules**: `tmp/<domain>analysis-<YYYYMMDD>/` and `autotest/TestResult/<domain>test-<YYYYMMDD>/` are paired with identical `<domain>` — only the suffix differs ("analysis" vs "test"). Dates use the full 8-digit `YYYYMMDD` (short formats sort incorrectly). When Step 11 invokes `miniapp-autotest` to run tests, it must explicitly tell it the target platform (WeChat/Alipay) and pass `--result-path`; the concrete script and parameters are determined by `miniapp-autotest` per its own platform rules and are not restated here. Batched execution (multiple runs of Steps 10-11, real-device follow-up, stage B and stage A on different days) reuses the directory established initially rather than creating new date groups. `tmp/` holds only intermediate artifacts (step files, testPlan JSON, archived scenario code); `autotest/TestResult/` holds only Step 11 execution output. The two must not be mixed.
3. **Handling code produced by Step 10**: the `SCENARIOS` region of `index.js` is written by Step 10 — before generating, check whether leftover code from a previous task exists; if so, clear it entirely and then inject the new code as a single edit. Once the Step 11 correction loop terminates (success / undecidable / max rounds reached / environment problem), immediately copy the complete `SCENARIOS` code into `tmp/<domain>analysis-<YYYYMMDD>/_archived_<domain>_scenarios.js` (including full handler implementations); archiving does not clear `index.js`. Details are in `empirical-code-generation.md` and in `execution-and-feedback.md`, "Stage 4: Code Archiving".

## Tooling (Steps 1/2, Optional)

When documentation reaches dozens of entries or code reaches thousands of lines, use `scripts/api-filter/` (`doc-filter.js` / `code-filter.js` / `cross-validate.js`) to filter and locate; if the volume is manageable, the tools are unnecessary. Command arguments, data formats, and error handling are in `references/automated-filter-tools.md`.

1. The scripts perform deterministic retrieval only and never call an LLM; semantic judgments are made by the caller and written back via `judge` / `record-code-evidence` / `resolve`. The returned `candidate` / `pending` / `docOnly` / `codeOnly` are all queues awaiting judgment.
2. Any argument containing Chinese, an array, or an object must be passed via `--xxxFile <path>` rather than inline shell JSON.
3. The three scripts share `tmp/<domain>analysis-<YYYYMMDD>/_api_registry.json`; round summaries and exported files go in the same directory.
4. `export` is the data source for the Step 1/2 persisted files and does not replace the narrative summary.
5. After locating a permission/scope mapping table, enumerate it exhaustively with `extract-object-keys`; keyword hits alone are insufficient.
6. `--docRoot` accepts comma-separated directories; pass all documentation source directories at once in Step 0.
7. `groupingHints` is only a preliminary clue for 3a and must be re-verified.
8. Step 8's `transform-pairs.js` likewise never calls an LLM; see `api-composition-and-equivalence-channels.md`, Section 5. Its outer orchestration uses `step8-loop.js` (issuing cards and writing back; criteria are judged live from the cards by the LLM and not persisted); see Section 5.1.

## Analysis Workflow

### Two Independent Stages

| Stage | Steps | Input | Final output | Key intermediate artifacts |
|---|---|---|---|---|
| **A Discovery** | Step 0-8 | Functional domain name + documentation/code source paths | Comparison-pair sequence `_stageA_pairs.json` | Shared-source grouping table `_stageA_groups.json` |
| **B Validation** | Step 9-12 | `_stageA_pairs.json` | Vulnerability findings report | `_stageB_equiv_verdicts.md` (equivalence verdict table), test code per comparison pair, `_stageB_codegen_runs.md` (run and retry count table) |

- Stage A advances in the order Step 0→8 and delivers upon completion of Step 8; `_stageA_pairs.json` is the only external contract.
- Stage B takes `_stageA_pairs.json` as its sole input and may be started independently in a different session; on startup it verifies that the file exists and that its schema is valid. If missing, it instructs the user to run stage A first and must not guess the comparison-pair contents.
- Both stages share the same `tmp/<domain>analysis-<YYYYMMDD>/` directory.

### Step 0: Define Scope
- **What**: establish the functional domain, documentation/code source paths, report filename, and `tmp/` group directory name; decide whether to use the filtering tools; complete four mandatory checks — sub-domain enumeration (local directories > web search > own knowledge), exhaustive enumeration of documentation source directories, real web-search calls with source attribution, and no silent dropping of directories listed by `list_dir`.
- **Before starting (mandatory)**: per Core Principle 0, read `documentation-and-code-collection.md` first; thereafter, before entering each step, read that step's rules file (see the `references/` table at the end).
- **Output**: `_tmp_<domainAbbr>_step0_scope.md`
- **Details**: `documentation-and-code-collection.md`, Section 2

### Step 1: Documentation-Layer Collection
- **What**: collect all API documentation for the target domain and produce a complete inventory as the analysis baseline (auxiliary/control-type APIs must not be omitted); judge domain membership per principles 3a/3a-1/3a-2/3b.
- **Output**: `_tmp_<domainAbbr>_step1_api_list.md`
- **Details**: `documentation-and-code-collection.md`, Sections 3 and 4

### Step 2: Code-Layer Implementation Review
- **What**: locate each API's implementation function, permission-check branches, and permission-bit mapping table; prefer judgment functions or mapping tables shared by multiple APIs; when a component internally invokes a data interface, perform two-level reachability determination.
- **Output**: `_tmp_<domainAbbr>_step2_code_check.md`
- **Details**: `documentation-and-code-collection.md`, Section 5

### Steps 3-6: Convergence Loop
- **What**: 3a shared-source grouping → 3b three-layer permission annotation → 3c parameter-sensitivity analysis → 3d data-flow and state-coupling analysis, iterating until no new findings emerge; the grouping table must not converge with "to be investigated / pending" states.
- **Output**: `_stageA_groups.json` (every member filled with `permVector` / `capability` / `rw`), `_tmp_<domainAbbr>_step3-6_convergence.md`
- **Details**: `convergence-loop.md`; 3a `api-grouping.md`, 3b `permission-layering-framework.md`, 3c `parameter-analysis.md`, 3d `data-flow-analysis.md`

### Step 7: Documentation-Code Cross-Validation
- **What**: check documentation claims against code implementation item by item, recording discrepancies with unified deviation labels.
- **Output**: `_tmp_<domainAbbr>_step7_cross_validation.md`
- **Details**: `doc-code-cross-validation.md`

### Step 8: Transform into Comparison Pairs (Substitution and Composition)
- **Input**: `_stageA_groups.json`
- **What**: within the candidate space delimited by shared-source groups, repeatedly apply **substitution** (B2 coordination) and **composition** (B1 dependency) transformations to the starting access; the LLM coarsely screens whether equivalence is possible, producing a comparison pair `p = ⟨s₀, s₁, γ, μ⟩` — `s` is a parameter-free API sequence skeleton, `γ=(w,c,r)` is the transformation rationale, and `μ` is the equivalence rationale (equivalence reason / comparison criterion / construction hint). The outer loop selects the starting point; the inner loop treats that starting point as the sole baseline. Candidates enter the stack uniformly, and only those passing the coarse screen become comparison pairs; the screening criterion is permissive — anything whose possibility cannot be ruled out is passed through. A precondition gate is checked before entry, and cross-group sweeps plus worked-example review are performed before exit.
- **Output (stage A external contract)**: `_stageA_pairs.json`; those marked `drop` are recorded in `_tmp_<domainAbbr>_step8_dropped.md` and must not be silently discarded.
- **Details**: `api-composition-and-equivalence-channels.md` (script `transform-pairs.js`; outer orchestration by `step8-loop.js` issues substitution/composition cards, with criteria judged live from the cards in this step)

### Step 9: Scenario Construction and Equivalence Determination (Stage B Entry)
- **What**: for each comparison pair — horizontally construct two invocation sequences that can achieve the target capability (invocation targets and order, parameters, callbacks and wait points, preconditions); vertically construct the comparison configuration (collection, measurement conventions, execution relationship, determine the permission gap before setting authorization, environment reset); describe with the DSL; produce the equivalence verdict (`equivalent` / `no_gap` / `not_equivalent` / `undecidable`), with only `equivalent` advancing to Step 10. Select a validation protocol for each validation scenario and define the three-branch decision criteria; exploitation scenarios are handed to Step 12 to be filled in.
- **Output**: `_stageB_equiv_verdicts.md` (full coverage, one row per comparison pair), validation scenario list (DSL + decision task sheet), exploitation scenario list with harm-tier distribution
- **Details**: `scenario-construction-and-exploitation.md`

### Step 10: Empirical Code Generation
- **Input**: the validation scenarios corresponding to comparison pairs judged `equivalent` in Step 9 (exploitation scenarios excluded).
- **What**: faithfully translate the DSL into validation code (scenario-registration pattern) and a testPlan; both design and coding stay in this step; each comparison pair has its own independent scenario code and testPlan; `ACT`-type scenarios compare observable effects rather than data fields.
- **Clear before injection (mandatory)**: before injecting into the `SCENARIOS` region of `index.js`, check whether it already contains code — whether left over from a previous task or generated by an earlier batch of this task. **If so, clear it entirely and then inject this batch**, performing the clear and the injection as a single edit; if empty, fill it directly. **Appending after old code is strictly forbidden**: if functions are tested one after another by appending, `index.js` accumulates without bound, bloating the code, slowing execution, and making results hard to attribute. When multiple scenarios must run together, inject them all in one batch rather than appending in several passes.
- **Output**: validation task sheet, scenario-registration code block, testPlan JSON
- **Details**: `empirical-code-generation.md`

### Step 11: Execution and Feedback
- **What**: deploy and execute using the `miniapp-autotest` skill (pure execution/orchestration, no validation logic authored here); the main flow uses DevTools uniformly by default, with real-device runs deferred until after report delivery; record for each comparison pair whether the code ran through (no errors, executed to completion, independent of the validation conclusion) and how many regeneration rounds were needed; code defects go through the Step 10↔11 correction loop (at most 3 rounds); when results require revising an upstream judgment, follow the qualitative-validation loop back to Steps 8/9/10.
- **Code archiving (mandatory)**: once the correction loop terminates (success / undecidable / max rounds / environment problem), **immediately copy the complete `SCENARIOS` code** into `tmp/<domain>analysis-<YYYYMMDD>/_archived_<domain>_scenarios.js` (including full handler implementations) as the record of that execution. Archiving **only copies** and does not clear `index.js` — clearing is deferred until the next Step 10 generates new code.
- **Output**: results under `autotest/TestResult/`, empirical validation summary table, `_stageB_codegen_runs.md`, real-device follow-up list (if any)
- **Details**: `execution-and-feedback.md`

### Step 12: Tiered Summary by Data Value
- **Input**: the Step 11 result summary table and real-device follow-up list, `_stageB_equiv_verdicts.md`, `_stageB_codegen_runs.md`, `_stageA_pairs.json`, `_stageA_groups.json`.
- **What**: tier by the six-dimensional criteria; list the reachable paths and three-layer permission requirements per tier; mark mismatches with ★★/★★★; put core findings first; write the harm tier of exploitation scenarios back into each finding; run the pre-submission self-check (new-paradigm self-check, pending-decision clearing).
- **Output**: final report (stage B external output)
- **Details**: `final-report-and-paradigm-codification.md`, `data-value-framework.md`

### Step 13: Codify New Analysis Paradigms
- **What**: when the Step 12 self-check surfaces a new paradigm — list them → ask the user to confirm → modify only the corresponding rules file under `references/` per the confirmation → add cross-references. Never modify a rules file without confirmation.
- **Details**: `final-report-and-paradigm-codification.md`, Section 7

### Real-Device Follow-Up (Triggered After Report Delivery, Not Counted Among the 13 Steps)
Once the user confirms they are present and can scan the QR code, reuse the testPlan to execute on RealDevice, then write targeted updates back into the delivered report. Details are in `execution-and-feedback.md`, "Real-Device Follow-Up Flow".

## Resources

- **Dependent skill**: `miniapp-autotest` (`.codebuddy/skills/miniapp-autotest/`) — the pure execution engine for Step 11; it does not generate code.
- **Scripts**: `scripts/api-filter/` (Steps 1/2 and 8).
- **Knowledge asset**: `knowledge/derivability_graph.json` (derivability graph); additions and modifications require Step 13 confirmation.

### references/

| Step | File |
|---|---|
| Steps 0-2 | `documentation-and-code-collection.md`; tool command reference `automated-filter-tools.md` |
| Steps 3-6 | `convergence-loop.md`; `api-grouping.md`, `permission-layering-framework.md`, `parameter-analysis.md`, `data-flow-analysis.md` |
| Step 7 | `doc-code-cross-validation.md` |
| Step 8 | `api-composition-and-equivalence-channels.md`; formal background `unified-theory-equivalence-and-permission-flaws.md` |
| Step 9 | `scenario-construction-and-exploitation.md` |
| Step 10 | `empirical-code-generation.md`; quantitative basis `equivalence-path-validation-methodology.md` (ACQUIRE type only) |
| Step 11 | `execution-and-feedback.md` |
| Steps 12-13 | `final-report-and-paradigm-codification.md`; `data-value-framework.md` |
