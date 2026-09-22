#!/usr/bin/env python3
"""Regenerate the opencode-prs README assets from a live OpenCode 2 TUI.

    pnpm build
    python3 scripts/screenshots/prs.py            # both themes
    python3 scripts/screenshots/prs.py dark       # one theme

Needs: opencode 2 (background service running), tmux, Google Chrome, ImageMagick
(`magick`), gifsicle. Python 3 standard library only.

How it works:
1. Imports a fake session through `POST /api/experimental/session/import`
   whose transcript contains four `gh pr create` shell calls, so the sidebar
   lists four PRs. `scripts/screenshots/gh` shadows the real `gh` on PATH and
   answers the batched GraphQL query with canned data that covers approved +
   checks passing, waiting + comments + checks failing, draft + checks pending,
   and merged (folded behind the `▸ 1 merged` line).
2. Starts `opencode --session ...` inside a detached tmux pane with a private
   XDG_CONFIG_HOME so the theme mode and plugin list do not touch ~/.config.
3. Captures the pane with `tmux capture-pane -e` (keeps the SGR colors), then
   injects SGR mouse-motion events at the first title so the real hover
   marquee runs, sampling one capture per marquee step.
4. Renders each capture to a 1280px wide PNG with headless Chrome: IBM Plex Mono
   from Google Fonts, 29px cells, 59px lines, panel at (74,73), same geometry
   as the earlier hand-made assets. A cursor SVG is placed on the lower half
   of the first title for the animation frames.
5. Assembles the GIF: 1.1s rest, 120ms per marquee step, 2.1s rest, plays once.

Outputs assets/prs-<mode>.png and assets/prs-hover-<mode>-v4.gif.
Bump the gif suffix (and the README references) when the animation changes:
GitHub caches by filename.
"""
import glob, html, json, os, re, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
ASSETS = os.path.join(ROOT, "assets")
PLUGIN = os.path.join(ROOT, "packages/prs/dist")
SESSION = "ses_screenshots0000000000prs"
GIF_SUFFIX = "v4"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

PR_URLS = [  # order of creation, sidebar sorts them itself
    "https://github.com/vvo/opencode-plugins/pull/35",
    "https://github.com/vvo/opencode-plugins/pull/39",
    "https://github.com/vvo/tzdb/pull/212",
    "https://github.com/vvo/opencode-plugins/pull/37",
]
FIRST_TITLE = "[opencode-prs] Show"   # top row after sorting, gets hovered
LAST_META = "▸ 1 merged"              # bottom row, proves everything rendered

# Render geometry (matches the previous assets)
COLS, ROWS = 38, 8
CELL_W, CELL_H = 29, 59
PAD_X, PAD_Y = 74, 73
FONT_PX = 46
PANEL_W = 1132
PAGE_H = PAD_Y + ROWS * CELL_H + 70
CURSOR = (20.4, 1.55)  # cell units from the "▼": lower half of the first title
CURSOR_SVG = """<svg xmlns="http://www.w3.org/2000/svg" width="28" height="42" viewBox="0 0 14 21">
<path d="M1 1 L1 16 L4.6 12.6 L7.4 19.2 L10 18.1 L7.3 11.6 L12.2 11.6 Z" fill="#fff" stroke="#000" stroke-width="1.1" stroke-linejoin="round"/>
</svg>"""

SGR = re.compile(r"\x1b\[([0-9;]*)m")
OSC = re.compile(r"\x1b\]8;[^\x1b]*\x1b\\")
TMUX = ["tmux", "-L", "opencode-shots"]


def run(*args, **kw):
    return subprocess.run(list(args), check=True, capture_output=True, text=True, **kw).stdout


def tmux(*args):
    return run(*TMUX, *args)


def delete_session():
    subprocess.run(["opencode", "api", "delete", f"/api/session/{SESSION}"], capture_output=True)


