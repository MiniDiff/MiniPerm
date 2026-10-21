#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
alipay_autotest.py -- Alipay mini-program auto test driver (pyautogui based)

Why this script exists
-----------------------
Alipay has no official runtime automation SDK (no equivalent of
miniprogram-automator), and the Alipay DevTools exposes no automation port.
Therefore the WeChat path (auto.js + miniprogram-automator) is unavailable on
Alipay; the only option is GUI automation: copy the generated case code into
the real project, let the IDE recompile, then drive the IDE and simulator
with pyautogui clicks, and finally harvest the rendered AXML and console log
via the clipboard.

Per-case execution flow
------------------------
    1. overwrite the project page files with index.axml / index.js / index.acss
    2. click "compile" in the IDE and wait for the rebuild
    3. (optional) click the scenario button(s) inside the simulator
    4. harvest the rendered AXML: Inspector -> right-click page -> Copy -> Copy outerHTML
    5. harvest the console: Console panel -> click -> Ctrl+A / Ctrl+C
    6. clear the console so the next case starts from a clean state

Results are written to <result-path>/<case>/<platform>/<conf>/{index.html, log.txt},
matching the directory layout produced by the WeChat path, so the existing
Analyzer can be reused as-is.

Coordinates
-----------
pyautogui uses absolute screen coordinates; every click target depends on the
window layout and the display scaling factor. Run --calibrate first, then use
--save-coords to persist the result. Do not reuse the built-in default
coordinates on a different machine.
"""

import argparse
import json
import os
import shutil
import sys
import time

# ---- default coordinates ---------------------------------------------------
# The coordinates below came from a 1920x1080 monitor + Alipay DevTools
# maximized + simulator docked on the left. They are only a starting point,
# not a guaranteed value.
DEFAULT_COORDS = {
    "compile": [260, 105],          # IDE toolbar: compile / build
    "inspector_panel": [690, 135],  # bottom panel: Inspector / Elements tab
    "page_node": [690, 165],        # root <page> node in the inspector tree
    "copy_menu": [750, 235],        # deprecated: AXML harvesting now uses keyboard navigation; kept only for config-file backward compatibility
    "copy_outer": [930, 235],       # deprecated: same as above
    "console_panel": [770, 135],    # bottom panel: Console tab
    "log_last_line": [770, 190],    # console output area (click to gain focus)
    "clear_log": [641, 167],        # console toolbar: clear
    # Targets inside the simulator. Need calibration, depend on where the simulator is docked.
    "scenario_button": [0, 0],      # the single "start test" button (set to 0,0 to skip)
    "run_all_button": [0, 0],       # the "run all scenarios" button (set to 0,0 to skip)
}

SKIP = (0, 0)


class UIAutomator:
    """A thin pyautogui wrapper that resolves click targets by logical name."""

    def __init__(self, coords, pause=1.0, dry_run=False):
        self.coords = coords
        self.dry_run = dry_run
        if not dry_run:
            import pyautogui
            pyautogui.FAILSAFE = True
            pyautogui.PAUSE = pause
            self.pg = pyautogui
        else:
            self.pg = None

    def _xy(self, name):
        v = self.coords.get(name)
        if not v or len(v) != 2:
            raise KeyError("coordinate %r is not configured" % name)
        return int(v[0]), int(v[1])

    def click(self, name, clicks=1, button="left"):
        x, y = self._xy(name)
        if (x, y) == SKIP:
            print("  skipping %s (not configured)" % name)
            return False
        if self.dry_run:
            print("  [dry-run] click %s at (%d, %d)" % (name, x, y))
            return True
        self.pg.click(x=x, y=y, clicks=clicks, button=button)
        print("  click %s (%d, %d)" % (name, x, y))
        return True

    def hover(self, name, duration=0.3):
        """Move the mouse to the target without clicking. Used to try expanding
        an Electron context-menu submenu -- the submenu only expands on a real
        mouseenter event, and an instant click usually can't trigger it, so a
        moveTo with a non-zero duration is needed for reliability."""
        x, y = self._xy(name)
        if (x, y) == SKIP:
            print("  skipping %s (not configured)" % name)
            return False
        if self.dry_run:
            print("  [dry-run] hover %s at (%d, %d)" % (name, x, y))
            return True
        self.pg.moveTo(x=x, y=y, duration=duration)
        print("  hover %s (%d, %d)" % (name, x, y))
        return True

    def hotkey(self, *keys):
        if self.dry_run:
            print("  [dry-run] hotkey %s" % "+".join(keys))
            return
        self.pg.hotkey(*keys)

    def press(self, key):
        if self.dry_run:
            print("  [dry-run] key press %s" % key)
            return
        self.pg.press(key)
        print("  key press %s" % key)


def read_clipboard():
    """Read clipboard text; return an empty string when unavailable or empty."""
    try:
        import tkinter as tk
        root = tk.Tk()
        root.withdraw()
        text = root.clipboard_get()
        root.destroy()
        return text
    except Exception:
        try:
            import pyperclip
            return pyperclip.paste()
        except Exception:
            return ""


def save_file(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


def copy_file(src, dst):
    if not os.path.isfile(src):
        return False
    shutil.copy2(src, dst)
    print("  copied %s -> %s" % (os.path.basename(src), dst))
    return True


class Runner:
    def __init__(self, ui, project_path, code_path, platform, conf,
                 compile_wait=8, run_wait=5, max_retry=3):
        self.ui = ui
        self.project_path = project_path
        self.code_path = code_path
        self.platform = platform
        self.conf = conf
        self.compile_wait = compile_wait
        self.run_wait = run_wait
        self.max_retry = max_retry

    def compile_project(self):
        self.ui.click("compile")
        time.sleep(self.compile_wait)

    def trigger_scenarios(self):
        """Click inside the simulator. Both targets are optional."""
        self.ui.click("run_all_button")
        time.sleep(self.run_wait)
        self.ui.click("scenario_button")
        time.sleep(self.run_wait)

    def harvest_axml(self, out_path):
        self.ui.click("inspector_panel")
        time.sleep(1)
        self.ui.click("page_node", button="right")
        time.sleep(1)
        # Empirical conclusion: the "Copy" submenu only expands on a real hover
        # (mouseenter) event. pyautogui's moveTo/click could never trigger the
        # submenu expansion in this Electron app (the cursor genuinely reached
        # the target pixel, but the submenu simply would not appear -- verified
        # repeatedly; it is neither a coordinate offset nor a timing issue).
        # Switched to keyboard navigation, which avoids hover entirely:
        # once the context menu pops up, arrow keys visibly highlight each item;
        # Down three times reaches "Copy", Right expands the submenu (its first
        # item, "Copy outerAXML", is auto-highlighted), and Enter confirms.
        # This path does not depend on the copy_menu / copy_outer coordinates.
        self.ui.press("down")   # -> Add attribute
        time.sleep(0.3)
        self.ui.press("down")   # -> Edit as HTML
        time.sleep(0.3)
        self.ui.press("down")   # -> Copy
        time.sleep(0.3)
        self.ui.press("right")  # expand the submenu; "Copy outerAXML" auto-highlights
        time.sleep(0.8)
        self.ui.press("enter")  # confirm the copy
        time.sleep(1)
        text = read_clipboard()
        if not text.strip():
            print("  warning: clipboard is empty, AXML not harvested")
            return 0
        # Rough sanity check: real AXML/HTML content should contain angle
        # brackets; if what we got is the IDE's blank-editor hint text or a
        # stale clipboard value, the menu interaction landed in the wrong place.
        if '<' not in text or '>' not in text:
            print("  warning: clipboard content doesn't look like AXML (menu may not have popped as expected): %r" % text[:60])
            return 0
        save_file(out_path, text)
        return 1

    def harvest_log(self, out_path, clear=True):
        self.ui.click("console_panel")
        time.sleep(1)
        self.ui.click("log_last_line")
        self.ui.hotkey("ctrl", "a")
        self.ui.hotkey("ctrl", "c")
        time.sleep(1)
        text = read_clipboard()
        ok = 1 if text.strip() else 0
        if clear:
            self.ui.click("clear_log")
        save_file(out_path, text)
        return ok

    def run_case(self, case_dir):
        """Copy one case into the project, run it, and harvest the results. Returns True on success."""
        name = os.path.basename(case_dir)
        print("[case] %s" % name)
        for ext in ("axml", "js", "acss", "json"):
            src = os.path.join(case_dir, "index." + ext)
            dst = os.path.join(self.code_path, "index." + ext)
            if os.path.isfile(src):
                copy_file(src, dst)
        time.sleep(2)

        out_dir = os.path.join(case_dir, self.platform, self.conf)
        os.makedirs(out_dir, exist_ok=True)

        for attempt in range(1, self.max_retry + 1):
            self.compile_project()
            self.trigger_scenarios()
            a = self.harvest_axml(os.path.join(out_dir, "index.html"))
            b = self.harvest_log(os.path.join(out_dir, "log.txt"))
            if a and b:
                print("  succeeded (attempt %d)" % attempt)
                return True
            print("  retry %d/%d" % (attempt, self.max_retry))
            time.sleep(1)
        print("  failed: %s" % name)
        return False


def calibrate():
    """Print the pointer coordinates once per second, to help record each target's position."""
    import pyautogui
    print("Move the pointer to each target and read off the coordinates; press Ctrl+C to stop.")
    try:
        while True:
            x, y = pyautogui.position()
            print("  x=%-5d y=%-5d\r" % (x, y), end="", flush=True)
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\ndone")


