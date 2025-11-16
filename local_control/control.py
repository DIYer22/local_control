"""
Cross-platform input and power control utilities without external GUI dependencies.
"""

from __future__ import annotations

import platform
import subprocess
from typing import Dict, Optional, Sequence

import ctypes

from . import clipboard as clipboard_utils
from .clipboard import ClipboardData


class _BaseBackend:
    def move_cursor(self, dx: float, dy: float) -> None:  # pragma: no cover - OS specific
        raise NotImplementedError

    def click(self, button: str = "left", double: bool = False) -> None:  # pragma: no cover
        raise NotImplementedError

    def button_action(self, button: str, action: str) -> None:  # pragma: no cover
        raise NotImplementedError

    def scroll(self, vertical: float = 0.0, horizontal: float = 0.0) -> None:  # pragma: no cover
        raise NotImplementedError

    def type_text(self, text: str) -> None:  # pragma: no cover
        raise NotImplementedError

    def key_action(self, key: str, action: str) -> None:  # pragma: no cover
        raise NotImplementedError

    def state(self) -> Dict[str, float]:
        raise NotImplementedError


class _WindowsBackend(_BaseBackend):
    INPUT_MOUSE = 0
    INPUT_KEYBOARD = 1

    MOUSEEVENTF_LEFTDOWN = 0x0002
    MOUSEEVENTF_LEFTUP = 0x0004
    MOUSEEVENTF_RIGHTDOWN = 0x0008
    MOUSEEVENTF_RIGHTUP = 0x0010
    MOUSEEVENTF_MIDDLEDOWN = 0x0020
    MOUSEEVENTF_MIDDLEUP = 0x0040
    MOUSEEVENTF_WHEEL = 0x0800
    MOUSEEVENTF_HWHEEL = 0x01000

    KEYEVENTF_KEYUP = 0x0002
    KEYEVENTF_UNICODE = 0x0004

    _KEY_MAP: Dict[str, int] = {
        "enter": 0x0D,
        "esc": 0x1B,
        "backspace": 0x08,
        "tab": 0x09,
        "up": 0x26,
        "down": 0x28,
        "left": 0x25,
        "right": 0x27,
        "delete": 0x2E,
        "home": 0x24,
        "end": 0x23,
        "pageup": 0x21,
        "pagedown": 0x22,
        "shift": 0xA0,
        "ctrl": 0xA2,
        "alt": 0xA4,
        "command": 0x5B,  # Windows / Command key
        "space": 0x20,
        "minus": 0xBD,
        "equals": 0xBB,
        "leftbracket": 0xDB,
        "rightbracket": 0xDD,
        "backslash": 0xDC,
        "semicolon": 0xBA,
        "quote": 0xDE,
        "comma": 0xBC,
        "period": 0xBE,
        "slash": 0xBF,
        "grave": 0xC0,
    }

    _BUTTON_FLAGS = {
        "left": (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        "middle": (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
        "right": (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
    }

    def __init__(self) -> None:
        from ctypes import wintypes

        self._user32 = ctypes.WinDLL("user32", use_last_error=True)

        self._user32.VkKeyScanW.argtypes = [wintypes.WCHAR]
        self._user32.VkKeyScanW.restype = wintypes.SHORT

        ULONG_PTR = wintypes.ULONG_PTR

        class MOUSEINPUT(ctypes.Structure):
            _fields_ = [
                ("dx", wintypes.LONG),
                ("dy", wintypes.LONG),
                ("mouseData", wintypes.DWORD),
                ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD),
                ("dwExtraInfo", ULONG_PTR),
            ]

        class KEYBDINPUT(ctypes.Structure):
            _fields_ = [
                ("wVk", wintypes.WORD),
                ("wScan", wintypes.WORD),
                ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD),
                ("dwExtraInfo", ULONG_PTR),
            ]

        class HARDWAREINPUT(ctypes.Structure):
            _fields_ = [
                ("uMsg", wintypes.DWORD),
                ("wParamL", wintypes.WORD),
                ("wParamH", wintypes.WORD),
            ]

        class _INPUT_UNION(ctypes.Union):
            _fields_ = [
                ("mi", MOUSEINPUT),
                ("ki", KEYBDINPUT),
                ("hi", HARDWAREINPUT),
            ]

        class INPUT(ctypes.Structure):
            _anonymous_ = ("value",)
            _fields_ = [("type", wintypes.DWORD), ("value", _INPUT_UNION)]

        self._wintypes = wintypes
        self._MOUSEINPUT = MOUSEINPUT
        self._KEYBDINPUT = KEYBDINPUT
        self._INPUT = INPUT

    def _send_inputs(self, inputs: Sequence[ctypes.Structure]) -> None:
        if not inputs:
            return
        array_type = self._INPUT * len(inputs)
        array = array_type(*inputs)
        sent = self._user32.SendInput(
            len(array),
            ctypes.byref(array),
            ctypes.sizeof(self._INPUT),
        )
        if sent != len(array):
            raise OSError(ctypes.get_last_error())

    def move_cursor(self, dx: float, dy: float) -> None:
        point = self._wintypes.POINT()
        if not self._user32.GetCursorPos(ctypes.byref(point)):
            raise OSError(ctypes.get_last_error())
        target_x = int(round(point.x + dx))
        target_y = int(round(point.y + dy))
        if not self._user32.SetCursorPos(target_x, target_y):
            raise OSError(ctypes.get_last_error())

    def click(self, button: str = "left", double: bool = False) -> None:
        if button not in {"left", "middle", "right"}:
            raise ValueError(f"Unsupported button: {button}")
        down_flag, up_flag = self._BUTTON_FLAGS[button]

        events = []
        for _ in range(2 if double else 1):
            down = self._INPUT()
            down.type = self.INPUT_MOUSE
            down.value.mi = self._MOUSEINPUT(
                dx=0,
                dy=0,
                mouseData=0,
                dwFlags=down_flag,
                time=0,
                dwExtraInfo=0,
            )
            up = self._INPUT()
            up.type = self.INPUT_MOUSE
            up.value.mi = self._MOUSEINPUT(
                dx=0,
                dy=0,
                mouseData=0,
                dwFlags=up_flag,
                time=0,
                dwExtraInfo=0,
            )
            events.extend([down, up])
        self._send_inputs(events)

    def button_action(self, button: str, action: str) -> None:
        if button not in self._BUTTON_FLAGS:
            raise ValueError(f"Unsupported button: {button}")
        if action not in {"down", "up"}:
            raise ValueError(f"Unsupported button action: {action}")
        down_flag, up_flag = self._BUTTON_FLAGS[button]
        flag = down_flag if action == "down" else up_flag
        event = self._INPUT()
        event.type = self.INPUT_MOUSE
        event.value.mi = self._MOUSEINPUT(
            dx=0,
            dy=0,
            mouseData=0,
            dwFlags=flag,
            time=0,
            dwExtraInfo=0,
        )
        self._send_inputs([event])

    def scroll(self, vertical: float = 0.0, horizontal: float = 0.0) -> None:
        if vertical:
            value = -vertical
            amount = int(round(value * 120))
            if amount == 0:
                amount = -120 if vertical > 0 else 120
            event = self._INPUT()
            event.type = self.INPUT_MOUSE
            event.value.mi = self._MOUSEINPUT(
                dx=0,
                dy=0,
                mouseData=amount,
                dwFlags=self.MOUSEEVENTF_WHEEL,
                time=0,
                dwExtraInfo=0,
            )
            self._send_inputs([event])
        if horizontal:
            amount = int(round(horizontal * 120))
            if amount == 0:
                amount = 120 if horizontal > 0 else -120
            event = self._INPUT()
            event.type = self.INPUT_MOUSE
            event.value.mi = self._MOUSEINPUT(
                dx=0,
                dy=0,
                mouseData=amount,
                dwFlags=self.MOUSEEVENTF_HWHEEL,
                time=0,
                dwExtraInfo=0,
            )
            self._send_inputs([event])

    def type_text(self, text: str) -> None:
        if not text:
            return
        events = []
        for char in text:
            code = ord(char)
            down = self._INPUT()
            down.type = self.INPUT_KEYBOARD
            down.value.ki = self._KEYBDINPUT(
                wVk=0,
                wScan=code,
                dwFlags=self.KEYEVENTF_UNICODE,
                time=0,
                dwExtraInfo=0,
            )
            up = self._INPUT()
            up.type = self.INPUT_KEYBOARD
            up.value.ki = self._KEYBDINPUT(
                wVk=0,
                wScan=code,
                dwFlags=self.KEYEVENTF_UNICODE | self.KEYEVENTF_KEYUP,
                time=0,
                dwExtraInfo=0,
            )
            events.extend([down, up])
        self._send_inputs(events)

    def key_action(self, key: str, action: str) -> None:
        vk = self._KEY_MAP.get(key)
        if vk is None and len(key) == 1:
            char = key
            result = self._user32.VkKeyScanW(ctypes.c_wchar(char))
            if result != -1:
                vk = result & 0xFF
        if vk is None:
            raise ValueError(f"Unsupported key: {key}")
        if action not in {"press", "down", "up"}:
            raise ValueError(f"Unsupported action: {action}")

        event_down = self._INPUT()
        event_down.type = self.INPUT_KEYBOARD
        event_down.value.ki = self._KEYBDINPUT(
            wVk=vk,
            wScan=0,
            dwFlags=0,
            time=0,
            dwExtraInfo=0,
        )
        event_up = self._INPUT()
        event_up.type = self.INPUT_KEYBOARD
        event_up.value.ki = self._KEYBDINPUT(
            wVk=vk,
            wScan=0,
            dwFlags=self.KEYEVENTF_KEYUP,
            time=0,
            dwExtraInfo=0,
        )

        if action == "press":
            self._send_inputs([event_down, event_up])
        elif action == "down":
            self._send_inputs([event_down])
        else:
            self._send_inputs([event_up])

    def state(self) -> Dict[str, float]:
        point = self._wintypes.POINT()
        if not self._user32.GetCursorPos(ctypes.byref(point)):
            raise OSError(ctypes.get_last_error())
        width = self._user32.GetSystemMetrics(0)
        height = self._user32.GetSystemMetrics(1)
        return {
            "x": float(point.x),
            "y": float(point.y),
            "width": float(width),
            "height": float(height),
        }


class _DarwinBackend(_BaseBackend):
    kCGHIDEventTap = 0

    kCGEventLeftMouseDown = 1
    kCGEventLeftMouseUp = 2
    kCGEventRightMouseDown = 3
    kCGEventRightMouseUp = 4
    kCGEventOtherMouseDown = 25
    kCGEventOtherMouseUp = 26
    kCGEventMouseMoved = 5
    kCGEventScrollWheel = 22

    kCGMouseButtonLeft = 0
    kCGMouseButtonRight = 1
    kCGMouseButtonCenter = 2

    kCGScrollEventUnitPixel = 0
    kCGScrollEventUnitLine = 1

    _KEY_MAP: Dict[str, int] = {
        "enter": 36,
        "esc": 53,
        "backspace": 51,
        "tab": 48,
        "up": 126,
        "down": 125,
        "left": 123,
        "right": 124,
        "delete": 117,
        "home": 115,
        "end": 119,
        "pageup": 116,
        "pagedown": 121,
        "shift": 56,
        "ctrl": 59,
        "alt": 58,
        "command": 55,
        "space": 49,
        "grave": 50,
        "minus": 27,
        "equals": 24,
        "leftbracket": 33,
        "rightbracket": 30,
        "backslash": 42,
        "semicolon": 41,
        "quote": 39,
        "comma": 43,
        "period": 47,
        "slash": 44,
        "0": 29,
        "1": 18,
        "2": 19,
        "3": 20,
        "4": 21,
        "5": 23,
        "6": 22,
        "7": 26,
        "8": 28,
        "9": 25,
        "a": 0,
        "b": 11,
        "c": 8,
        "d": 2,
        "e": 14,
        "f": 3,
        "g": 5,
        "h": 4,
        "i": 34,
        "j": 38,
        "k": 40,
        "l": 37,
        "m": 46,
        "n": 45,
        "o": 31,
        "p": 35,
        "q": 12,
        "r": 15,
        "s": 1,
        "t": 17,
        "u": 32,
        "v": 9,
        "w": 13,
        "x": 7,
        "y": 16,
        "z": 6,
    }

    def __init__(self) -> None:
        from ctypes import (
            c_bool,
            c_double,
            c_int32,
            c_size_t,
            c_uint16,
            c_uint32,
            c_uint64,
            c_void_p,
        )

        self._c_bool = c_bool
        self._c_double = c_double
        self._c_int32 = c_int32
        self._c_uint16 = c_uint16
        self._c_uint32 = c_uint32
        self._c_uint64 = c_uint64
        self._c_void_p = c_void_p
        self._c_size_t = c_size_t

        self._quartz = ctypes.CDLL(
            "/System/Library/Frameworks/ApplicationServices.framework/Versions/A/ApplicationServices"
        )

        class CGPoint(ctypes.Structure):
            _fields_ = [("x", c_double), ("y", c_double)]

        self.CGPoint = CGPoint

        self._quartz.CGEventCreateMouseEvent.restype = c_void_p
        self._quartz.CGEventCreateMouseEvent.argtypes = [
            c_void_p,
            c_uint32,
            CGPoint,
            c_uint32,
        ]

        self._quartz.CGEventCreateScrollWheelEvent.restype = c_void_p
        self._quartz.CGEventCreateScrollWheelEvent.argtypes = [
            c_void_p,
            c_uint32,
            c_uint32,
            c_int32,
            c_int32,
        ]

        self._quartz.CGEventCreateKeyboardEvent.restype = c_void_p
        self._quartz.CGEventCreateKeyboardEvent.argtypes = [
            c_void_p,
            c_uint16,
            c_bool,
        ]

        self._quartz.CGEventKeyboardSetUnicodeString.argtypes = [
            c_void_p,
            ctypes.c_long,
            ctypes.POINTER(c_uint16),
        ]

        self._quartz.CGEventPost.argtypes = [c_uint32, c_void_p]
        self._quartz.CFRelease.argtypes = [c_void_p]

        self._quartz.CGEventCreate.restype = c_void_p
        self._quartz.CGEventCreate.argtypes = [c_void_p]
        self._quartz.CGEventGetLocation.argtypes = [c_void_p]
        self._quartz.CGEventGetLocation.restype = CGPoint
        self._quartz.CGMainDisplayID.restype = c_uint32
        self._quartz.CGDisplayPixelsWide.argtypes = [c_uint32]
        self._quartz.CGDisplayPixelsWide.restype = c_size_t
        self._quartz.CGDisplayPixelsHigh.argtypes = [c_uint32]
        self._quartz.CGDisplayPixelsHigh.restype = c_size_t
        self._quartz.CGEventSetFlags.argtypes = [c_void_p, c_uint64]
        self._quartz.CGEventSetFlags.restype = None

    def _prepare_event(self, event: ctypes.c_void_p, flags: int = 0) -> ctypes.c_void_p:
        if event:
            self._quartz.CGEventSetFlags(event, self._c_uint64(flags))
        return event

    def _current_position(self) -> "CGPoint":
        event = self._quartz.CGEventCreate(self._c_void_p())
        if not event:
            raise RuntimeError("Failed to create CGEvent for cursor location.")
        try:
            return self._quartz.CGEventGetLocation(event)
        finally:
            self._quartz.CFRelease(event)

    def _post_event(self, event: ctypes.c_void_p) -> None:
        if not event:
            raise RuntimeError("Unable to create Quartz event.")
        try:
            self._quartz.CGEventPost(self.kCGHIDEventTap, event)
        finally:
            self._quartz.CFRelease(event)

    def move_cursor(self, dx: float, dy: float) -> None:
        current = self._current_position()
        target = self.CGPoint(current.x + dx, current.y + dy)
        event = self._prepare_event(
            self._quartz.CGEventCreateMouseEvent(
                None,
                self.kCGEventMouseMoved,
                target,
                self.kCGMouseButtonLeft,
            )
        )
        self._post_event(event)

    def click(self, button: str = "left", double: bool = False) -> None:
        if button not in {"left", "middle", "right"}:
            raise ValueError(f"Unsupported button: {button}")
        if button == "left":
            down_type = self.kCGEventLeftMouseDown
            up_type = self.kCGEventLeftMouseUp
            cg_button = self.kCGMouseButtonLeft
        elif button == "right":
            down_type = self.kCGEventRightMouseDown
            up_type = self.kCGEventRightMouseUp
            cg_button = self.kCGMouseButtonRight
        else:
            down_type = self.kCGEventOtherMouseDown
            up_type = self.kCGEventOtherMouseUp
            cg_button = self.kCGMouseButtonCenter

        current = self._current_position()
        point = self.CGPoint(current.x, current.y)

        for _ in range(2 if double else 1):
            down_event = self._prepare_event(
                self._quartz.CGEventCreateMouseEvent(None, down_type, point, cg_button)
            )
            up_event = self._prepare_event(
                self._quartz.CGEventCreateMouseEvent(None, up_type, point, cg_button)
            )
            self._post_event(down_event)
            self._post_event(up_event)

    def button_action(self, button: str, action: str) -> None:
        if button not in {"left", "middle", "right"}:
            raise ValueError(f"Unsupported button: {button}")
        if action not in {"down", "up"}:
            raise ValueError(f"Unsupported button action: {action}")
        if button == "left":
            down_type = self.kCGEventLeftMouseDown
            up_type = self.kCGEventLeftMouseUp
            cg_button = self.kCGMouseButtonLeft
        elif button == "right":
            down_type = self.kCGEventRightMouseDown
            up_type = self.kCGEventRightMouseUp
            cg_button = self.kCGMouseButtonRight
        else:
            down_type = self.kCGEventOtherMouseDown
            up_type = self.kCGEventOtherMouseUp
            cg_button = self.kCGMouseButtonCenter
        event_type = down_type if action == "down" else up_type
        current = self._current_position()
        point = self.CGPoint(current.x, current.y)
        event = self._prepare_event(
            self._quartz.CGEventCreateMouseEvent(None, event_type, point, cg_button)
        )
        self._post_event(event)

    def scroll(self, vertical: float = 0.0, horizontal: float = 0.0) -> None:
        if not vertical and not horizontal:
            return

        def _normalize(value: float, invert: bool = False) -> int:
            """
            Convert browser wheel deltas (typically ~120 per detent) into smaller
            macOS-friendly increments. The divisor keeps physical scroll wheels from
            jumping entire pages while still allowing smooth trackpad gestures.
            """
            if value == 0.0:
                return 0
            divisor = 40.0
            scaled = value / divisor
            if invert:
                scaled = -scaled
            rounded = int(round(scaled))
            if rounded == 0:
                rounded = -1 if scaled < 0 else 1
            return rounded

        vert = _normalize(vertical, invert=True)
        horiz = _normalize(horizontal)
        event = self._prepare_event(
            self._quartz.CGEventCreateScrollWheelEvent(
                None,
                self.kCGScrollEventUnitLine,
                2,
                vert,
                horiz,
            )
        )
        self._post_event(event)

    def type_text(self, text: str) -> None:
        if not text:
            return
        utf16 = text.encode("utf-16-le")
        units = [int.from_bytes(utf16[i : i + 2], "little") for i in range(0, len(utf16), 2)]
        buffer_type = self._c_uint16 * len(units)
        buf = buffer_type(*units)
        down = self._prepare_event(self._quartz.CGEventCreateKeyboardEvent(None, 0, True))
        self._quartz.CGEventKeyboardSetUnicodeString(down, len(units), buf)
        up = self._prepare_event(self._quartz.CGEventCreateKeyboardEvent(None, 0, False))
        self._quartz.CGEventKeyboardSetUnicodeString(up, len(units), buf)
        self._post_event(down)
        self._post_event(up)

    def key_action(self, key: str, action: str) -> None:
        keycode = self._KEY_MAP.get(key)
        if keycode is None:
            raise ValueError(f"Unsupported key: {key}")
        if action not in {"press", "down", "up"}:
            raise ValueError(f"Unsupported action: {action}")
        if action in {"press", "down"}:
            down = self._prepare_event(self._quartz.CGEventCreateKeyboardEvent(None, keycode, True))
            self._post_event(down)
        if action in {"press", "up"}:
            up = self._prepare_event(self._quartz.CGEventCreateKeyboardEvent(None, keycode, False))
            self._post_event(up)

    def state(self) -> Dict[str, float]:
        current = self._current_position()
        display = self._quartz.CGMainDisplayID()
        width = float(self._quartz.CGDisplayPixelsWide(display))
        height = float(self._quartz.CGDisplayPixelsHigh(display))
        return {
            "x": float(current.x),
            "y": float(current.y),
            "width": width,
            "height": height,
        }


class _X11Backend(_BaseBackend):
    _SHIFT_REQUIRED = set("~!@#$%^&*()_+{}|:\"<>?ABCDEFGHIJKLMNOPQRSTUVWXYZ")

    _KEY_MAP: Dict[str, str] = {
        "enter": "Return",
        "esc": "Escape",
        "backspace": "BackSpace",
        "tab": "Tab",
        "up": "Up",
        "down": "Down",
        "left": "Left",
        "right": "Right",
        "delete": "Delete",
        "home": "Home",
        "end": "End",
        "pageup": "Page_Up",
        "pagedown": "Page_Down",
        "shift": "Shift_L",
        "ctrl": "Control_L",
        "alt": "Alt_L",
        "command": "Super_L",
        "space": "space",
        "minus": "minus",
        "equals": "equal",
        "leftbracket": "bracketleft",
        "rightbracket": "bracketright",
        "backslash": "backslash",
        "semicolon": "semicolon",
        "quote": "apostrophe",
        "comma": "comma",
        "period": "period",
        "slash": "slash",
        "grave": "grave",
    }

    _BUTTON_MAP: Dict[str, int] = {
        "left": 1,
        "middle": 2,
        "right": 3,
    }

    def __init__(self) -> None:
        self._x11 = ctypes.cdll.LoadLibrary("libX11.so.6")
        self._xtst = ctypes.cdll.LoadLibrary("libXtst.so.6")

        self._x11.XOpenDisplay.restype = ctypes.c_void_p
        self._display = self._x11.XOpenDisplay(None)
        if not self._display:
            raise RuntimeError("Unable to open X11 display. Ensure DISPLAY is set.")

        self._x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        self._x11.XKeysymToKeycode.restype = ctypes.c_uint
        self._x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
        self._x11.XStringToKeysym.restype = ctypes.c_ulong
        self._xtst.XTestFakeRelativeMotionEvent.argtypes = [
            ctypes.c_void_p,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_ulong,
        ]
        self._xtst.XTestFakeButtonEvent.argtypes = [
            ctypes.c_void_p,
            ctypes.c_uint,
            ctypes.c_int,
            ctypes.c_ulong,
        ]
        self._xtst.XTestFakeKeyEvent.argtypes = [
            ctypes.c_void_p,
            ctypes.c_uint,
            ctypes.c_int,
            ctypes.c_ulong,
        ]
        self._x11.XFlush.argtypes = [ctypes.c_void_p]
        self._x11.XDefaultScreen.argtypes = [ctypes.c_void_p]
        self._x11.XDefaultScreen.restype = ctypes.c_int
        self._x11.XDisplayWidth.argtypes = [ctypes.c_void_p, ctypes.c_int]
        self._x11.XDisplayWidth.restype = ctypes.c_int
        self._x11.XDisplayHeight.argtypes = [ctypes.c_void_p, ctypes.c_int]
        self._x11.XDisplayHeight.restype = ctypes.c_int
        self._x11.XRootWindow.argtypes = [ctypes.c_void_p, ctypes.c_int]
        self._x11.XRootWindow.restype = ctypes.c_ulong
        self._x11.XQueryPointer.argtypes = [
            ctypes.c_void_p,
            ctypes.c_ulong,
            ctypes.POINTER(ctypes.c_ulong),
            ctypes.POINTER(ctypes.c_ulong),
            ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_uint),
        ]
        self._x11.XQueryPointer.restype = ctypes.c_bool

        self._shift_keycode = self._resolve_keycode("Shift_L")

    def _resolve_keycode(self, keysym_name: str) -> Optional[int]:
        keysym = self._x11.XStringToKeysym(keysym_name.encode("ascii"))
        if keysym == 0:
            return None
        keycode = self._x11.XKeysymToKeycode(self._display, keysym)
        return int(keycode) if keycode else None

    def _flush(self) -> None:
        self._x11.XFlush(self._display)

    def move_cursor(self, dx: float, dy: float) -> None:
        self._xtst.XTestFakeRelativeMotionEvent(
            self._display, int(round(dx)), int(round(dy)), 0
        )
        self._flush()

    def click(self, button: str = "left", double: bool = False) -> None:
        mapping = {"left": 1, "middle": 2, "right": 3}
        if button not in mapping:
            raise ValueError(f"Unsupported button: {button}")
        button_code = mapping[button]
        repeats = 2 if double else 1
        for _ in range(repeats):
            self._xtst.XTestFakeButtonEvent(self._display, button_code, True, 0)
            self._xtst.XTestFakeButtonEvent(self._display, button_code, False, 0)
            self._flush()

    def button_action(self, button: str, action: str) -> None:
        button_code = self._BUTTON_MAP.get(button)
        if button_code is None:
            raise ValueError(f"Unsupported button: {button}")
        if action not in {"down", "up"}:
            raise ValueError(f"Unsupported button action: {action}")
        press = 1 if action == "down" else 0
        self._xtst.XTestFakeButtonEvent(self._display, button_code, press, 0)
        self._flush()

    def scroll(self, vertical: float = 0.0, horizontal: float = 0.0) -> None:
        def _emit(button: int, count: int) -> None:
            for _ in range(abs(count)):
                self._xtst.XTestFakeButtonEvent(self._display, button, True, 0)
                self._xtst.XTestFakeButtonEvent(self._display, button, False, 0)

        if vertical:
            count = int(round(vertical))
            if count == 0:
                count = 1 if vertical > 0 else -1
            button = 4 if count > 0 else 5
            _emit(button, count)
        if horizontal:
            count = int(round(horizontal))
            if count == 0:
                count = 1 if horizontal > 0 else -1
            button = 7 if count > 0 else 6
            _emit(button, count)
        self._flush()

    def _press_keycode(self, keycode: int, shift: bool = False) -> None:
        if shift and self._shift_keycode is not None:
            self._xtst.XTestFakeKeyEvent(self._display, self._shift_keycode, True, 0)
        self._xtst.XTestFakeKeyEvent(self._display, keycode, True, 0)
        self._xtst.XTestFakeKeyEvent(self._display, keycode, False, 0)
        if shift and self._shift_keycode is not None:
            self._xtst.XTestFakeKeyEvent(self._display, self._shift_keycode, False, 0)
        self._flush()

    def _type_char_direct(self, char: str) -> bool:
        if char == "\n":
            self.key_action("enter", "press")
            return True
        if char == "\r":
            return True
        if char == "\t":
            self.key_action("tab", "press")
            return True
        if char == " ":
            keysym = self._x11.XStringToKeysym(b"space")
        else:
            try:
                encoded = char.encode("utf-8")
            except UnicodeEncodeError:
                return False
            keysym = self._x11.XStringToKeysym(encoded)
        if keysym == 0:
            return False
        keycode = self._x11.XKeysymToKeycode(self._display, keysym)
        if keycode == 0:
            return False
        need_shift = char in self._SHIFT_REQUIRED
        self._press_keycode(keycode, shift=need_shift)
        return True

    def _type_via_clipboard(self, text: str) -> None:
        if not text:
            return
        try:
            previous = clipboard_utils.get_clipboard()
        except Exception:
            previous = None
        try:
            clipboard_utils.set_clipboard(ClipboardData(kind="text", data=text))
        except Exception as exc:
            raise RuntimeError(
                "Unable to access clipboard for Unicode typing. Install wl-copy or xclip."
            ) from exc
        try:
            self.key_action("ctrl", "down")
            try:
                self.key_action("v", "press")
            finally:
                self.key_action("ctrl", "up")
        finally:
            if previous:
                try:
                    clipboard_utils.set_clipboard(previous)
                except Exception:
                    pass

    def type_text(self, text: str) -> None:
        for idx, char in enumerate(text):
            if self._type_char_direct(char):
                continue
            remaining = text[idx:]
            if remaining:
                self._type_via_clipboard(remaining)
            return

    def key_action(self, key: str, action: str) -> None:
        keysym_name = self._KEY_MAP.get(key)
        if not keysym_name and len(key) == 1:
            keysym_name = key
        if not keysym_name:
            raise ValueError(f"Unsupported key: {key}")
        keycode = self._resolve_keycode(keysym_name)
        if keycode is None:
            raise RuntimeError(f"Could not resolve keycode for {keysym_name}")
        if action == "press":
            self._press_keycode(keycode)
            return
        if action == "down":
            self._xtst.XTestFakeKeyEvent(self._display, keycode, True, 0)
        elif action == "up":
            self._xtst.XTestFakeKeyEvent(self._display, keycode, False, 0)
        else:
            raise ValueError(f"Unsupported action: {action}")
        self._flush()

    def state(self) -> Dict[str, float]:
        screen = self._x11.XDefaultScreen(self._display)
        width = float(self._x11.XDisplayWidth(self._display, screen))
        height = float(self._x11.XDisplayHeight(self._display, screen))
        root = self._x11.XRootWindow(self._display, screen)
        root_return = ctypes.c_ulong()
        child_return = ctypes.c_ulong()
        root_x = ctypes.c_int()
        root_y = ctypes.c_int()
        win_x = ctypes.c_int()
        win_y = ctypes.c_int()
        mask = ctypes.c_uint()
        success = self._x11.XQueryPointer(
            self._display,
            root,
            ctypes.byref(root_return),
            ctypes.byref(child_return),
            ctypes.byref(root_x),
            ctypes.byref(root_y),
            ctypes.byref(win_x),
            ctypes.byref(win_y),
            ctypes.byref(mask),
        )
        if not success:
            return {"x": 0.0, "y": 0.0, "width": width, "height": height}
        return {
            "x": float(root_x.value),
            "y": float(root_y.value),
            "width": width,
            "height": height,
        }


