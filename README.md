# MiniPerm

MiniPerm is a collection of CodeBuddy / Claude Skills for **privacy and permission analysis of mini-program APIs**. It is used to systematically find:

> API paths that can obtain equivalent data, or control the same hardware, but **require different permissions**.

The workflow is: filter candidate APIs from documentation and code, group them by shared artifact, enumerate comparison pairs through **substitution / composition** transformations, screen out potentially equivalent channels, and finally verify permission gaps through real-device execution.

---

## 1. Directory Structure

```
MiniPerm/
├── README.md                     this file
├── supplementary_material.pdf    supplementary material
├── api-privacy-analysis/         Skill 1: privacy & permission equivalence analysis (main analysis)
└── miniapp-autotest/             Skill 2: automated mini-program verification (execution engine)
```

### 1.1 `supplementary_material.pdf`

Supplementary material introducing the Skills and the Prompts.

### 1.2 `api-privacy-analysis/`

The **main analysis** Skill. It filters APIs from documentation and code, groups them, enumerates equivalence channels, constructs validation scenarios, adjudicates results, and produces the report.

```
api-privacy-analysis/
├── SKILL.md                  entry point: the full 13-step procedure and core principles
├── knowledge/
│   └── derivability_graph.json   derivability knowledge graph, seed data (reused across tasks)
├── references/               16 rule documents (step-by-step detail of SKILL.md)
│   ├── documentation-and-code-collection.md            Step 1/2 documentation & code collection
│   ├── api-grouping.md                                 Step 3 shared-source grouping
│   ├── data-flow-analysis.md                           Step 3d data flow
│   ├── parameter-analysis.md                           Step 3c parameter analysis
│   ├── doc-code-cross-validation.md                    Step 7 doc-code cross validation
│   ├── api-composition-and-equivalence-channels.md     Step 8 transformation enumeration
│   ├── equivalence-path-validation-methodology.md     quantitative equivalence validation
│   ├── permission-layering-framework.md                three-layer permission framework
│   ├── data-value-framework.md                         data value tiering
│   ├── scenario-construction-and-exploitation.md       Step 9 scenario construction
│   ├── empirical-code-generation.md                    Step 10 empirical code generation
│   ├── execution-and-feedback.md                       Step 11 execution and feedback
│   ├── unified-theory-equivalence-and-permission-flaws.md  unified adjudication theory
│   ├── automated-filter-tools.md                       filtering tool usage rules
│   ├── convergence-loop.md                             convergence loop
│   └── final-report-and-paradigm-codification.md       final report and paradigm codification
└── scripts/
    └── api-filter/           deterministic execution scripts (Steps 1/2 and 8)
        ├── doc-filter.js         documentation-side filtering (scan, pairing, verdict write-back)
        ├── code-filter.js        code-side filtering (anchor location, function extraction)
        ├── cross-validate.js     documentation-code cross validation
        ├── transform-pairs.js    Step 8 double-loop transformation engine
        ├── step8-loop.js         Step 8 loop orchestration
        ├── render-reports.js     report rendering
        └── lib/                  shared library (cli / registry / stats / textUtils)
```

### 1.3 `miniapp-autotest/`

The **verification execution engine**. It is a pure execution / orchestration layer that performs no semantic judgment — it receives the validation task sheet produced by `api-privacy-analysis`, actually runs the mini-program in the WeChat DevTools, collects output and screenshots, and writes results back.

```
miniapp-autotest/
├── SKILL.md                  entry point: interfacing with the WeChat DevTools CLI / automation
├── auto.js                   automation main script (launch, inject cases, collect console/screenshots, write back)
├── run_all.bat               one-click Windows entry point
├── references/
│   ├── template-guide.md     case template authoring guide
│   └── testplan-schema.md    testplan structure definition
└── assets/
    ├── testpage-template/    blank case page template (index.js / .wxml / .wxss)
    └── testproject/          test project that can be imported directly into the DevTools
```

#### Before running: set a test AppID

`assets/testproject/project.config.json` ships with a placeholder AppID:

```json
"appid": "XXXX"
```

**You must replace `XXXX` with your own test AppID before running.** The WeChat DevTools CLI cannot open a project or start the automation port without a valid AppID (it fails with `code 31: missing parameter project/appid`).

Options:

- Use a **personal test account** AppID, or
- Use the **"test number" / no-AppID** mode of the DevTools (note that some APIs are unavailable in this mode, which may affect verification of permission-gated APIs).

This is the only value you need to fill in manually; everything else in the project is ready to import and run.

---

## 2. How the Two Skills Cooperate

