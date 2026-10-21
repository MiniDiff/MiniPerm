#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
calibrate_shot.py -- Alipay DevTools coordinate calibration helper
                      (screenshot -> an image-capable model reads it -> returns coordinates)

Flow (used together with alipay_autotest.py):

    1. Open the Alipay DevTools, open the test project, maximize the window and fix its position.
    2. Run:  python calibrate_shot.py
       - if the screen is locked, it errors out immediately; unlock the screen first
       - this generates tmp/shots/screen_full.png (full resolution) and screen_view.png (half size)
    3. Hand screen_view.png to an image-capable (multimodal) model, and have it point out the pixel
       position of these targets:
       compile / inspector_panel / page_node / copy_menu / copy_outer /
       console_panel / log_last_line / clear_log / scenario_button / run_all_button
    4. The model's coordinates are on the view image; the real coordinate = the view coordinate x 2
       (scale = 0.5).
    5. Write the converted coordinates into alipay_coords.json (or use alipay_autotest.py --save-coords).

Why a half-size copy is needed: the full 4K image is large; the half-size copy is easier for a model
to inspect, and the coordinates simply need to be scaled back up.
Note: the screenshot must be taken while the DevTools window is in the foreground and unobstructed,
otherwise the resulting coordinates are invalid.
"""

import ctypes
import os
import sys
import time

OUT = 'tmp/shots'


def desktop_accessible():
    """Return True when the interactive desktop can be captured (not locked)."""
    u = ctypes.windll.user32
    h = u.OpenInputDesktop(0, False, 0x0001)  # DESKTOP_READOBJECTS
    if h:
        u.CloseDesktop(h)
        return True
    return False


def main():
    if not desktop_accessible():
        print('error: the screen is locked / on a secure desktop (lock screen, UAC, or screensaver); cannot capture.')
        print('unlock the screen first, then retry.')
        return 1

    try:
        import pyautogui
        from PIL import Image
    except ImportError as e:
        print('missing dependency: %s' % e)
        print('run: pip install pyautogui pillow')
        return 1

    os.makedirs(OUT, exist_ok=True)
    shot = pyautogui.screenshot()
    w, h = shot.size
    full_path = os.path.join(OUT, 'screen_full.png')
    view_path = os.path.join(OUT, 'screen_view.png')
    shot.save(full_path)
    half = shot.resize((w // 2, h // 2), Image.LANCZOS)
    half.save(view_path)
    print('screen size:', w, 'x', h)
    print('saved:', full_path)
    print('saved:', view_path, 'size', half.size[0], 'x', half.size[1], '(scale=0.5)')
    print()
    print('next step: hand screen_view.png to a model to read, and have it return each target\'s')
    print('coordinate on the view image; real coordinate = view coordinate x 2. After writing the')
    print('result into alipay_coords.json, alipay_autotest.py can be run.')
    return 0


if __name__ == '__main__':
    time.sleep(0)  # keep the import order stable
    sys.exit(main())