def _create_backend() -> _BaseBackend:
    system = platform.system()
    if system == "Windows":
        return _WindowsBackend()
    if system == "Darwin":
        return _DarwinBackend()
    return _X11Backend()


_BACKEND: Optional[_BaseBackend] = None


def _backend() -> _BaseBackend:
    global _BACKEND
    if _BACKEND is None:
        _BACKEND = _create_backend()
    return _BACKEND


def move_cursor(dx: float, dy: float) -> Dict[str, float]:
    backend = _backend()
    if dx != 0 or dy != 0:
        backend.move_cursor(dx, dy)
    return backend.state()


def click(button: str = "left", double: bool = False) -> None:
    _backend().click(button=button, double=double)


def button_action(button: str, action: str) -> None:
    _backend().button_action(button=button, action=action)


def scroll(vertical: float = 0.0, horizontal: float = 0.0) -> None:
    _backend().scroll(vertical=vertical, horizontal=horizontal)


def type_text(text: str) -> None:
    _backend().type_text(text)


def key_action(key: str, action: str) -> None:
    _backend().key_action(key, action)


def cursor_state() -> Dict[str, float]:
    return _backend().state()


def lock_screen() -> None:
    system = platform.system()
    if system == "Windows":
        subprocess.run(
            ["rundll32.exe", "user32.dll,LockWorkStation"],
            check=False,
        )
        return

    if system == "Darwin":
        mac_commands = [
            [
                "/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession",
                "-suspend",
            ],
            [
                "osascript",
                "-e",
                'tell application "System Events" to keystroke "q" using {control down, command down}',
            ],
            [
                "pmset",
                "displaysleepnow",
            ],
        ]
        _run_first_success(
            mac_commands,
            error_message="Lock command unavailable on this system.",
        )
        return

    _run_first_success(
        [
            ["loginctl", "lock-session"],
            ["gnome-screensaver-command", "-l"],
            ["xdg-screensaver", "lock"],
        ],
        error_message="Lock command unavailable on this system.",
    )