def import_session(work):
    base = int(time.time() * 1000)
    messages = [{"id": "msg_screenshots000000000000u", "time": {"created": base}, "text": "Open the PRs",
                 "files": [], "agents": [], "type": "user"}]
    for i, url in enumerate(PR_URLS):
        t = base + 1000 * (i + 1)
        messages.append({
            "id": f"msg_screenshots00000000000a{i}", "time": {"created": t, "completed": t + 500},
            "type": "assistant", "agent": "build",
            "model": {"id": "anthropic/claude-sonnet-4", "providerID": "anthropic"},
            "content": [{
                "type": "tool", "id": f"toolu_screenshots{i}", "name": "shell", "executed": False,
                "time": {"created": t, "ran": t + 10, "completed": t + 400},
                "state": {"status": "completed",
                          "input": {"command": "gh pr create --fill", "workdir": work},
                          "content": [{"type": "text", "text": url + "\n"}]},
            }],
            "finish": "tool-calls",
        })
    doc = {"info": {"id": SESSION, "projectID": "screenshots", "agent": "build",
                    "model": {"id": "anthropic/claude-sonnet-4", "providerID": "anthropic"},
                    "cost": 0, "tokens": {"input": 0, "output": 0, "reasoning": 0, "cache": {"read": 0, "write": 0}},
                    "outcome": "succeeded", "time": {"created": base, "updated": base},
                    "title": "opencode-prs screenshots", "location": {"directory": work}},
           "messages": messages}
    delete_session()
    run("opencode", "api", "post", "/api/experimental/session/import", "--data", json.dumps(doc))


def write_launcher(work, mode):
    xdg = os.path.join(work, "xdg", "opencode")
    os.makedirs(xdg, exist_ok=True)
    json.dump({
        "$schema": "https://opencode.ai/v2/cli.json",
        "theme": {"name": "opencode", "mode": mode},
        "plugins": ["-opencode.sidebar.context", PLUGIN],
        "tabs": {"enabled": False},
        "attention": {"notifications": False, "sound": False},
    }, open(os.path.join(xdg, "cli.json"), "w"), indent=2)
    launcher = os.path.join(work, f"launch-{mode}.sh")
    open(launcher, "w").write(f"""#!/bin/sh
export PATH="{HERE}:$PATH"
export XDG_CONFIG_HOME="{os.path.join(work, 'xdg')}"
cd "{work}"
exec opencode --session {SESSION}
""")
    os.chmod(launcher, 0o755)
    return launcher


def capture_frames(launcher, outdir):
    os.makedirs(outdir, exist_ok=True)
    subprocess.run(TMUX + ["kill-server"], capture_output=True)
    tmux("new-session", "-d", "-s", "shots", "-x", "160", "-y", "45", f"{launcher}; sleep 600")
    plain = lambda: tmux("capture-pane", "-t", "shots", "-p").split("\n")
    styled = lambda: tmux("capture-pane", "-t", "shots", "-p", "-e")
    for _ in range(60):
        time.sleep(0.5)
        rows = plain()
        if any("PRs (4)" in r for r in rows) and any(LAST_META in r for r in rows):
            break
    else:
        sys.exit("sidebar did not render, is the background service up and the plugin built?")
    time.sleep(1.5)
    rows = plain()
    row = next(i for i, r in enumerate(rows) if FIRST_TITLE in r) + 1
    col = rows[row - 1].index(FIRST_TITLE) + 1
    open(os.path.join(outdir, "still.ansi"), "w").write(styled())

    # two SGR mouse-motion events on the title, then wait past the 500ms hover delay
    for dx in (16, 17):
        tmux("send-keys", "-t", "shots", "-l", f"\x1b[<35;{col + dx};{row}M")
        time.sleep(0.1)
    time.sleep(0.5)
    frames = []
    deadline = time.time() + 15
    while time.time() < deadline:
        snap = styled()
        key = snap.split("\n")[row - 1]
        if not frames or key != frames[-1][0]:
            frames.append((key, snap))
        if len(frames) > 3 and key == frames[0][0]:
            break
        time.sleep(0.06)
    subprocess.run(TMUX + ["kill-server"], capture_output=True)
    for i, (_, snap) in enumerate(frames):
        open(os.path.join(outdir, f"frame-{i:02d}.ansi"), "w").write(snap)
    return len(frames)


def parse_cells(line):
    fg = bg = None
    bold = False
    cells = []
    pos = 0
    line = OSC.sub("", line)
    while pos < len(line):
        m = SGR.match(line, pos)
        if m:
            params = [int(p) for p in m.group(1).split(";") if p] or [0]
            i = 0
            while i < len(params):
                p = params[i]
                if p == 0: fg = bg = None; bold = False
                elif p == 1: bold = True
                elif p == 22: bold = False
                elif p == 39: fg = None
                elif p == 49: bg = None
                elif p in (38, 48) and params[i + 1:i + 2] == [2]:
                    color = "#%02x%02x%02x" % tuple(params[i + 2:i + 5])
                    if p == 38: fg = color
                    else: bg = color
                    i += 4
                i += 1
            pos = m.end()
            continue
        if line[pos] != "\x1b":
            cells.append((line[pos], fg, bg, bold))
        pos += 1
    return cells


