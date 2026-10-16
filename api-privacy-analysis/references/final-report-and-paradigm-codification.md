# Final Report and Paradigm Codification Rules (Steps 12-13)

> Corresponds to Step 12 of `SKILL.md` (tiered summary by data value) and Step 13 (codifying newly discovered analysis paradigms). The six-dimensional criteria and tiering of data value are in `data-value-framework.md`.

## 1. Inputs to Step 12

- The **empirical validation result summary table** from Step 11 (scenario ID, core hypothesis, validation-method ID, empirical conclusion `√/×/!`, qualitative-validation loop rounds, result directory path, recommended effect on tiering);
- The **real-device follow-up list** from Step 11 (if any);
- The **comparison-pair equivalence verdict table** `_stageB_equiv_verdicts.md` from Step 9 (including comparison pairs of the three kinds `no_gap` / `not_equivalent` / `undecidable` that did not enter empirical testing, with their rationale; `undecidable` entries must be cleared item by item — see Section 6);
- The **code generation and run record table** `_stageB_codegen_runs.md` from Step 11 (used to annotate the empirical evidence strength of each finding: ran through and yielded a conclusion / did not run through and therefore evidence is insufficient);
- `_stageA_pairs.json` from Step 8 and `_stageA_groups.json` from Steps 3-6 (three-layer permission annotation, capability nature, read-write inventory; used for path organization and tier ordering).

## 2. Tiering and Mismatch Highlighting

1. First tier each path by the six-dimensional criteria (authenticity / precision / timeliness / acquisition cost / identifiability / derivability), then cross-check with auxiliary rules such as degree of permission protection, privacy sensitivity, and the derivability conservation law, and finally tier by the datum's ultimate value (e.g. continuous trajectory > single high-precision value > fuzzy value > indirectly reverse-lookupable signal > user active disclosure > no data).
2. Within each tier, list all reachable paths (including single APIs and composed invocations) and their respective three-layer permission requirements.
3. Highlight with ★★/★★★ those path groups where "the data is equivalent or shares a key component, but the permission requirements differ sharply" (corresponding to the two mismatch classes "same value, different permission" and "same permission, different value" in `data-value-framework.md`). The star rating is a **mismatch-type label**; differences in severity must be stated in prose and must not be implied by adding or removing stars.
4. Attach a documentation-code deviation summary index (may reference the Step 7 output to avoid maintaining it twice).

## 3. Report Structure

1. **Core findings first**: the first substantive section of the report body (after the introduction / statement of the analysis target) must be a "Core Findings at a Glance" table summarizing the 3-8 most important findings. Each row contains at least: finding description, mismatch level (★★/★★★ and type), evidence strength (direct code evidence / indirect support / speculation), empirical status (empirically confirmed / not included in empirical testing / falsified), and potential risk (harm tier). The complete tiering inventory, full three-layer permission table, and cross-validation table follow afterward as supporting material. If a historical analysis report already exists for this functional domain, prefer reusing its mature section structure.
2. **Keep the at-a-glance table row-scannable**: one or two sentences per cell; code line numbers, multi-paragraph argumentation, and the full development of the risk belong in the corresponding "Finding Details" subsection, which the at-a-glance table points to via section number or anchor.
3. **Fixed skeleton**: introduction → core findings at a glance → finding details (tiered by data value; each tier contains a table plus inline risk notes) → cross-tier mechanisms → core conclusion ranking / risk priority summary → real-device follow-up list → appendix.
4. **Physically separate process material from the findings themselves**: purely procedural material such as the actual tool execution trace and the methodological effect of scenario generation belongs by default only in `tmp/` intermediate files; the report body keeps at most a short "Methodology Execution Notes" subsection (a few sentences plus a link to the `tmp/` file). Only when the user explicitly asks may it appear as a standalone appendix at the end of the report, and it must not be inserted between "Core Findings" and the appendix.

## 4. Writing Potential Risk Back into the Report

The exploitation scenarios and harm tiers produced by Step 9 must not be gathered only into a separate section at the end of the report; they must be written back to **the place where each corresponding finding appears** — immediately after each tiered subsection's highlight/★★★ block, add a short "! Potential Risk" paragraph stating:

1. The harm tier (reusing the four classes of `scenario-construction-and-exploitation.md`: continuous tracking / one-shot high-precision theft / indirect reverse-lookup inference / limited fragments, or "review blind spot");
2. Who specifically is harmed and what an attacker can do with it (non-technical language, aimed at reviewers; no pseudocode);
3. Where an effect compounds with, or is amplified in combination with, other findings, this must be pointed out explicitly.

## 5. Real-Device Follow-Up List Subsection

Produced only when Step 11 has scenarios whose confirmation was deferred due to DevTools environment limitations or to avoid blocking. It must **clearly distinguish two kinds of reason**: (i) only a real-device environment is missing, and a real device would resolve it (hardware dependency, need to observe native prompt rendering); (ii) what is missing is an external condition such as a real group chat or several real friend accounts, which a real device would not resolve. Each entry contains at least: the corresponding finding, current evidence strength, the specific reason DevTools could not validate it, whether a real device would resolve it, and the testPlan path recommended for reuse. The end of the subsection must carry a reminder: these tests require a human to scan a QR code on site with a phone, so it is advisable to execute them when a real device is conveniently available rather than acting on the reminder immediately; the subsequent trigger path is in `execution-and-feedback.md`, "Real-Device Follow-Up Flow".

## 6. Pre-Submission Self-Check (Not Omissible)

1. **New-paradigm self-check**: did this round discover a new paradigm not covered by the rules files (a new equivalence-channel type / deviation classification label / grouping basis / evidence type / data-value judgment signal, etc.)? If so, marking the work complete is forbidden; Step 13 must be entered first.
2. **Pending-decision clearing**: check item by item whether all pending / doubtful / downgraded items produced across the process have been cleared — either verification has been completed and the conclusion written back, or an explained downgrade rationale has been recorded. Also check that every "no risk / equivalent / excluded" conclusion in the report traces back to evidence meeting the tiered-burden standard of the presumption-of-guilt principle (in particular whether "exclusions" went through actual execution validation rather than resting only on code/document-level "not found"). If any item remains a merely unverified assumption, marking the work complete is forbidden; verification must be completed first or the item must be explicitly moved into the real-device follow-up list.

## 7. Step 13: Codifying Newly Discovered Analysis Paradigms (Confirmation-Protected; Directly Rewriting Rules Files Is Forbidden)

When the Step 12 self-check surfaces a new paradigm, handle it as follows; do not skip confirmation and directly modify any rules file:

1. **List them**: enumerate the new paradigms one by one, each stating "which section/list of which rules file it corresponds to", "how it is proposed to be modified (new label / subtype / explanatory paragraph, etc.)", and "the concrete case that triggered the finding";
2. **Ask for confirmation**: present the complete list to the user with an explicit statement that "the above are proposed modifications; please confirm before execution". Do not persist any modification without first showing it;
3. **Execute per confirmation**: modify only the items the user explicitly confirmed (in whole or in part). The modification target is by default the corresponding rules file under this skill's built-in `references/` (`references/` is the sole authoritative version); unconfirmed items remain in the list;
4. **Add cross-references**: after modification, note in the methodological notes of the corresponding rules file that "subsequent analyses of similar APIs should consult this paradigm for re-review".

Additions or modifications to the edges of `knowledge/derivability_graph.json` must likewise go through this flow; analysis tasks may not silently rewrite it. Modifying a rules file without confirmation is a process violation.
