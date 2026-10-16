/**
 * Step 11: execution and feedback — automated test executor
 *
 * Usage (no code generation; it only connects + executes + collects):
 *   node auto.js
 *     --test-project-path <path of the mini-program project already filled with test code>
 *     [--devtools-cli-path <path to the WeChat devtools cli.bat>]
 *     [--platform <DevTools|RealDevice>]
 *     [--result-path <result output directory>]
 *
 *   --devtools-cli-path default (preset on this machine):
 *     C:\tools\devtools\cli.bat
 *
 * Connection modes:
 *   DevTools   — execute in the devtools simulator
 *   RealDevice — drive a real device through devtools (scan the QR code to connect first)
 *
 * Operations:
 *   passed in through external testPlan config (see the testPlan structure notes at the end of this file);
 *   the script generates no test code and only executes step by step per the plan.
 *
 * Result collection:
 *   - console logs (console.log / warn / error)
 *   - screenshots (automatic per step, plus manually triggered screenshot steps)
 *   - page WXML snapshots (optional, for diagnosing rendering problems)
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const automator = require('miniprogram-automator')

// ====== machine preset: WeChat devtools CLI default path ======
const DEVTOOLS_CLI_DEFAULT = 'C:\\tools\\devtools\\cli.bat'
const DEVTOOLS_DIR = path.dirname(DEVTOOLS_CLI_DEFAULT)

// ensure the devtools CLI directory is in PATH (automator.launch() uses the bare name 'cli.bat', relying on PATH lookup)
if (process.platform === 'win32' && !process.env.PATH.includes(DEVTOOLS_DIR)) {
  process.env.PATH = DEVTOOLS_DIR + ';' + process.env.PATH
  console.log('[Setup] injected the CLI directory into PATH: ' + DEVTOOLS_DIR)
}

// module-level flag: the real-device platform does not support screenshots (stated explicitly in the official docs)
// https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/miniprogram.html
let _isRealDevicePlatform = false

// ====== Argument parsing ======

function parseArgs(argv) {
  const config = {
    resultPath: './autotest/TestResult/',
    platform: 'DevTools',          // DevTools | RealDevice
    devToolsCliPath: DEVTOOLS_CLI_DEFAULT, // defaults to the machine preset path; overridable via --devtools-cli-path
    testProjectPath: '',
    testPlanPath: '',              // external testPlan JSON file path (optional); in batch mode supports comma-separated multiple
    timeout: 120000,               // per-operation timeout, ms
    remoteTimeout: 120000,         // real-device QR scan timeout, ms
    autoPort: 9420,                // IDE automation WebSocket port (for log display / RealDevice hints only; no longer passed to launch())
    captureWxml: false,            // whether to collect page WXML snapshots
    clearAuth: false,              // whether to clear the authorization cache before testing
    autoAuthorize: false,          // whether to auto-click "Allow" on permission prompts
    batch: false,                  // batch mode: execute several testPlans consecutively (testPlanPath comma-separated)
    bail: false,                   // in batch mode, stop the rest once any plan fails
    maxRetries: 3,                 // IDE connection retry count
    report: true,                  // whether to generate an aggregate report after batching ends
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') {
      printUsage()
      process.exit(0)
    }

    // Boolean flags (take no value)
    if (arg === '--clear-auth') {
      config.clearAuth = true
      continue
    }
    if (arg === '--auto-authorize') {
      config.autoAuthorize = true
      continue
    }
    if (arg === '--batch') {
      config.batch = true
      continue
    }
    if (arg === '--bail') {
      config.bail = true
      continue
    }
    if (arg === '--no-report') {
      config.report = false
      continue
    }

    const [rawKey, inlineValue] = arg.split('=', 2)
    if (!rawKey.startsWith('--')) {
      console.error('Unknown argument: ' + arg)
      printUsage()
      process.exit(1)
    }

    const key = rawKey.slice(2)
    let value = inlineValue !== undefined ? inlineValue : argv[++i]
    if (value === undefined || value.startsWith('--')) {
      console.error('Missing value for argument: ' + rawKey)
      printUsage()
      process.exit(1)
    }

    switch (key) {
      case 'result-path':       config.resultPath = value; break
      case 'devtools-cli-path': config.devToolsCliPath = value; break
      case 'test-project-path': config.testProjectPath = value; break
      case 'test-plan-path':    config.testPlanPath = value; break
      case 'platform':
        config.platform = value
        if (value === 'RealDevice') _isRealDevicePlatform = true
        break
      case 'timeout':           config.timeout = parseInt(value); break
      case 'remote-timeout':    config.remoteTimeout = parseInt(value); break
      case 'auto-port':         config.autoPort = parseInt(value); break
      case 'capture-wxml':      config.captureWxml = value === 'true'; break
      case 'retries':           config.maxRetries = parseInt(value); break
      default:
        console.error('Unknown argument: ' + rawKey)
        printUsage()
        process.exit(1)
    }
  }

  const missing = []
  if (!config.testProjectPath) missing.push('--test-project-path')
  if (missing.length > 0) {
    console.error('Missing required argument(s): ' + missing.join(', '))
    printUsage()
    process.exit(1)
  }

  return config
}

function printUsage() {
  console.log([
    'Usage:',
    '  node auto.js --test-project-path <path> [options]',
    '',
    'Required:',
    '  --test-project-path <path>    mini-program project path (already filled with test code)',
    '',
    'Options:',
    '  --devtools-cli-path <path>    path to the WeChat devtools cli.bat',
    '                                default: ' + DEVTOOLS_CLI_DEFAULT,
    '  --result-path <path>          result output directory, default ./autotest/TestResult/',
    '  --platform <DevTools|RealDevice>',
    '                                execution platform, default DevTools',
    '  --auto-port <port>            for log display / RealDevice hints only, default 9420 (no longer passed to automator.launch())',
    '  --remote-timeout <ms>         real-device QR scan connection timeout, ms, default 120000 (2 minutes)',
    '  --test-plan-path <path>       testPlan JSON file path (if omitted, the built-in default plan is used)',
    '  --timeout <ms>                per-step operation timeout, ms, default 120000',
    '  --capture-wxml <true|false>   whether to additionally collect page WXML snapshots, default false',
    '  --clear-auth                  clear the authorization cache before testing',
    '  --auto-authorize              auto-click the "Allow" button on permission prompts',
    '  --batch                       batch mode: testPlanPath supports comma-separated multiple JSON files',
    '  --bail                        in batch mode, stop the rest once any plan fails (default: continue)',
    '  --retries <N>                 IDE connection failure retry count, default 3',
    '  --no-report                   disable generation of the final aggregate report (generated by default)',
    '  -h, --help                    show help',
    '',
    'testPlan JSON structure (generated by Step 10 and passed in):',
    '  {',
    '    "name": "test name",',
    '    "description": "test description",',
    '    "entryPage": "pages/AutoTest/index",  // entry page path',
    '    "preSteps": [                         // preparatory steps (optional)',
    '      {',
    '        "type": "relaunch|navigateTo|delay",',
    '        "page": "pages/AutoTest/index",    // required for relaunch/navigateTo',
    '        "ms": 2000                          // required for delay',
    '      }',
    '    ],',
    '    "steps": [                             // test operation steps',
    '      {',
    '        "id": "S1",',
    '        "name": "step description",',
    '        "type": "tap|input|screenshot|wait|scroll|assert|callApi|authorize",',
    '        // tap/input types:',
    '        "selector": "#Button",',
    '        // additional for the input type:',
    '        "value": "input content",',
    '        // wait type:',
    '        "ms": 3000,',
    '        // callApi type (invoke a page method):',
    '        "apiMethod": "doTest",',
    '        "apiParams": [],',
    '        // assert type:',
    '        "assertSelector": "#Result",',
    '        "assertText": "expected text"',
    '        // authorize type (operate the permission prompt):',
    '        "action": "allow|deny",           // allow=click Allow, deny=click Deny',
    '      }',
    '    ],',
    '    "cleanupSteps": [                     // cleanup steps (optional)',
    '      { "type": "relaunch", "page": "pages/AutoTest/index" }',
    '    ]',
    '  }',
  ].join('\n'))
}

// ====== Utility functions ======

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true })
}

/** Save a screenshot */
async function saveScreenshot(miniProgram, filePath) {
  if (_isRealDevicePlatform) {
    // Real devices do not support screenshots: https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/miniprogram.html
    return
  }
  try {
    // timeout protection is added here: error-handling paths (such as the "auto-screenshot on error" after a tap timeout) depend on this function no longer hanging,
    // otherwise, once the underlying connection / page state is unstable as a whole, it would hang indefinitely again at the "remedial screenshot" step,
    // making the already-effective timeout mechanism useless.
    const screenshot = await Promise.race([
      miniProgram.screenshot(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('screenshot timeout')), 8000)),
    ])
    fs.writeFileSync(filePath, screenshot, 'base64')
    console.log('  [Screenshot] saved: ' + filePath)
    return true
  } catch (err) {
    console.warn('  [Screenshot] failed: ' + err.message)
    return false
  }
}

/** Save a page WXML snapshot */
async function saveWxmlSnapshot(page, filePath) {
  try {
    const element = await Promise.race([
      page.$('page'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('query timeout')), 5000)),
    ])
    if (element) {
      const wxml = await Promise.race([
        element.outerWxml(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('outerWxml timeout')), 5000)),
      ])
      fs.writeFileSync(filePath, wxml, 'utf-8')
      console.log('  [WXML] saved: ' + filePath)
    }
  } catch (err) {
    console.warn('  [WXML] failed: ' + err.message)
  }
}

