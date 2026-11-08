#!/usr/bin/env python3
"""Regenerate the opencode-cost-details README assets from a live OpenCode 2 TUI.

    pnpm build
    python3 scripts/screenshots/cost-details.py            # both themes
    python3 scripts/screenshots/cost-details.py dark       # one theme

Needs: opencode 2 (background service running) with the `vercel` provider, tmux,
Google Chrome, ImageMagick (`magick`), gifsicle. Python 3 standard library only.
Each theme sends one short prompt to claude-sonnet-5.5, a few cents.

How it works:
1. Imports a fake session through `POST /api/experimental/session/import`: three
   turns on claude-opus-5.5, with and without the `max` variant, carrying made-up
   costs. The session's own model is claude-sonnet-5.5.
2. Starts `opencode --session ...` inside a detached tmux pane with a private
   XDG_CONFIG_HOME that loads the built plugin and hides the built-in Context.
3. Captures the sidebar, then types a prompt and captures the Context block every
   time it changes while sonnet answers: the turn costs move and a third model row
   appears. Only the Context block is kept, so nothing else from the TUI (MCP
   servers, the reply) ends up in the image.
4. Renders each capture with headless Chrome in IBM Plex Mono and assembles the GIF
   with the real delays between frames.

Outputs assets/cost-details-<mode>.png and assets/cost-details-<mode>-<suffix>.gif.
Bump GIF_SUFFIX (and the README references) when the animation changes: GitHub
caches by filename.
"""
import html, json, os, re, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
ASSETS = os.path.join(ROOT, "assets")
PLUGIN = os.path.join(ROOT, "packages/cost-details/dist")
SESSION = "ses_screenshots00000000costs"
GIF_SUFFIX = "v1"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TMUX = ["tmux", "-L", "opencode-cost-shots"]
COLS, ROWS = 160, 45
CELL_W, CELL_H, FONT_PX, MARGIN = 12, 24, 20, 28
PROMPT = "In one sentence, what does a token bucket rate limiter do?"
OPUS = {"id": "anthropic/claude-opus-5.5", "providerID": "vercel"}
SONNET = {"id": "anthropic/claude-sonnet-5.5", "providerID": "vercel"}

# ("user", text) or ("assistant", variant, cost)
TRANSCRIPT = [
    ("user", "Move the rate limiter to Redis"),
    ("assistant", "max", 31.20),
    ("assistant", "max", 28.70),
    ("user", "Add tests for the limits"),
    ("assistant", "max", 32.43),
    ("assistant", None, 10.53),
    ("user", "Explain the retry logic"),
    ("assistant", None, 7.12),
]


def run(*args, **kw):
    return subprocess.run(list(args), check=True, capture_output=True, text=True, **kw).stdout


def tmux(*args):
    return run(*TMUX, *args)


def delete_session():
    subprocess.run(["opencode", "api", "delete", f"/api/session/{SESSION}"], capture_output=True)


def import_session(work):
    base = int(time.time() * 1000) - 3_600_000
    messages, at = [], base
    for index, item in enumerate(TRANSCRIPT):
        at += 60_000
        if item[0] == "user":
            messages.append({"id": f"msg_shotcost{index:02d}u", "time": {"created": at}, "text": item[1],
                             "files": [], "agents": [], "type": "user"})
            continue
        _, variant, cost = item
        model = dict(OPUS, **({"variant": variant} if variant else {}))
        messages.append({
            "id": f"msg_shotcost{index:02d}a", "time": {"created": at, "completed": at + 500},
            "type": "assistant", "agent": "build", "model": model, "cost": cost,
            "tokens": {"input": 2_000, "output": 800, "reasoning": 0, "cache": {"read": 21_000 + index * 600, "write": 3_000}},
            "content": [{"type": "text", "text": "Done."}], "finish": "stop",
        })
    doc = {"info": {"id": SESSION, "projectID": "screenshots", "agent": "build", "model": SONNET,
                    "cost": round(sum(i[2] for i in TRANSCRIPT if i[0] == "assistant"), 2),
                    "tokens": {"input": 0, "output": 0, "reasoning": 0, "cache": {"read": 0, "write": 0}},
                    "outcome": "succeeded", "time": {"created": base, "updated": at},
                    "title": "cost-details screenshots", "location": {"directory": work}},
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
        "session": {"sidebar": "auto"},
        "tabs": {"enabled": False},
        "attention": {"notifications": False, "sound": False},
    }, open(os.path.join(xdg, "cli.json"), "w"), indent=2)
    launcher = os.path.join(work, f"launch-{mode}.sh")
    open(launcher, "w").write(f"""#!/bin/sh
export XDG_CONFIG_HOME="{os.path.join(work, 'xdg')}"
cd "{work}"
exec opencode --session {SESSION}
""")
    os.chmod(launcher, 0o755)
    return launcher


SGR = re.compile(r"\x1b\[([0-9;:]*)m")
OSC = re.compile(r"\x1b\]8;[^\x1b]*\x1b\\")


def plain(capture):
    return [re.sub(r"\x1b\[[0-9;:]*m", "", OSC.sub("", l)) for l in capture.split("\n")]


def block(capture):
    """(top, bottom, left) of the Context block in the sidebar, or None while it is not there yet."""
    lines = plain(capture)
    top = next((i for i, l in enumerate(lines) if re.search(r"\bContext\s*$", l)), None)
    if top is None:
        return None
    bottom = next((i for i in range(top, min(top + 12, len(lines))) if "current $" in lines[i]), None)
    if bottom is None:
        return None
    return top, bottom, lines[top].rindex("Context")


