# API Composition and Equivalence-Channel Analysis Rules (General)

> Goal: a single API's permission annotation reflects only the risk of "isolated invocation", but real threats often come from "compositions of multiple APIs" or "multiple acquisition paths for the same datum, with sharply differing permission requirements across paths". This rule is used to systematically find these equivalence / substitution channels, rather than recording them only after discovery.
>
> **Division of labor with `equivalence-path-validation-methodology.md`**: what this rule produces are **candidate** equivalence relations — qualitative judgments based on static code/documentation analysis ("suspected equivalent" / "shares the same underlying data source"), the product of the Step 8 stage; the **quantitative validation** question of "to what degree are these candidate relations actually equivalent" (how to compare continuous numeric values statistically, how to characterize cases where fields differ yet remain correlated, how to design paired experiments that eliminate true-value-drift confounding) is `equivalence-path-validation-methodology.md`'s responsibility, belonging to the dynamic empirical phase of Steps 9-11. Neither substitutes for the other: this rule performs no numeric-level validation, and `equivalence-path-validation-methodology.md` performs no candidate discovery.
>
> **Important distinction on examples**: the API / method names appearing in the pattern definitions below are **abstract placeholders or schematic illustrations**, used only to make a pattern's semantics concrete. They are **not** findings, and they are **not** prior answers. Every analysis must derive its own conclusions from the code base and documentation actually under examination in that run. If the user requires an analysis to "re-analyze everything, do not use historical data", that instruction forbids importing concrete conclusions, inventories, or findings from any previous analysis — including anything recorded in this file. What may legitimately be carried over is only the **method**: the investigation procedure, the danger signals, and the code-retrieval techniques. The **result** is never carried over.
>
> **Division of labor with `unified-theory-equivalence-and-permission-flaws.md`**: that file provides the cross-pattern theoretical coordinate system (the three axes: comparison grain / trigger condition / capability nature) and the unified formal definition of a vulnerability, helping to judge whether a newly discovered candidate should be filed as a new case of an existing pattern in this file or needs to go through Step 13 to propose a new pattern; this file provides each pattern's concrete investigation method, danger signals, and code-retrieval techniques. The two do not duplicate each other and are complementary.
>
> **Structure of this file**: Sections 1-10 are the working mainline — taking same-source groups as the candidate space, applying the two transformations **substitute** and **compose** to generate **comparison pairs** `p = ⟨s₀, s₁, γ, μ⟩`, having the LLM perform a coarse screen of equivalence possibility, and persisting to `_stageA_pairs.json`. **Appendix A's pattern catalog (A-F) is not on the mainline**; it has two uses: (i) a semantic reference when judging during transformation "is this candidate possibly equivalent / escalated"; (ii) the worked-example mandatory re-check checklist.
>
> The reason patterns are not the main axis: a pattern inventory is an induction over historical discoveries and naturally covers only known forms; whereas transformation enumeration derives from shared artifacts and relation types, and is equally reachable for unseen new forms. But the **concrete verification actions** codified in the pattern catalog (A2 vertical self-evidence, C value-non-additivity enumeration, F branch-consistency check) must still be executed unconditionally; they have been written into Sections 6, 9, and 10 respectively.

## 1. This Rule's Mainline: From Same-Source Groups to Comparison Pairs

This rule's working mainline is **transformation enumeration**: starting from the candidate space delimited by the same-source groups obtained in Steps 3-6, repeatedly applying the two transformations **substitute** and **compose** to the starting path to generate **comparison pairs**, then having the LLM perform a coarse screen of equivalence possibility. The pattern catalog (A-F) is not on the mainline, but serves as a **semantic reference during transformation** and the **worked-example re-check checklist**, placed in Appendix A.

```
  Same-source groups _stageA_groups.json
        │  (three classes of shared artifact × two relation types; see api-grouping.md)
        ▼
  Outer loop: choose starting point A
        │   if Q has an unused composed sequence → take it (only mark used, do not dequeue)
        │   else                                 → take an unused single API from U
        │   termination criterion: |U| + |{q ∈ Q : q unused}| = 0
        ▼
  Inner loop: with A as the sole baseline
        │   candidate stack S (grows only, taken by cursor k) + this baseline's compared set Cmp
        │   X ← S[k];  k ← k + 1        termination criterion: k ≥ |S|
        │   TRANSFORM(X, A, G):
        │     ├ substitute —— from the coordination (B2) group X belongs to
        │     └ compose    —— from the dependency (B1) group X belongs to,
        │                     or a coordination (B2) group A belongs to that excludes X
        │   substitute candidates enter the stack directly; compose candidates
        │   enter only after being judged "meaningful"
        │   candidates passing the equivalence-possibility screen generate comparison pairs;
        │   composed ones are additionally enqueued into Q
        ▼
  Comparison-pair set _stageA_pairs.json  →  delivered to Stage B (Steps 9-12)
```

### 1.1 Definition of a Comparison Pair (Four-Tuple)

A comparison pair is formalized as **`p = ⟨s₀, s₁, γ, μ⟩`**:

| Field | Meaning | Source |
|---|---|---|
| **`s₀`** | The **baseline**'s API sequence skeleton `⟨f₁, …, f_k⟩` (`k ≥ 1`) | The starting point chosen by the outer loop |
| **`s₁`** | The **candidate**'s API sequence skeleton `⟨g₁, …, g_m⟩`; may be a single API or a multi-API sequence | Produced by inner-loop transformation |
| **`γ = (w, c, r)`** | **Transformation basis**: shared artifact `w`, category `c ∈ {A1, A2, A3}`, relation type `r ∈ {B1 dependency, B2 coordination}` | Taken directly from the same-source group five-tuple |
| **`μ`** | **Equivalence basis**: equivalence reason + comparison criterion + construction hint | Given by the LLM at coarse-screen time |

**The sequence skeleton records only API names and order, with no concrete parameter values** — parameters are supplemented by Step 9 per parameter-sensitivity analysis. In addition, permission-gap judgment, asynchronous wait points, degraded controls, and per-side collection are **not recorded in the comparison pair**: the first belongs to Step 9, and the latter three can be derived directly from `γ` (see `scenario-construction-and-exploitation.md`).

### 1.2 The Two Transformations

| Transformation | Applicable relation type | Meaning | Key judgment |
|---|---|---|---|
| **Substitute** `substitute(X → m)` | **B2 coordination** | Replace one API in the current sequence with a path of the same capability | Compare the two's **produced data object and effect target**, not name or directory similarity |
| **Compose** `compose(X, m)` | **B1 dependency** | When the current sequence is insufficient to achieve the target capability, search along the semantic axis given by the category for a **complementer** to cooperate | Must have **role complementarity**; the criterion is "**escalation**", not "equivalence" |

**Coordination does not constitute composition** — composition requires role complementarity, i.e. the relation type must be dependency.

## 2. Algorithm: Double Loop

```
Algorithm 1  Equivalence comparison-pair discovery
Input:  API set A; shared-group set G; permission vector R(·)
Output: comparison-pair set P (each p = ⟨s₀, s₁, γ, μ⟩); composed-sequence queue Q
        (intermediate structure, not delivered downstream)

 1  Q ← [];   P ← ∅;   U ← A
 2  // Outer loop: choose starting point
 3  while pending(U, Q) > 0 do
 4      if Q has an unused item then  A ← first_unused(Q);  mark_used(A)   // take without dequeuing
 5      else                          A ← select(U);  U ← U \ {A}
 6      if A already used as a starting point then continue
 7      mark A as used as a starting point
 8      // Inner loop: generate comparison pairs with A as baseline
 9      S ← [A];  k ← 0;  Cmp ← {A}          // S is the candidate stack (grows only), k the cursor
10      while k < |S| do                     // termination is cursor overflow, not stack emptiness
11          X ← S[k];  k ← k + 1             // taking the target does not clear it from the stack
12          for each B ∈ TRANSFORM(X, A, G) do
13              if B ∉ Cmp then              // Cmp is per-baseline, discarded when baseline changes
14                  Cmp ← Cmp ∪ {B}
15                  screen ← LLM_MAY_EQUIV(A, B)          // judgment one: any equivalence possibility (lenient)
16                  if B is a composed sequence then
17                      value ← LLM_COMPOSITE_VALUE(B)   // judgment two: is the composition meaningful
18                      if value = meaningless then continue   // meaningless ones enter neither stack nor queue
19                  push(S, B)
20                  if screen ≠ drop then
21                      P ← P ∪ { RECORD(A, B) }
22                      if B is a composed sequence then enqueue(Q, B)
23  return P

where pending(U, Q) = |U| + |{ q ∈ Q : q unused }|.

TRANSFORM(X, A, G):                   // substitute + compose; group-selection rules in §2.2
 1  C ← ∅
 2  for each g ∈ G with X ∈ g ∧ g.relation = B2 do        // substitute: coordination group X belongs to
 3      for each m ∈ g.members \ X do                     // exclude members already in X
 4          C ← C ∪ { substitute(X → m) }
 5  for each g ∈ G with X ∈ g ∧ g.relation = B1 do        // compose source (a): dependency group X belongs to
 6      for each m ∈ g.members \ X do
 7          if COMPOSABLE(X, m, g) then                   // role-complementarity judgment
 8              C ← C ∪ { compose(X, m) }
 9  for each g ∈ G with A ∈ g ∧ g.relation = B2 do        // compose source (b): coordination group A belongs to
10      if g.members ∩ X = ∅ then                         // this group excludes the comparison object
11          for each m ∈ g.members \ X do
12              if COMPOSABLE(X, m, g) then
13                  C ← C ∪ { compose(X, m) }
14  return C
```

### 2.1 Outer Loop: Starting-Point Selection

- **When `Q` contains unused composed sequences, take them first** — a composed sequence has already been judged able to achieve some capability, so using it as a starting point can continue to discover deeper vulnerabilities: e.g. using some standard interface as a starting point generates `{writer + reader}` and enqueues it, and the next round uses that composition as the starting point, thereby discovering its same-source sibling branch (another API reading the same state). Taking only marks `used` and **does not dequeue**, so the queue retains all historical members and later enqueue dedup can consult `Q` directly.
- **When `Q` has no unused items left, it does not terminate**; instead it turns to single APIs never used as starting points and takes **one with a higher permission vector that is the standard interface for that capability** to continue analysis.
- Each path may **be a starting point at most once**, marked once used, to avoid repeated analysis.
- The termination criterion is `pending(U, Q) = |U| + |{q ∈ Q : q unused}|` reaching zero, i.e. all single APIs have been used as starting points and the queue no longer holds unused composed sequences. **`|Q|` must not be used to judge this**: the queue retains historical members and is never empty, so judging by `|Q|` would yield the conclusion that the outer loop never terminates.

### 2.2 Inner Loop: Comparison-Pair Generation