/** Format a timestamp */
function timestamp() {
  const d = new Date()
  return d.getFullYear()
    + String(d.getMonth() + 1).padStart(2, '0')
    + String(d.getDate()).padStart(2, '0') + '_'
    + String(d.getHours()).padStart(2, '0')
    + String(d.getMinutes()).padStart(2, '0')
    + String(d.getSeconds()).padStart(2, '0')
}

// ====== Default testPlan (used when none is passed in externally) ======
// after Step 10 generates the test code, a testPlan JSON file can be generated alongside and passed in via --test-plan-path

const DEFAULT_TEST_PLAN = {
  name: 'default test',
  description: 'No testPlan specified; the default placeholder plan is used. Pass the Step 10 generated testPlan via --test-plan-path.',
  entryPage: 'pages/AutoTest/index',
  steps: [
    { id: 'S0', name: 'wait for page load', type: 'wait', ms: 3000 },
    { id: 'S1', name: 'initial page screenshot', type: 'screenshot' },
    // ============================================================
    // TODO: later fill in concrete operation steps according to actual test needs. For example:
    //
    // { id: 'S2', name: 'tap the trigger button', type: 'tap', selector: '#BtnStart' },
    // { id: 'S3', name: 'wait for result rendering', type: 'wait', ms: 2000 },
    // { id: 'S4', name: 'result page screenshot', type: 'screenshot' },
    // { id: 'S5', name: 'enter a test value into the input box', type: 'input', selector: '#Input', value: 'test' },
    // { id: 'S6', name: 'verify the result display', type: 'assert', assertSelector: '#Result', assertText: 'expected text' },
    // ============================================================
  ],
  cleanupSteps: [
    { type: 'relaunch', page: 'pages/AutoTest/index' },
  ],
}

// ====== Core: load the testPlan ======

function loadTestPlan(config) {
  if (config.testPlanPath && fs.existsSync(config.testPlanPath)) {
    console.log('Loading testPlan from: ' + config.testPlanPath)
    const raw = fs.readFileSync(config.testPlanPath, 'utf-8')
    return JSON.parse(raw)
  }
  console.log('No testPlan file provided, using DEFAULT_TEST_PLAN')
  return DEFAULT_TEST_PLAN
}

// ====== Core: pre-inject the Bluetooth permission into the IDE storage file ======
//         miniprogram-automator's Native.authorizeAllow/confirmModal
//         cannot handle native prompts triggered directly by Bluetooth / location and similar APIs;
//         so here we modify WeappStorage on disk directly, making the IDE believe Bluetooth is already authorized
function preGrantBluetoothPermission() {
  try {
    const userDataBase = path.join(process.env.LOCALAPPDATA || '', '微信开发者工具', 'User Data')
    if (!fs.existsSync(userDataBase)) return

    const profiles = fs.readdirSync(userDataBase)
    let modifiedCount = 0
    let injectedCount = 0

    // prefabricated authSetting data (including permissions always allowed by default + Bluetooth)
    const DEFAULT_AUTH = {
      'scope.address': true,
      'scope.invoice': true,
      'scope.invoiceTitle': true,
      'scope.userInfo': true,
      'scope.bluetooth': true,
    }
    const innerPayload = {
      args: '',
      data: { errMsg: 'getSetting:ok', authSetting: DEFAULT_AUTH },
      expire: 9999999999999  // never expires
    }

    for (const profile of profiles) {
      const storageDir = path.join(userDataBase, profile, 'WeappSimulator', 'WeappStorage')
      if (!fs.existsSync(storageDir)) continue

      const files = fs.readdirSync(storageDir)
      for (const file of files) {
        if (!file.startsWith('storage_') || !file.endsWith('.json')) continue
        const filePath = path.join(storageDir, file)
        try {
          const raw = fs.readFileSync(filePath, 'utf-8')
          const obj = JSON.parse(raw)

          // case 1: an empty file {"2":{}} — inject the complete cache|getSetting structure
          if (obj['2'] !== undefined && obj['3'] === undefined) {
            obj['3'] = {
              'cache|getSetting': {
                data: JSON.stringify(innerPayload),
                dataType: 'Object'
              }
            }
            fs.writeFileSync(filePath, JSON.stringify(obj), 'utf-8')
            injectedCount++
            console.log('  [PreAuth] injected the complete permission structure → ' + file)
            continue
          }

          // case 2: an existing cache|getSetting structure — append into the existing authSetting
          const cache = obj && obj['3'] && obj['3']['cache|getSetting']
          if (!cache || !cache.data) continue

          const inner = JSON.parse(cache.data)
          if (!inner.data || !inner.data.authSetting) continue

          if (inner.data.authSetting['scope.bluetooth'] !== undefined) continue

          inner.data.authSetting['scope.bluetooth'] = true
          cache.data = JSON.stringify(inner)
          fs.writeFileSync(filePath, JSON.stringify(obj), 'utf-8')
          modifiedCount++
          console.log('  [PreAuth] injected scope.bluetooth → ' + file)
        } catch (_) {
          // the file format does not match or cannot be parsed; skip
        }
      }
    }
    if (modifiedCount + injectedCount > 0) {
      console.log('  [PreAuth] processed ' + (modifiedCount + injectedCount)
        + ' storage file(s) (modified: ' + modifiedCount + ', injected: ' + injectedCount + ')')
    } else {
      console.log('  [PreAuth] no modifiable storage file found (possibly a new project; the IDE creates it automatically after launch)')
    }
  } catch (e) {
    console.warn('  [PreAuth] failed to pre-inject the Bluetooth permission: ' + e.message)
  }
}

// ====== Core: trigger IDE recompilation ======
//         after clearing the cache, when the IDE restarts it may reuse the old build artifacts if the source files are unchanged.
//         so we trigger the IDE's file watcher by "deleting the page wxml → writing it back immediately",
//         the IDE then detects the file delete + create events and force-recompiles that page and its dependencies.
function triggerRebuild(projectPath) {
  try {
    // prefer the test page's index.wxml (the project must contain it)
    const candidates = [
      'pages/AutoTest/index.wxml',
      'pages/index/index.wxml',
    ]
    let targetFile = null
    for (const rel of candidates) {
      const full = path.join(projectPath, rel)
      if (fs.existsSync(full)) { targetFile = full; break }
    }
    if (!targetFile) {
      console.log('  [Rebuild] no operable wxml file found, skipping')
      return
    }

    // first read the file content
    const raw = fs.readFileSync(targetFile, 'utf-8')
    // delete → the IDE file watcher perceives a delete
    fs.unlinkSync(targetFile)
    // write back immediately → the IDE perceives a create, triggering diff comparison and recompilation
    fs.writeFileSync(targetFile, raw, 'utf-8')

    const relName = path.relative(projectPath, targetFile)
    console.log('  [Rebuild] deleted and restored ' + relName + ' (forced recompilation)')
  } catch (e) {
    console.warn('  [Rebuild] delete/restore failed: ' + e.message + ' (the IDE will still try to compile)')
  }
}

// ====== Core: process management ======

/** Force-terminate all IDE-related processes (wechatdevtools + the WeChatAppEx runtime) */
function killAllIDEProcesses() {
  const targets = ['wechatdevtools.exe', 'wechatwebdevtools.exe', 'WeChatAppEx.exe']
  for (const proc of targets) {
    try { spawnSync('taskkill', ['/F', '/IM', proc], { stdio: 'ignore' }) } catch (_) {}
  }
}

/**
 * convert a Windows path to its 8.3 short form, avoiding encoding corruption of non-ASCII characters / spaces when passing arguments to spawn.
 * Linux/macOS return it unchanged. If obtaining the short path fails, fall back to the original path.
 */
function toShortPath(longPath) {
  if (process.platform !== 'win32') return longPath
  try {
    const result = spawnSync('cmd', ['/c', 'for %I in ("' + longPath + '") do @echo %~sI'], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore']
    })
    const short = (result.stdout || '').trim()
    return (short && fs.existsSync(short)) ? short : longPath
  } catch (_) { return longPath }
}

/**
 * find a CLI identifier usable for spawn.
 *
 * on Windows, automator.launch() internally uses child_process.spawn(cliPath, args, {stdio:'ignore'})
 * to launch the .bat. Node.js's spawn on Windows can resolve the bare name 'cli.bat' via PATHEXT/PATH and works fine,
 * but passing a full path (e.g. 'C:\\tools\\devtools\\cli.bat') may make spawn fail (.bat needs shell:true).
 *
 * therefore: on Windows always return 'cli.bat' first (the bare name, relying on PATH), avoiding spawn directly executing a full-path .bat and failing.
 */
function findSpawnCliPath(config) {
  // Windows: always prefer the bare name (PATH lookup); spawn is more compatible with bare-name .bat
  if (process.platform === 'win32' && safeWhich('cli.bat')) return 'cli.bat'
  // fallback: a pure-ASCII full path
  const full = config.devToolsCliPath
  if (!/[^\x00-\x7F]/.test(full)) return full
  // fallback for non-ASCII paths: short path
  return toShortPath(full)
}

/** On Windows, check whether a command is in PATH (used to verify CLI availability) */
function safeWhich(cmd) {
  if (process.platform !== 'win32') return false
  try {
    const result = spawnSync('where', [cmd], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
    return result.status === 0 && (result.stdout || '').trim().length > 0
  } catch (_) { return false }
}

// ====== Core: connect to the mini-program (with retries) ======

async function connectWithRetry(config, maxRetries = 3) {
  let lastError = null
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const prefix = maxRetries > 1 ? `[attempt ${attempt}/${maxRetries}] ` : ''
      return await connect(config, prefix)
    } catch (e) {
      lastError = e
      if (attempt < maxRetries) {
        const backoff = attempt * 10000
        console.log('\n' + '='.repeat(50))
        console.log('  IDE connection failed (attempt ' + attempt + '/' + maxRetries + '): ' + e.message)
        console.log('  waiting ' + backoff/1000 + 's before retrying (force-cleaning all IDE processes)...')
        console.log('='.repeat(50))
        killAllIDEProcesses()
        await wait(backoff)
      }
    }
  }
  throw lastError
}