def load_coords(path):
    coords = dict(DEFAULT_COORDS)
    if path and os.path.isfile(path):
        with open(path, encoding="utf-8") as f:
            coords.update(json.load(f))
        print("loaded coordinates from %s" % path)
    return coords


def configure(argv=None):
    p = argparse.ArgumentParser(
        description="Drive the Alipay DevTools with pyautogui to run mini-program test cases.")
    p.add_argument("--project-path", default=r"C:\AlipayMiniProjects\autotest",
                   help="the Alipay project root already opened in the IDE.")
    p.add_argument("--page", default="pages/AutoTest",
                   help="the page directory cases are injected into (relative to the project root).")
    p.add_argument("--result-path", default="../AutoTestResult",
                   help="the root directory that holds the generated case directories.")
    p.add_argument("--platform", default="DevTools", help="the result subdirectory name.")
    p.add_argument("--conf", default="normal", help="runtime config label, e.g. normal / native.")
    p.add_argument("--coords", default=None, help="JSON config file of click targets.")
    p.add_argument("--save-coords", default=None, help="write the effective coordinates to this file.")
    p.add_argument("--compile-wait", type=int, default=8, help="seconds to wait after compiling.")
    p.add_argument("--run-wait", type=int, default=5, help="seconds to wait after clicking run.")
    p.add_argument("--max-retry", type=int, default=3)
    p.add_argument("--only", default=None, help="run only the case directory with this name.")
    p.add_argument("--calibrate", action="store_true", help="print pointer coordinates then exit.")
    p.add_argument("--dry-run", action="store_true", help="print actions only, never move the mouse.")
    args = p.parse_args(argv)

    if args.calibrate:
        calibrate()
        sys.exit(0)

    coords = load_coords(args.coords)
    if args.save_coords:
        with open(args.save_coords, "w", encoding="utf-8") as f:
            json.dump(coords, f, indent=2, ensure_ascii=False)
        print("coordinates written to %s" % args.save_coords)

    if not args.project_path:
        p.error("--project-path is required")

    return args, coords