- With the chosen starting point `A` as the **sole baseline**, maintain a candidate stack, a per-baseline compared set (`compared`), and an already-pushed set (`visited`);
- **The candidate stack grows but is never cleared**: **substitute** candidates produced by transformation enter the stack directly, and later continue to be transformed using stack items as targets; taking advances only the cursor `cursor` and **does not clear the target from the stack** — first, to avoid the same sequence being taken repeatedly, second, so that "currently in the stack" is always available for repeat-push dedup. The whole stack is rebuilt together with `current` **when the baseline changes**. Therefore the inner loop's termination criterion is `cursor >= stack.length`; **"stack empty" must no longer be used** (the stack only grows, so it is never empty). Sequence length defaults to no more than 3 (adjustable via `--maxLen`).
- **The outer-loop queue `Q` is taken from without dequeuing**: `Q`'s members are access sequences composed by the inner loop, and are enqueued only after the LLM judges them "meaningful and possibly equivalent to the baseline". When taken in order as a baseline they are only marked `used` and **kept in the queue**, so later enqueue dedup can consult `Q` directly, preventing the same composition from being repeatedly enqueued by different baselines. Therefore the outer loop's termination criterion is that both `U` and "items in `Q` never marked `used`" are empty; **`Q.length` must not be used** (the queue retains historical members and is never empty).
- **Group-selection rules for transformation**:
  - **Substitute** takes APIs only from "**the group the comparison object belongs to whose relation type is coordination (B2)**", replacing the positions in the comparison object that belong to that group (replacing one by one, leaving positions not in that group as-is);
  - **Compose** takes APIs from **two classes of group**: (a) the group the comparison object belongs to whose relation type is **dependency (B1)**; (b) **a coordination (B2) group the baseline belongs to** that **does not contain the comparison object**.
    (b)'s semantics: a baseline often spans multiple capability dimensions and thus belongs to several coordination groups (e.g. `<multi-dimension-API>` both records and sends over the network, belonging to both the "recording group" and the "network-send group"). The comparison object (e.g. `<capture-stream-API>` produced by substitution) usually has only **one** of those dimensions, so to be equivalent to the baseline it must **supplement the other dimensions it lacks**. Hence one must go to coordination groups the baseline belongs to that **exclude the comparison object** to take members; taking from the group that contains the comparison object would merely repeat a dimension it already has, spinning in place. The judgment is thus "that group must not contain any member of X". Note that X is the **post-substitution** sequence and usually no longer contains baseline members, so this condition is not always false.
  - **Trivial solutions must be excluded**: if a candidate sequence already **contains all the baseline's members**, it naturally possesses the baseline's capability, and its equivalence with the baseline is trivial, not constituting a valuable equivalence channel. Typical triggers are treating the baseline itself as an append item, or looping back to the baseline after substitution.
  - Composition must satisfy two conditions: **① role complementarity**; **② non-redundancy** — the append item must bring a (role, capability) combination the comparison object does not yet possess. Satisfying ① alone is insufficient: if the sequence already has that role-capability combination, appending merely repeats an existing dimension and the composition has no value (see Appendix A pattern C's criteria and positive/negative examples). `rw` may be a compound annotation (e.g. `trigger+reader`), which must be split and paired one by one; a missing side participates in comparison as a placeholder. The dependency order puts the writer / opener / trigger first and the reader / responder after.
- **The LLM does two things in the inner loop** (the script calls no LLM; it only provides the write-back interface `judge-pair`):
  - ① **Equivalence possibility** (`screen`): judge whether the two sides of the comparison have any equivalence possibility, with **lenient** conditions — anything that cannot be excluded is passed and generates a comparison pair. The cost of a false pass is only one redundant validation execution; the cost of a missed exclusion is an **irreversible missed detection**.
  - ② **Composition meaningfulness** (`compositeValue`): judge whether the composition is meaningful. Those judged **meaningless enter neither the inner-loop stack nor the outer-loop queue**, being cut directly from this round's output. This is the main means of suppressing composition-branch explosion: the number of compositions grows factorially with sequence length (a 33-member group can reach 30 000 three-element sequences), and `--maxLen` alone is insufficient to let a large domain finish.
  - The two **must not be conflated**: a composition not equivalent to the current baseline (`drop`) may still have independent meaning, so `drop` ones by default **remain in the stack** for continued exploration; to prune additionally by "not equivalent", `--pruneDroppedComposite` must be specified explicitly.
- **Sequences already pushed or enqueued may not be pushed again** (otherwise an infinite loop): the inner loop filters newly generated candidates with the per-baseline `compared`, and records sequences already pushed under this starting point in `visited`; `Q` dedups by "already used as a starting point (`started`) / already in the queue" (the queue retains history, so no separate `queued` is needed).
- **State is split into two layers, and no label may cross into the other**: one group resets **with each inner-loop start**, the other **persists across starting points**. The former serves only "the current baseline", the latter only "outer-loop advancement and audit trail"; **writes in either layer must not pollute the other**.
  - **Per-baseline reset layer** (created wholesale when `next-start` establishes a new starting point, discarded when the baseline changes): ① `compared` — **candidate access sequences already compared under this baseline**, the sole filter basis for candidate generation; ② `visited` — sequences already pushed under this starting point, preventing infinite loops. The two differ in purpose and must not be merged: `visited` guarantees the inner loop can drain, `compared` guarantees the same baseline does not compare twice with the same access.
  - **Global persistence layer** (retained across starting points; no inner loop may reset it): ① `started` — sequences already used as starting points; ② `queued` — composed sequences historically enqueued into `Q`; ③ `baseRegistry` — **composed** sequences already used as a **baseline** (registered when a composed `Q` item is taken as a starting point, answering "has this composition already served as a baseline"); ④ `producedComposite` — composed sequences already **produced** (registered each time `transform` generates a compose candidate, **never cleaned**); ⑤ `enumSeen` — sequences already traversed by enumeration-type starting points.
  - `settled` is demoted to **audit trail** and **no longer participates in candidate filtering**.
- **Why `compared` must be per-baseline** (the original implementation used a global `settled` filter, which showed systematic missed detection): if "B has been judged against baseline A" is treated as "B need not be judged again against baseline C", then each B2 group actually enumerates only the pairings of **the first starting point** — measured: Alipay identity-and-account domain B2 substitute pairs only 12/70 (groups G4, G5, G9, G10 having **zero coverage**), WeChat identity-and-account domain only 12/58. After switching to per-baseline `compared`, both domains reached **70/70 and 58/58 full coverage**, and the outer loop still terminated normally.
- **A non-negotiable criterion: equivalence depends on the baseline and is not transitive**. Changing the baseline changes the comparison object — a candidate judged not equivalent (`drop`) against the old baseline may instead be equivalent against the new one (precision and data-source differences are not transitive). Therefore **even a `drop` conclusion may not be reused across baselines**; any "globally settled, so skip" fast path introduces missed detections. `(A,B)` and `(C,B)` are two independent comparison pairs and cannot be blocked by the same global label.
- **Rising candidate volume is the inherent cost of complete enumeration** (WeChat identity-and-account domain 27→86; location-and-space domain 84→332). It may be controlled only by using `--maxLen` to converge sequence length, **not by cross-baseline deduplication in exchange for a lower count**.
- **The exception "composition starting points from `Q` are not deduplicated" is thereby abolished**: per-base deduplication naturally allows sibling branches to reappear under a new baseline, so there is no need to open a back door for `fromQ` — this also eliminates the phenomenon of "the `Q` stage seemingly not executing (the starting point was taken but yielded 0 candidates)".
- **Why `producedComposite` is not cleared**: after composed sequences have each served as a baseline, they remain in that set, so that later regeneration of the same composition can find "already produced", avoiding repeated enumeration and repeated enqueueing into `Q`; it serves only for lookup and audit, **does not participate in candidate filtering**, and is strictly separated from `compared`, which does participate in filtering.
- **Whether it can serve as a baseline vs. whether it is traversed are two questions**: `U` takes all APIs (rule line 70), and every API will be traversed; whether it "can serve as the baseline of a comparison pair" is separately determined by `baseSet`.
- **The baseline candidate set `baseSet` = APIs whose three permission layers (link / code / platform / user) are not all empty**. Reason: the baseline is "the protected side", and one whose three layers are all empty has no permission gap of its own to reference — using it as a baseline would only produce "zero permission vs. zero permission" comparisons, constituting no gap and having no benchmarking value. Hence it is relaxed to "any API with protection on at least one layer may serve as a baseline", rather than only those with `standard:true` (the latter covers only a few capabilities and would crowd most capabilities onto the same baseline). Single APIs whose three layers are all empty are **still traversed** (`--enumOnly`), to complete §9.2's within-group pairwise enumeration; only their candidates serve as audit trail.
- **Starting points must reach every group** (a necessary condition of rule 9.2): when only standard interfaces are taken, groups unrelated to the connected component of the standard interface (e.g. Wi-Fi / Beacon / compass) would never get a starting point, so `U`'s complete order is "those usable as baselines → the rest → members of all-empty groups".
- The inner loop's termination condition is the cursor finishing the candidate stack (`cursor >= stack.length`). Because the stack only grows and is never cleared, "stack empty" cannot be used; the whole stack is rebuilt together with `current` when the baseline changes.

### 2.3 Composition Length Needs No Hard Upper Bound

Composition happens only within shared groups, must satisfy role complementarity, and excludes members already in the sequence during transformation, so its length is **naturally bounded by the shared group's size**; unrelated ones have no way to be composed together, so no separate hard upper bound is needed.

## 3. Concrete Execution of Transformations (By Category)

### 3.1 Substitute (B2 Coordination)

Replace one API in the current sequence with a path of the same capability, **retrieving candidates only within the shared group the current object belongs to**:

| Category | Replaceable object | What to compare |
|---|---|---|
| **A1** shared data object | Another producer of the same data schema | Whether the produced data object is the same (field set / error bound) |
| **A2** shared underlying resource | Another path achieving the same capability | Whether the achieved **effect** is comparable (scope of effect / reversibility / audit trail) |
| **A3** shared event channel | Another trigger, or another responder | Multiple triggers and responders on the same event can coexist, so channel-type also has a **symmetric coordination relation** |

If after substitution **parameter calibration** is needed to align (e.g. some coordinate-conversion API must be passed the viewport centre coordinates), the value is determined by parameter-sensitivity analysis before judging.

**Division of responsibility**: the script gives the substitutable candidate set per shared artifact and relation type, and retrieves their groups and code locations; whether a candidate is "the same capability" is decided by the **LLM** through semantic equivalence reasoning.

### 3.2 Compose (B1 Dependency)

If the current object is insufficient to achieve the target capability, search along the semantic axis given by the category for a **complementer** to cooperate:

| Category | Pair with | Source of coupling evidence |
|---|---|---|
| **A1** shared data object | Its **writer** or **reader** | The read/write inventory (`rw` field) |
| **A2** shared underlying resource | That resource's **opener** and **result reader** | The open relation |
| **A3** shared event channel | That channel's **trigger** and **responder** | The event chain |

Whether composition is possible is determined by the **relation type** (must be B1 dependency) and requires **role complementarity**. Whether the composition can achieve the target capability must be judged by the **LLM** through value-escalation reasoning — judging whether the composed sequence produces data or effects equivalent to the starting point; the script only gives the compatible candidate set per shared artifact and retrieves their code locations.

**Composition must "bring something new" to be appended**: the append item must bring a (role, capability) combination the comparison object **does not yet possess**. Merely "being role-complementary with some member of the sequence" is insufficient — if the sequence already has that role-capability combination, appending merely repeats an existing dimension and produces no new acquisition / effect capability, so the composition has no value.

| | Sequence X | Append item | Judgment | Reason |
|---|---|---|---|---|
| Valuable | `<map-reader-API>` (reader, ACQUIRE) | `<map-writer-API>` (writer, ACQUIRE) | ✓ | Supplies the write side, forming a write-read closed loop |
| Valuable | `<capture-stream-API>` (reader, ACQUIRE) | `<egress-API>` (writer, ACT-Egress) | ✓ | Supplies the network-send dimension |
| No value | `<map-reader-API>` (reader, ACQUIRE) | `<coord-convert-API>` (reader, ACQUIRE) | ✗ | reader+ACQUIRE already present, repeats the same dimension |
| No value | `<egress-API>` + `<capture-stream-API>` | `<capture-API>` (reader, ACQUIRE) | ✗ | reader+ACQUIRE already provided by `<capture-stream-API>` |

Note the division of labor with "role complementarity": **complementarity** guarantees the append item has dependency coupling with the sequence (can be chained), while **non-redundancy** guarantees it brings a new dimension (worth chaining). Both are indispensable — complementarity without non-redundancy produces large numbers of synonymous repeated compositions (one important source of composition-branch explosion).

A side whose role or capability annotation is missing participates in comparison as a placeholder (better lenient than strict), with no pointless tightening; sequence length is still capped by `--maxLen` (default 3), plus the `visited` set for dedup, so the stack can drain.

## 4. LLM Coarse Screen: Prompt Card

### 4.1 Positioning of the Coarse Screen: Initial Filter, Not Final Adjudication

This is an **initial filter**: the LLM only judges whether a candidate has any **possibility of capability equivalence**, and **anything whose possibility cannot be excluded is passed**, handed to the validation module to execute empirical testing before a conclusion is reached. Therefore the **criteria are lenient** — the cost of a false pass is only one redundant validation execution, while the cost of a missed exclusion is an **irreversible missed detection**, consistent with the grouping stage's "better lenient than strict" principle.

### 4.2 The Card's Four-Part Structure

| Part | Content |
|---|---|
| **Task** | Judge whether equivalence (substitute) / escalation (compose) is possible |
| **Criteria and cautions** | Determined by the **category**, and all stated as **possibility** ("is it possible …", not "is it …") |
| **Input** | **Auto-filled from grouping output**: shared artifact, relation type, capability nature, read/write inventory and parameter values — **the model need not extract them itself** |
| **Output** | Structured pass opinion and confidence (see 4.5) |

### 4.3 Substitute Card

```
[Task]
Judge whether a possibility of "capability equivalence" exists between the following two paths.
This is an initial filter; you are not required to confirm that equivalence holds — as long as the
possibility of equivalence cannot be excluded, you should pass it (pass or weak_pass).

[Input]
Baseline path s₀:      <API sequence, with known parameter values>
Candidate path s₁:     <API sequence, with known parameter values>
Shared artifact w:     <concrete artifact instance>
Artifact category c:   <A1 data object | A2 underlying resource | A3 event channel>
Relation type r:       B2 coordination
Capability nature:     s₀=<ACQUIRE|ACT-*>, s₁=<ACQUIRE|ACT-*>
Read/write inventory:  <the writers and readers of this shared artifact>
Parameter sensitivity: <whether any known conclusion exists that "behavior changes under a specific value">

[Criteria]
A1 data object:   could the two's produced data objects be the same? Allow coordinate / unit
                  conversion and precision differences within the error bound.
A2 underlying resource: could the two's achieved effects be comparable? Compare scope of effect,
                  reversibility, and audit trail, not the return value.
A3 event channel: could the two be two triggers (or two responders) on the same event?

[Cautions]
- Do not rely on name or documentation-directory similarity;
- If the candidate has no privacy value in isolation but "may have value combined with other APIs",
  judge it drop and note in rationale "better routed to composition" — it still remains in the stack
  to participate in later composition transformations, so it is not lost thereby;
- If a specific parameter value is needed to align (e.g. must pass the value corresponding to some
  state), it should still be passed, and record in pending_checks "needs re-check after parameter
  calibration".

[Output]
Strictly output the JSON below; output nothing else.
```

### 4.4 Compose Card

The compose card differs from the substitute card in three ways: ① the semantic axis is given by the category and **must be dependency** (coordination does not constitute composition); ② the input must give **coupling evidence** (read/write inventory, open relation, or event chain); ③ the criterion is "**escalation**" rather than "equivalence", and is only a possibility judgment — as long as the cooperator is complementary to the starting point on the semantic axis and the possibility of escalation cannot be excluded, pass it, leaving it to the **degraded control** to substantiate at the validation stage; confirmation is not required at the initial-filter stage.

```
[Task]
Judge whether the following composed sequence could produce "capability escalation", i.e. whether
after composition it could produce data or effects equivalent to the baseline path.
This is an initial filter — as long as the possibility of escalation cannot be excluded, pass it.

[Input]
Baseline path s₀:        <API sequence>
Candidate composition s₁: <API sequence, ordered by dependency>
Shared artifact w:       <concrete artifact instance>
Artifact category c:     <A1 | A2 | A3>
Relation type r:         B1 dependency
Roles of each member:    <writer/reader | opener/result-reader | trigger/listener>
Coupling evidence:       <read/write inventory entry / open relation / event chain, with code location>
Capability nature of each member: <annotated one by one, ACQUIRE | ACT-*>

[Criteria]
A1 data object:    could the writer write high-value data into that state, causing the reader's
                   output to escalate to equivalence with s₀?
A2 underlying resource: could the opener put that resource into a readable state, enabling the
                   result reader to obtain an equivalent output?
A3 event channel:  could the trigger make that channel deliver high-value data, enabling the
                   responder to receive an equivalent output?

[Cautions]
- Examining any single member alone must not serve as grounds for negation — escalation comes
  precisely from the composition;
- You are not required to confirm "without the precursor the reader cannot obtain the data"
  (that belongs to the degraded control, substantiated at the validation stage);
- The composed sequence's order has been fixed by the dependency relation; do not reorder it.

[Output]
Strictly output the JSON below; output nothing else.
```

### 4.5 Structured Output (Shared by Both Cards)

```json
{
  "screen": "pass | weak_pass | drop",
  "confidence": 0.00,
  "rationale": "<judgment reason: what is shared, through which link the capability is achieved>",
  "criteria": {
    "targetType": "data | effect",
    "fields": ["<field1>", "<field2>"],
    "tolerance": "<error bound>"
  },
  "constructionHint": "<direction given for scenario construction: write first then read / take the value corresponding to some state as the parameter / place the observation point after the callback>",
  "pending_checks": ["<concrete items needing empirical re-check>"],
  "evidence_refs": ["doc:<path>", "code:<file>:<line>"]
}
```

**Field uses**: `screen` decides whether it is recorded as a comparison pair (`pass` / `weak_pass` are recorded, `drop` goes to the exclusion list); `rationale` + `criteria` + `constructionHint` together **merge into the comparison pair's `μ`** (equivalence basis); `pending_checks` is handed to Step 9 to be converted into validation sub-items; `evidence_refs` serves for traceability.

## 5. Script Assistance (Optional; Use When Candidate Scale Is Large)

The **deterministic parts** of the double loop (within-group member retrieval, substitutability and composability judgment, role-complementarity judgment, stack/queue entry, dedup, persistence) can be executed by script, with the LLM responsible only for semantic judgment. This Skill provides `scripts/api-filter/transform-pairs.js`, whose commands and data flow are as follows:

| Command | Role | Purpose |
|---|---|---|
| `init` | Script | Read in `_stageA_groups.json`, initialize the outer-loop queue `Q` and unused set `U`, create the state file |
| `next-start` | Script | Select the next starting point per the outer-loop rule (prefer the composed sequence at `Q`'s head, otherwise take a single API with a higher permission vector); `--enumOnly true` means this starting point is unsuitable as a baseline and serves only for enumeration |
| `plan-next-start` | Script | **Preview** the next starting point without consuming it, and give whether it is usable as a baseline (`legalBase` + `nextStartArgs` that can be fed straight back) |
| `next-candidate` | Script | Take **one** undecided candidate from the current starting point (advancing the inner loop automatically when needed), returning `inner-done` when the inner loop ends |
| `skip-start` | Script | Mark the current starting point as already used and dequeue it directly, without draining its inner-loop stack; used when the caller judges this API unsuitable as a baseline, to advance the outer loop cleanly |
| `transform` | Script | Execute `TRANSFORM` on the current stack top, output the **candidate queue awaiting LLM judgment** (with already auto-filled card input fields) |
| (judging) | **LLM** | Judge item by item per the cards of 4.3/4.4, producing the JSON of 4.5 |
| `judge-pair` | Script | Write back the judgment result: `pass` / `weak_pass` are recorded into `P` and (if a composition) enqueued into `Q`; `drop` is recorded into the exclusion list |
| `loop-status` | Script | Report `Q` / `U` / stack / visited-set status, judge whether the inner and outer loops can terminate |
| `export` | Script | Export `_stageA_pairs.json` (comparison-pair set) and `_tmp_<domainAbbr>_step8_dropped.md` (exclusion list) |

**Iron rules (consistent with the other scripts under `scripts/api-filter/`)**:
1. The script internally **calls no LLM** — `transform` only gives candidates by category and relation type; "whether equivalence / escalation is possible" is always judged by the caller (the current conversation) and written back via `judge-pair`;
2. Parameters containing Chinese, or array / object structures, always go through `--xxxFile <path>`, never command-line inline JSON;
3. The state file and outputs persist to `tmp/<domain>analysis-<YYYYMMDD>/`, the same directory as the other intermediate artifacts.

**If candidate scale is manageable** (e.g. same-source groups number under ten), the script may be skipped, with a human / the LLM advancing manually per Algorithm 1 and producing `_stageA_pairs.json` in the same format.

### 5.1 Outer Driver: `step8-loop.js` (Card Issuance / Write-Back)

`transform-pairs.js` provides only single-step commands; the caller must still maintain the three-stage orchestration state of "which starting point to take / whether it is usable as a baseline / which candidate has been judged" — logic unrelated to the algorithm yet very easy to get wrong (index misalignment, missed judgments, inconsistent `Q` / `U` peeking conventions). `scripts/api-filter/step8-loop.js` solidifies this orchestration and renders candidates as the **4.3 substitute card / 4.4 compose card** for the LLM to judge on the spot.

**Criteria are not persisted to files**: this script accepts no "criteria module"; card bodies are extracted at runtime from this rules file's 4.3/4.4. Criteria are semantic judgments; if solidified into code, a new copy would need rewriting for each functional domain, contradicting the division of labor that "scripts do only deterministic enumeration and leave semantic judgment to the caller".

**Round-trip protocol** (each invocation advances one round):

```
① node step8-loop.js --groups <grouping table> --state <state file> [--maxCards 40]
     → writes _step8_cards.md (cards), _step8_cards/<C-id>.json (write-back template),
       and prints cardsFile / verdictsFile / nextCommand

② The LLM judges item by item per the cards, writing results into verdicts.jsonl
   (JSONL, one per line, must contain candidateId)
   — alternatively, directly edit _step8_cards/<C-id>.json

③ node step8-loop.js --state <state file> --verdicts <verdicts.jsonl>
     → first writes back this round's judgments (appliedThisRound), then issues the next batch

④ when phase is complete, export automatically
```

`phase` values: `cards` (cards awaiting judgment) / `complete` (terminated and exported) / `error`. A starting point's `enumOnly` is determined by the script and annotated at the card top — when this marker is set, the starting point is unsuitable as a baseline and its candidates serve only as enumeration audit trail.

> The same grouping yields different numbers of comparison pairs under different judgments — the orchestration is the same, the judgments differ. This is precisely why criteria should not be solidified in the script.

Parameters: `--maxCards` (cards issued per batch), `--maxLen` (sequence length cap), `--maxInnerSteps` (per-round step-count backstop; when overly lenient criteria cause the stack to keep expanding, it errors rather than silently running to the cap). `--groups` is needed only for the first `init`; later rounds recover from the state file.

## 6. Single-Path Defect Identification (Produced Without Transformation)

Appendix A's **patterns A, B, E** characterize defects of **a single path itself**, not depending on "comparison with something else", and are therefore **not produced by transformation enumeration**; they must be actively identified here, or they will be systematically missed:

| Pattern | Identification method | Key requirement |
|---|---|---|
| **A2** architectural non-integration | Check whether the capability depends on a system / host-app-level authorization premise (`osGate=Present`), and whether the mini-program-level three layers are indeed all empty | **Prioritize vertical self-evidence, not depending on whether a sibling API exists** — either holding independently suffices to conclude; failing to find a sibling API does not lower priority or defer the judgment |
| **A1** scene-value straight-through | Search the code for branches of the form "if the scene value is hit, pass through directly" | — |
| **B** internal privilege symbol | Search for internal flag bits that bypass routine validation | Distinguish the loosening direction (B1, risk) from the tightening direction (B2, not a risk but needs recording) |
| **E1** check-target substitution | For methods needing combined use of multiple hardware / permissions, check one by one whether the permission-check target corresponds one-to-one with the actual access scope | — |
| **E2** state timeliness | Check whether there is a branch depending on "state established by some past invocation, with no expiry / revocation linkage mechanism for that state" | — |

Identified defects are **recorded directly into the comparison-pair list**: `s₀` takes that capability's standard protected interface, `s₁` takes the defect path, `γ` takes the same-source group it belongs to (if it belongs to no group, `γ.w` is recorded as the resource / data entity the capability touches and `γ.r` is left empty, annotated "single-path defect"), and `μ.rationale` states the defect mechanism.

## 7. Cross-Group and Cross-Functional-Domain Investigation

Same-source groups are divided by **shared code artifact**, whereas cross-functional-domain substitution channels may instead share **data content** rather than a code artifact (two paths belonging to entirely different functional domains, with no shared artifact at all, yet able to restore the same datum or achieve the same effect). Therefore, after the double loop terminates, **one more round of investigation must still cross outside the same-source group boundary**:

- Per **pattern D** (Appendix A), check whether other groups and other seemingly unrelated functional categories (**especially domains easily misjudged as "low-sensitivity categories"**) hold substitution paths that can restore the same data, or achieve the same effect (including network-egress / hardware-control effects);
- Pattern D's supplement — the **independent reachability of APIs encapsulated inside components** investigation, see the corresponding subsection of Appendix A;
- Discovered cross-domain substitution paths are likewise recorded as comparison pairs (`γ.w` recorded as the shared **data content** rather than a code artifact, with `μ.rationale` noting "cross-functional-domain, no shared artifact").

## 8. Mandatory Re-Check of Worked Examples

The concrete API / method names solidified in Appendix A's pattern-definition passages are **verified methodological assets**. At the start of this step, first read through these examples, quickly compare them against the Step 1 confirmed inventory, re-check the hits one by one, and record in the **five-part format**:

1. **Verbatim rule citation** — quote the original statement of that example in Appendix A, stating its conclusion;
2. **This run's code re-check** — give the concrete line range and code facts in this run's code base; must be a byte-by-byte re-check, not a paraphrase;
3. **Re-check conclusion** — whether this example holds / does not hold / shows deviation in this run's code base;
4. **Three-axis location** — give coordinates on the three axes of comparison grain, trigger condition, and capability nature (see `unified-theory-equivalence-and-permission-flaws.md`);
5. **Relation to the rule** — whether this finding corroborates the rule, extends it, or reveals an applicable boundary the rule does not state.

**Writing only a conclusion without the verification process is not accepted**; wherever a conclusion diverges from Appendix A's existing description, one must first re-check whether the verification method itself was adequate (e.g. whether the dispatch-table route check / cold-start invocation comparison the rule requires was really performed), and may not use a shallower judgment to override a more deeply verified conclusion.

**Failure mode to guard against**: one analysis's scope fully covered the exact APIs of the A2/E worked examples, and Step 2 retrieved the code too, but Step 8 did only free-form exploratory investigation and did not treat Appendix A as a checklist to verify item by item, causing a shallow conclusion about one API to **directly contradict** what the rules file records, and the other API's check-substitution branch to go entirely unexamined.

## 9. Pre-Gate and Termination Conditions

### 9.1 Gate (Must Be Confirmed Before Entering This Step)

Transformation depends on Steps 3-6's output; before entering, confirm in `_stageA_groups.json`:

1. All confirmed APIs have completed **three-layer permission annotation** (`permVector`, including the link layer `osGate`) — missing this, no gap-judgment baseline can be provided to Step 9;
2. Every shared state field has its complete **writers and readers** listed (`rw`) — missing this, A1's compose transformation has nothing to pair;
3. **Capability nature** (`capability`) is annotated — missing this, `μ.criteria.targetType` cannot be determined, and effect-achievement-type channels will be systematically missed;
4. The grouping table contains **no** group in a "needs deeper digging / insufficient evidence / pending" state;
5. Members **needing parameter calibration** have been identified — missing this, candidates that "require calibration to align" cannot be generated in the substitute transformation.

Each pattern's complete dependency on preprocessing output is in Appendix C, "Pattern — Preprocessing Dependency Table".

### 9.2 Termination Conditions

All of the following must hold simultaneously: ① the double loop has terminated (`Q` and `U` both empty); ② the worked-example re-check is complete (Section 8); ③ single-path defect identification is complete (Section 6); ④ cross-group / cross-functional-domain investigation is complete (Section 7).

### 9.3 Negative Conclusions

To exclude a produced "suspected comparison pair", the **presumption-of-guilt principle** of `SKILL.md`, "Negative Conclusions and Pending-Decision Management" (graded evidence + multi-round execution validation) must be observed — deriving "does not constitute a risk" from this step's code-layer comparison alone is **medium-weight evidence** and **cannot independently support exclusion**; it must advance to Steps 9-11 to complete actual execution validation before it can truly be excluded, otherwise it is registered in the pending-decision list.

If a new form is found that cannot be explained by the two transformations substitute / compose and does not belong to patterns A/B/E, trigger Step 13.

## 10. Output Requirements

**Main output**: the comparison-pair set, persisted to `tmp/<domain>analysis-<YYYYMMDD>/_stageA_pairs.json` — this is **Stage A's sole external contract file**, and Stage B (Steps 9-12) starts with it as its only input. Schema:

```json
{ "domain": "<functional domain name>", "generatedAt": "<YYYY-MM-DD>",
  "groupsFile": "_stageA_groups.json",
  "pairs": [
    { "id": "P1",
      "s0": ["<baseline sequence: API names…>"],
      "s1": ["<candidate sequence: API names…>"],
      "gamma": { "w": "<shared artifact instance>", "c": "A1", "r": "B1", "groupId": "G1" },
      "mu": {
        "rationale": "<equivalence reason: what is shared, through which link the capability is achieved>",
        "criteria": { "targetType": "data",
                      "fields": ["<fields…>"], "tolerance": "<error bound>" },
        "constructionHint": "<construction hint>" },
      "transform": "compose",
      "screen": "pass", "confidence": 0.00,
      "pendingChecks": ["<items needing empirical re-check>"],
      "evidenceRefs": ["doc:…", "code:…"] } ] }
```

**Responsibility boundary**: this step does **not** produce a "data-value tiering comparison table" — tiering by data value and annotating ★★/★★★ mismatch levels is Step 12's responsibility (see `data-value-framework.md`).

**Process records** (persisted to the same directory):

| Output | File | Requirement |
|---|---|---|
| Excluded candidate list | `_tmp_<domainAbbr>_step8_dropped.md` | Those with `screen=drop` **must not be silently discarded**; each must state what verification action was performed at exclusion time |
| Worked-example re-check record | `_tmp_<domainAbbr>_step8_equivalence_channels.md` | Five-part format (Section 8) |
| **Composition enumeration record table** | Same as above | `starting point \| candidate composition \| each one's output value \| whether escalated \| inferred sharing mechanism \| whether a benchmarkable standalone API exists`; covers pairwise pairing of the group's "three-layer-permissions-all-empty" members, **recording even when nothing is found** |
| **Same-resource operation-branch consistency table** | Same as above | `resource name \| operation branch list \| each branch's three-layer + link permission \| protection-strength ordering \| risk ordering \| whether self-consistent / mismatched` (corresponds to Appendix A pattern F) |
| Cross-functional-domain additional-mechanism explanation table | Same as above | Channels requiring external databases / pre-deployed devices and other preconditions are listed separately, to avoid conflating their risk tier with "pure in-code straight-through" |

For hardware-control / network-egress capabilities (`capability = ACT-*`), the comparison criterion switches to effect-consistency testing (see `unified-theory-equivalence-and-permission-flaws.md` §4.4), not the six-dimensional data-value standard.

---

# Appendix A: Equivalence / Bypass Pattern Catalog (Semantic Reference and Worked-Example Checklist)

> **This appendix is not the working mainline.** It has two uses: (i) a **semantic reference** for judging during Section 3's transformation "is this candidate possibly equivalent / escalated"; (ii) Section 8's **worked-example mandatory re-check list**. Among them, patterns A/B/E are defects of a single path itself, actively identified by Section 6 and not produced by transformation enumeration; pattern C corresponds to the **compose** transformation, and patterns D/F correspond to the **substitute** transformation and cross-group investigation.

### Pattern A: Scene / Environment Straight-Through

Under a specific launch scene, source party, or environment context, some API entirely bypasses routine permission validation, directly reading high-value data passed in by a third party / upstream.

- Investigation method: near the permission-judgment function, look for a branch of the form "if some scene value / environment flag is hit, return the data directly", and whether that branch is **shared** by several APIs of differing permission tiers.
- Danger signal: several APIs that originally have different permission bits (e.g. one strong, one weak / none) invoke the same "straight-through judgment function" and the same "data formatting function" at bottom.

**Pattern A's two subtypes (the key to judgment differs; annotate them separately)**:
- **A1: scene-value whitelist straight-through (conventional)** — an explicit "if some scene value / environment flag is hit, return the data directly" judgment branch exists in the code; the permission-validation logic objectively exists and is merely bypassed by that branch.
- **A2: architectural non-integration straight-through (newly discovered)** — this API was never, in product / code design, integrated into the unified checkPrivacy / privacy-agreement permission system; its runtime invocation path contains no scope / permission judgment branch at all (not "bypassed", but "never existed"), standing in sharp contrast to a "sibling API" in the same functional domain that accesses the same underlying hardware / data source yet **is** integrated into the permission system. The key to judgment: A1 is "a judgment branch exists but is bypassed"; A2 is "no judgment branch exists at all". When confirming A2, check whether this API is routed to empty/null directly in the Service dispatch layer (straight to a native bridge, with no JS-side wrapper function and appearing in no privacy-popup mapping table), and compare item by item with the "sibling API" over the underlying hardware capabilities they share, proving that the two should have been aligned but were not. Example: iBeacon scanning (`<discovery-API>` / `<beacon-API>`) and ordinary Bluetooth device scanning (`<adapter-API>` + `<ble-scan-API>`) both use BLE hardware, yet the former is entirely unconnected to the privacy-agreement system while the latter requires a `scope.bluetooth` prompt, constituting A2's typical case.

  **A2's two independent proof paths (new; judging A2 to hold does not require both paths to be present, either holding independently suffices to conclude)**: the early analysis flow implicitly treated "whether a sibling API can be found for comparison" as a necessary condition for A2 to hold, causing capabilities without sibling APIs (e.g. NFC read/write / HCE) to be easily missed. In fact A2's holding has **two mutually independent** proof paths:

  | Proof path | Precondition | Judgment method | What to do if not found / not satisfied |
  |---|---|---|---|
  | **① Horizontal: sibling-capability comparison** | Another "sibling API" exists in the same functional domain with higher permission requirements, accessing the same underlying hardware / data source | Compare link by link the suspected candidate and the sibling API, proving the candidate's permission requirements at the mini-program level (code layer / platform layer / user layer) are strictly weaker than the sibling API's | If the functional domain genuinely has no sibling API comparable at the semantic / hardware level (e.g. NFC), ① does not apply — **this must not lead to judging A2 not established**; switch to ② |
  | **② Vertical: intra-chain tier self-evidence (does not depend on a sibling API; the judgment is independently valid and sufficient)** | The capability depends on a permission the operating system grants to the container as a whole (i.e. the class of prompts referred to in `permission-layering-framework.md`'s "system / host-app-level authorization prompt" section; objective criterion: whether consent to that prompt is written into the mini-program-level `<setting-API>().authSetting` — only if not written is this precondition met) | Prove that this API has established **no** subdivision approval whatsoever at the **mini-program level**: the Service dispatch layer routes to null / pure native forwarding; the privacy-agreement declaration table does not include that purpose identifier; there is no scope judgment branch at runtime — all three confirmed empty | If the capability never involves any system-level authorization premise (a purely software / logical capability), ② does not apply and one can only rely on ①; if at that point ① also has no sibling API to compare, the candidate cannot be decided by A2 |

  **Relation between the two paths**: ② (vertical self-evidence) depends on no external control; it suffices to prove the internal asymmetry "the system layer already treats this capability as sensitive and requiring dedicated authorization, while the mini-program layer has established no corresponding approval for it" — this is the **more general, less named-case-dependent** judgment device in A2 investigation and should be the default first investigation action; ① (horizontal sibling comparison) is limited by the contingent domain feature "whether a natural control object exists", and when one is found it should be recorded as double corroboration of ① and ②, but is **not a precondition for A2 to hold**.

  **Control cases (showing the two paths' independence)**:

  | Case | ① Horizontal: sibling-capability comparison | ② Vertical: intra-chain tier self-evidence | Evidence form |
  |---|---|---|---|
  | **Beacon scanning** | Compared with `<adapter-API>` + `<ble-scan-API>` (ordinary BLE scan): both use BLE hardware, the sibling API requires `scope.bluetooth`, Beacon requires none | `<discovery-API>` / `<beacon-API>` depend on system Bluetooth permission (a system-level prompt), while the mini-program-level three (dispatch route / privacy-declaration table / scope branch) are all empty | **Double evidence chain**: ① and ② each hold independently and corroborate each other |
  | **NFC read/write / HCE** | No "higher-permission, equivalent NFC read/write effect" control API exists in the WeChat ecosystem, so **① does not apply** | The whole `<nfc-adapter-API>` family depends on system NFC permission (a system-level prompt, e.g. the "set as default NFC payment app" inquiry), while the mini-program-level three are all empty (no scope / privacy-declaration layer) | **Single evidence chain (② only)**, holding independently with sufficient evidence, **with no reduction of judgment force for lack of a sibling API** — were the NFC/HCE named example not written into the analysis rules in advance, any analyst following ②'s vertical self-evidence procedure (check whether a system-level authorization premise exists + check whether the mini-program-level three are all empty) could equally discover the vulnerability independently, without needing to remember this concrete case |

  **Unconditional trigger rule not depending on named cases (new; to prevent this pattern from degenerating into "recognizing only known cases")**: unlike A1, A2 has no at-a-glance danger signal of the form "several APIs of differing permission tiers share the same straight-through judgment function" to trigger investigation — precisely this "no visible signal" is A2's most covert aspect. Therefore this pattern sets an **unconditional** trigger rule, independent of whether the analyst remembers some concrete case: **as soon as Step 2 finds an API showing the feature "no permission-judgment code findable at the JS layer / pure native bridge forwarding", before filing it into some group and assuming it "inherits the authentication state of other already-authenticated members of the same group", that assumption is forbidden to be accepted directly; the following minimal verification must first be completed** — ① check this API's route target in the Service dispatch layer: is it empty/null, or does it really forward to the **same** native handler as the already-authenticated members; ② use a thought experiment or a real invocation to judge the "cold-start control": detaching from the state established by the already-authenticated members and invoking this API alone, does a pre-state error like "not init" / "not initialized" appear (showing a shared-state dependency really exists), or does it succeed directly (showing an independent zero-permission path). Only after ① and ② can one conclude "the two have the same permission threshold and constitute no risk"; asserting "they share the same precondition" merely from "the two's code structure is similar (e.g. both are invocations of the same bridge function `z.k9`)" is unverified lumping induction and is forbidden as a basis for conclusion. This trigger rule applies unconditionally to any functional domain and any analysis, regardless of whether the rules file has already recorded a similar named case — named cases (e.g. the iBeacon example above) are only auxiliary clues for fast recognition, never a precondition for "whether this verification should be done"; in other words, even if the rules file has never mentioned a concrete API, as long as it shows the "zero JS-layer validation" feature in Step 2, it must go through ① and ② equally before it can be excluded from A2 risk. **This rule addresses the question "is this API really zero-permission (or does it hide a dependency on shared state of already-authenticated members of the same group)", which is distinct from — and ordered before — the question ②'s vertical self-evidence addresses, "is zero-permission equivalent to no risk (or does it constitute an A2 vulnerability)": the unconditional trigger rule confirms the reality of zero permission, and ② vertical self-evidence judges, once zero permission is confirmed, whether it constitutes a vulnerability. The two connect in sequence and cannot substitute for each other.**

  **Causal attribution (see `unified-theory-equivalence-and-permission-flaws.md` §1.1 / §1.3b / §3.A)**: the root cause of the great majority of real A2 cases is that approval at the "operating system → container (super-app)" link objectively exists (e.g. the system grants Bluetooth/NFC permission to the WeChat app as a whole), while the "container → guest (mini-program)" link has never established a corresponding secondary approval for this capability; analysts easily mistake "the system layer already controls it" as equivalent to "the mini-program layer also controls it" — this causal mechanism is precisely the theoretical basis of ②'s vertical self-evidence method above: the delegation chain has a **Monotonicity Assumption** (a downstream link's approval strength for a capability should not be strictly lower than the strength already established upstream), so the internal asymmetry of "upstream has a gate, downstream has none" constitutes vulnerability evidence independently, with no external control needed. This causal attribution has been independently reproduced in two unrelated functional domains (Beacon/NFC being hardware-class; mDNS LAN discovery being network-class, with the Service dispatch layer likewise uniformly routed to `null`, completely isomorphic to Beacon), proving it has cross-domain predictive power and is not a coincidence of a single case.

### Pattern B: Internal Privilege Symbol / Flag

The base library or runtime has an internal privilege flag bit; when it is satisfied, behavior differs from the normal path.

- Investigation method: near the permission-validation code, look for a judgment branch checking an internal Symbol / private flag, parallel to the normal `scope` / permission check.
- Note: this class belongs to the "additional situation · internal privilege layer" of `permission-layering-framework.md`; just annotate it in the concrete API's notes, no need to expand it into an independent analysis section.

**Pattern B's two directions (new; the key to judgment differs; annotate them separately, no default direction may be presupposed)**:
- **B1: loosening direction (conventional)** — when the privilege flag is satisfied, it **bypasses / loosens** the normal authorization prompt or data desensitization, making it easier in that scene to obtain data originally restricted (e.g. location / recording privilege straight-through in emergency scenes). This is pattern B's most common and most easily conceived direction.
- **B2: tightening direction (newly discovered, easily overlooked)** — when the privilege flag is satisfied, it **tightens / strengthens** data processing (e.g. desensitizing / cleaning by default for ordinary callers, with only internal privileged parties able to retain raw data); for the vast majority of callers (those not satisfying the privilege condition), the existence of this privilege symbol is in fact a **privacy-protection strengthening mechanism**. The key to judgment: one must not assume on seeing "internal privilege symbol" that it is "bypassing a restriction"; one must first confirm whether the flag controls a "loosening" or a "tightening" behavior — if B2, it constitutes no added risk (it is instead safer for ordinary developers), but the fact that it "is not stated in public documentation" should still be recorded (belonging to `doc-code-cross-validation.md`'s "hidden permission bypass" category, merely protective rather than risky in nature), because reviewers cannot confirm from public documentation alone that this protective measure really exists and takes effect by default. Example: the mini-program `<media-picker-API>` has an internal undocumented parameter (only not silently deleted under certain internal host types), which controls "whether to retain original EXIF metadata (including sensitive fields such as GPS)"; by default it is forcibly stripped for ordinary third-party mini-program developers, with only internal privileged hosts able to retain complete data — the privilege direction is "tightening", not "loosening".

### Pattern C: Cross-Method Composition Equivalence

Two or more methods that "all look low-permission / no-permission", invoked in a specific order, produce high-value data — equivalent to a single API requiring higher permission. See `data-flow-analysis.md`, step three.

**Pattern C's two subtypes (the mechanisms differ; annotate them separately)**:

- **C1: state-coupling type** — after a writer (with permission validation / user authorization) fills shared state, a reader (with no permission validation) can exploit that state inspection-free. Investigation method: look for instance / module state fields read and written jointly by multiple methods; for each state field, list all writers and all readers, and check whether a combination exists of "writer's permission threshold is low + reader's permission judgment depends on that state". Output: write out explicitly the **exact preconditions** needed to trigger the composition effect (invocation order, whether parameters are empty, whether some switch is on, etc.), not merely "the risk is higher after composition". The key to judgment: a concrete **shared state field** must first be found.

- **C2: composition-escalation type** (aligned with `scenario-construction-and-exploitation.md` §1.1.1) — multiple APIs' individually returned data have limited independent value, but composed invocation produces a "non-additive escalation" (`V(A+B) > max(V(A), V(B))`), forming an equivalence channel. The key to judgment: it does not depend on inferring a shared state field — as long as enumeration finds value escalation, it can be judged, even if the concrete sharing mechanism cannot be located immediately. C2's detailed enumeration method, enumeration scope (compositions among equivalence channels / with zero-permission APIs / among low-permission APIs in the same functional domain), non-additivity criteria (dimension expansion / persistence escalation / coverage escalation), and post-composition validation-scenario construction method are in `scenario-construction-and-exploitation.md` §1.1.1.

- **C3: named-benchmark type (new)** — when the composition `{p1,p2,...}`'s target is not an abstract "a value escalation has occurred" (C2's criterion) but can be **precisely benchmarked against a higher-permission single API `q` already existing in the functional domain**, it should preferentially be classified as C3: this turns "does it constitute a vulnerability" from a vague value comparison into a precisely computable permission-vector comparison (whether `R({p1,p2,...})` reaches `R(q)`). Investigation method: for any set of low/medium-permission APIs within a group, proactively search whether a higher-permission single API exists in the same functional domain whose data / effect stands in a potential equivalence relation with the composition result; if so, compute link by link whether the composed path aligns with that single API at the link / code / platform / user layers — if the composed path is inspection-free at some link while the single API has approval there, judge it a vulnerability; if the requirements at each layer are identical (even if each triggers multiple checks), record it honestly as "the composition and the single API are permission-equivalent; a healthy-design positive example", and do not exaggerate it as risk. When C3 is satisfied, C2's criteria are naturally also satisfied; only when no named benchmark target is found does one fall back to C2's abstract value-escalation judgment. The two are not mutually exclusive, and C3 should be tried first. Example (a positive example, demonstrating the computation process rather than a vulnerability per se): the composition of `<map-writer-API>` (parameterless invocation) and `<map-reader-API>` is precisely benchmarked against `<baseline-locate-API>` — the parameterless `<map-writer-API>` triggers one `<scope-id>` check and sets the `<state-flag>` state; when `<map-reader-API>` is invoked with that state bit true and `<map>` having `show-location` enabled, it **again independently** triggers a `<scope-id>` check, and the coordinates read back after passing are the user's current device true location (gcj02). Computation result: the composed path and `<baseline-locate-API>` both require `<scope-id>` prompt consent at the user layer, and are consistent at the link / code / platform layers too, making this a positive example; but if either of those two checks were missing from the composed invocation sequence, it would immediately constitute a precisely quantifiable vulnerability — the named benchmark lets the gap size be computed precisely, rather than only being able to assert vaguely, as in C2, that "the value became higher". The complete formal definition and further examples are in `unified-theory-equivalence-and-permission-flaws.md` §3.C.

**C3's degraded-case verification requirement (new)**: when computing the permission vectors of the composed path `R({p1,p2,...})` and the benchmark standalone `R(q)`, **one must simultaneously verify whether the degraded case of "skipping any one step of the composition and invoking the remaining steps alone" still maintains permission alignment; one may not verify only one ideal invocation order**.

This item addresses the following risk: this file's C3 worked example (the parameterless `<map-writer-API>` + `<map-reader-API>` composition benchmarked against `<baseline-locate-API>`) was confirmed by byte-by-byte code re-check, but its conclusion of "two independent checks aligned" **holds only for the specific invocation order "parameterless `<map-writer-API>` immediately preceding"**; once that order is departed from, the original positive example slides into a potential vulnerability. Two classes of departure have been identified:
- **Path one (most common, most easily reproduced)**: the developer never calls `<map-writer-API>`, invoking `<map-reader-API>()` directly. Code facts: the state flag `<state-flag>` is not initialized in the constructor, defaults to `undefined` which is always falsy, so the check condition `useShowLocation && <state-flag>` is always false and unconditionally goes to the zero-permission branch;
- **Path two (timing dependency)**: after the parameterless `<map-writer-API>` establishes `<state-flag>=true`, if a parameterized `<map-writer-API>` is then called (e.g. moving the map to display a merchant's location), that state is overwritten to false, after which `<map-reader-API>` degrades back to the zero-permission branch.

**Execution method**: for any C3 judgment, besides computing the ideal order, one must also enumerate the following degraded cases and compute the permission vector for each independently — ① after omitting each step of the composition, invoke the remaining steps alone; ② change the invocation order, or insert other calls of the same family causing shared state to be overwritten; ③ each API's different invocation forms (no parameters / with parameters). If a gap appears in any degraded case, judge it a vulnerability; one may not judge the candidate safe merely because "it holds under the ideal order".

**Important supplement: do not merely wait to "discover" shared state before investigating — proactively enumerate suspicions (value non-additivity check)**

The reason pattern C is most easily missed: analysts are used to judging each API's permission in isolation, and only when permissions are all judged "low / none" do they naturally skip them, never thinking to "compose" two APIs already judged harmless. But the real risk lies precisely here — two APIs whose static permission judgments are both empty may, after composed invocation, have value far exceeding the sum of separate invocation. Therefore pattern C's investigation must include a **proactive enumeration** action, fully corresponding to and echoing `data-flow-analysis.md` §3.2:

1. **Core signal**: if a functional domain / group has ≥2 APIs annotated "three-layer permissions all empty / none", that is not a signal "can be skipped" but **the signal most needing prioritized composition enumeration** — because a static review system inherently cannot intercept "two individually compliant APIs composing a non-compliant effect", and all-empty permissions are exactly where the review blind spot concentrates;
1.5. **Enumeration priority signal (new): capability pairs in the functional domain that are "direction-complementary / role-opposite" should be enumerated first** — i.e. two capabilities playing opposite roles such as "initiator / responder", "reader / read", "sender / receiver" (e.g. "actively reading external data" vs. "being read externally / simulating the read side"; a typical example: NFC tag reading vs. HCE card emulation). Such capability pairs can form a **complete data-acquisition-to-reuse closed loop** after composition (one end acquires data, the other end uses the data to respond / reproduce), and the probability of risk escalation is usually higher than for two "same-direction" capabilities (e.g. both being "reader" type), because same-direction composition is often merely "data splicing", whereas direction-complementary composition can often eliminate steps that would otherwise require external cooperation / extra equipment, achieving a **self-consistent closed loop** for the attack / abuse chain. Investigation method: first annotate each API in the group with a "role label" (initiate / respond, read / write, acquire / output, etc.), then perform value-non-additivity enumeration preferentially on role-complementary API pairs, rather than enumerating indiscriminately in alphabetical or discovery order;
2. **Enumeration action**: for any two APIs (A, B) in that group, enumerate sequences such as `A()→B()`, `B()→A()`, A's different invocation forms (no parameters / with parameters) each followed by `B()`, and invocation before/after a switch, comparing the composed data value `V(seq)` with `max(V(A), V(B))`; as long as `V(seq) > max(V(A), V(B))` exists, judge it value non-additivity ("1+1>2"), with no need to know in advance which state field is at work;
3. **Classification after judgment**: once enumeration finds value escalation, judge whether it is C1 or C2 — if a concrete shared state field can be located, classify as C1 (state-coupling type) and transfer to `data-flow-analysis.md` §3.1's matrix for systematic recording; if the concrete mechanism cannot be located immediately but the value escalation really exists, classify as C2 (composition-escalation type) and transfer to `scenario-construction-and-exploitation.md` §1.1.1 for composition validation-scenario construction;
4. The complete enumeration method, priority ordering (control-flow + reader pairings / two-consumer pairings / naming-semantics-correspondence pairings), and output format are in `data-flow-analysis.md` §3.2; this rule does not expand them again, but **when investigating pattern C that enumeration must be explicitly executed; one may not rest content with "no shared state field found, so this group is risk-free"**.

### Pattern D: Cross-Functional-Domain / Cross-Category Substitution Channel (Easily Overlooked; Needs Dedicated Investigation)

The same high-value datum may exist in a functional domain that "looks like an entirely different category", and that category's permission review standard is often looser (because review classifies by API name / category rather than by actual data capability).

**Pattern D's two subtypes (differing severity; annotate them separately)**:
- **D1: differing review standards type (conventional)** — the data in the other category indeed "legitimately" belongs to that category's reasonable output, only that category's review strictness is lower (e.g. a category that should itself return some indirect identifier, where review did not realize that identifier can be reverse-looked-up into high-value information).
- **D2: permission-identifier mismatch type (more severe)** — the data and the permission identifier / authorization semantics associated with its acquisition path are **entirely unrelated**, i.e. the official permission classification system itself files this data into a wholly unrelated category (e.g. obtaining, in exchange for "microphone use" authorization, the global identity identifiers of call participants, the two having no semantic relation). D2 is not "different review strictness" but "the classification itself is wrong"; its risk tier should be higher than D1, since the user cannot infer at all from the authorization prompt text what data type is actually disclosed. The key to judging D1 vs. D2: in the path by which the data is obtained, does it have a reasonable semantic association with its permission identifier — D1 has an association (merely a review oversight), D2 has none (classification mismatch).

- Investigation method:
  1. Clarify the target data's "restorable forms" (e.g. geographic coordinates can be obtained directly by GPS, but also indirectly reverse-looked-up / mapped via Wi-Fi BSSID, Bluetooth beacon RSSI, IP address, etc.);
  2. Systematically search all functional domains in the project (especially "device management", "network", "sensor" and other seemingly unrelated categories), looking for APIs that can produce these indirect-form data;
  3. Check whether these APIs' permission-mapping-table entries **reuse the same permission identifier** as the target high-value API (reuse implies the official side also considers the two equivalent, the strongest equivalence evidence); if not reused, check whether its permission-judgment mechanism takes an entirely different channel (e.g. relying on a system-level switch rather than an application-layer prompt), so that actual review strength is lower.
- Output: additionally state "the external conditions required for reverse lookup / mapping" (e.g. whether a third-party database must be connected, whether devices with known coordinates must be pre-deployed), because such channels are often not "one step inside pure code" but require combining external resources to restore the target data; analysis must honestly annotate this added cost, neither exaggerating nor ignoring it.
- **Capability-nature blind-spot reminder (new; to avoid investigating only "data acquisition" and missing "effect achievement")**: this pattern's original wording focuses on "whether an alternative acquisition path exists for the same high-value **data**", which easily limits investigation to retrieving "can the same datum be obtained" and forgets to retrieve "can the same external **effect** (sending out / controlling hardware) be achieved by another path". When investigating D, two questions must be raised simultaneously: ① can this datum be obtained through another seemingly unrelated category? ② can this effect (network egress / hardware control) be achieved through another seemingly unrelated category, thereby bypassing the mechanism that should control that effect (e.g. a domain whitelist)? Example (D2, effect-achievement type): WeChat mini-program network egress is on the surface uniformly governed by the "domain whitelist" — `<network-request-API>` / `<upload-API>` / `<download-API>` / `<socket-API>` share one `<exemption-switch>` dynamic-exemption system, and `<tcp-API>.connect` requires either "a non-local IP within the LAN" or "a configured legal domain"; but `<udp-API>.send` / `write` / `connect` have no domain / LAN legality check at all in the code layer, and the documentation explicitly states "from base library version 2.9.3 onward, any IP and domain is allowed" — a deliberate official design choice, honestly stated in the documentation, not constituting a "documentation omission", but viewed from the cross-category equivalence perspective it constitutes a structural bypass of the domain whitelist, a platform-level security model: as long as a developer chooses to send data via UDP rather than HTTP/WebSocket, they can completely bypass the only existing, broadest-coverage network-egress control mechanism within the analysis scope. **Methodological reminder**: an API whose own "documentation honestly states zero control" would, evaluated in isolation, be judged consistent and need no attention; but when that API stands in an **effect-substitutable relation** with other strongly controlled APIs in the same functional domain, the very fact that "the documentation is honest" cannot lower its risk priority — it must be cross-checked against pattern D before a conclusion is drawn. This is a direct application, at the level of concrete pattern investigation, of the presumption-of-guilt principle of `SKILL.md`, "Negative Conclusions and Pending-Decision Management": taken in isolation, "this path's documentation is honest" is a negative conclusion, and one must test whether a cross-category equivalence control exists; one may not skip this layer of checking merely because the documentation is honest in itself.

### Pattern E: Permission-Check Target Substitution and Permission-State Timeliness (Check Defects Inside the Same Method, Split Into E1/E2)

**E1: silent scope substitution type (former pattern E, renumbered)** — when the scope that should have been checked inside the same method (corresponding to the hardware / data it actually invokes) is not authorized, the code does not pop the authorization prompt corresponding to that scope, but **silently substitutes the check target for another scope with different semantics**; once the substitute scope obtains user consent, it passes directly, releasing access to the hardware / data that should have been governed by the original scope.
- **Difference from pattern D2 (permission-identifier mismatch type)**: pattern D describes a data-equivalence relation "between two different APIs / methods" (different entry points, same datum, official permission classification system filing the data wrongly); pattern E1 describes **inside the same method**, the permission-check branch being replaced at runtime by another scope, with the user never asked to take a position on the original scope that was substituted out — the problem is not "wrong classification" but "the check target itself was swapped".
- Investigation method: for methods in the same functional domain that need combined use of multiple hardware / permissions (e.g. a recording function using both camera and microphone), check one by one whether the scope strings actually compared in their permission-check code correspond one-to-one with the hardware types they invoke; if a branch is found where "the scope checked does not fully correspond to the hardware actually used" or "when some scope is unauthorized it turns to check another scope with different semantics", that is a hit. It can be cross-compared with other "seemingly similar" methods in the same functional domain (those accessing the same hardware combination): if other methods adopt "checking all relevant scopes simultaneously", that further corroborates that the current finding is not established platform policy but a concrete implementation oversight, rather than a design choice needing no attention.
- Danger signal: the hardware / capability names mentioned in the authorization-failure prompt text do not fully match the hardware scope that method actually accesses (e.g. the failure text mentions only "microphone", but the method itself continuously captures camera frames and produces a video file).
- Output: write out explicitly the difference between "the semantics of the scope prompt text the user actually clicked to consent to" and "the hardware access scope actually unlocked after that consent", and cite the correct implementation in the same functional domain as a control (if any), to prove this is not industry convention but a concrete implementation oversight. Example: `<record-start-API>` (camera component recording), when `scope.camera` is unauthorized, turns to request `scope.record` (microphone), and after success still continuously captures camera frames and produces a video file; as a control, `LivePusherContext` in the same domain, for the same "camera + microphone" combination scene, checks both `scope.record` and `scope.camera` scopes simultaneously.

**E2: permission-state expiry without re-validation type (new, TOCTOU type)** — the same method, at **this current invocation**, does not re-verify the **current** state of the permission it depends on, but by default reuses a historical authorization result "assumed still to hold" (e.g. assuming some precursor method previously succeeded in establishing some session / resource-level state, and therefore skipping the independent check this invocation should have), while that historical authorization state may have changed between the two invocations (the user revoked the permission in system settings, the session expired, the resource was released) — this is the concretization, in the permission-check context, of the classic "Time-Of-Check to Time-Of-Use" (TOCTOU) race pattern.
- **Difference from E1**: E1 is "it checked, but checked the wrong target (the scope semantics do not correspond)"; E2 is "the target checked is not itself wrong, but the **moment** at which the check occurs is wrong — it relies on the residual result of some past check rather than the live state at the time of this invocation".
- **Difference from pattern C1**: C1 concerns "whether the writer / reader permissions are equal"; E2 concerns "whether the same permission-judgment branch's basis still reflects the true current authorization state as time passes" — the two may hit the same piece of code; the perspectives and criteria differ and are not mutually exclusive.
- Investigation method: for any code branch that "checks some state flag / cached bit to decide whether permission has been granted, rather than re-triggering a live check every time", examine that state flag's **lifecycle** — does it have an expiry mechanism, is it dynamically cleared when the permission is revoked externally, and is there a window between the clearing check and the actual use? If the state flag, once written, remains valid indefinitely with no mechanism for invalidation upon external permission change, it constitutes an E2 candidate.
- Danger signal: expressions such as "skip if already authorized" or "reuse the previous decision result" appear in functional documentation or code comments, and no corresponding invalidation / re-validation trigger point can be found.
- The complete formal definition and its correspondence with axis two's "state / timing trigger" are in `unified-theory-equivalence-and-permission-flaws.md` §3.E.

### Pattern F: Permission Consistency of Operation Branches on the Same Resource (New)

Patterns A-E all implicitly share one premise — the objects of comparison are "two **different** paths achieving the **same** capability goal". Pattern F addresses a different question: **the same logical resource has multiple operation branches (typically add / delete / modify / query, or read / write); is each branch's permission-protection strength commensurate with the risk it actually creates, and are they internally self-consistent with one another** — it does not require the branches to "achieve the same capability", but requires that the **relative ordering of protection strength** among branches stay consistent with the **relative ordering of risk**.

**F1: benign differentiation (positive example; record it but it does not constitute risk)** — the permission difference between operation branches is appropriate **not because reading's risk is inherently lower than writing**, but because an effective user-layer protection still exists on the weakly protected side: invoking such an API pops a system-native selector, and the user must actively specify on the spot before the selected data can be obtained — although no scope authorization is requested directly, the user's active participation itself constitutes user-layer protection, so it is not exaggerated into a vulnerability.

Example: `<media-picker-API>` (selector read; the user actively picks an image from the album) versus `<album-writer-API>` (write; requires authorization), and `<file-picker-API>` (selector read; the user actively picks a file) versus its corresponding write operation — both require active user participation, and the data obtained **involves only the user themselves**, so user-layer protection is adequate and differentiated protection is appropriate. Both, together with their respective write operations (the calendar domain excepted), exhibit the same consistent differentiation pattern, a positive design paradigm recurring across multiple functional domains.

**Counter-example (should be judged permission missing, not F1)**: `<contact-picker-API>` (selector read, zero permission) versus `<contact-writer-API>` (write, requiring the complete `<scope-id>` prompt authorization flow) — although `<contact-picker-API>` likewise has a native selector, what it returns are the names and numbers of **arbitrary third-party contacts** on the device, data belonging to **other natural persons**; the user's active selection of a record in their own contacts **cannot substitute for third parties' authorization of their own data**. Therefore user-layer protection on that side is inadequate here, forming a gap with `<contact-writer-API>`'s complete authorization and constituting permission missing (a judgment already officially recognized). Hence `<contact-picker-API>` no longer serves as an F1 positive example and should be moved into the permission-missing class.

**Boundary note**: whether a native selector constitutes adequate user-layer protection must be examined against whether the data involves third parties — when only the user's own data is involved it is adequate and F1 may be judged; when third-party data is involved, the user's active selection cannot substitute for third-party authorization, protection is inadequate, F1 may not be judged by default, and evidence must be adduced under the presumption-of-guilt principle (default suspicion that a mismatch exists).

**F2: mismatch-risk type (must be evidenced and excluded per the presumption-of-guilt principle in `SKILL.md`, "Negative Conclusions and Pending-Decision Management"; must not default to F1)** — the permission difference among operation branches **has not been** shown to be commensurate with the risk difference; typical situations: ① a low-protection branch can be reused as an **information bypass** for a high-protection branch (e.g. a nearly undefended "write / update" operation whose failure / success status can be probed repeatedly, indirectly achieving the "read / query" effect that should be protected by strong permission); ② some operation branch's actual persistence / impact surface is underestimated (e.g. a "delete" operation appears to affect only local state but in fact cascades to other users' visible public data, yet is approved only by the standard for "local operations"); ③ the operation branches of the same resource are scattered across different registration entries in the permission system, one branch being included in the privacy table / scope system while another semantically close branch is omitted (overlapping with D2; the difference is that F2 emphasizes "alignment among branches within the same resource", while D2 emphasizes "wrong classification across functional domains").
- Investigation method: for any identified "resource" (a set of CRUD / multi-operation APIs around the same entity), list all its operation branches and their respective three-layer + link permission annotations; for any two branches, if protection strength differs sharply, proactively ask "is the risk really correspondingly lower" — one must not default to intuitions such as "read is lower risk than write"; each must be argued one by one, and the argument follows the presumption-of-guilt principle in `SKILL.md`, "Negative Conclusions and Pending-Decision Management" (default suspicion that a mismatch exists; F1 requires sufficient evidence; a negative conclusion must record the verification action performed).
- The complete definition and the distinction from pattern C are in `unified-theory-equivalence-and-permission-flaws.md` §3.F.

### Pattern D Supplement: Independent Reachability of APIs Encapsulated Inside Components (New, 2026-08-13; Same "Substitution Channel" Category as Pattern D but Differing in Trigger)

When the investigation object is a **built-in / custom UI component** (rather than an independent `wx.xxx` API), the common mistake is treating "whether the component itself is safe" and "whether the underlying data interface actually invoked inside the component is safe" as the same question — these are two independent attack surfaces and must be investigated separately:

- **The component itself**: i.e. "can the user infer data from this component's rendering result / component instance"; the judgment method is in `doc-code-cross-validation.md`, "Reachability Determination for Component-Specific APIs", Layer 1 (`selectComponent` + `fields({node:true})`).
- **The underlying API invoked inside the component**: a component's method body often invokes one or more independent platform APIs to obtain the data needed for rendering (e.g. a "friends list" component internally invoking an API that batch-queries friends' info). **That underlying API may itself be an independently registered public interface directly callable by arbitrary business code**, regardless of "whether it has ever been used by this component" — i.e. it may constitute an equivalence / more direct substitution channel **entirely detached from the component**, even if the component itself has been empirically proven natively render-isolated and absolutely safe. The judgment method is in Layer 2 of that chapter of `doc-code-cross-validation.md` (`typeof` existence detection + direct invocation).

**Investigation principles**: ① one must not infer, from the component itself (Layer 1) being proven safe, that the API invoked inside it (Layer 2) is necessarily safe too — the latter needs independent verification of whether it can be invoked directly detached from the component and whether it has independent permission validation; ② conversely, one must not directly assume the component itself constitutes a leakage channel merely because an API invoked inside it is found to exist — whether the component really synchronizes that API's return result to the JS side likewise needs Layer 1's independent empirical test. Both judgments must be performed; neither may be omitted, and the empirical results should be recorded separately rather than merged into one general conclusion.

**Typical misjudgment pattern (be alert)**: seeing a `<view-data-writer>({...})` or similar assignment statement in a component's method body and directly skipping Layer 1's empirical test, taking for granted that "the component handed the data to JS" — this actually skips the key judgment of "is that <view-data-writer> an internal render-layer state update or a genuine cross-thread bridge", a typical evidence-strength assessment error (see the newly added warning item in `doc-code-cross-validation.md`'s "Evidence-strength tiering" chapter).

# Appendix B: Equivalence-Channel / Bypass Pattern Overview Table

> This table is a quick-reference overview of patterns A-F; detailed definitions and investigation methods are in the pattern subsections above; three-axis coordinate locations are in `unified-theory-equivalence-and-permission-flaws.md` §5.

| Pattern | Name | Core feature | Subtypes | Key investigation question | Typical signal / example |
|:---:|------|---------|--------|-------------|---------------|
| **A** | Scene / environment straight-through | Permission validation bypassed or never existing under a specific environment / scene | **A1** scene-value whitelist straight-through: a judgment branch exists but is bypassed; **A2** architectural non-integration: no judgment branch exists at all | A1: does this API have a judgment branch bypassable by a specific scene value? A2: ① horizontal — does it share the same underlying hardware / data source with other APIs in the same functional domain yet have different permission requirements? ② vertical — does the capability depend on system-level authorization to the container as a whole (`osGate=Present`), and if so, are the mini-program-level three layers indeed all empty? **② does not depend on ①; either holding suffices to conclude** | A2 double-evidence typical: iBeacon scanning can both compare horizontally with ordinary Bluetooth scanning and self-evidence vertically (system Bluetooth permission + three layers all empty); A2 vertical-only typical: NFC read/write / HCE has no sibling API to compare, concluding independently on vertical self-evidence alone; mDNS LAN discovery reproduces isomorphically |
| **B** | Internal privilege symbol / flag | An undisclosed internal flag bit controls the direction of permission behavior | **B1** loosening direction: privileges bypass / loosen restrictions when satisfied; **B2** tightening direction: privileges strengthen protection when satisfied (safer for ordinary callers) | Does this privilege flag control "loosening" or "tightening"? B2 constitutes no added risk but still needs recording as undisclosed | B2 typical: `<media-picker-API>`'s internal undocumented parameter controls EXIF retention, with sensitive metadata forcibly stripped for third parties by default |
| **C** | Cross-method composition equivalence | Multiple low / no-permission APIs composing to produce value escalation, or precisely reproducing some high-permission standalone API | **C1** state-coupling type: depends on a locatable shared state field; **C2** composition-escalation type: value non-additivity but no named benchmark; **C3** named-benchmark type: can be precisely benchmarked against a high-permission standalone API, computing the permission gap | Does the group contain ≥2 APIs whose "three-layer permissions are all empty"? Does a benchmarkable higher-permission standalone API exist? | C3 typical: `<map-writer-API>` (parameterless) + `<map-reader-API>` precisely benchmarked against `<baseline-locate-API>` (verified: the two checks align, a positive example) |
| **D** | Cross-functional-domain / cross-category substitution | The same data / effect has a substitution acquisition path in another category, and that category's review standard is often looser | **D1** differing review standards; **D2** permission-identifier mismatch, covering both data-acquisition and effect-achievement natures | In the path obtaining this data / effect, does it have a reasonable semantic association with its permission identifier? | D2 typical (effect achievement): `<udp-API>` can send to any IP / port, entirely bypassing the domain whitelist jointly observed by `request` / `uploadFile` / `<tcp-API>` |
| **E** | Permission-check target substitution / timeliness defect | A check defect inside the same method, split into two independent mechanisms | **E1** silent scope substitution; **E2** permission-state expiry without re-validation (TOCTOU type) | E1: does the scope checked match the actual hardware scope? E2: does the state flag the check depends on have an expiry / revocation linkage mechanism? | E1 typical: `<record-start-API>`; E2: branches depending on an "skip if already authorized" cache bit with no invalidation mechanism |
| **F** | Permission consistency of operation branches on the same resource | Whether the protection strength of different operation branches (read / write / add / delete) on the same resource is commensurate with the risk | **F1** benign differentiation (positive example); **F2** mismatch-risk type | For branches whose protection strength differs sharply, does the weaker side have effective user-layer protection (a native selector, and data involving only the user themselves)? | F1 typical: `<media-picker-API>` (selector read, user actively specifies) vs. `<album-writer-API>` (write, requires authorization); counter-example: `<contact-picker-API>` (involving third-party data, already determined missing) |

## Quick Severity Judgment for Patterns

| Priority | Pattern | Basis |
|:---:|:---:|------|
| ★★★ highest | **A2** architectural non-integration | The API is designed entirely outside the permission system, with no code-level permission-judgment branch that could be fixed; **the judgment does not require finding a sibling API — vertical self-evidence alone (system-level permission premise + mini-program-level three layers all empty) suffices to conclude independently; finding a sibling API serves only as strengthening corroboration** |
| ★★★ highest | **D2** permission-identifier mismatch | The official classification itself attributes the data / effect wrongly; the user cannot infer at all from the authorization prompt what is actually disclosed |
| ★★★ depending on computation | **C3** named-benchmark type | If computation shows the composed path has a gap at some link relative to the benchmark standalone API, that equals having found a precisely quantifiable vulnerability; if all links align, it is a positive example |
| ★★☆ medium-high | **E1** silent scope substitution | The scope is silently substituted inside the method; the user consents to A but actually unlocks B |
| ★★☆ medium-high | **E2** permission-state expiry without re-validation | Depends on the size of the timeliness window and how long it remains usable after revocation; the longer the window, the higher the risk |
| ★★☆ medium-high | **C2** composition-escalation type | Multiple "seemingly harmless" APIs breach the permission boundary after composition; the review blind spot concentrates here |
| ★★☆ medium | **A1** scene-value whitelist | A judgment branch exists but can be bypassed by a specific scene; the fix direction is clear (tighten the branch condition) |
| ★★☆ medium | **C1** state-coupling type | Permission judgment depends on a locatable shared state; the fix path is clear (supplement the reader's permission check) |
| ★★☆ depending on mechanism | **F2** mismatch-risk type | Depending on the concrete mismatch mechanism (bypass type / persistence-underestimation type / registration-omission type), severity differs |
| ★☆☆ low | **D1** differing review standards | The data is legitimate in the other category; the main problem is insufficiently fine review granularity rather than a permission-system defect |
| — record | **B1/B2** internal privilege flag | B1 needs assessment for abuse; B2 constitutes no added risk but the undisclosed state needs recording |
| — record (positive example) | **F1** benign differentiation | Constitutes no risk, but should be recorded as a methodological positive example to prevent future misjudgment as a vulnerability |

> **Usage note**: in actual analysis, first investigate patterns A-F for equivalence channels, then judge severity per the table above to decide priority. B1/B2 and F1 directions may not constitute risks, but still need recording and explanation; one may not skip writing them merely because "they constitute no risk".

---

# Appendix C: Pattern — Preprocessing Dependency Table

> This table establishes the dependency relations between Step 8's patterns and Steps 3-6's four preprocessing outputs (3a same-source grouping / 3b three-layer permission annotation / 3c parameter-sensitivity analysis / 3d data-flow and state-coupling analysis), for use as a completeness gate check before entering Step 8 (corresponding to this file's Section 9 gate). This table is derived back from each pattern's judgment logic, answering "what preprocessing data a pattern needs for analysis" and "to what degree missing some preprocessing item causes that pattern to fail".

| Step 8 pattern | Preprocessing output needed | Dependency strength | Consequence of lacking it |
|---|---|---|---|
| A1 scene-value whitelist straight-through | 3b + Step 2 branch location | Medium | Hard to locate the "bypassable by a scene value" judgment branch |
| A2 architectural non-integration | 3b all-empty annotation + link layer `osGate` + Service dispatch-table route | Strong | ② vertical self-evidence cannot execute; A2 judgment does not hold |
| B1/B2 internal privilege symbol | 3b (internal-privilege-layer additional annotation) | Medium | Cannot determine whether the privilege direction is loosening or tightening |
| C1 state-coupling type | 3d (writer / reader inventory) + 3a (shared state field) | Strong | Cannot locate the shared state field; C1 undecidable |
| C2 composition-escalation type | 3b (identify three-layers-all-empty members) + 3a (fix enumeration scope) | Strong | Core signal missing; enumeration cannot start |
| C3 named-benchmark type | 3a + 3b (locate the high-permission standalone API) + 3d | Strong | No benchmark target; cannot compute the permission-vector gap |
| D1/D2 cross-functional-domain substitution | 3a (cross-group grouping table) + 3d (ACQUIRE / ACT capability-nature annotation) | Strong | ACT-type effect-substitution channels systematically missed |
| E1 silent scope substitution | 3b + 3c (identify methods needing combined multiple hardware) | Medium-strong | Cannot determine the hardware-scope correspondence that should be compared |
| E2 state expiry (TOCTOU) | 3d (state-flag lifecycle) + 3b | Strong | Cannot determine whether the state flag has an expiry / revocation linkage mechanism |
| F1/F2 same-resource branch consistency | 3a (identify the multi-operation-branch set of the same resource) + 3b | Strong | Cannot delimit the "resource" boundary; branches cannot be enumerated |

## Three Structural Insights

1. **3b has infrastructure status**: the six pattern classes A2, C2, C3, D, E, F all depend on 3b. The mechanism is that the judgment of all the above patterns is essentially "permission comparison" — A2 compares the asymmetry "the system layer has a gate while the mini-program layer has none"; C2/C3 compare the permission vectors of composed paths and standalone paths; D compares permission identifiers across categories; E compares the check target against actual hardware; F compares the protection-strength ordering of branches on the same resource. Without complete and accurate 3b annotation, all the above comparisons lose their baseline. This is also the fundamental reason 3b must be revised repeatedly as new findings appear during the convergence loop, rather than being completed once.

2. **3d is a hard constraint on C1, E2, and ACT-type D**: 3d produces three irreplaceable pieces of information — each shared state field's complete writer / reader inventory (C1's direct judgment input), each state flag's lifecycle characteristics i.e. whether it has an expiry mechanism and revocation linkage (E2's sole basis), and each API's capability-nature annotation (ACQUIRE / ACT-Hardware / ACT-Egress / pure control flow). The third is especially critical for pattern D: only via the ACT annotation can one systematically search "can the same external effect be achieved by another category", thereby discovering effect-achievement-type D2 (e.g. `<udp-API>` bypassing the domain whitelist) structural bypasses, and avoiding investigation covering only data acquisition while missing effect achievement.

3. **3c mainly serves E1 and C1**: among parameter-sensitivity analysis's three patterns, the one contributing most directly to Step 8 is "pattern three: a specific parameter value hitting runtime state". That pattern on the one hand identifies the set of methods "needing combined use of multiple hardware / permissions", constituting E1's candidate objects; on the other hand it reveals the phenomenon "a specific parameter value can degrade an API into an equivalent read of high-value state", constituting C1's trigger condition.