async function connect(config, logPrefix = '') {
  // ====== Path preprocessing: uniformly convert to absolute paths + Windows short paths ======
  const projectAbs = path.resolve(config.testProjectPath)
  const projectShort = toShortPath(projectAbs)
  const cliForSpawn = findSpawnCliPath(config)

  console.log('\n========== Connecting to the mini-program ==========')
  console.log('Platform:      ' + config.platform)
  console.log('DevTools CLI:  ' + config.devToolsCliPath + (cliForSpawn !== config.devToolsCliPath ? '  → spawn: ' + cliForSpawn : ''))
  console.log('Project path:  ' + projectAbs)
  if (projectShort !== projectAbs) console.log('  (short:       ' + projectShort + ')')

  // check whether the CLI exists (first the full path, then PATH)
  const cliExists = fs.existsSync(config.devToolsCliPath) || (process.platform === 'win32' && safeWhich('cli.bat'))
  if (!cliExists) {
    console.error('DevTools CLI not found.')
    console.error('please confirm the WeChat devtools is installed. Default path: ' + DEVTOOLS_CLI_DEFAULT)
    console.error('or specify the correct cli.bat path via --devtools-cli-path')
    throw new Error('CLI not found')
  }

  // real-device mode: force-close existing IDE processes, ensuring the later cli.bat auto correctly enters automation mode
  if (config.platform === 'RealDevice') {
    console.log(logPrefix + 'real-device mode — closing existing IDE processes to ensure automation mode starts correctly...')
    try {
      spawnSync(cliForSpawn, ['close', '--project', projectShort], { stdio: 'ignore' })
    } catch (_) {}
    await wait(1000)
    killAllIDEProcesses()
    await wait(2000)
    console.log('  IDE processes closed')
  }

  // 0) clear the authorization cache (optional; ensures the baseline authSetting is not polluted by historical authorizations)
  if (config.clearAuth) {
    console.log(logPrefix + 'clearing the authorization cache...')
    try {
      spawnSync(cliForSpawn, ['close', '--project', projectShort], { stdio: 'ignore' })
      await wait(2000)
      console.log('  closing all IDE processes...')
      killAllIDEProcesses()
      await wait(3000)
      spawnSync(cliForSpawn, ['cache', '--clean', 'auth', '--project', projectShort], { stdio: 'ignore' })
      preGrantBluetoothPermission()
      triggerRebuild(projectShort)
      console.log('  authorization cache cleared (processes closed + disk cleaned + Bluetooth pre-authorized + recompilation triggered)')
    } catch (e) {
      console.warn('failed to clear the authorization cache: ' + e.message + ' (execution continues)')
    }
  }

  // 1) launch the IDE and establish the connection — following directly the implementation of auto.spec.js runCase():
  //      await automator.launch({ cliPath, projectPath }).then(async miniProgram => {...})
  //    launching the tool and establishing the connection in one step, without explicitly passing port/timeout, letting the library use defaults / pick a free port automatically
  //     (official docs https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/quick-start.html).
  //    on Windows, cliForSpawn returns 'cli.bat' (the bare name, relying on PATH),
  //    so that automator.launch()'s internal spawn('cli.bat', args) can execute the .bat properly via PATHEXT.
  //    if launch() fails, throw directly, letting the outer connectWithRetry() clean up IDE processes and retry.
  console.log(logPrefix + 'launching the IDE and connecting (automator.launch)...')
  console.log('  cliPath:     ' + cliForSpawn + '  (full: ' + config.devToolsCliPath + ')')
  console.log('  projectPath: ' + projectShort)

  return await automator.launch({
    // wsEndpoint: 'ws://127.0.0.1:9420',
    cliPath: cliForSpawn,
    projectPath: projectShort,
  }).then(async miniProgram => {
    console.log(logPrefix + 'IDE launched & connected.')
    // note: we once tried "minimize + restore twice" to fix a suspected blank-screen problem; empirical testing confirmed the problem is unrelated to screen rendering
    // (Page.$/$$/data() still hang even when the screen renders normally), so that workaround has been removed.
    // the real workaround is the direct evaluate call for #BtnScenario_*/#Result_* in the tap/assert steps.
    return await applyPlatformMode(miniProgram, config)
  }).catch(e => {
    const msg = (e && e.message) || String(e)
    console.error(logPrefix + 'automator.launch() failed: ' + msg)

    // targeted diagnosis for a known Node.js version compatibility issue: even when cliPath is entirely correct,
    // the changed spawn(.bat) behavior under Node v20+ produces this exact same error text, easily misleading users
    // into repeatedly checking / modifying cliPath (the real cause is unrelated to cliPath). Hint only when the error occurs; no proactive warning at startup.
    if (/Failed to launch wechat web devTools.*cliPath is correctly specified/i.test(msg)) {
      const major = parseInt(process.versions.node.split('.')[0], 10)
      console.error('')
      console.error('  ！  diagnostic hint: this error may be unrelated to cliPath itself!')
      console.error('  current Node.js version: ' + process.version + (major >= 20 ? ' (a known affected version)' : ''))
      console.error('  known issue: on Node v20 and above, the internal spawn(cli.bat) call of automator.launch() fails because')
      console.error('  the fix in Node for CVE-2024-27980 tightened spawn behavior for .bat files (shell:true is required to invoke them),')
      console.error('  so even if --devtools-cli-path is specified entirely correctly, the error text is exactly the same as this one.')
      console.error('  suggestion: switch to Node.js v18.17.1 (verified working),')
      console.error('        you can switch via nvm / nvm-windows: nvm install 18.17.1 && nvm use 18.17.1')
      console.error('  (only if this error persists on v18.17.1 should you investigate the usual way, whether cliPath is correct / the IDE is installed)')
      console.error('')
    }

    // targeted at CLI argument syntax incompatibility caused by an outdated miniprogram-automator:
    // old versions (<0.10.0) assemble the command cli --auto <path> --auto-port <port> (v1 syntax, project path as a positional argument),
    // whereas the new WeChat devtools CLI has upgraded to v2 syntax: cli auto --project <path> --auto-port <port>,
    // so the command assembled by the old SDK is rejected by the new CLI (code 31: missing parameter project/appid),
    // which finally manifests as "cli.bat exits but the IDE automation port is not opened".
    if (/http port is open/i.test(msg)) {
      let automatorVersion = 'unknown'
      try {
        const pkg = require('miniprogram-automator/package.json')
        automatorVersion = pkg.version
      } catch (_) {}

      console.error('')
      console.error('  ！  diagnostic hint: the miniprogram-automator version may be too old and incompatible with the current WeChat devtools CLI!')
      console.error('  current miniprogram-automator version: ' + automatorVersion)
      console.error('  known issue: old versions (<0.10.0) assemble CLI commands using v1 syntax (cli --auto <path> --auto-port <port>),')
      console.error('  whereas the new WeChat devtools CLI accepts only v2 syntax (cli auto --project <path> --auto-port <port>).')
      console.error('  the command assembled by the old SDK is rejected by the new tool (code 31: missing parameter project/appid),')
      console.error('  so the project cannot be opened and the automation port cannot listen, finally surfacing as this error.')
      console.error('  suggestion: upgrade miniprogram-automator to v0.12.1 or higher:')
      console.error('        npm install miniprogram-automator@0.12.1')
      console.error('  (only if this error persists on v0.12.1+ should you investigate the usual way, whether the IDE service port is open / the project path is correct)')
      console.error('')
    }
    throw e
  })
}

async function applyPlatformMode(miniProgram, config) {
  // only RealDevice needs to switch to remote debugging
  if (config.platform !== 'RealDevice') {
    return miniProgram
  }

  console.log('')
  console.log('='.repeat(56))
  console.log('  real-device remote debugging mode (RealDevice)')
  console.log('='.repeat(56))
  console.log('')
  console.log('  preconditions:')
  console.log('  - WeChat base library version >= 2.7.3')
  console.log('  - computer and phone on the same LAN')
  console.log('  - phone WeChat is logged in')
  console.log('')

  const remoteTimeout = config.remoteTimeout || 120000

  try {
    // miniProgram.remote() makes the devtools output a QR code,
    // and the returned Promise resolves once the user scans successfully
    console.log('[waiting] calling remote() to generate the QR code...')
    console.log('   (WebSocket: ws://127.0.0.1:' + (config.autoPort || 9420) + ')')
    console.log('   (IDE service port: please confirm that devtools Settings → Security → Service Port is enabled)')
    console.log('')

    // first check whether remote is usable (some versions return a rejected promise instead of throwing)
    let remotePromise
    try {
      remotePromise = miniProgram.remote()
      // if remote() throws synchronously
      if (!remotePromise || typeof remotePromise.then !== 'function') {
        throw new Error('remote() did not return a Promise — the IDE may not support automated remote debugging; please confirm the devtools version is >= 1.05.2107090')
      }
    } catch (initErr) {
      console.error('remote() call failed: ' + (initErr.message || initErr))
      console.error('')
      console.error('  common causes:')
      console.error('  1. the devtools version is too old (needs >= 1.05.2107090)')
      console.error('  2. IDE automation mode did not start correctly — try restarting the devtools manually')
      console.error('  3. --auto-port port conflict — try another port (e.g. --auto-port 9421)')
      console.error('  4. the project is already open manually in the IDE but not in automation mode — close the project first, then run the test')
      throw initErr
    }

    console.log('  QR code generated; please view it in the devtools and scan it with WeChat')
    console.log('  (timeout: ' + (remoteTimeout / 1000) + 's; please finish scanning before it)')
    console.log('')

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(
        'QR-code scan timed out (' + (remoteTimeout / 1000) + 's); no real-device connection detected.\n' +
        'please confirm: 1) phone and computer are on the same network  2) WeChat is open  3) the QR code has been scanned'
      )), remoteTimeout)
    })

    await Promise.race([remotePromise, timeoutPromise])

    console.log('')
    console.log('√ real-device connection succeeded! All subsequent test operations run on the real device.')
    console.log('')

    // after the real-device connection, wait for page sync to finish (network latency + compilation)
    await wait(5000)

    return miniProgram

  } catch (err) {
    console.log('')
    console.error('× real-device connection failed: ' + err.message)
    console.log('')
    console.log('  troubleshooting:')
    console.log('  1. confirm that devtools Settings → Security → Service Port is enabled')
    console.log('  2. check whether phone WeChat is open and logged in')
    console.log('  3. confirm phone and computer are on the same LAN')
    console.log('  4. the WeChat base library version must be >= 2.7.3')
    console.log('  5. you may try specifying a port via the --auto-port parameter(e.g. --auto-port ' + (config.autoPort || 9420) + ')')
    console.log('  6. you may also first manually click "Real-device debugging" in the devtools, scan, and then run the test')
    console.log('')

    throw new Error('real-device connection failed: ' + err.message)
  }
}