```
Documentation + Code
         │
         ▼
api-privacy-analysis ── filter → group → transform enumeration → equivalence channel candidates
         │                                                              │
         │  Step 9 produces "validation scenario + task sheet"           │
         ▼                                                              │
miniapp-autotest ────── real-device execution, collect output ───────────┘
         │
         ▼  write execution results back
api-privacy-analysis ── Step 11 adjudication → Step 12 tiering → Step 13 report
```

Division of labor:

- **Judgment belongs to `api-privacy-analysis`**: it decides *what to test, why, and how to adjudicate*.
- **Execution belongs to `miniapp-autotest`**: it is a pure engine that does not understand the validation logic; the right to write code must remain with the step that has finished the design reasoning.
- The two are connected through `_stageA_pairs.json` (the Step 8 external contract file) and the task sheet (the Step 9 output).

---

## 3. Usage

### 3.1 Functional Domains to Analyze

Analysis proceeds domain by domain. The list of functional domains:

| # | Functional domain (English) | Functional domain (Chinese) |
|---|---|---|
| 1 | Identity and Account | 身份与账户 |
| 2 | Location and Space | 位置与空间 |
| 3 | Hardware and Sensors | 硬件与传感 |
| 4 | Media and Content | 媒体与内容 |
| 5 | Network and Communication | 网络与通信 |
| 6 | Storage and Files | 存储与文件 |
| 7 | Intelligence and Biometrics | 智能与生物 |
| 8 | Transaction and Commerce | 交易与商业 |
| 9 | Interface and Interaction | 界面与交互 |
| 10 | System and Runtime | 系统与运行时 |
| 11 | Ecosystem and Connectivity | 生态与连接 |

### 3.2 Analysis Command

Iterate over the table above: fill the current functional domain into the `XXX` slots and the input paths / result directory into the `&&&` slots, then **execute the command once per domain**, saving each domain's result into the results folder.

Command template (copy it and replace `XXX` and `&&&`):

```
Use the api-privacy-analysis skill. The input files are: documentation part &&&, and code part &&&. Analyze XXX-class APIs (for example XXX, and so on), covering all relevant APIs as completely as possible. Focus on finding paths that can obtain equivalent data or control the same hardware but require different permissions. Use miniapp-autotest to verify and test the issues discovered. Write the analysis results into XXX-class-API-analysis.md. Do not use historical data; do not omit vulnerabilities that have been analyzed before — re-analyze them and write them into the report. Note that every step of the procedure must be executed strictly according to the rules. Save the documentation API filtering results, the code API filtering results, the grouping results including each group's content, and the comparison pair sequences as "<domain>-<step>.md" files into the results folder.
```

### 3.3 Placeholder Meanings

| Placeholder | Meaning | Example |
|---|---|---|
| `&&&` (1st) | documentation input path | `docs/api_doc/` |
| `&&&` (2nd) | code input path (mini-program base library) | `code/WAService.js` |
| `&&&` (3rd) | results output folder | `results/` |
| `XXX` (1st, 2nd) | current functional domain name | `Location and Space` |
| `XXX` (3rd) | domain name used in the report filename | `Location-and-Space-class-API-analysis.md` |

Filled example, using the domain **Location and Space**:

```
Use the api-privacy-analysis skill. The input files are: documentation part docs/api_doc/, and code part code/WAService.js. Analyze Location and Space-class APIs (for example getLocation, getFuzzyLocation, and so on), covering all relevant APIs as completely as possible. Focus on finding paths that can obtain equivalent data or control the same hardware but require different permissions. Use miniapp-autotest to verify and test the issues discovered. Write the analysis results into Location-and-Space-class-API-analysis.md. Do not use historical data; do not omit vulnerabilities that have been analyzed before — re-analyze them and write them into the report. Note that every step of the procedure must be executed strictly according to the rules. Save the documentation API filtering results, the code API filtering results, the grouping results including each group's content, and the comparison pair sequences as "Location-and-Space-<step>.md" files into the results folder.
```

---

## 4. Output Files per Functional Domain

After each domain is analyzed, the results folder should contain:

| File | Content |
|---|---|
| `<domain>-class-API-analysis.md` | main report of the domain (findings, adjudication, tiering) |
| `<domain>-documentation-filtering.md` | documentation-side API filtering results |
| `<domain>-code-filtering.md` | code-side API filtering results |
| `<domain>-grouping.md` | shared-source grouping results (including each group's content) |
| `<domain>-comparison-pairs.md` | comparison pair sequence (Step 8 output) |
| `_stageA_pairs.json` | Step 8 external contract file (for reuse by later steps) |