def to_html(capture, cursor):
    lines = [parse_cells(l) for l in open(capture, encoding="utf8").read().split("\n")]
    header = next(i for i, l in enumerate(lines) if "PRs (" in "".join(c[0] for c in l))
    text = "".join(c[0] for c in lines[header])
    col0 = text.index("▼")
    panel_bg = lines[header][col0][2]
    page_bg = lines[header][col0 - 3][2]

    def span(ch, fg, bg, bold):
        style = ";".join(filter(None, [f"color:{fg}" if fg else "", "font-weight:700" if bold else ""]))
        return f'<span style="{style}">{html.escape(ch)}</span>' if style else html.escape(ch)

    body = []
    for row in lines[header:header + ROWS]:
        cells = row[col0:col0 + COLS]
        cells += [(" ", None, panel_bg, False)] * (COLS - len(cells))
        body.append("".join(span(*c) for c in cells))
    cursor_html = ""
    if cursor:
        x, y = PAD_X + cursor[0] * CELL_W, PAD_Y + cursor[1] * CELL_H
        cursor_html = f'<img src="cursor.svg" style="position:absolute;left:{x:.0f}px;top:{y:.0f}px;width:28px;height:42px">'
    return f"""<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
html,body{{margin:0;background:{page_bg};width:1280px;height:{PAGE_H}px;overflow:hidden}}
#panel{{position:absolute;left:{PAD_X}px;top:{PAD_Y}px;width:{PANEL_W}px;height:{ROWS * CELL_H - 5}px;background:{panel_bg}}}
pre{{position:absolute;left:{PAD_X + 26}px;top:{PAD_Y - 9}px;margin:0;color:{panel_bg};letter-spacing:{CELL_W - FONT_PX * 0.6}px;
    font:400 {FONT_PX}px/{CELL_H}px 'IBM Plex Mono',monospace;-webkit-font-smoothing:antialiased;white-space:pre}}
</style></head><body><div id="panel"></div><pre>{chr(10).join(body)}</pre>{cursor_html}</body></html>"""


def render(captures, outdir, cursor=None):
    os.makedirs(outdir, exist_ok=True)
    open(os.path.join(outdir, "cursor.svg"), "w").write(CURSOR_SVG)
    pngs = []
    for capture in captures:
        name = os.path.splitext(os.path.basename(capture))[0]
        page = os.path.join(outdir, f"{name}.html")
        open(page, "w", encoding="utf8").write(to_html(capture, cursor))
        png = os.path.join(outdir, f"{name}.png")
        run(CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--virtual-time-budget=5000",
            "--force-device-scale-factor=1", f"--window-size=1280,{PAGE_H}", f"--screenshot={png}", f"file://{page}")
        pngs.append(png)
    return pngs


def build(mode, work):
    print(f"[{mode}] capturing")
    launcher = write_launcher(work, mode)
    cap = os.path.join(work, f"cap-{mode}")
    count = capture_frames(launcher, cap)
    print(f"[{mode}] rendering still + {count} frames")
    out = os.path.join(work, f"out-{mode}")
    still = render([os.path.join(cap, "still.ansi")], out)[0]
    rest = render([os.path.join(cap, "still.ansi")], os.path.join(out, "rest"), CURSOR)[0]
    frames = render(sorted(glob.glob(os.path.join(cap, "frame-*.ansi"))), os.path.join(out, "hover"), CURSOR)
    png = os.path.join(ASSETS, f"prs-{mode}.png")
    gif = os.path.join(ASSETS, f"prs-hover-{mode}-{GIF_SUFFIX}.gif")
    shutil.copy(still, png)
    run("magick", "-dispose", "none", "-delay", "112", rest, "-delay", "12", *frames, "-delay", "212", rest,
        "-loop", "1", "-layers", "optimize", gif)
    run("gifsicle", "--batch", "-O3", gif)
    print(f"[{mode}] wrote {png} and {gif}")


def main():
    modes = sys.argv[1:] or ["light", "dark"]
    if not os.path.isdir(PLUGIN):
        sys.exit("packages/prs/dist missing, run pnpm build first")
    work = tempfile.mkdtemp(prefix="opencode-prs-shots-")
    print(f"work dir {work}")
    import_session(work)
    for mode in modes:
        build(mode, work)
    delete_session()


if __name__ == "__main__":
    main()