// ====== Core: execute a single step ======

async function executeStep(step, miniProgram, page, resultDir, stepIdx, config) {
  const stepId = step.id || ('S' + stepIdx)
  console.log('\n--- Step ' + stepId + ': ' + (step.name || step.type) + ' ---')

  // fallback: before each step, temporarily listen for exception events and print the message, avoiding an uncaught termination
  const onException = (e) => {
    console.error('  [step ' + stepId + ' exception] ' + (e && e.message ? e.message : require('util').inspect(e, {depth: 3})))
  }
  miniProgram.on('exception', onException)

  // before interactive steps, auto-refresh the page reference (handles the edge case where mockWx and similar operations invalidate the page reference)
  const interactiveTypes = ['tap', 'input', 'scroll', 'assert', 'screenshot']
  if (interactiveTypes.indexOf(step.type) !== -1) {
    try {
      const refreshed = await Promise.race([
        miniProgram.currentPage(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('currentPage timeout')), 5000)),
      ])
      if (refreshed) {
        page = refreshed
        console.log('  [refresh] page reference refreshed: ' + (page.path || '?'))
      }
    } catch (e) {
      console.warn('  [refresh] failed to refresh the page (keeping the old reference): ' + e.message)
    }
  }

  try {
    switch (step.type) {

      // ----- page navigation -----
      case 'relaunch':
        if (!step.page) throw new Error('relaunch needs "page"')
        console.log('  relaunch → ' + step.page)
        page = await miniProgram.reLaunch(step.page)
        await wait(2000)  // wait for page rendering
        break

      case 'navigateTo':
        if (!step.page) throw new Error('navigateTo needs "page"')
        console.log('  navigateTo → ' + step.page)
        page = await miniProgram.navigateTo(step.page)
        await wait(2000)
        break

      // ----- wait -----
      case 'wait':
      case 'delay': {
        const ms = step.ms || 2000
        console.log('  waiting ' + ms + 'ms...')
        await wait(ms)
        break
      }

      // ----- tap -----
      case 'tap': {
        if (!step.selector) throw new Error('tap needs "selector"')
        console.log('  tap → ' + step.selector)

        // diagnostic: use evaluate to check whether the page data loaded correctly
        try {
          const diag = await Promise.race([
            miniProgram.evaluate(function() {
              var pages = getCurrentPages()
              var page = pages[pages.length - 1]
              var scenarioCount = (page.data.scenarios && page.data.scenarios.length) || 0
              var scenarioIds = (page.data.scenarios || []).map(function(s) { return s.id }).join(',')
              return 'scenarios:' + scenarioCount + ' [' + scenarioIds + '] | route:' + page.route
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('evaluate timeout')), 5000)),
          ])
          console.log('  [diag] ' + diag)
        } catch (e) {
          console.warn('  [diag] evaluate failed: ' + e.message)
        }

        // ====== Known environment problem workaround: prefer direct evaluate calls, skipping the hanging Page.* protocol ======
        // some WeChat devtools versions (confirmed by empirical testing; unrelated to a blank screen / rendering, and manual minimize-restore
        // does not fix it either) have an issue where Page-domain automation-protocol commands such as Page.getElement/getElements/getData
        // hang forever (neither resolving nor rejecting), whereas App-domain commands
        // (App.callFunction, i.e. evaluate, and App.captureScreenshot) are unaffected.
        // because this framework's generic test-page template (index.js) is itself under our control, with buttons uniformly bound to
        // bindtap="runScenario" data-id="{{item.id}}", we can call page.runScenario(e) directly via evaluate inside the mini-program
        // runtime by constructing a synthetic event object, entirely bypassing the Page.* protocol query / tap chain.
        const scenarioBtnMatch = /^#BtnScenario_(.+)$/.exec(step.selector)
        if (scenarioBtnMatch) {
          const scenarioId = scenarioBtnMatch[1]
          console.log('  [evaluate-tap] scenario button detected, calling page.runScenario("' + scenarioId + '") directly (bypassing the Page.* protocol)')
          await miniProgram.evaluate(function(id) {
            var pages = getCurrentPages()
            var pg = pages[pages.length - 1]
            pg.runScenario({ currentTarget: { dataset: { id: id } } })
          }, scenarioId)
          await wait(500)
          break
        }

        // normal path: following the official docs for element.tap(): get the element via page.$(selector) and call element.tap() directly
        // https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/element.html#element-tap
        const el = await waitForElement(page, step.selector, step.timeout || 15000, 'tap')
        await el.tap()
        await wait(500)
        break
      }

      // ----- input -----
      case 'input': {
        if (!step.selector) throw new Error('input needs "selector"')
        const val = step.value || ''
        console.log('  input → ' + step.selector + ' = "' + val + '"')
        const el = await waitForElement(page, step.selector, step.timeout || 15000, 'input')
        await el.input(val)
        await wait(500)
        break
      }

      // ----- scroll -----
      case 'scroll': {
        if (!step.selector) throw new Error('scroll needs "selector"')
        console.log('  scroll → ' + step.selector)
        const el = await waitForElement(page, step.selector, step.timeout || 15000, 'scroll')
        // note: miniprogram-automator has no element.scrollTop(value) method (that is only a read-only property getter);
        // the correct API for scrolling to a given position is element.scrollTo(x, y)
        // https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/element.html
        await el.scrollTo(0, step.scrollTop || 500)
        await wait(500)
        break
      }

      // ----- screenshot (explicit step) -----
      case 'screenshot':
        if (_isRealDevicePlatform) {
          console.log('  [RealDevice] skipping the screenshot (not supported officially; the API lacks this capability)')
          break
        }
        console.log('  taking screenshot...')
        await saveScreenshot(miniProgram,
          path.join(resultDir, stepId + '_screenshot.png'))
        break

      // ----- invoke a page method -----
      case 'callApi': {
        if (!step.apiMethod) throw new Error('callApi needs "apiMethod"')
        console.log('  callApi → ' + step.apiMethod)
        const result = await miniProgram.callWxMethod(step.apiMethod, step.apiParams || [])
        console.log('  callApi result: ' + JSON.stringify(result))
        break
      }

      // ----- assert -----
      case 'assert': {
        if (!step.assertSelector) throw new Error('assert needs "assertSelector"')
        console.log('  assert → ' + step.assertSelector)

        // ====== Same workaround as tap: #Result_{id} is read directly via evaluate from page.data.results[id] ======
        const resultMatch = /^#Result_(.+)$/.exec(step.assertSelector)
        let text
        if (resultMatch) {
          const scenarioId = resultMatch[1]
          text = await miniProgram.evaluate(function(id) {
            var pages = getCurrentPages()
            var pg = pages[pages.length - 1]
            return (pg.data.results && pg.data.results[id]) || ''
          }, scenarioId)
        } else {
          const el = await waitForElement(page, step.assertSelector, step.timeout || 15000, 'assert')  // wait for and directly obtain the element
          text = await el.text()
        }
        console.log('  element text: "' + text + '"')
        if (step.assertText && !text.includes(step.assertText)) {
          console.warn('  ASSERT FAIL: expected "' + step.assertText + '", got "' + text + '"')
        } else {
          console.log('  ASSERT OK')
        }
        break
      }

      // ----- permission prompt operation -----
      case 'authorize': {
        const action = step.action || 'allow'
        console.log('  authorize → ' + action)
        const native = miniProgram.native()
        try {
          if (action === 'allow') await native.authorizeAllow()
          else if (action === 'deny') await native.authorizeCancel()
          else console.warn('  Unknown authorize action: ' + action)
          console.log('  authorize ' + action + ' done')
        } catch (e) {
          console.warn('  authorize ' + action + ' failed (the prompt may already be closed): ' + e.message)
        }
        await wait(300)  // wait for the prompt close animation
        break
      }

      // ----- Mock / restore wx APIs (to bypass system prompts that cannot be handled; DevTools only) -----
      case 'mockWx': {
        if (!step.method) throw new Error('mockWx needs "method"')
        const mockResult = step.result !== undefined ? step.result : { errMsg: step.method + ':fail mocked' }
        console.log('  mockWx: ' + step.method + ' → ' + JSON.stringify(mockResult))
        try {
          await miniProgram.mockWxMethod(step.method, mockResult)
          console.log('  mockWx: ' + step.method + ' mocked successfully')
        } catch (e) {
          console.warn('  mockWx: ' + step.method + ' mock failed (not supported on real devices): ' + e.message + '  — continuing')
        }
        break
      }
      case 'restoreWx': {
        if (!step.method) throw new Error('restoreWx needs "method"')
        console.log('  restoreWx: ' + step.method)
        try {
          await miniProgram.restoreWxMethod(step.method)
          console.log('  restoreWx: ' + step.method + ' restored successfully')
        } catch (e) {
          console.warn('  restoreWx: ' + step.method + ' restore failed (not supported on real devices): ' + e.message + '  — continuing')
        }
        break
      }

      // ----- unknown -----
      default:
        console.warn('  Unknown step type: ' + step.type + ' — skipped')
    }

    // auto-screenshot after each step (screenshot-type steps already take an explicit screenshot; skipped to avoid duplication)
    if (step.type !== 'screenshot') {
      const autoScreenshotPath = path.join(resultDir, stepId + '_auto.png')
      await saveScreenshot(miniProgram, autoScreenshotPath)
    }

    // auto-handle permission prompts (the background poller already does this; here it is an extra fallback at step boundaries)
    if (config.autoAuthorize) {
      try {
        const native = miniProgram.native()
        await native.authorizeAllow()
      } catch (_) {
        // no prompt, or the prompt is already closed; ignore normally
      }
    }

    // optional: additionally collect a WXML snapshot
    if (config.captureWxml) {
      await saveWxmlSnapshot(page,
        path.join(resultDir, stepId + '_wxml.txt'))
    }

  } catch (err) {
    console.error('  Step ' + stepId + ' ERROR: ' + err.message)
    // on error, take a screenshot to preserve the scene
    await saveScreenshot(miniProgram,
      path.join(resultDir, stepId + '_ERROR.png'))
    if (config.captureWxml) {
      try {
        await saveWxmlSnapshot(page,
          path.join(resultDir, stepId + '_ERROR_wxml.txt'))
      } catch (_) {}
    }
    throw err  // rethrow; the outer layer decides whether to continue
  } finally {
    // clean up the step-level exception listener, avoiding MaxListenersExceededWarning
    miniProgram.off('exception', onException)
  }

  return page
}

