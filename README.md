<p align="center"><img src="assets/banner.png" alt="Ayla Resolve — MOTH in a moonlit editing studio" width="100%"></p>

# Ayla Resolve

**A thoughtful view into your timeline.** A small, local DaVinci Resolve Studio companion for [Pi](https://pi.dev): inspect projects, share the current frame with your agent, and navigate a deliberately limited part of the interface.

[Русский](README.ru.md) · [Ayla tools](https://github.com/kekma-dot/ayla-tools) · [MIT](LICENSE)

> **Experimental, macOS only.** This is not an autonomous video editor. Native recipes require Resolve MCP **21.1.1 and the exact qualified schema**. Other versions get status diagnostics only. No personal Ayla server, profile or account is needed.

## Install in ordinary Pi

You need Node **22.19+**, Pi **1.3.0**, and a licensed local DaVinci Resolve Studio installation that includes `ResolveMCP`. Git must be available. These are prerequisites, not bundled software.

In your terminal (not the Pi chat), run:

```sh
pi install git:github.com/kekma-dot/ayla-tools-resolve
```

Then start Pi, or run `/reload` inside an existing Pi session. Open Resolve manually. In Pi, type:

```text
/resolve status
```

The default native binary is:

```text
/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Applications/ResolveMCP
```

For a different installation, start Pi with an **absolute** binary path:

```sh
RESOLVE_MCP_PATH="/absolute/path/to/ResolveMCP" pi
```

The command does not automatically launch Resolve, modify your project, or grant macOS permissions. GUI tools need the operating system's Accessibility permission; window screenshots may also need Screen Recording permission. Grant only permissions you intend to use. Permissions are not required for every API-only operation.

## Ask your agent

- “Check whether my Resolve installation is supported.”
- “Summarize the open project, then list the first 20 video clips on track 1.”
- “Show the current timeline frame. Do not move the playhead.”
- “Draft a copy of this timeline with Blue review markers at relative frames 0 and 120. Do not apply it.”

| Tool / command | What it does |
|---|---|
| `resolve_inspect` | Status, current project/timeline summary, bounded track listing |
| `resolve_preview` | Exports the current frame to a private temporary PNG, returns it to the model, removes the file |
| `resolve_control` | Reads Resolve windows/permissions, screenshots one verified Resolve window, opens allowlisted top-level menus, switches workspace page |
| `resolve_plan` | Drafts a copy + up to 50 Blue markers; **no mutation** |
| `/resolve pending` | Reads an unresolved operation receipt |
| `/resolve apply DIGEST` | **Human-only UI approval**; creates a new timeline copy, adds markers and saves the current project |

Marker frames are integer **offsets from timeline start**, not timecodes or absolute vendor frame values. Drafts expire after ten minutes. Applying saves **all current unsaved project work**, and copied timelines can share media and grades. Back up your project before trying the experimental mutation recipe.

## Deliberate limits

No arbitrary script execution, mouse clicks, keyboard injection, cuts, transcription, audio processing, grading, Fusion or movie rendering are provided. Opening a top-level menu does not execute its items. The package does not install or configure a separate full scripting MCP.

- Keep the GUI/playhead still while capturing a frame. Display/color/composite fidelity is not fully live-qualified.
- Native version/schema changes fail closed. Do not change the hash just to make a newer version pass.
- A timeout after dispatch is an **unknown outcome**, not permission to retry. Inspect `/resolve pending` and the real project before continuing. Never automatically delete the pending record.
- Linux can run portable unit/loader checks but **cannot use this native backend**. Windows is not qualified.
- Tests cover synthetic native servers, cancellation, cleanup, schema mismatch, no retry, scoped GUI input and operator approval; they do **not** certify every real project or physical editing result.

## Privacy and security

ResolveMCP runs locally as a short-lived owned child process. There is no Ayla backend and no telemetry service. Project/clip names returned to Pi enter the model conversation. Requested frame/window images go to your **active model provider**, and screenshots may include filenames or dialogs. Only request captures you are allowed to share.

The native stderr stream is not forwarded to chat. Preview files are temporary. Copy-operation receipts are private local files under `${XDG_STATE_HOME:-$HOME/.local/state}/pi-davinci-resolve/`; uninstall does not delete them, your media or projects. Guards reduce accidental misuse; they are not an OS sandbox.

## Remove or disable

```sh
pi remove git:github.com/kekma-dot/ayla-tools-resolve
```

Run `/reload` afterwards. To disable without removing it, use `pi config` and turn off the extension, or set its package filter to `"extensions": []`. Avoid installing this alongside another package registering the same `resolve_*` tools or `/resolve` command.

## Develop and verify

```sh
npm ci --ignore-scripts
PI_TEST_SDK_ROOT="$PWD/node_modules/@earendil-works/pi-coding-agent" npm test
```

The supported host baseline is Pi 1.3.0. Wildcard peer dependencies follow Pi's host-mapping contract; they do not promise compatibility with future Pi releases. CI runs the same checks on macOS and Linux; macOS-only cases are explicitly skipped on Linux. Live Resolve use is a separate manual smoke test, not an automated CI claim.

## Credits

Part of **Ayla tools** by Dmitry / `kekma-dot`. Original MOTH mascot selected by the project owner; banner generated with GPT Image. Code and distributed artwork are provided under [MIT](LICENSE), without exclusivity or suitability guarantees for AI-generated art. DaVinci Resolve is a Blackmagic Design product; this project is independent and not endorsed by Blackmagic Design or Pi.