def main(argv=None):
    args, coords = configure(argv)

    project_path = args.project_path
    code_path = os.path.join(project_path, args.page)
    if not os.path.isdir(code_path):
        print("error: page directory does not exist: %s" % code_path)
        return 2

    ui = UIAutomator(coords, dry_run=args.dry_run)
    runner = Runner(ui, project_path, code_path, args.platform, args.conf,
                    compile_wait=args.compile_wait,
                    run_wait=args.run_wait,
                    max_retry=args.max_retry)

    root = args.result_path
    if not os.path.isdir(root):
        print("error: result directory does not exist: %s" % root)
        return 2

    cases = []
    for entry in sorted(os.listdir(root)):
        full = os.path.join(root, entry)
        if not os.path.isdir(full):
            continue
        if entry in (args.platform, "__pycache__"):
            continue
        if args.only and entry != args.only:
            continue
        cases.append(full)

    if not cases:
        print("no case directories found under %s" % root)
        return 1

    print("running %d case(s) against %s" % (len(cases), project_path))
    ok = 0
    for c in cases:
        if runner.run_case(c):
            ok += 1
    print("done: %d/%d succeeded" % (ok, len(cases)))
    return 0 if ok == len(cases) else 1


if __name__ == "__main__":
    sys.exit(main())