// ====== Core: log collection ======

function setupLogCollector(miniProgram) {
  const logEntries = []

  console.log('  [Setup] registering the log collector...')

  miniProgram.on('console', msg => {
    const entry = {
      time: new Date().toISOString(),
      type: msg.type || 'log',
      args: msg.args || [],
    }
    logEntries.push(entry)
    // output to the console in real time
    const prefix = '  [MiniProgram:' + entry.type + ']'
    console.log(prefix + ' ' + entry.args.join(' '))
  })

  // exception capture
  miniProgram.on('exception', err => {
    logEntries.push({
      time: new Date().toISOString(),
      type: 'exception',
      args: [err.message || JSON.stringify(err)],
    })
    console.error('  [MiniProgram:exception] ' + (err.message || JSON.stringify(err)))
    console.error('  [exception full object] ' + require('util').inspect(err, {depth: 5}))
  })

  // fallback: catch any connection-layer exception such as "unregistered event", avoiding an uncaught error aborting the whole test
  miniProgram.on('error', err => {
    console.error('  [MiniProgram:error] ' + (err && err.message ? err.message : require('util').inspect(err)))
  })

  return logEntries
}

// ====== Core: main execution flow ======

async function run(config, testPlan) {
  const runTimestamp = timestamp()
  const resultDir = path.join(config.resultPath, testPlan.name + '_' + runTimestamp)
  ensureDir(resultDir)

  console.log('\n========================================')
  console.log('test name: ' + testPlan.name)
  console.log('test description: ' + testPlan.description)
  console.log('result directory: ' + resultDir)
  console.log('========================================')

  // 1) connect (with automatic retries)
  const miniProgram = await connectWithRetry(config, config.maxRetries)

  // 1.5) start the background permission-prompt poller (solves the timing problem of prompts appearing asynchronously)
  //     three-layer strategy:
  //       ① authorizeAllow — effective for wx.authorize() prompts
  //       ② confirmModal   — effective for modal dialogs
  //       ③ SendKeys Enter — effective for native prompts triggered directly by APIs (Bluetooth / location, etc.)
  //          note: miniprogram-automator Native methods do not support API-triggered prompts; a keyboard fallback is needed
  let authPollingTimer = null
  let keyPollingTimer = null
  if (config.autoAuthorize) {
    let authPollCount = 0
    console.log('[AuthPoller] starting the background permission-prompt poll (Native 400ms / Key 2500ms)...')
    // strategy A: Native methods (fast response to wx.authorize prompts and modal dialogs)
    authPollingTimer = setInterval(async () => {
      try {
        authPollCount++
        const native = miniProgram.native()
        await native.authorizeAllow()
        await native.confirmModal()
      } catch (_) { /* silent when there is no prompt */ }
      if (authPollCount % 25 === 0) {
        console.log('  [AuthPoller] heartbeat #' + authPollCount + ' (Native polling)')
      }
    }, 400)

    // strategy B: keyboard Enter (fallback for native prompts triggered directly by APIs, which Native methods do not support)
    keyPollingTimer = setInterval(() => {
      try {
        // send the Enter key asynchronously, equivalent to clicking the prompt default button ("Allow")
        require('child_process').exec(
          'powershell -NoProfile -NonInteractive -Command "[System.Windows.Forms.SendKeys]::SendWait(\'{ENTER}\')"',
          { timeout: 3000, windowsHide: true },
          () => {} // silent; the result does not matter
        )
      } catch (_) { /* silent when there is no prompt or PowerShell is unavailable */ }
    }, 2500)
  }

  // 2) start log collection
  const logEntries = setupLogCollector(miniProgram)

  // 2.5) diagnostic: verify the logging system works (trigger console.log via evaluate)
  try {
    await miniProgram.evaluate(() => { console.log('[DIAG] Log system check') })
    await wait(1000)
    console.log('  [Setup] log diagnostic done, currently collected ' + logEntries.length + ' log entries')
  } catch (e) {
    console.warn('  [Setup] log diagnostic failed: ' + e.message)
  }

  let page = null

  try {
    // 3) preparation (non-fatal: a relaunch failure does not abort the overall flow)
    if (testPlan.preSteps && testPlan.preSteps.length > 0) {
      console.log('\n========== Preparation ==========')
      for (let i = 0; i < testPlan.preSteps.length; i++) {
        try {
          page = await executeStep(testPlan.preSteps[i], miniProgram, page, resultDir, 'PRE' + i, config)
        } catch (e) {
          console.warn('[PRE' + i + '] preparation step failed (non-fatal), continuing: ' + (e && e.message))
          // do not throw; continue with subsequent steps
        }
      }
    }

    // 4) navigate to the entry page (prefer currentPage to avoid an unnecessary reLaunch)
    console.log('\n========== Entering the test page ==========')
    const entryPage = testPlan.entryPage || 'pages/AutoTest/index'
    await wait(3000)  // wait for the IDE to load the page
    try {
      page = await miniProgram.currentPage()
      console.log('  current page: ' + (page && page.path || 'unknown'))
      if (!page || page.path !== entryPage) {
        console.log('  page does not match, executing reLaunch → ' + entryPage)
        page = await miniProgram.reLaunch(entryPage)
        await wait(3000)
      }
    } catch (e) {
      console.warn('  currentPage failed, trying reLaunch: ' + (e && e.message))
      page = await miniProgram.reLaunch(entryPage)
      await wait(3000)
    }

    // entry screenshot
    await saveScreenshot(miniProgram, path.join(resultDir, '00_entry.png'))

    // after the entry page loads, auto-handle permission prompts (the background poller also handles them)
    if (config.autoAuthorize) {
      try {
        await miniProgram.native().authorizeAllow()
        console.log('  [Setup] entry authorization prompt handled')
      } catch (_) {}
    }

    // pre-authorize Bluetooth (if auto-authorization is enabled):
    //   proactively trigger the standard authorization prompt via wx.authorize, then authorizeAllow clicks "Allow"
    //   so that a later openBluetoothAdapter no longer prompts (the permission is pre-authorized)
    if (config.autoAuthorize) {
      console.log('  [Setup] pre-authorizing Bluetooth...')
      try {
        // trigger the standard wx.authorize prompt
        await miniProgram.evaluate(() => {
          wx.authorize({ scope: 'scope.bluetooth',
            success: () => console.log('[AutoTest] Bluetooth pre-auth success'),
            fail: (e) => console.log('[AutoTest] Bluetooth pre-auth fail:', JSON.stringify(e))
          })
        })
        await wait(800) // wait for the prompt to appear
        // try clicking "Allow"
        const native = miniProgram.native()
        await native.authorizeAllow()
        await native.confirmModal()
        await wait(500)
        console.log('  [Setup] Bluetooth pre-authorization done')
      } catch (e) {
        console.warn('  [Setup] Bluetooth pre-authorization exception: ' + e.message + ' (may already be authorized, or there is no prompt)')
      }
    }

    // 5) execute test steps (each step writes step_results.json + last_result.json in real time)
    console.log('\n========== Executing test steps ==========')
    const stepResults = []
    let failed = false
    for (let i = 0; i < testPlan.steps.length; i++) {
      const step = testPlan.steps[i]
      const stepId = step.id || ('S' + i)
      const stepStart = Date.now()
      try {
        page = await executeStep(step, miniProgram, page, resultDir, i, config)
        stepResults.push({
          id: stepId, name: step.name || step.type, type: step.type,
          status: 'ok', durationMs: Date.now() - stepStart,
        })
      } catch (stepErr) {
        stepResults.push({
          id: stepId, name: step.name || step.type, type: step.type,
          status: 'error', durationMs: Date.now() - stepStart,
          error: stepErr.message,
        })
        console.error('Step failed, stopping execution: ' + stepErr.message)
        failed = true
        break
      }
      // write in real time after each step (external tools can read progress at any time)
      const stepFilePath = path.join(resultDir, 'step_results.json')
      fs.writeFileSync(stepFilePath, JSON.stringify(stepResults, null, 2), 'utf-8')
      writeLastResult(config, {
        testName: testPlan.name, platform: config.platform,
        timestamp: runTimestamp, resultDir: resultDir,
        status: 'RUNNING',
        currentStep: stepId, stepIndex: i + 1, totalSteps: testPlan.steps.length,
        stepResults: stepResults,
        logCount: logEntries.length,
      })
    }

    // 6) final page screenshot
    await saveScreenshot(miniProgram, path.join(resultDir, '99_final.png'))

    // 7) save logs
    console.log('\n========== Saving results ==========')
    const logFilePath = path.join(resultDir, 'console.log')
    const logContent = logEntries.map(e =>
      '[' + e.time + '][' + e.type + '] ' + e.args.join(' ')
    ).join('\n')
    fs.writeFileSync(logFilePath, logContent, 'utf-8')
    console.log('Log saved: ' + logFilePath + ' (' + logEntries.length + ' entries)')

    // 8) extract the verdict
    const verdicts = extractVerdict(logEntries)
    const keyLogs = logEntries
      .filter(e => e.type === 'log')
      .map(e => e.args.join(' '))
      .filter(line => line.includes('[VF-') || line.includes('漏洞') || line.includes('vulnerability') || line.includes('undecidable') || line.includes('authSetting') || line.includes('startBeaconDiscovery'))
      .slice(-15)

    // 9) save the test summary
    const summary = {
      testName: testPlan.name,
      description: testPlan.description,
      platform: config.platform,
      timestamp: runTimestamp,
      totalSteps: testPlan.steps.length,
      status: failed ? 'FAILED' : 'PASSED',
      logEntriesCount: logEntries.length,
      resultDir: resultDir,
      stepResults: stepResults,
      verdict: verdicts.vf1Verdict || verdicts.vf2Verdict || null,
      keyLogs: keyLogs,
    }
    fs.writeFileSync(
      path.join(resultDir, 'summary.json'),
      JSON.stringify(summary, null, 2),
      'utf-8'
    )

    // 10) write the final last_result.json
    writeLastResult(config, {
      testName: testPlan.name, description: testPlan.description,
      platform: config.platform, timestamp: runTimestamp, resultDir: resultDir,
      status: summary.status,
      totalSteps: testPlan.steps.length, logEntriesCount: logEntries.length,
      stepResults: stepResults,
      verdict: summary.verdict,
      keyLogs: keyLogs,
      screenshots: collectScreenshots(resultDir),
    })

    console.log('\n========================================')
    console.log('test completed: ' + summary.status)
    console.log('result directory: ' + resultDir)
    console.log('========================================')

  } finally {
    // 8.5) stop the background permission poll
    if (authPollingTimer) { clearInterval(authPollingTimer); console.log('[AuthPoller] Native stopped') }
    if (keyPollingTimer) { clearInterval(keyPollingTimer); console.log('[AuthPoller] Key stopped') }

    // 9) cleanup
    if (testPlan.cleanupSteps && testPlan.cleanupSteps.length > 0) {
      console.log('\n========== Cleanup ==========')
      for (let i = 0; i < testPlan.cleanupSteps.length; i++) {
        try {
          page = await executeStep(testPlan.cleanupSteps[i], miniProgram, page, resultDir, 'CLEAN' + i, config)
        } catch (e) {
          console.error('[CLEAN' + i + ' ERROR]', e && e.message, '\n', e && e.stack)
        }
      }
    }

    await miniProgram.disconnect()
    console.log('Disconnected.')
  }
}

