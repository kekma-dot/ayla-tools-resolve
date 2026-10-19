<p align="center"><img src="assets/banner.png" alt="Ayla Resolve" width="100%"></p>

# Ayla Resolve

A local companion for [Pi](https://pi.dev) that reads a DaVinci Resolve Studio project, shares the current frame with your agent, and moves through a small, allowlisted part of the interface.

[Русский](README.ru.md) · [Ayla tools](https://github.com/kekma-dot/ayla-tools) · [MIT](LICENSE)

> Experimental, macOS only. Native recipes need Resolve MCP **21.1.1 with the exact qualified schema**; other versions get status diagnostics only. It will not cut or grade a film for you.

## Install

You need macOS, Node **22.19+**, Pi **1.3.0**, Git, and a licensed local DaVinci Resolve Studio that includes `ResolveMCP`.

In a terminal, not in the Pi chat:

```sh
pi install git:github.com/kekma-dot/ayla-tools-resolve
```

Start Pi, or run `/reload` in a running session. Open Resolve yourself, then type in Pi:

```text
/resolve status
```

The default native binary is:

```text
/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Applications/ResolveMCP
```

For another installation, give an absolute path when starting Pi:

```sh
RESOLVE_MCP_PATH="/absolute/path/to/ResolveMCP" pi
```

Installing does not launch Resolve, change your project or grant macOS permissions. GUI tools need Accessibility; window screenshots may also need Screen Recording. API-only calls need neither.

## Use

- "Check whether my Resolve installation is supported."
- "Summarize the open project, then list the first 20 video clips on track 1."
- "Show the current timeline frame without moving the playhead."
- "Draft a copy of this timeline with Blue markers at relative frames 0 and 120. Do not apply it."

| Tool or command | What it does |
|---|---|
| `resolve_inspect` | Status, project and timeline summary, bounded track listing |
| `resolve_preview` | Exports the current frame to a private temporary PNG, sends it to the model, deletes the file |
| `resolve_control` | Reads windows and permissions, screenshots one verified Resolve window, opens allowlisted top-level menus, switches the workspace page |
| `resolve_plan` | Drafts a timeline copy with up to 50 Blue markers and changes nothing |
| `/resolve pending` | Shows an unresolved operation receipt |
| `/resolve apply DIGEST` | Applies a draft: copies the timeline, adds the markers, saves the project |

Marker frames are integer offsets from the timeline start, not timecodes or vendor frame values. A draft expires after ten minutes. Applying saves all unsaved project work, and a copied timeline can share media and grades with the original. Back up the project before trying it.

`/resolve apply` is a human step. You type the digest and approve it in the Pi UI; the model cannot approve its own plan.

## Limits

- No script execution, clicks, key injection, cuts, transcription, audio processing, grading, Fusion or movie rendering. Opening a menu does not run its items.
- Keep the GUI and the playhead still while a frame is captured. Colour, effects and compositing fidelity are not live-qualified.
- A changed native version or schema fails closed. Do not edit the hash to get a newer version past it.
- A timeout after dispatch is an unknown outcome. Do not retry or replay the mutation. Check `/resolve pending` and the real project first, and keep the receipt.
- Linux runs the portable unit and loader tests but cannot use this native backend. Windows is not qualified.
- Tests use synthetic native servers and cover cancellation, cleanup, schema mismatch, no retry, GUI scope and operator approval. They do not certify a real project or a physical editing result.
- Live status has been run against a real Resolve installation. Preview and mutation have not been run.

## Privacy

ResolveMCP runs locally as a short-lived child process of the extension. Project and clip names returned to Pi become part of the model conversation. Requested frames and window screenshots go to your active model provider and can contain file names or dialogs, so only ask for captures you are allowed to share.

Native stderr is not forwarded to chat, and preview files are temporary. Operation receipts are local files under `${XDG_STATE_HOME:-$HOME/.local/state}/pi-davinci-resolve/` and stay there after uninstall. These guards reduce accidental misuse; they are not an OS sandbox.

## Remove or disable

```sh
pi remove git:github.com/kekma-dot/ayla-tools-resolve
```

Then run `/reload`. To disable without removing, use `pi config`, or filter the package with `"extensions": []`. Do not install it next to another package that registers the same `resolve_*` tools or the `/resolve` command.

## Development

```sh
npm ci --ignore-scripts
PI_TEST_SDK_ROOT="$PWD/node_modules/@earendil-works/pi-coding-agent" npm test
```

The tested host baseline is Pi 1.3.0, and the wildcard peer dependencies are Pi's host mapping rather than a compatibility promise. CI runs the same checks on macOS and Linux, skipping the macOS-only cases on Linux. Live Resolve use is a manual smoke test.

## License and credits

MIT, see [LICENSE](LICENSE). Part of Ayla tools by Dmitry / `kekma-dot`. DaVinci Resolve is a Blackmagic Design product; this project is independent and not endorsed by Blackmagic Design or Pi.
