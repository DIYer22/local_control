# Local Control

Local Control exposes a lightweight web application that lets you steer the local machine's mouse, send keyboard input, and trigger lock or shutdown actions from any device on the same network. The server is written in pure Python with minimal dependencies and ships with a mobile-friendly frontend.

## Features
- Mouse cursor movement and click controls from touch or pointer devices.
- Keyboard typing and special key presses transmitted to the host.
- Realtime input field streams keystrokes (including Backspace/Delete) as you type.
- Text pad accepts pasted multi-line snippets; send them with the on-page button or ⌘/Ctrl + Enter.
- Desktop browsers capture the local pointer while steering and only release it after you push 10% past a screen edge (with a short 0.1s delay).
- OS-level wake/unlock, lock, and shutdown shortcuts (best-effort across Windows, macOS, Linux).
- Authentication that reuses the current OS account credentials, remembers trusted devices, and rate-limits brute-force attempts.
- CLI launcher for quick startup on custom ports (default `4001`).

## Requirements
- Python 3.9 or newer.
- Desktop environments capable of receiving simulated input (X11/Wayland, Windows, or macOS).
- Linux/X11 hosts require the `libX11` and `libXtst` system libraries (commonly present on desktop distributions; Wayland sessions need XWayland support).
- macOS hosts must grant the Python process accessibility permissions (System Settings → Privacy & Security → Accessibility).

## Installation
```bash
pip install .
```

## Usage
```bash
local-control --port 4001
```

Open `http://<host-ip>:4001` from your phone, tablet, or another computer on the same LAN. Sign in with the current desktop user's username and password. Devices marked as trusted skip future logins under the same secret.

## Notes
- Wake/unlock, shutdown, and lock commands may require additional privileges depending on the operating system and policy.
- Wake/unlock only simulates user activity; if the host is password-protected you must still enter credentials locally or via the typing panel.
- On Linux and macOS the credential check uses a non-interactive `sudo` call, so the current user must be part of the sudoers group.
- The server stores minimal data inside the platform-specific application data directory (see `local_control/config.py`) to remember trusted devices and the secret key used to sign them.
- For production deployment consider running behind HTTPS and a reverse proxy.