// ====== Helper: wait ======

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * self-polling lookup that returns the element (replacing miniprogram-automator page.waitFor, whose polling does not terminate in some cases).
 *
 * the implementation follows the Element API usage recommended in the official docs:
 *   https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/element.html#element-tap
 *   const element = await page.$(selector)
 *   await element.tap()
 * that is, use page.$(selector) to obtain a single Element reference directly, and once found return that element for the caller to operate on
 * (tap / input / scroll / text, etc.), avoiding the duplicate query of "first $$ to check existence, then $ to fetch the element".
 *
 * it retries page.$(selector) every 300ms until a non-empty element is obtained or the overall timeout is reached.
 */
async function waitForElement(page, selector, timeoutMs, label) {
  const start = Date.now()
  const log = label || 'waitFor'
  const perAttemptTimeout = Math.min(5000, timeoutMs)
  while (Date.now() - start < timeoutMs) {
    try {
      // the page.$() RPC call itself has a very small chance of "hanging" without resolving or rejecting
      // (commonly when the page reference becomes unstable due to earlier mockWx / evaluate operations),
      // without a per-attempt timeout, the outer while loop Date.now() time check never gets a chance to run again,
      // so the whole function hangs indefinitely and the declared timeoutMs becomes completely ineffective.
      // use Promise.race to back each attempt individually; after a timeout, continue retrying in the next while iteration.
      const element = await Promise.race([
        page.$(selector),
        new Promise((_, reject) => setTimeout(() => reject(new Error('single-query timeout')), perAttemptTimeout)),
      ])
      if (element) {
        // found; return the element reference directly so the caller can immediately call element.tap()/input()/text(), etc.
        return element
      }
    } catch (_) { /* not found, connection temporarily dropped, or single-query timeout; keep retrying */ }
    await wait(300)
  }

  // timeout diagnostics
  const path = page.path || 'unknown'
  console.error('  [debug] timeout: page=' + path + ', selector=' + selector + ', timeoutMs=' + timeoutMs)
  try {
    // list top-level elements to check whether the page rendered normally
    // this also carries an RPC hang risk and needs timeout protection, otherwise it would hang again during the "timeout diagnostics" stage itself,
    // making the outer waitForElement never return (even if the main query loop already exited correctly on timeout).
    const topLevel = await Promise.race([
      page.$$('view, button, text, navigator, image, block'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('diagnostic query timeout')), 5000)),
    ])
    console.error('  [debug] page top-level elements (view/button/text, etc.): ' + (topLevel ? topLevel.length : 0) + ' total')
    if (topLevel && topLevel.length > 0 && topLevel.length <= 50) {
      for (let i = 0; i < topLevel.length && i < 10; i++) {
        try {
          const tag = (await Promise.race([topLevel[i].tagName(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))])) || '?'
          const id = (await Promise.race([topLevel[i].attribute('id'), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))])) || ''
          const cls = (await Promise.race([topLevel[i].attribute('class'), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))])) || ''
          console.error('  [debug]   [' + i + '] <' + tag + (id ? ' id="' + id + '"' : '') + (cls ? ' class="' + cls + '"' : '') + '>')
        } catch (_) {}
      }
    }
  } catch (_) {}

  throw new Error('' + log + 'timed out waiting for element: ' + selector + ' (' + timeoutMs + 'ms)')
}

// ====== Result extraction and report generation ======

/**
 * write structured test results to a fixed location for external tools to read and analyze in real time.
 * called after every step, ensuring data is not lost even if the test is interrupted.
 */
function writeLastResult(config, payload) {
  const filePath = path.join(config.resultPath, 'last_result.json')
  try {
    fs.writeFileSync(filePath, JSON.stringify({
      updatedAt: new Date().toISOString(),
      ...payload,
    }, null, 2), 'utf-8')
  } catch (e) {
    console.warn('  [Result] failed to write last_result.json: ' + e.message)
  }
}

/**
 * in batch scenarios, accumulate the progress of all plans into batch_progress.json (without overwriting and losing history).
 * in batching, last_result.json is overwritten repeatedly by each plan/step and reflects only "the latest step",
 * so the progress of already-finished plans cannot be reviewed; this function accumulates each plan latest status into the same
 * array file, deduplicating and updating by (testName, timestamp), guaranteeing that at any moment in the batch any plan's
 * progress can be looked up from this single file and is not lost as later plans continue executing.
 */
function updateBatchProgress(batchProgress, config, planEntry) {
  if (!batchProgress) return
  try {
    const idx = batchProgress.findIndex(p => p.testName === planEntry.testName && p.timestamp === planEntry.timestamp)
    const merged = { ...(idx >= 0 ? batchProgress[idx] : {}), ...planEntry, updatedAt: new Date().toISOString() }
    if (idx >= 0) batchProgress[idx] = merged
    else batchProgress.push(merged)
    fs.writeFileSync(
      path.join(config.resultPath, 'batch_progress.json'),
      JSON.stringify(batchProgress, null, 2),
      'utf-8'
    )
  } catch (e) {
    console.warn('  [BatchProgress] failed to write batch_progress.json: ' + e.message)
  }
}

/** Extract VF-1/VF-2 verdict text from log entries */
function extractVerdict(logEntries) {
  const lines = logEntries
    .filter(e => e.type === 'log')
    .map(e => e.args.join(' '))
    .join('\n')

  // VF-N verdict line format: [VF-N] <symbol> <verdict text>
  // possible verdict text: "vulnerability exists", "vulnerability does not exist", "undecidable"
  const vf1Match = lines.match(/\[VF-1\][^\n]*?(√|×|！)\s*((?:漏洞|无法判定|vulnerability|undecidable)[^\n]*)/)
  const vf2Match = lines.match(/\[VF-2\][^\n]*?(√|×|！)\s*((?:漏洞|无法判定|vulnerability|undecidable)[^\n]*)/)

  return {
    vf1Verdict: vf1Match ? vf1Match[1] + ' ' + vf1Match[2] : null,
    vf2Verdict: vf2Match ? vf2Match[1] + ' ' + vf2Match[2] : null,
  }
}

