"""
Clipboard synchronization helpers for text and image payloads.

This module attempts to use native OS facilities first and falls back to an
in-memory clipboard replica when platform commands are unavailable.
"""

from __future__ import annotations

import base64
import platform
import subprocess
import tempfile
import textwrap
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional, Union

OS_NAME = platform.system()


@dataclass
class ClipboardData:
    kind: str  # "text" or "image"
    data: str  # text content or base64 payload
    mime: Optional[str] = None


_FALLBACK_CLIPBOARD: Optional[ClipboardData] = None


def get_clipboard() -> Optional[ClipboardData]:
    """
    Return the clipboard contents as ClipboardData.
    Attempts to retrieve images first (PNG), then text. Falls back to the
    in-memory replica if OS access fails.
    """
    global _FALLBACK_CLIPBOARD
    for getter in (_get_image_clipboard, _get_text_clipboard):
        try:
            data = getter()
        except Exception:
            data = None
        if data:
            _FALLBACK_CLIPBOARD = data
            return data
    return _FALLBACK_CLIPBOARD


def set_clipboard(data: ClipboardData) -> None:
    """
    Update the host clipboard with the provided payload.
    """
    global _FALLBACK_CLIPBOARD
    handlers = {
        "text": _set_text_clipboard,
        "image": _set_image_clipboard,
    }
    handler = handlers.get(data.kind)
    if not handler:
        raise ValueError(f"Unsupported clipboard type: {data.kind}")
    try:
        handler(data)
        _FALLBACK_CLIPBOARD = data
    except Exception:
        # Fallback to in-memory replica when OS update fails.
        _FALLBACK_CLIPBOARD = data


# --------------------------------------------------------------------------- #
# Text clipboard helpers


def _get_text_clipboard() -> Optional[ClipboardData]:
    text = None
    if OS_NAME == "Darwin":
        text = _run_command_capture(["pbpaste"])
        if text is not None:
            text = text.decode("utf-8", errors="replace")
    elif OS_NAME == "Windows":
        script = (
            "Add-Type -AssemblyName System.Windows.Forms;"
            '[System.Windows.Forms.Clipboard]::GetText()'
        )
        text = _run_command_capture(
            ["powershell", "-NoProfile", "-Command", script], text_mode=True
        )
    else:
        text = _first_success(
            [
                ["wl-paste", "--no-newline"],
                ["xclip", "-selection", "clipboard", "-out"],
                ["xsel", "--clipboard", "--output"],
            ],
            decode=True,
        )
    if text:
        return ClipboardData(kind="text", data=text)
    return None


def _set_text_clipboard(data: ClipboardData) -> None:
    payload = data.data
    if OS_NAME == "Darwin":
        _run_command_capture(
            ["pbcopy"],
            input_data=payload.encode("utf-8"),
        )
    elif OS_NAME == "Windows":
        script = textwrap.dedent(
            """
            Add-Type -AssemblyName System.Windows.Forms;
            $inputText = [Console]::In.ReadToEnd();
            [System.Windows.Forms.Clipboard]::SetText($inputText);
            """
        )
        _run_command_capture(
            ["powershell", "-NoProfile", "-Command", script],
            input_data=payload,
            text_mode=True,
        )
    else:
        commands = [
            ["wl-copy"],
            ["xclip", "-selection", "clipboard"],
            ["xsel", "--clipboard", "--input"],
        ]
        for cmd in commands:
            result = _run_command_capture(cmd, input_data=payload.encode("utf-8"))
            if result is not None:
                return
        raise RuntimeError("Failed to set clipboard text via wl-copy/xclip/xsel.")


# --------------------------------------------------------------------------- #
# Image clipboard helpers (PNG base64)


def _get_image_clipboard() -> Optional[ClipboardData]:
    if OS_NAME == "Darwin":
        return _mac_get_image()
    if OS_NAME == "Windows":
        return _windows_get_image()
    if OS_NAME == "Linux":
        return _linux_get_image()
    return None


def _set_image_clipboard(data: ClipboardData) -> None:
    if OS_NAME == "Darwin":
        _mac_set_image(data)
    elif OS_NAME == "Windows":
        _windows_set_image(data)
    elif OS_NAME == "Linux":
        _linux_set_image(data)
    else:
        raise RuntimeError("Image clipboard unsupported on this platform.")


