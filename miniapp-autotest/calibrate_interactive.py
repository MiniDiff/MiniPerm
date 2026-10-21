#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
calibrate_interactive.py -- interactive coordinate calibration (no image reading required)

Use case: when a model cannot read screenshots, calibrate manually instead.
The flow is: the script prompts for a target -> you move the mouse there ->
press Enter to record the coordinate.

Menu-type targets (copy_menu / copy_outer) cannot be located in advance,
because the menu only exists after a right-click. The script first right-clicks
page_node, waits for the menu to pop up, then prompts for those positions.

Usage:
    python calibrate_interactive.py
    python calibrate_interactive.py --coords alipay_coords.json   # start from an existing config, filling only the missing items
"""

import argparse
import json
import os
import sys
import time

try:
    import pyautogui
except ImportError:
    print('pyautogui is missing; install it first: pip install pyautogui')
    sys.exit(1)

# (name, description)
STATIC_TARGETS = [
    ('compile',         'the compile button in the toolbar above the simulator (the C-refresh icon)'),
    ('inspector_panel', 'the Elements / Inspector tab of the debugger panel'),
    ('page_node',       'the root <page> node in the Elements tree (a right-click will be fired here next)'),
    ('console_panel',   'the Console tab of the debugger panel'),
    ('log_last_line',   'the Console output area (click to gain focus)'),
    ('clear_log',       'the clear button in the Console toolbar'),
    ('refresh_button',  'the "Refresh environment info" button on the page (optional)'),
    ('run_all_button',  'the "Run all scenarios" button on the page'),
]

# Right-click menu items: the menu must be popped first
MENU_TARGETS = [
    ('copy_menu',  '"Copy" in the context menu'),
    ('copy_outer', '"Copy outerHTML" in the submenu'),
]


def ask(name, desc, coords):
    cur = coords.get(name, [0, 0])
    tip = ' (current %s, press Enter alone to keep it)' % cur if cur and cur != [0, 0] else ''
    s = input('  -> move the mouse to [%s] (%s)%s, then press Enter (type s to skip): '
              % (desc, name, tip)).strip()
    if s.lower() == 's':
        coords[name] = [0, 0]
        print('     skipped')
        return
    x, y = pyautogui.position()
    coords[name] = [x, y]
    print('     recorded (%d, %d)' % (x, y))


def main():
    p = argparse.ArgumentParser(description='Interactively calibrate click coordinates for the Alipay DevTools.')
    p.add_argument('--coords', default='alipay_coords.json', help='the coordinate config file')
    args = p.parse_args()

    coords = {}
    if os.path.isfile(args.coords):
        try:
            coords = json.load(open(args.coords, encoding='utf-8'))
            print('loaded existing config: %s' % args.coords)
        except Exception as e:
            print('failed to read existing config, starting blank: %s' % e)

    print()
    print('=== Phase 1: static targets ===')
    print('(bring the Alipay DevTools to the foreground and keep the window position fixed)')
    for name, desc in STATIC_TARGETS:
        ask(name, desc, coords)

    print()
    print('=== Phase 2: context-menu items ===')
    pn = coords.get('page_node', [0, 0])
    if pn and pn != [0, 0]:
        print('about to right-click at page_node %s to pop the menu...' % pn)
        input('  press Enter to continue once confirmed (make sure the mouse is free to move): ')
        pyautogui.click(x=pn[0], y=pn[1], button='right')
        time.sleep(1.5)
        print('  the menu should now be open; please locate these in order:')
        for name, desc in MENU_TARGETS:
            ask(name, desc, coords)
        pyautogui.press('escape')
    else:
        print('page_node is not configured; skipping menu-item calibration (rerun this script later to fill it in)')

    keep = {k: v for k, v in coords.items() if k.startswith('_')}
    out = dict(keep)
    out.update(coords)
    json.dump(out, open(args.coords, 'w', encoding='utf-8'),
              indent=2, ensure_ascii=False)
    print()
    print('written to %s' % args.coords)
    todo = [k for k, v in out.items()
            if not k.startswith('_') and (not v or v == [0, 0])]
    print('still [0,0] (will be skipped at runtime):', todo or 'none')


if __name__ == '__main__':
    main()