/** Generate the batch aggregate Markdown report */
function generateReport(batchResults, config) {
  const reportPath = path.join(config.resultPath, 'batch_report_' + timestamp() + '.md')
  const lines = []

  lines.push('# Automated Test Batch Report')
  lines.push('')
  lines.push('**Executed at**: ' + new Date().toISOString())
  lines.push('**Platform**: ' + config.platform)
  lines.push('**Total**: ' + batchResults.length + ' test plans')
  lines.push('')

  // summary table
  lines.push('## Summary')
  lines.push('')
  lines.push('| # | Test plan | Status | Verdict | Result directory |')
  lines.push('|---|----------|------|------|----------|')
  for (let i = 0; i < batchResults.length; i++) {
    const r = batchResults[i]
    const statusIcon = r.status === 'PASSED' ? '√' : '×'
    lines.push('| ' + (i + 1) + ' | ' + r.name + ' | ' + statusIcon + ' ' + r.status + ' | ' + (r.verdict || 'N/A') + ' | ' + r.resultDir + ' |')
  }
  lines.push('')

  // detailed results
  for (let i = 0; i < batchResults.length; i++) {
    const r = batchResults[i]
    lines.push('---')
    lines.push('')
    lines.push('## ' + (i + 1) + '. ' + r.name)
    lines.push('')
    lines.push('- **Status**: ' + r.status)
    lines.push('- **Result directory**: `' + r.resultDir + '`')
    if (r.verdict) lines.push('- **Verdict**: ' + r.verdict)
    if (r.error) lines.push('- **Error**: ' + r.error)
    lines.push('')
    lines.push('### Key logs')
    lines.push('```')
    if (r.keyLogs && r.keyLogs.length > 0) {
      lines.push(r.keyLogs.slice(-10).join('\n'))
    } else {
      lines.push('(no logs)')
    }
    lines.push('```')
    lines.push('')
    lines.push('### Screenshots')
    if (r.screenshots && r.screenshots.length > 0) {
      for (const ss of r.screenshots) {
        lines.push('- ' + path.basename(ss))
      }
    } else {
      lines.push('(no screenshots)')
    }
    lines.push('')
  }

  fs.writeFileSync(reportPath, lines.join('\n'), 'utf-8')
  console.log('\n' + '='.repeat(50))
  console.log('batch aggregate report generated: ' + reportPath)
  console.log('='.repeat(50))

  return reportPath
}

/** Collect the screenshot file list from the result directory */
function collectScreenshots(resultDir) {
  try {
    return fs.readdirSync(resultDir)
      .filter(f => f.endsWith('.png'))
      .map(f => path.join(resultDir, f))
  } catch (_) { return [] }
}

// ====== Entry point ======

async function main() {
  const config = parseArgs(process.argv.slice(2))

  // batch mode: testPlanPath supports comma-separated multiple files
  if (config.batch && config.testPlanPath && config.testPlanPath.includes(',')) {
    const planPaths = config.testPlanPath.split(',').map(p => p.trim()).filter(Boolean)
    console.log('\n═══════════════════════════════════')
    console.log('  batch mode: ' + planPaths.length + ' test plans')
    console.log('═══════════════════════════════════')
    for (let i = 0; i < planPaths.length; i++) {
      console.log('  [' + (i + 1) + '] ' + planPaths[i])
    }
    console.log('')
  }

  try {
    // batch mode
    if (config.batch && config.testPlanPath && config.testPlanPath.includes(',')) {
      const planPaths = config.testPlanPath.split(',').map(p => p.trim()).filter(Boolean)
      const batchResults = []
      const batchProgress = []  // cumulative record: progress of all plans/steps across the whole batch, preventing last_result.json from being overwritten per plan and becoming unreviewable

      // batch mode: whether DevTools or RealDevice, establish one single connection that all plans reuse in turn,
      // disconnecting uniformly only after everything finishes, avoiding each testPlan repeating "launch IDE → clear cache → recompile → connect → disconnect",
      // significantly improving batch efficiency and stability (no per-plan reconnect under DevTools; no repeated QR scan under RealDevice).
      const platformLabel = config.platform === 'RealDevice' ? 'RealDevice' : 'DevTools'
      console.log('\n[' + platformLabel + '] establishing a shared connection (' + planPaths.length + ' test plans will reuse the same connection in turn, no per-plan reconnect)...')
      const sharedMiniProgram = await connectWithRetry(config, config.maxRetries)
      console.log('[' + platformLabel + '] shared connection established')

      // a shared connection corresponds to one shared, continuously growing log collector (across all plans), avoiding repeated registration of console listeners
      const sharedLogEntries = setupLogCollector(sharedMiniProgram)
      try {
        await sharedMiniProgram.evaluate(() => { console.log('[DIAG] Log system check') })
        await wait(1000)
        console.log('  [Setup] log diagnostic done, currently collected ' + sharedLogEntries.length + ' log entries')
      } catch (e) {
        console.warn('  [Setup] log diagnostic failed: ' + e.message)
      }

      try {
        for (let i = 0; i < planPaths.length; i++) {
          const planPath = planPaths[i]
          if (!fs.existsSync(planPath)) {
            console.warn('！  skipping a nonexistent testPlan: ' + planPath)
            batchResults.push({ name: path.basename(planPath), status: 'SKIPPED', error: 'file does not exist: ' + planPath, resultDir: '', verdict: null, keyLogs: [], screenshots: [] })
            continue
          }

          // create an independent config for each plan (keeping its own plan path)
          const planConfig = { ...config, testPlanPath: planPath }
          const testPlan = loadTestPlan(planConfig)

          try {
            // sharing the same connection: cache clearing takes effect only once at the initial connection before the batch starts; later plans do not clear again
            planConfig.clearAuth = false

            console.log('\n' + '█'.repeat(50))
            console.log('█ batch [' + (i + 1) + '/' + planPaths.length + ']: ' + testPlan.name)
            console.log('█'.repeat(50))

            // pass in the shared connection and shared log collector, skipping repeated connect / scan / disconnect
            const { resultDir, status, summary } = await runWithResult(planConfig, testPlan, sharedMiniProgram, batchProgress, sharedLogEntries)

            batchResults.push({
              name: testPlan.name,
              status: status,
              resultDir: resultDir,
              verdict: summary.verdict || 'see logs',
              error: status === 'FAILED' ? 'test step execution failed' : null,
              keyLogs: summary.keyLogs || [],
              screenshots: collectScreenshots(resultDir),
            })
          } catch (planErr) {
            console.error('\n× fatal error executing the test plan: ' + planErr.message)
            batchResults.push({
              name: testPlan.name,
              status: 'FATAL',
              resultDir: '',
              verdict: null,
              error: planErr.message,
              keyLogs: [],
              screenshots: [],
            })
            if (config.bail) {
              console.log('--bail is set, stopping subsequent test plans')
              break
            }
          }
        }
      } finally {
        // after all plans finish, disconnect the shared connection uniformly
        console.log('\n[' + platformLabel + '] all plans finished, disconnecting the shared connection...')
        try { await sharedMiniProgram.disconnect() } catch (_) {}
        console.log('[' + platformLabel + '] shared connection disconnected')
      }

      // generate the aggregate report
      if (config.report) {
        generateReport(batchResults, config)
      }

      // overall status
      const passedCount = batchResults.filter(r => r.status === 'PASSED').length
      const totalCount = batchResults.length
      console.log('\n' + '█'.repeat(50))
      console.log('█ batch complete: ' + passedCount + '/' + totalCount + ' passed')
      console.log('█'.repeat(50))

      process.exit(passedCount === totalCount ? 0 : 1)

    } else {
      // single-execution mode
      const testPlan = loadTestPlan(config)
      await run(config, testPlan)
      process.exit(0)
    }
  } catch (err) {
    console.error('\nFATAL ERROR: ' + err.message)
    console.error(err.stack)
    process.exit(1)
  }
}