def shutdown_system() -> None:
    system = platform.system()
    if system == "Windows":
        subprocess.run(["shutdown", "/s", "/t", "0"], check=False)
        return

    if system == "Darwin":
        subprocess.run(
            ["osascript", "-e", 'tell application "System Events" to shut down'],
            check=False,
        )
        return

    _run_first_success(
        [
            ["systemctl", "poweroff"],
            ["shutdown", "-h", "now"],
        ],
        error_message="Shutdown command unavailable on this system.",
    )


def _run_first_success(commands: Sequence[Sequence[str]], error_message: str) -> None:
    for command in commands:
        try:
            result = subprocess.run(command, check=False)
        except FileNotFoundError:
            continue
        if result.returncode == 0:
            return
    raise RuntimeError(error_message)


def unlock_screen() -> None:
    system = platform.system()
    if system == "Windows":
        try:
            user32 = ctypes.WinDLL("user32", use_last_error=True)
            VK_SHIFT = 0x10
            KEYEVENTF_KEYUP = 0x0002
            user32.keybd_event(VK_SHIFT, 0, 0, 0)
            user32.keybd_event(VK_SHIFT, 0, KEYEVENTF_KEYUP, 0)
        except Exception:
            pass
        return

    if system == "Darwin":
        mac_commands = [
            ["osascript", "-e", 'tell application "System Events" to key code 49'],
            ["caffeinate", "-u", "-t", "2"],
        ]
        _run_first_success(
            mac_commands,
            error_message="Unlock command unavailable on this system.",
        )
        return

    _run_first_success(
        [
            ["loginctl", "unlock-session"],
            ["gnome-screensaver-command", "-d"],
            ["xdg-screensaver", "reset"],
        ],
        error_message="Unlock command unavailable on this system.",
    )
