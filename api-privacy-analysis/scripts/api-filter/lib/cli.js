'use strict';
// Common CLI argument parsing and I/O utilities, shared by doc-filter.js / code-filter.js / cross-validate.js.
// No third-party dependencies; implemented purely with Node.js built-in modules.

const fs = require('fs');

/**
 * Parses an argument list of the form `--key value --flag --k2 v2`.
 * Values are strings; to pass JSON, use it together with jsonArg() / resolveJsonInput().
 */
function parseArgs(argv) {
  const args = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { args, positional };
}

function jsonArg(v, fallback) {
  if (v === undefined) return fallback;
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch (e) {
    return v;
  }
}

/**
 * Unified JSON input resolution: prefer reading `--<key>File <path>` (large payloads should go through a file, avoiding shell escaping problems),
 * otherwise read `--<key> '<json string>'`; if neither is present, return the fallback.
 */
function resolveJsonInput(args, key, fallback) {
  const fileKey = key + 'File';
  if (args[fileKey]) {
    const txt = fs.readFileSync(args[fileKey], 'utf8');
    return JSON.parse(txt);
  }
  if (args[key] !== undefined) {
    return jsonArg(args[key], fallback);
  }
  return fallback;
}

function printResult(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function fail(msg) {
  process.stderr.write('[error] ' + msg + '\n');
  process.exit(1);
}

function requireArg(args, key) {
  if (args[key] === undefined) {
    fail('missing required parameter --' + key);
  }
  return args[key];
}

/**
 * Unified command dispatch and error handling entry. Errors thrown by business code (permission validation inside the Registry, etc.)
 * are caught here and converted into the canonical `[error] ...` output plus a non-zero exit code, rather than exposing the raw stack:
 * callers (usually the analysis flow driving this tool) should always judge success or failure by the exit code, not by the stack format.
 */
function runCli(commands, argv) {
  const [command, ...rest] = argv;
  const fn = commands[command];
  if (!fn) {
    fail('unknown command "' + command + '", available commands: ' + Object.keys(commands).join(', '));
    return;
  }
  const { args } = parseArgs(rest);
  try {
    fn(args);
  } catch (e) {
    fail(e && e.message ? e.message : String(e));
  }
}

module.exports = {
  parseArgs,
  jsonArg,
  resolveJsonInput,
  printResult,
  fail,
  requireArg,
  runCli,
};