/** A variant of run() that returns a structured result rather than only logs */
async function runWithResult(config, testPlan, existingMiniProgram = null, batchProgress = null, sharedLogEntries = null) {
  const runTimestamp = timestamp()
  const resultDir = path.join(config.resultPath, testPlan.name + '_' + runTimestamp)
  ensureDir(resultDir)

  console.log('\n========================================')
  console.log('test name: ' + testPlan.name)
  console.log('test description: ' + testPlan.description)
  console.log('result directory: ' + resultDir)
  console.log('========================================')

  // reuse an existing connection (batch mode; works for both DevTools and RealDevice), avoiding repeated connect / repeated QR scan
  const shouldConnect = !existingMiniProgram
  const miniProgram = existingMiniProgram || await connectWithRetry(config, config.maxRetries)

  let authPollingTimer = null
  let keyPollingTimer = null
  if (config.autoAuthorize) {
    let authPollCount = 0
    console.log('[AuthPoller] starting the background permission-prompt poll (Native 400ms / Key 2500ms)...')
    authPollingTimer = setInterval(async () => {
      try {
        authPollCount++
        const native = miniProgram.native()
        await native.authorizeAllow()
        await native.confirmModal()
      } catch (_) {}
      if (authPollCount % 25 === 0) {
        console.log('  [AuthPoller] heartbeat #' + authPollCount + ' (Native polling)')
      }
    }, 400)
    keyPollingTimer = setInterval(() => {
      try {
        require('child_process').exec(
          'powershell -NoProfile -NonInteractive -Command "[System.Windows.Forms.SendKeys]::SendWait(\'{ENTER}\')"',
          { timeout: 3000, windowsHide: true },
          () => {}
        )
      } catch (_) {}
    }, 2500)
  }

  // log collection: in batch scenarios, reuse the same continuously growing shared log array (sharedLogEntries), avoiding each plan
  // repeatedly calling setupLogCollector() to register new console listeners (otherwise listeners pile up and logs are double-counted).
  // logStartIndex records the shared array length before this plan starts; at the end it is used to slice out the log segment "belonging only to this plan".
  const logStartIndex = sharedLogEntries ? sharedLogEntries.length : 0
  const logEntries = sharedLogEntries || (shouldConnect ? setupLogCollector(miniProgram) : [])
  if (shouldConnect) {
    try {
      await miniProgram.evaluate(() => { console.log('[DIAG] Log system check') })
      await wait(1000)
      console.log('  [Setup] log diagnostic done, currently collected ' + logEntries.length + ' log entries')
    } catch (e) {
      console.warn('  [Setup] log diagnostic failed: ' + e.message)
    }
  }

  let page = null
  let status = 'PASSED'
  const stepResults = []
  // hoisted to the outer scope: the original implementation declared it with const inside the try {} block,
  // but the return statement below references it after try/finally ends, which is outside the const block scope,
  // so whether the test succeeds or fails, reaching the return statement always throws a ReferenceError (always reproducible in batch mode).
  let summary = null

  try {
    if (testPlan.preSteps && testPlan.preSteps.length > 0) {
      console.log('\n========== Preparation ==========')
      for (let i = 0; i < testPlan.preSteps.length; i++) {
        try {
          page = await executeStep(testPlan.preSteps[i], miniProgram, page, resultDir, 'PRE' + i, config)
        } catch (e) {
          console.warn('[PRE' + i + '] preparation step failed (non-fatal), continuing: ' + (e && e.message))
        }
      }
    }

    console.log('\n========== Entering the test page ==========')
    const entryPage = testPlan.entryPage || 'pages/AutoTest/index'
    await wait(3000)
    try {
      page = await miniProgram.currentPage()
      console.log('  current page: ' + (page && page.path || 'unknown'))
      if (!page || page.path !== entryPage) {
        console.log('  page does not match, executing reLaunch → ' + entryPage)
        page = await miniProgram.reLaunch(entryPage)
        await wait(3000)
      }
    } catch (e) {
      console.warn('  currentPage failed, trying reLaunch: ' + (e && e.message))
      page = await miniProgram.reLaunch(entryPage)
      await wait(3000)
    }

    await saveScreenshot(miniProgram, path.join(resultDir, '00_entry.png'))

    if (config.autoAuthorize) {
      try { await miniProgram.native().authorizeAllow(); console.log('  [Setup] entry authorization prompt handled') } catch (_) {}
    }

    if (config.autoAuthorize) {
      console.log('  [Setup] pre-authorizing Bluetooth...')
      try {
        await miniProgram.evaluate(() => {
          wx.authorize({ scope: 'scope.bluetooth',
            success: () => console.log('[AutoTest] Bluetooth pre-auth success'),
            fail: (e) => console.log('[AutoTest] Bluetooth pre-auth fail:', JSON.stringify(e))
          })
        })
        await wait(800)
        const native = miniProgram.native()
        await native.authorizeAllow()
        await native.confirmModal()
        await wait(500)
        console.log('  [Setup] Bluetooth pre-authorization done')
      } catch (e) {
        console.warn('  [Setup] Bluetooth pre-authorization exception: ' + e.message + ' (may already be authorized, or there is no prompt)')
      }
    }

    // 5) execute test steps (each step writes step_results.json + last_result.json in real time)
    console.log('\n========== Executing test steps ==========')
    for (let i = 0; i < testPlan.steps.length; i++) {
      const step = testPlan.steps[i]
      const stepId = step.id || ('S' + i)
      const stepStart = Date.now()
      try {
        page = await executeStep(step, miniProgram, page, resultDir, i, config)
        stepResults.push({
          id: stepId, name: step.name || step.type, type: step.type,
          status: 'ok', durationMs: Date.now() - stepStart,
        })
      } catch (stepErr) {
        stepResults.push({
          id: stepId, name: step.name || step.type, type: step.type,
          status: 'error', durationMs: Date.now() - stepStart,
          error: stepErr.message,
        })
        console.error('Step failed, stopping execution: ' + stepErr.message)
        status = 'FAILED'
        break
      }
      // write in real time after each step (external tools can read progress at any time)
      const stepFilePath = path.join(resultDir, 'step_results.json')
      fs.writeFileSync(stepFilePath, JSON.stringify(stepResults, null, 2), 'utf-8')
      const planLogCountSoFar = sharedLogEntries ? (sharedLogEntries.length - logStartIndex) : logEntries.length
      writeLastResult(config, {
        testName: testPlan.name, platform: config.platform,
        timestamp: runTimestamp, resultDir: resultDir,
        status: 'RUNNING',
        currentStep: stepId, stepIndex: i + 1, totalSteps: testPlan.steps.length,
        stepResults: stepResults,
        logCount: planLogCountSoFar,
      })
      // batch-level cumulative progress: even if later plans keep overwriting last_result.json, this plan/step record
      // is still fully retained in batch_progress.json and is not lost
      updateBatchProgress(batchProgress, config, {
        testName: testPlan.name, timestamp: runTimestamp, resultDir: resultDir,
        status: 'RUNNING',
        currentStep: stepId, stepIndex: i + 1, totalSteps: testPlan.steps.length,
        stepResults: stepResults.slice(),
      })
    }

    await saveScreenshot(miniProgram, path.join(resultDir, '99_final.png'))

    console.log('\n========== Saving results ==========')
    // in batch scenarios, logEntries is a shared array growing across all plans, so it must be sliced by logStartIndex
    // into the log segment "belonging only to this plan", avoiding other plans logs mixing into this plan console.log / summary
    const planLogEntries = sharedLogEntries ? sharedLogEntries.slice(logStartIndex) : logEntries
    const logFilePath = path.join(resultDir, 'console.log')
    const logContent = planLogEntries.map(e =>
      '[' + e.time + '][' + e.type + '] ' + e.args.join(' ')
    ).join('\n')
    fs.writeFileSync(logFilePath, logContent, 'utf-8')
    console.log('Log saved: ' + logFilePath + ' (' + planLogEntries.length + ' entries)')

    // extract the verdict
    const verdicts = extractVerdict(planLogEntries)
    const keyLogs = planLogEntries
      .filter(e => e.type === 'log')
      .map(e => e.args.join(' '))
      .filter(line => line.includes('[VF-') || line.includes('漏洞') || line.includes('vulnerability') || line.includes('undecidable') || line.includes('authSetting') || line.includes('startBeaconDiscovery'))
      .slice(-15)

    // save the test summary
    summary = {
      testName: testPlan.name,
      description: testPlan.description,
      platform: config.platform,
      timestamp: runTimestamp,
      totalSteps: testPlan.steps.length,
      status: status,
      logEntriesCount: planLogEntries.length,
      resultDir: resultDir,
      stepResults: stepResults,
      verdict: verdicts.vf1Verdict || verdicts.vf2Verdict || null,
      keyLogs: keyLogs,
    }
    fs.writeFileSync(path.join(resultDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf-8')

    // write the final last_result.json
    writeLastResult(config, {
      testName: testPlan.name, description: testPlan.description,
      platform: config.platform, timestamp: runTimestamp, resultDir: resultDir,
      status: summary.status,
      totalSteps: testPlan.steps.length, logEntriesCount: planLogEntries.length,
      stepResults: stepResults,
      verdict: summary.verdict,
      keyLogs: keyLogs,
      screenshots: collectScreenshots(resultDir),
    })
    // batch-level cumulative progress: this plan final status (PASSED/FAILED + verdict) also lands in batch_progress.json
    updateBatchProgress(batchProgress, config, {
      testName: testPlan.name, timestamp: runTimestamp, resultDir: resultDir,
      status: summary.status,
      stepResults: stepResults.slice(),
      verdict: summary.verdict,
    })

    console.log('\n========================================')
    console.log('test completed: ' + summary.status)
    console.log('result directory: ' + resultDir)
    console.log('========================================')

  } finally {
    if (authPollingTimer) { clearInterval(authPollingTimer); console.log('[AuthPoller] Native stopped') }
    if (keyPollingTimer) { clearInterval(keyPollingTimer); console.log('[AuthPoller] Key stopped') }

    if (testPlan.cleanupSteps && testPlan.cleanupSteps.length > 0) {
      console.log('\n========== Cleanup ==========')
      for (let i = 0; i < testPlan.cleanupSteps.length; i++) {
        try {
          page = await executeStep(testPlan.cleanupSteps[i], miniProgram, page, resultDir, 'CLEAN' + i, config)
        } catch (e) {
          console.error('[CLEAN' + i + ' ERROR]', e && e.message)
        }
      }
    }
    // only connections this function established itself are disconnected; reused connections are managed by the host (batch loop)
    if (shouldConnect) {
      await miniProgram.disconnect()
      console.log('Disconnected.')
    }
  }

  return { logEntries: (sharedLogEntries ? sharedLogEntries.slice(logStartIndex) : logEntries), resultDir, status, stepResults, summary }
}

// ====== Global fallback: send any silently swallowed event / exception to the log file ======
const _debugLogPath = path.join(__dirname, '_debug_uncaught.log')
function _logUncaught(tag, info) {
  try {
    const line = '[' + new Date().toISOString() + '][' + tag + '] ' + info + '\n'
    fs.appendFileSync(_debugLogPath, line)
  } catch (_) {}
}
process.on('uncaughtException', (err) => {
  _logUncaught('uncaughtException', (err && err.message) + '\n' + (err && err.stack))
})
process.on('unhandledRejection', (reason) => {
  _logUncaught('unhandledRejection', (reason && reason.message) + '\n' + (reason && reason.stack))
})

main()