def _mac_get_image() -> Optional[ClipboardData]:
    script = textwrap.dedent(
        """
        on run argv
            set outPath to POSIX file (item 1 of argv)
            try
                set theData to the clipboard as «class PNGf»
            on error
                return ""
            end try
            set fileRef to open for access outPath with write permission
            set eof of fileRef to 0
            write theData to fileRef
            close access fileRef
            return POSIX path of outPath
        end run
        """
    )
    with tempfile.TemporaryDirectory() as tmp:
        script_path = Path(tmp) / "extract_clipboard.scpt"
        script_path.write_text(script, encoding="utf-8")
        output_path = Path(tmp) / "clipboard.png"
        result = _run_command_capture(
            ["osascript", str(script_path), str(output_path)],
            text_mode=True,
        )
        if not result:
            return None
        if not output_path.exists():
            return None
        data = output_path.read_bytes()
    encoded = base64.b64encode(data).decode("ascii")
    return ClipboardData(kind="image", data=encoded, mime="image/png")


def _mac_set_image(data: ClipboardData) -> None:
    if data.mime and data.mime != "image/png":
        raise ValueError("macOS clipboard only accepts PNG payloads in this implementation.")
    raw = base64.b64decode(data.data)
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        tmp.write(raw)
        tmp_path = Path(tmp.name)
    script = textwrap.dedent(
        """
        on run argv
            set inPath to POSIX file (item 1 of argv)
            set the clipboard to (read inPath as «class PNGf»)
        end run
        """
    )
    script_path = tmp_path.with_suffix(".scpt")
    try:
        script_path.write_text(script, encoding="utf-8")
        _run_command_capture(["osascript", str(script_path), str(tmp_path)], text_mode=True)
    finally:
        if tmp_path.exists():
            tmp_path.unlink()
        if script_path.exists():
            script_path.unlink()


def _windows_get_image() -> Optional[ClipboardData]:
    script = textwrap.dedent(
        """
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $image = [Windows.Forms.Clipboard]::GetImage()
        if ($image -eq $null) { return "" }
        $path = [System.IO.Path]::GetTempFileName() + ".png"
        $image.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
        Write-Output $path
        """
    )
    result = _run_command_capture(
        ["powershell", "-NoProfile", "-Command", script],
        text_mode=True,
    )
    if not result:
        return None
    path = Path(result.strip())
    if not path.exists():
        return None
    data = path.read_bytes()
    try:
        path.unlink()
    except OSError:
        pass
    encoded = base64.b64encode(data).decode("ascii")
    return ClipboardData(kind="image", data=encoded, mime="image/png")


def _windows_set_image(data: ClipboardData) -> None:
    if data.mime and data.mime != "image/png":
        raise ValueError("Windows clipboard helper expects PNG payloads.")
    raw = base64.b64decode(data.data)
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        tmp.write(raw)
        tmp_path = Path(tmp.name)
    script = textwrap.dedent(
        """
        Param([string]$imagePath)
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $img = [System.Drawing.Image]::FromFile($imagePath)
        [Windows.Forms.Clipboard]::SetImage($img)
        $img.Dispose()
        """
    )
    try:
        _run_command_capture(
            ["powershell", "-NoProfile", "-Command", script, str(tmp_path)],
            text_mode=True,
        )
    finally:
        if tmp_path.exists():
            tmp_path.unlink()


def _linux_get_image() -> Optional[ClipboardData]:
    commands = [
        ["wl-paste", "--type", "image/png"],
        ["xclip", "-selection", "clipboard", "-t", "image/png", "-out"],
    ]
    for cmd in commands:
        blob = _run_command_capture(cmd)
        if blob:
            encoded = base64.b64encode(blob).decode("ascii")
            return ClipboardData(kind="image", data=encoded, mime="image/png")
    return None


def _linux_set_image(data: ClipboardData) -> None:
    payload = base64.b64decode(data.data)
    commands = [
        ["wl-copy", "--type", "image/png"],
        ["xclip", "-selection", "clipboard", "-t", "image/png", "-in"],
    ]
    for cmd in commands:
        result = _run_command_capture(cmd, input_data=payload)
        if result is not None:
            return
    raise RuntimeError("No clipboard image utility (wl-copy/xclip) available.")


# --------------------------------------------------------------------------- #
# Utility helpers


def _run_command_capture(
    command: Iterable[str],
    input_data: Optional[Union[bytes, str]] = None,
    text_mode: bool = False,
    timeout: int = 5,
) -> Optional[Union[str, bytes]]:
    if text_mode and isinstance(input_data, bytes):
        input_value: Optional[Union[bytes, str]] = input_data.decode("utf-8", errors="ignore")
    else:
        input_value = input_data
    try:
        result = subprocess.run(
            list(command),
            input=input_value,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
            check=False,
            text=text_mode,
        )
    except (FileNotFoundError, subprocess.SubprocessError, TimeoutError):
        return None
    if result.returncode != 0:
        return None
    return result.stdout


def _first_success(commands: Iterable[List[str]], decode: bool = False) -> Optional[str]:
    for cmd in commands:
        output = _run_command_capture(cmd)
        if output:
            if decode:
                return output.decode("utf-8", errors="replace")
            return output
    return None
