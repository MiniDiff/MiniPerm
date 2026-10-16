# Equivalence Path Validation Methodology (General)

> Goal: provide a **formal, quantifiable, cross-domain** method for the Step 9/10 judgment "are these two paths equivalent", replacing the current loose binary judgment of "core field equivalent / not equivalent". This rule is the methodological back end of protocol ② (control-group comparison) in `empirical-code-generation.md` — protocol ② answers "what operational steps to use for the experiment", while this file answers "once the experimental data are in, how to judge rigorously to what degree the two paths are equivalent". It also provides a **feedback / knowledge-completion mechanism** enabling the empirical results of Step 11 to validate, calibrate, and extend the knowledge base that drives scenario generation, rather than being consumed once and discarded.

## Core Positioning

| Dimension | Description |
|---|---|
| **Input source** | The validation scenarios produced by Step 9 (data-equivalence types, e.g. scenarios corresponding to patterns VF-data-equivalence-validation / D1 / D2 / C2 / E); paired sample data produced by Step 11 empirical testing |
| **Core task** | (i) Give a quantitative definition of "degree of equivalence" (rather than a binary judgment); (ii) assign, per data type, the corresponding statistical consistency test; (iii) characterize the complex case of "different fields but still related" with a directed derivability graph; (iv) define the knowledge-completion loop letting empirical results feed back into the graph itself |
| **What it does not own** | Not how concrete validation code is written (that is `empirical-code-generation.md`'s responsibility), not how tests are deployed and executed (that is Step 11's responsibility) |
| **Output destination** | The "validation succeeded / failed" decision of protocol ② is replaced by the quantitative output defined here; the ★★/★★★ tiering of Step 12 directly cites the equivalence-degree value produced by this file |
| **Knowledge asset** | This methodology is accompanied by a **persistent, cross-analysis-task reusable** knowledge file `knowledge/derivability_graph.json` (sibling to `scripts/api-filter/` of this skill, located in the `knowledge/` subdirectory under the skill root), recording discovered derivability edges and thickening continuously as analyses accumulate; any functional-domain analysis should first read and reuse it, then add new findings |

---

## 1. Formalizing the Problem