def cells(line):
    fg = bg = None
    bold = False
    out, pos = [], 0
    line = OSC.sub("", line)
    while pos < len(line):
        m = SGR.match(line, pos)
        if m:
            params = [int(p) for p in re.split("[;:]", m.group(1)) if p] or [0]
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
            out.append((line[pos], fg, bg, bold))
        pos += 1
    return out


def capture(launcher):
    subprocess.run(TMUX + ["kill-server"], capture_output=True)
    tmux("new-session", "-d", "-s", "shots", "-x", str(COLS), "-y", str(ROWS), f"{launcher}; sleep 600")
    styled = lambda: tmux("capture-pane", "-t", "shots", "-p", "-e")
    try:
        deadline = time.time() + 30
        while time.time() < deadline and not (block(styled()) and "max" in styled()):
            time.sleep(0.3)
        else:
            if time.time() >= deadline:
                sys.exit("Context block did not render, is the background service up and the plugin built?")
        time.sleep(2)
        still = styled()
        tmux("send-keys", "-t", "shots", "-l", PROMPT)
        time.sleep(0.3)
        tmux("send-keys", "-t", "shots", "Enter")

        def key(snap):
            found = block(snap)
            lines = plain(snap)
            return "\n".join(l[found[2]:] for l in lines[found[0]:found[1] + 1]) if found else None

        frames = [(time.time(), still)]
        last_change, started = time.time(), False
        deadline = time.time() + 120
        while time.time() < deadline:
            snap = styled()
            if key(snap) and key(snap) != key(frames[-1][1]):
                frames.append((time.time(), snap))
                last_change, started = time.time(), True
            # sonnet gets its own row once its first cost lands; stop when the turn settles
            if started and "sonnet" in snap and time.time() - last_change > 6:
                break
            time.sleep(0.1)
        else:
            sys.exit("the turn never finished, check the vercel provider")
        return still, frames
    finally:
        subprocess.run(TMUX + ["kill-server"], capture_output=True)


def render(capture, out, frame, width, page_bg, default_fg, work):
    top, bottom, left = frame
    lines = [cells(l) for l in capture.split("\n")]
    rows = []
    for row in lines[top:bottom + 1]:
        row = row + [(" ", None, None, False)] * (left + width - len(row))
        rows.append(row[left:left + width])
    panel_bg = next((c[2] for r in rows for c in r if c[2]), page_bg)

    def span(ch, fg, bg, bold):
        style = f"color:{fg or default_fg}" + (";font-weight:700" if bold else "")
        return f'<span style="{style}">{html.escape(ch)}</span>'

    body = "\n".join("".join(span(*cell) for cell in row) for row in rows)
    w = len(rows[0]) * CELL_W + 2 * MARGIN
    h = len(rows) * CELL_H + 2 * MARGIN
    page = os.path.join(work, os.path.splitext(os.path.basename(out))[0] + ".html")
    open(page, "w", encoding="utf8").write(f"""<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>html,body{{margin:0;background:{panel_bg}}}
pre{{margin:{MARGIN}px;font:400 {FONT_PX}px/{CELL_H}px 'IBM Plex Mono',monospace;white-space:pre;
letter-spacing:{CELL_W - FONT_PX * 0.6:.2f}px;-webkit-font-smoothing:antialiased}}</style>
</head><body><pre>{body}</pre></body></html>""")
    run(CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--virtual-time-budget=5000",
        "--force-device-scale-factor=2", f"--window-size={w},{h}", f"--screenshot={out}", f"file://{page}")
    return out


def build(mode, work):
    print(f"[{mode}] importing and capturing")
    import_session(work)
    still, frames = capture(write_launcher(work, mode))
    page_bg, fg = ("#ffffff", "#1a1a1a") if mode == "light" else ("#0a0a0a", "#eeeeee")
    # One crop for every frame, tall enough for the largest block, so the GIF does not jump.
    found = [block(snap) for _, snap in frames]
    top = found[0][0]
    height = max(b - t for t, b, _ in found)
    left = found[0][2] - 1
    width = max(max(len(l.rstrip()) for l in plain(snap)[t:b + 1]) for (_, snap), (t, b, _) in zip(frames, found)) - left + 2
    still_png = render(still, os.path.join(ASSETS, f"cost-details-{mode}.png"), (top, found[0][1], left), width, page_bg, fg, work)
    pngs = []
    for index, (_, snap) in enumerate(frames):
        t = block(snap)[0]
        pngs.append(render(snap, os.path.join(work, f"{mode}-{index:03d}.png"), (t, t + height, left), width, page_bg, fg, work))
    args = []
    for index, png in enumerate(pngs):
        if index + 1 < len(frames):
            delay = min(250, max(8, round((frames[index + 1][0] - frames[index][0]) * 100)))
            delay = max(delay, 200) if index == 0 else delay
        else:
            delay = 300
        args += ["-delay", str(delay), png]
    gif = os.path.join(ASSETS, f"cost-details-{mode}-{GIF_SUFFIX}.gif")
    run("magick", *args, "-loop", "0", "-layers", "optimize", gif)
    run("gifsicle", "--batch", "-O3", gif)
    print(f"[{mode}] wrote {still_png} and {gif} ({len(frames)} frames)")


def main():
    modes = sys.argv[1:] or ["light", "dark"]
    if not os.path.isdir(PLUGIN):
        sys.exit("packages/cost-details/dist missing, run pnpm build first")
    work = os.path.realpath(tempfile.mkdtemp(prefix="opencode-cost-shots-"))
    run("git", "init", "-q", "-b", "main", work)
    print(f"work dir {work}")
    try:
        for mode in modes:
            build(mode, work)
    finally:
        delete_session()


if __name__ == "__main__":
    main()