Suppose there exists a hidden **real-world state** \(S_t\) (the user's true GPS coordinates, true WiFi environment, true identity attributes, etc., as of time \(t\)). Any candidate path \(P\) (which may be a single API call, or a multi-API invocation sequence under pattern C2 of `api-composition-and-equivalence-channels.md`) is defined as a mapping:

```
O_P(t) = f_P(S_t, θ_P, ε_P)
```

where `θ_P` is the invocation parameter and `ε_P` is the observation noise specific to that path (GPS jitter, quantization error, timestamp precision, etc.).

Introduce a **semantic attribute space** `Attr = {a1, a2, ..., an}` (e.g. "precise latitude/longitude", "city of residence", "instantaneous speed", "WiFi BSSID", "openId"; the same attribute space is shared across functional domains, with location / user-info / device-management classes differing only in which subset they use), each attribute having a truth function `τ_a(S_t)`.

Define the **derivability function** `ρ`: given the output `O_P` of one (or several) invocations of path `P`, and a set of known transformations `T = {T1, T2, ...}` (e.g. "latitude/longitude → city" reverse geocoding, "difference of two coordinates → speed" numerical differentiation, each transformation annotated with an error bound `δ` and a resource cost `c`), the **derivable closure precision** `ρ_P(a)` of path `P` for attribute `a` states: whether an estimate of `τ_a(S_t)` can be reconstructed from `O_P` plus zero or more compositions of `T`; if so, it gives the error bound; if not, it is recorded as `⊥` (not derivable). **Key constraint: `ρ_P` must be the complete closure, not only the fields `P` literally returns** — as long as `P`'s raw output can reach `a` via known transformations in the graph, `ρ_P(a)` is not `⊥`, even if `a` itself is not among `P`'s raw return values (this is the most common misuse that Section 1.1 below corrects).

### 1.1 Closure Expansion and Information-Unit Folding (Key Prerequisite; Prevents Artificial Inflation of the Denominator)

**Problem**: if one simply counts "the literal fields each of the two paths returns raw", a systematic bias arises — because the same underlying information may appear repeatedly in one path's return value in the form of multiple derived fields, and those derived fields carry no independent information. **A real reproduced misuse case**: path A returns `{precise latitude/longitude, city id, city name}`, path B returns only `{precise latitude/longitude}`; counting fields directly yields `EquivDegree = 1/(1+2+0) = 0.33`, implying "A carries twice as much information as B" — but both city id and city name are deterministic functions of precise latitude/longitude (derivable from coordinates by reverse geocoding), so relative to the coordinates themselves they **carry no independent information**; although B does not literally return them, as long as B has the coordinates it already equivalently possesses the ability to obtain them (at the resource cost of one reverse-geocoding call). The correct judgment here is "A and B are near-completely equivalent", not "A has over 33% more information than B" — this is not a weighting problem, it is **the wrong choice of counting unit**.

**Correction method (before computing `C` / `Δ`, perform two preprocessing steps)**:

1. **Closure expansion**: from the raw return field set `raw(P)` of path `P`, recursively expand along known transformation edges in the graph into `closure(P) = raw(P) ∪ { a | ∃ b ∈ closure(P), the graph contains an edge b→a, with acceptable error bound / resource cost }`, until it stops growing.
2. **Redundancy folding**: within `closure(P)`, if an attribute set `{a1,a2,...}` can each be deterministically derived from the same upstream attribute (e.g. city id and city name are both functions of latitude/longitude), merge them into **one information unit** and do not count them repeatedly — the criterion is borrowed from information theory: if the conditional entropy of `a2` given `a1` is zero (`a2` is a deterministic function of `a1`, carrying no additional independent information), the two belong to the same information unit.

`C(P1,P2)`, `Δ(P1→P2)`, and `Δ(P2→P1)` must all be defined over the **folded information-unit set**, not the raw field set:

```
C(P1,P2)      = { u | u is a folded information unit, closure(P1) ⊇ some representative of u ∧ closure(P2) ⊇ some representative of u ∧ the statistical consistency test passes }
Δ(P1→P2)      = { u | closure(P1) covers u ∧ closure(P2) does not cover u (still not covered after closure expansion) }
```

**Recomputing the opening example with the above correction**: the graph contains the known edges "precise latitude/longitude → city id" (reverse geocoding) and "precise latitude/longitude → city name" (reverse geocoding), and the three fold into the single information unit "location identifier unit". After closure expansion `closure(A) = {location identifier unit}`, and `closure(B) = {precise latitude/longitude} ∪ {city id} (via closure expansion) ∪ {city name} (via closure expansion) = {location identifier unit}`. After folding, `C(A,B) = {location identifier unit}`, `Δ(A→B)=∅`, `Δ(B→A)=∅`, and `EquivDegree = 1/1 = 1.0` — correctly reflecting the intuitive judgment that "A and B are in fact near-completely equivalent", and correcting the distorted result `0.33` obtained without closure folding.

**This correction and the weighting mechanism of Innovation 1 (`w(a)`) are steps at two different levels and neither may substitute for the other**: folding addresses the counting-unit error of "the same information being counted repeatedly, inflating the denominator"; weighting addresses the value judgment of "how large the privacy-value weight of the genuine differences that remain after folding should be" — folding must remove redundancy first, and only then are the folded information units weighted to compute the ratio; the order may not be reversed (weighting before folding is unrecoverable, because the incorrect counting of raw fields has already distorted the summation structure).

Hence the definitions:

- **Core equivalence set** `C(P1,P2) = { u | u is a folded information unit, ρ_P1(u)≠⊥ ∧ ρ_P2(u)≠⊥ ∧ the two reconstructed values pass the statistical consistency test }`
- **One-sided excess set** `Δ(P1→P2) = { u | ρ_P1(u)≠⊥ ∧ ρ_P2(u)=⊥ }`, with `Δ(P2→P1)` defined symmetrically

---

## 2. Innovation 1: Equivalence Measure — Replacing the Binary Judgment With a Continuous Quantity

```
EquivDegree(P1,P2) = |C(P1,P2)| / |C(P1,P2) ∪ Δ(P1→P2) ∪ Δ(P2→P1)|
```

Further introducing privacy-value weighting (`w(a)` taken from the scalar score converted by the six-dimensional standard of `data-value-framework.md`) yields the **weighted equivalence degree**, giving high-value attributes greater influence on the total:

```
WeightedEquivDegree = Σ_{a∈C} w(a) / Σ_{a∈C∪ΔA∪ΔB} w(a)
```

**Usage**: this value directly answers "to what degree are the two paths equivalent" and supplies the quantitative basis for the ★★/★★★ tiering of Step 12 — the closer `WeightedEquivDegree` is to 1, the more it should be marked as a "same value, different permission" mismatch (★★★); if `Δ(P1→P2)` is non-empty while `Δ(P2→P1)` is empty (a one-sided superset relation, e.g. `<baseline-locate-API>` relative to `<map-writer-API>+<map-reader-API>`), the directionality must be explicitly annotated in the report rather than written loosely as "partially equivalent".

**Principle for determining decision thresholds**: do not set a fixed global threshold (such as "EquivDegree>0.5 counts as equivalent") — the threshold should be set in conjunction with the tiering standard of Step 12's `data-value-framework.md`, i.e. "does `C(P1,P2)` contain the key attribute that determines this data tier", rather than looking at the ratio number alone. For example, if `C` contains only latitude/longitude and latitude/longitude happens to be the decisive attribute for location data tiering, then even if the `EquivDegree` value is not high (because P1 has many additional fields P2 lacks), it should still be judged as constituting a "same value, different permission" mismatch.

---

## 3. Innovation 2: Type-Aware Value-Level Consistency Testing — Solving "the Values Will Never Be Identical"

Instead of judging by "field-by-field value equality", treat each path as one "measurement" of the same latent variable, borrowing the **measurement equivalence** framework of metrology/psychometrics, and assign a method by data type:

| Data type | Comparison method | Theoretical source |
|---|---|---|
| Continuous numeric (latitude/longitude / RSSI / acceleration / signal strength) | **Paired controlled experiment** + **TOST (Two One-Sided Tests)** | Standard method of bioequivalence trials (e.g. demonstrating "the efficacy difference lies within an acceptable range" in generic-drug approval) |
| Consistency-strength reporting for continuous numeric | **Bland-Altman agreement analysis** / Lin's concordance correlation coefficient (CCC) | Standard method in metrology for comparing whether two measuring instruments agree |
| Discrete / identity type (openId / gender enum / boolean flag) | Exact match / set inclusion | — |
| Composite / transform-requiring (address string ↔ latitude/longitude, BSSID ↔ location) | First transform into a comparable representation via a known transformation in "4. The Derivability Graph", then apply one of the two classes above | — |
| Existence / boolean (whether a field exists / whether an entry is reachable) | Present/absent comparison (reusing validation methods ①③) | — |
| Temporal / trajectory type (a sequence of consecutive samples) | Dynamic time warping (DTW) / Fréchet distance | Trajectory similarity measures |

### 3.1 Paired Controlled Experiment Design (Solving "the True Value Drifts")

- **Temporal proximity pairing**: invoke paths `P1` and `P2` consecutively within as short a time window `Δt` as possible (`Δt` should be smaller than the window allowed by the known maximum drift rate of the attribute — e.g. in a walking scenario the location drift rate is about 1-2 m/s, so with a 10-meter tolerance `Δt` should be kept within 5 seconds);
- **Environment-injection pairing (preferred; completely eliminates drift confounding)**: if the test environment supports fixing/simulating the true value (e.g. the DevTools simulator allows setting fixed coordinates), prefer it — this removes the confounder "whether the true value drifts" from the experimental design at the root, rather than "mitigating" it by shortening the time window;
- **Repeated pairing (for estimating the noise baseline)**: invoking the same path twice consecutively (without involving the other path), the difference is that path's own measurement-noise baseline `ε_P`, which serves as the empirical basis for the tolerance `δ`; the tolerance value should not be assumed directly from intuition or documentation.

### 3.2 TOST Equivalence Testing (Replacing "Set a Threshold and See Whether It Is Smaller")

The core idea of TOST: rather than asking "is there a significant difference between the two groups of data" (the default hypothesis of traditional significance testing is "no difference", so under low power it easily yields the misleading conclusion "no difference found = equivalent"), it asks the reverse: "can we **reject** the hypothesis that 'the difference exceeds the tolerance bounds `[-δ, +δ]`'" — through two one-sided tests (the difference is significantly less than `+δ`, and significantly greater than `-δ`), and only if both hold may the conclusion "equivalent" be drawn.

**Output format (for Step 11 result write-back and Step 12 citation)**:
```
TOST result: mean difference={...}, 90% confidence interval={[lower, upper]}, tolerance bound δ={±...}
Decision: the confidence interval falls entirely within [-δ,+δ] → equivalence holds (vulnerability exists, with statistical significance support)
          the confidence interval exceeds the bounds → equivalence does not hold (vulnerability does not exist, or a larger sample is needed)
          sample size too small so the confidence interval is too wide to decide → see "6. Academic Challenge 5: Statistical Power With Small Samples"
```

---

## 4. Innovation 3: Directed Derivability Graph — Solving "Different Fields but Still Related"

Model derivability relations as a **persistent, cross-analysis-task reusable directed graph**: nodes are semantic attributes, and an edge `a→b` is annotated with the transformation, error bound, resource cost, and evidence strength. The graph file is at `knowledge/derivability_graph.json` (JSON schema in "5. Graph Persistence Format" below) and is **shared across domains** — an edge discovered when analyzing the location class (e.g. the temporal derivation "latitude/longitude → speed") is equally applicable when analyzing other functional domains if its structure is reusable (e.g. "WiFi BSSID sequence → device movement trajectory" uses the same temporal differentiation principle).

### 4.1 Information-Theoretic Constraint (Preventing Subjective Abuse of Graph Edges)

Any proposed derivation edge `a→b` must satisfy the necessary condition of the information-theoretic **Data Processing Inequality**: no deterministic or random post-processing transformation can increase mutual information; that is, if the independent information carried by `b` strictly exceeds what `a` can carry under its transformation closure (and no external knowledge source already registered in the graph can supply that part), the edge should be rejected or downgraded to "merely statistically correlated, not deterministically derivable".

**Usage**: before adding an edge to the graph, first check whether this necessary condition holds as an initial filter for "is this edge worth further empirical validation", avoiding writing mere correlations (e.g. "the probability that the user invokes A during this period correlates with the probability of invoking B") into the graph as genuine derivability relations.

### 4.2 Directedness and the Direction of Information Loss

Derivation edges are **naturally directed** and mostly **lossy**:
- `<baseline-locate-API> → <fuzzy-locate-API>` holds (precise coordinates can be quantized/truncated into fuzzy coordinates);
- `<fuzzy-locate-API> → <baseline-locate-API>` does not hold (information lost in fuzzy coordinates cannot be inverted).

This directedness is exactly the mirror image of the "post-hoc field zeroing" deviation pattern in `doc-code-cross-validation.md` — wherever a deviation of "some high-precision field is zeroed/truncated under specific conditions" appears in documentation/code, it corresponds to a unidirectional "high precision → low precision" edge in the graph, and should be added to the graph simultaneously when that deviation is found, without waiting for a dedicated equivalence analysis.

### 4.3 Temporal Derivability (Sub-Innovation): Derivation Beyond a Single Invocation

Some attributes cannot be derived from a **single** invocation of a path, but can be derived from **a sequence of k invocations of the same path** — e.g. "speed" can be obtained by numerical differentiation of the time difference plus distance difference between two position readings; "trajectory" can be obtained by concatenating the time series of multiple position readings. This requires extending the domain of `ρ_P(a)` from "single output" to "the path's sampling strategy":

```
ρ_P^(k)(a): the derivable closure precision for attribute a when path P adopts the sampling strategy "invoke k times consecutively, interval Δt"
```

This upgrades the previously qualitative description of "persistent escalation" in pattern C2 of `api-composition-and-equivalence-channels.md` into a computable, parameterizable edge on the graph (varying with k and Δt), directly resolving questions of the kind "can the speed field of <baseline-locate-API> be achieved by a composed path" — the answer is not a simple "yes" or "no", but "when path P adopts the sampling strategy (k=2, Δt<X seconds), speed can be derived within error bound δ(k,Δt)".

### 4.4 Application Example: Functional Overlap of Hardware-Scanning APIs (Beacon vs Ordinary Bluetooth Scanning)

**First judge whether it falls within this framework's scope**: this framework handles equivalence between "data-acquisition" paths (per the criterion of the "two parallel analysis threads" in `data-value-framework.md` — whether substantive new information is returned to the mini-program JS layer after invocation). Both `<beacon-API>` (Beacon scanning) and `<ble-scan-API>` (general BLE device scanning) **return device/beacon list data**, so they are data-acquisition paths and this framework **applies directly** with no separate mechanism needed — this is a different class of problem from "genuine hardware control / output types" (e.g. vibration, NFC card writing, HCE response, which return no new data after invocation); the latter is in "4.5 Framework Boundary" below.

**Overlap relation from the closure-expansion perspective**: in the raw advertisement-packet data (`advertisData`, a manufacturer-defined byte segment) returned by general BLE scanning, beacons conforming to the iBeacon protocol format follow a fixed byte layout (prefix + UUID + major + minor + measured power); this is a **known, deterministic, zero-extra-resource-cost** local parsing transformation:

```
generic_ble_advertis_data → beacon_uuid_major_minor_rssi   (semantic fields parsed from the raw advertisement packet per the iBeacon format; purely local computation, no external service required)
```

Substituting into the closure computation: `closure(general BLE scan)` after expansion via this edge covers `{uuid, major, minor, rssi}` (all the core fields the Beacon path can obtain), while `closure(Beacon scan)`, because the system layer has already filtered and parsed per the iBeacon format, **does not contain** information about non-iBeacon devices, nor the raw bytes themselves (information loss in the Data Processing Inequality sense — filtering plus parsing is lossy post-processing and cannot restore the filtered-out devices or raw bytes in reverse). After folding:

```
C(Beacon, general BLE scan)        = {iBeacon core information unit (uuid/major/minor/rssi)}
Δ(Beacon → general BLE scan)       = ∅
Δ(general BLE scan → Beacon)       = {non-iBeacon device information, raw advertisData bytes}
EquivDegree = 1 / (1+0+1) = 0.5 (unweighted); if weighted by privacy value, the weight of the iBeacon core information unit is usually close to or higher than that of "non-iBeacon device information", so the weighted value will not deviate sharply
```

This result precisely quantifies the previously merely qualitative judgment in pattern A2 of `api-composition-and-equivalence-channels.md` that "Beacon and ordinary Bluetooth scanning both use BLE hardware but their permissions differ greatly" — general Bluetooth scanning is a **strict superset** of the Beacon capability (`Δ(Beacon→general BLE scan)=∅`) yet has a lower permission threshold, which is the typical form of a "same value, different permission" mismatch; it now has concrete numerical support rather than a vague statement like "the functions look overlapping".

### 4.5 Framework Boundary: Equivalence Between Pure "Hardware Control / Output" APIs Needs a Different Measure (Already Completed by `unified-theory-equivalence-and-permission-flaws.md` §4.4; Not Redefined Here)

The entire mechanism of this framework (equivalence measure, closure, TOST testing) rests on the premise that "paths return comparable data". If both paths belong to the **hardware control / output class** defined by `data-value-framework.md` (no new information returned after invocation, merely producing an effect externally — e.g. two different vibration/flash-pattern APIs, or two different NFC card-writing methods), then there is no "returned data" to compare, the domain of the `Attr` space is empty, and `EquivDegree` cannot be computed.

The "equivalence" question for such scenarios is essentially **capability/effect equivalence** rather than **information equivalence**: "can path A achieve the same external effect as path B at lower permission", and what must be measured is whether the "sets of achievable effects" overlap, not whether data fields overlap — this is the extension, at the level of equivalence judgment, of the "two parallel analysis threads" philosophy of `data-value-framework.md`. **This gap has been formally filled by `unified-theory-equivalence-and-permission-flaws.md` §4.4**: that section defines `EffectEquivDegree(p1,p2) = |CommonObservableEffects(p1,p2)| / |AllObservableEffects(p1) ∪ AllObservableEffects(p2)|`, substituting "the physical/logical scope, reversibility, and audit trail of observable effects" for this file's data-field comparison, for use with hardware-control / network-egress (`ACT`-type) capabilities. When judging equivalence for `ACT`-type capabilities, switch directly to that section's `EffectEquivDegree`; do not apply this file's `EquivDegree`/closure-folding system, and there is no need to file an extension request via Step 13 (the extension is complete and confirmed). This file covers only quantitative validation of `ACQUIRE`-type (data-acquisition) capabilities; the criteria distinguishing the two capability natures and their division of labor are in `unified-theory-equivalence-and-permission-flaws.md`, "Axis Three: Capability Nature".

---

## 5. Graph Persistence Format

Structure of `knowledge/derivability_graph.json`:

```json
{
  "schemaVersion": "1.1",
  "nodes": [
    {"id": "<domain>.<attributeName>", "domain": "location/userInfo/deviceManagement/...", "label": "human-readable name", "type": "continuous_geo|categorical|compound|existence|temporal"}
  ],
  "informationUnits": [
    {
      "unitId": "<unit id>",
      "label": "human-readable name",
      "members": ["<nodeId1>", "<nodeId2>", "..."],
      "rationale": "why these nodes have zero conditional entropy with respect to one another and should be folded into a single counting unit"
    }
  ],
  "edges": [
    {
      "from": "<source attribute id>",
      "to": "<target attribute id>",
      "transform": "human-readable description of the transformation",
      "temporal": {"required": true/false, "k": "number of invocations required or null", "deltaT": "invocation interval constraint or null"},
      "errorBound": {"type": "absolute|relative", "value": "number", "unit": "unit", "source": "assumed|self-jitter-baseline|documented|tost-confirmed"},
      "resourceCost": {"externalCall": true/false, "requiresNetwork": true/false, "requiresThirdPartyService": "service name or null"},
      "directionality": "unidirectional|bidirectional",
      "evidenceStrength": "assumed|doc-confirmed|code-confirmed|empirically-confirmed|refuted",
      "sourceAnalysis": "identifier of the analysis task that first proposed/validated this edge (e.g. locationInfoApiAnalysis-20260901)",
      "lastUpdatedRound": "round/date of the knowledge-completion action",
      "notes": "supplementary explanation"
    }
  ]
}
```

**The `informationUnits` field (added in version 1.1; corresponds to Section 1.1 "Closure Expansion and Information-Unit Folding")**: when computing `EquivDegree`, the counting unit of the `C` / `Δ` sets should be the units in `informationUnits`, not bare nodes — if a node is not included in any unit, it is treated as an independent unit (constituting a single-member unit by itself). Before adding a unit, first check whether the candidate node set satisfies "zero conditional entropy with respect to one another" (mutually deterministic functions), and write the basis in `rationale`, to avoid mistakenly folding nodes that are merely statistically correlated (rather than deterministically related) into a single unit.

A seed dataset is provided at `knowledge/derivability_graph.json` (including classic location-class cases: the core equivalence attributes of `<baseline-locate-API>` ↔ `<map-writer-API>+<map-reader-API>`, the unidirectional lossy edge of `<fuzzy-locate-API>`, the temporal derivation edge of speed, and the "location identifier information unit" folding example; plus the device-management-class Beacon ↔ general BLE scan unidirectional superset edge), for direct reuse and extension in later analyses, with no need to build from scratch each time.

---

## 6. Innovation 4: Feedback / Knowledge-Completion Loop

**Before (Steps 8/9)**: based on static analysis of code/documentation, the analyst proposes a set of **prior hypotheses** — hypothesized derivation edges (with assumed error bounds and resource costs, `evidenceStrength` annotated as `assumed`), the prior core equivalence set `C_prior`, and the prior equivalence degree `EquivDegree_prior`. These hypotheses are written into the validation task sheet as the concrete content of the scenario's "the validation conclusion will determine" field.

**After (Step 11 execution feedback)**: once the actual paired sample data are produced, three kinds of knowledge-completion action are performed:

| Action | Content | Graph field change |
|---|---|---|
| ① Confirm/Refute | For each hypothesized edge covered by this VF, compute empirical statistics with TOST/Bland-Altman | `evidenceStrength: assumed → empirically-confirmed` or `→ refuted` (a falsified edge should be **retained** in the graph and annotated `refuted`, not deleted outright — "known not to hold" is itself valuable knowledge, preventing future analyses from repeating the mistake) |
| ② Calibrate | Replace the assumed error bound with the jitter actually observed in repeated measurements (e.g. "the latitude/longitude tolerance was assumed to be 10 meters, but the self-jitter between two consecutive invocations is actually ±3 meters") | `errorBound.value` updated, `errorBound.source: assumed → self-jitter-baseline` or `tost-confirmed` |
| ③ Discover (genuine knowledge completion) | Analyze whether the empirical data contain consistency relations **not hypothesized beforehand** by the analyst (e.g. one only meant to test whether latitude/longitude agree, but the timestamps recorded in passing reveal, on review, a match with the "temporal derivability" pattern enabling derivation of the target path's speed field) | A previously absent edge is added to the graph, with `evidenceStrength: empirically-confirmed` and `sourceAnalysis` naming the analysis task that discovered it |

**What this loop solves**: the current output of Step 9 is a unidirectional, one-off judgment of the form "the validation conclusion will determine: if confirmed … if refuted …"; this mechanism makes the Step 11 execution result not merely "confirm/refute this particular VF", but also **revise/extend the knowledge base driving VF generation itself** (the derivability graph and its parameters), so that the next analysis — even in an entirely different functional domain — can reuse knowledge that has been validated.

**Landing flow**: after Step 11 completes empirical testing, besides filling in the existing "empirical validation summary table", additionally produce a "knowledge completion record" (see "7. Execution Flow Integration" below) listing this round's triggered actions ①②③; these actions follow **Step 13's "confirmation protection" flow in `SKILL.md`** — only after the list is shown to the user for confirmation may they be written into `knowledge/derivability_graph.json`; Step 11 may not silently rewrite the persistent knowledge file directly (the graph is a cross-task shared asset, and the cost of a mistaken write exceeds an error in a single analysis report).

---

## 7. Execution Flow Integration (Into Steps 9/10/11)

1. **When Step 9 constructs validation scenarios**: for VFs of the "data equivalence validation" type (corresponding to the rows marked "data equivalence validation" in the pattern mapping table of `scenario-construction-and-exploitation.md` 1.1, i.e. patterns C2/D1/D2/E), besides filling in the existing template fields, additionally annotate in the "validation sub-items":
   - The prior-hypothesized core equivalence set `C_prior` and its basis (citing existing edges in the graph, or annotating as a newly proposed hypothesized edge)
   - The consistency-test type adopted (per the dispatch table in "3. Type-Aware Value-Level Consistency Testing" of this file)
   - The paired-experiment design method (temporal proximity / environment injection / both must be stated)
2. **When Step 10 generates code**: the operational steps of protocol ② (control-group comparison) must include "paired collection" (rather than invoking each once) — designed per Section 3.1, collecting N paired samples (N determined by the power analysis in "6. Academic Challenge 5"; with no historical data, default to N≥10 as a starting point), and recording the raw values needed to compute TOST/Bland-Altman (not merely the boolean conclusion "whether they agree").
3. **When Step 11 gives execution feedback**:
   - Run TOST/Bland-Altman computation on the collected paired samples to obtain the `EquivDegree` value and confidence interval;
   - Produce a "knowledge completion record" (format below) listing this round's triggered actions ①②③, as one of the direct inputs to the Step 12 report's "pre-submission self-check" (whether a new paradigm was found);
   - The empirical validation summary table gains new columns: `EquivDegree` (numeric), `knowledge completion action` (brief ①②③).

**Knowledge completion record format**:
```
### Knowledge completion record: VF-{id}

- Derivability edge involved: {from → to}
- Action this round: ① confirm / ② calibrate / ③ discover (multiple choice)
- Empirical statistics: {TOST result / Bland-Altman agreement interval}
- Proposed graph update: {concrete evidenceStrength/errorBound changes, or the complete fields of the new edge}
- Step 13 confirmation needed: yes (required by default; the graph is a persistent asset)
```

---

## 8. Academic Challenges Within This Methodology's Scope and How They Are Addressed

| ID | Challenge | Response (corresponding section of this file) |
|---|---|---|
| 1 | **Epistemic boundary of unfalsifiability / black-box testing**: some equivalence claims cannot be falsified by black-box empirical testing alone ("a field was not observed" does not mean "this path architecturally cannot provide that field") | The "undecidable" branch of the three-branch decision must clearly distinguish "merely insufficient sample" (see Challenge 5, resolvable by more samples) from "the black-box method itself has an epistemic ceiling" (not resolvable by more samples; must be annotated honestly and retain code-side evidence as a supplement) |
| 2 | **Observation vs intervention (causal-inference perspective)**: in state-coupling (C1) equivalence relations, passively comparing two invocation results is only observational evidence; validating the true coupling relation requires interventional experiments that actively set the state | For VFs involving pattern C1, the operation-procedure design must include control groups under two conditions, "state pre-written" and "not pre-written" (echoing validation method ⑦, invocation-sequence sensitivity testing); mere passive before/after observation is insufficient |
| 3 | **Directionality of precision loss**: judging only "whether it can be derived" is insufficient; one must also judge "how much is lost, and in what direction" | Graph edges are naturally directed and carry `errorBound` (see Section 4.2), preventing a lossy unidirectional relation from being misreported as "equivalent" |
| 4 | **Combinatorial explosion of the composed-path search space**: candidate paths are not limited to single APIs but include invocation-sequence compositions of arbitrary length | Reuse the enumeration-scope constraints of pattern C2 in `api-composition-and-equivalence-channels.md` to shrink the search space; in principle one may exploit the common submodularity of information measures and use a greedy algorithm to search for the composition "reaching the target equivalence threshold with the fewest invocations", with an approximation guarantee — but this is a future extension direction; the current version uses Step 8's static enumeration results as the candidate source and performs no full-space search |
| 5 | **Statistical power with small samples**: limited by invocation frequency / user-operation friction, paired sample sizes are often very small and TOST power is limited | When reporting TOST results, Step 11 must also report the confidence-interval width; if the interval is so wide that it straddles the decision boundary, annotate "sample size insufficient, power inadequate, not equivalence failing to hold", rather than simply deciding "undecidable" and stopping; it is recommended that the sample size N ramp up with the available invocation budget (rate limits / user-interaction cost), adopting a sequential-testing approach (recompute after each few groups collected; stop early once the interval narrows within the decision threshold) |
| 6 | **Non-stationarity across sessions**: if the two paths' validations are executed at different times/sessions, the assumption "sharing the same true value" may not hold | Paired samples must be collected within the same test session and the same time window (see Section 3.1); splicing A data and B data collected in different batches for comparison after the fact is not allowed |
| 7 | **Equivalence in the average case may differ from that in tail/boundary cases**: routine scenarios agree closely, but boundary scenarios (indoors without signal / polar regions / concurrent multi-account) may behave very differently | For high-priority VFs, besides the routine paired experiment, additionally run stratified experiments constructed from the "boundary values" list of `parameter-analysis.md`, computing EquivDegree per stratum; do not report only one aggregate value detached from scenario |
| 8 | **Ontological incompleteness of the semantic attribute space**: the whole framework depends on a pre-defined attribute space and may miss unthought-of dimensions (e.g. timing side channels, information leaked by invocation latency itself) | The graph is continuously extended through Innovation 4's "discover" action, but this is asymptotic approximation rather than a problem solvable once and for all; the limitation must be annotated honestly in the report, and one must not imply that the graph has exhausted all relevant attributes |
| 9 | **Measurement distortion from the wrong counting unit (redundancy inflation)**: without closure expansion and redundancy folding, counting raw literal fields directly systematically underestimates equivalence because the same information has multiple derived representations (e.g. latitude/longitude, city id, city name share a source) | See Section 1.1 "Closure Expansion and Information-Unit Folding" — `C` / `Δ` must be defined over folded information units, not raw fields; the folding criterion borrows information-theoretic conditional entropy (whether the relation is a deterministic function) |
| 10 | **Boundary of the framework's scope**: the entire mechanism of the equivalence-measure framework rests on the premise that "paths return comparable data", and does not apply to pure hardware-control / output APIs (vibration / NFC card writing / HCE response, etc., which return no new information after invocation) | See Section 4.5 — such scenarios should be identified as "capability/effect equivalence" problems rather than "information equivalence" problems; do not apply this file's `EquivDegree` formula, switch to `EffectEquivDegree` of `unified-theory-equivalence-and-permission-flaws.md` §4.4 |

---

## Relations to Other Steps / Rules

| Direction | Step / rule | Relation |
|---|---|---|
| Upstream input | Step 8 (`api-composition-and-equivalence-channels.md`) | Step 8 produces **candidate** equivalence relations (static-analysis conclusions, qualitative); this file performs **quantitative validation** of those candidates (dynamic empirical testing, quantitative) — the two have different roles and neither may substitute for the other |
| Upstream input | Step 9 (`scenario-construction-and-exploitation.md`) | For scenario types marked "data equivalence validation" in the pattern mapping table, the concrete quantification method of their validation sub-items comes from this file |
| Downstream consumer | Step 10 (`empirical-code-generation.md` protocol ② control-group comparison) | The decision criteria of protocol ② cite Sections 2 and 3 of this file directly, no longer using the loose "core field equivalent" |
| Downstream consumer | Step 11 (`execution-and-feedback.md`) | Adds the "knowledge completion record" artifact; see "7. Execution Flow Integration" of this file |
| Downstream consumer | Step 12 (`data-value-framework.md`) | The ★★/★★★ tiering directly cites the `EquivDegree` / `WeightedEquivDegree` values produced by this file |
| Knowledge asset | Step 13 (confirmation protection flow) | Any added/modified edge of the graph must be confirmed by the user before landing; silent direct writing is not allowed |
| Capability-nature boundary | `unified-theory-equivalence-and-permission-flaws.md` §4.4 | This file covers only quantitative equivalence validation of `ACQUIRE`-type (data-acquisition) capabilities; consistency testing of effects for `ACT`-type (hardware-control / network-egress) capabilities is handled by that section's `EffectEquivDegree`. The two neither overlap nor substitute for each other; which class a target capability belongs to is judged per that file's "Axis Three: Capability Nature" |
