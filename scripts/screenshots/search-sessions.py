#!/usr/bin/env python3
"""Regenerate the opencode-search-sessions README screenshots from a live OpenCode 2 TUI.

    pnpm build
    python3 scripts/screenshots/search-sessions.py            # both themes
    python3 scripts/screenshots/search-sessions.py dark       # one theme

Needs: opencode 2 (background service running), tmux, Google Chrome. Python 3 standard library only.

How it works:
1. Writes a fake OpenCode database (only the tables the plugin reads) with made-up
   sessions, so no real conversation can leak into a public image.
2. Starts `opencode` in a detached tmux pane with a private XDG_CONFIG_HOME whose
   cli.json loads the built plugin with `database` and `index` options pointing at
   the fake database and a throwaway index.
3. Captures the home screen, then opens the search dialog with ctrl+x f, types a
   query and captures the results, with `tmux capture-pane -e` to keep the colors.
4. Crops each capture to the part that matters and renders it with headless Chrome
   in IBM Plex Mono.

Outputs assets/search-sessions-<mode>.png (the dialog) and
assets/search-sessions-home-<mode>.png (the field under the home prompt).
"""
import html, json, os, re, sqlite3, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
ASSETS = os.path.join(ROOT, "assets")
PLUGIN = os.path.join(ROOT, "packages/search-sessions/dist")
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TMUX = ["tmux", "-L", "opencode-search-shots"]
QUERY = "rate limit"
COLS, ROWS = 132, 42
CELL_W, CELL_H, FONT_PX, MARGIN = 12, 24, 20, 28

HOUR = 3_600_000
DAY = 24 * HOUR

# (title, project, hours ago, [(role, text), ...])
SESSIONS = [
    ("Add rate limiting to the checkout API", "acme-api", 2, [
        ("user", "Bots hammer checkout. Can we add rate limiting per IP before we call the payment provider?"),
        ("assistant", "I added a token bucket in middleware/rate-limit.ts: 20 requests per minute per IP. Past the limit, "
                      "checkout answers 429 with a Retry-After header, and the payment provider never sees the request."),
    ]),
    ("Fix the flaky login test on CI", "acme-store", 20, [
        ("user", "The login test fails one run out of five on CI, never on my machine."),
        ("assistant", "The test clicked before the session cookie was set. It now waits for the cookie."),
    ]),
    ("Retry webhooks with exponential backoff", "acme-api", 3 * 24, [
        ("user", "Webhook deliveries fail in bursts when the shipping provider is slow."),
        ("assistant", "Our queue retried instantly and hit the shipping provider's rate limit. Each retry now waits 2^n "
                      "seconds with jitter, capped at ten minutes."),
    ]),
    ("Investigate 429s from the GitHub API", "acme-store", 6 * 24, [
        ("user", "The release script gets 429 errors from GitHub halfway through. Is that a rate limit?"),
        ("assistant", "Yes. Unauthenticated calls share a limit of 60 per hour per IP; the script now sends GITHUB_TOKEN."),
    ]),
    ("Search page feels slow", "acme-store", 9 * 24, [
        ("user", "Typing in the product search lags, and the console shows warnings from the search API."),
        ("assistant", "Every keystroke sent a request, so the search API started to rate limit us. The input now waits "
                      "150 ms and cancels the previous request."),
    ]),
    ("Move sessions to Redis", "acme-api", 15 * 24, [
        ("user", "Can sessions live in Redis instead of Postgres?"),
        ("assistant", "Sessions now live in Redis with a 30 day TTL. The rate limiter keeps its counters there too, "
                      "so limits hold across all three API servers."),
    ]),
    ("Write the pricing page", "acme-store", 26 * 24, [
        ("user", "Draft the copy for the new pricing page: three plans, yearly discount."),
        ("assistant", "Here is a first draft with the three plans side by side and the yearly price below each."),
    ]),
    ("Plan the October newsletter", "blog", 30 * 24, [
        ("user", "What should go in the October newsletter?"),
        ("assistant", "Lead with the faster checkout, then the new search page, then two customer stories."),
    ]),
]
PROJECTS = {"acme-store": "project_acmestore", "acme-api": "project_acmeapi", "blog": "project_blog"}


def run(*args, **kw):
    return subprocess.run(list(args), check=True, capture_output=True, text=True, **kw).stdout


def tmux(*args):
    return run(*TMUX, *args)


def projects_root(work):
    """Project directories. The TUI runs in a short git repo so the prompt footer reads like a real one."""
    store = os.path.join(os.path.realpath("/tmp"), "acme-store")
    if not os.path.isdir(os.path.join(store, ".git")):
        os.makedirs(store, exist_ok=True)
        run("git", "init", "-q", "-b", "main", store)
    return {"acme-store": store, "acme-api": os.path.join(work, "acme-api"), "blog": os.path.join(work, "blog")}


def fake_database(work):
    directories = projects_root(work)
    path = os.path.join(work, "opencode.db")
    db = sqlite3.connect(path)
    db.executescript("""
        CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, name TEXT);
        CREATE TABLE project_directory (project_id TEXT NOT NULL, directory TEXT NOT NULL);
        CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, directory TEXT NOT NULL,
          title TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
        CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
          time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    """)
    for name, project in PROJECTS.items():
        directory = directories[name]
        db.execute("INSERT INTO project VALUES (?, ?, NULL)", (project, directory))
        db.execute("INSERT INTO project_directory VALUES (?, ?)", (project, directory))
    now = int(time.time() * 1000)
    for index, (title, project, hours, messages) in enumerate(SESSIONS):
        updated = now - hours * HOUR
        created = updated - HOUR
        session = f"ses_shots{index:02d}"
        db.execute("INSERT INTO session_v2 VALUES (?, ?, NULL, ?, ?, ?, ?)",
                   (session, PROJECTS[project], directories[project], title, created, updated))
        for number, (role, text) in enumerate(messages):
            data = {"text": text, "files": [], "agents": []} if role == "user" else {"content": [{"type": "text", "text": text}]}
            at = created + (number + 1) * 60_000
            db.execute("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)",
                       (f"msg_shots{index:02d}{number}", session, role, at, at, json.dumps(data)))
    db.commit()
    db.close()
    return path


def write_launcher(work, mode, database):
    xdg = os.path.join(work, "xdg", "opencode")
    os.makedirs(xdg, exist_ok=True)
    json.dump({
        "$schema": "https://opencode.ai/v2/cli.json",
        "theme": {"name": "opencode", "mode": mode},
        "plugins": [{"package": PLUGIN, "options": {"database": database, "index": os.path.join(work, f"index-{mode}.sqlite")}}],
        "tabs": {"enabled": False},
        "attention": {"notifications": False, "sound": False},
    }, open(os.path.join(xdg, "cli.json"), "w"), indent=2)
    project = projects_root(work)["acme-store"]
    launcher = os.path.join(work, f"launch-{mode}.sh")
    open(launcher, "w").write(f"""#!/bin/sh
export XDG_CONFIG_HOME="{os.path.join(work, 'xdg')}"
cd "{project}"
exec opencode
""")
    os.chmod(launcher, 0o755)
    return launcher


def wait_for(text, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if text in tmux("capture-pane", "-t", "shots", "-p"):
            return
        time.sleep(0.3)
    sys.exit(f"timed out waiting for {text!r}; is the background service up and the plugin built?")


def capture(launcher):
    subprocess.run(TMUX + ["kill-server"], capture_output=True)
    tmux("new-session", "-d", "-s", "shots", "-x", str(COLS), "-y", str(ROWS), f"{launcher}; sleep 600")
    try:
        wait_for("Search sessions")
        time.sleep(1.5)
        home = tmux("capture-pane", "-t", "shots", "-p", "-e")
        tmux("send-keys", "-t", "shots", "C-x")
        time.sleep(0.3)
        tmux("send-keys", "-t", "shots", "f")
        wait_for("Search every prompt")
        # The scope toggle is saved in the real OpenCode state: show all projects, then put it back.
        scoped = "Search sessions in " in tmux("capture-pane", "-t", "shots", "-p")
        if scoped:
            tmux("send-keys", "-t", "shots", "C-a")
        tmux("send-keys", "-t", "shots", "-l", QUERY)
        wait_for("sessions ·")
        time.sleep(1)
        dialog = tmux("capture-pane", "-t", "shots", "-p", "-e")
        if scoped:
            tmux("send-keys", "-t", "shots", "C-a")
            time.sleep(0.5)
        return home, dialog
    finally:
        subprocess.run(TMUX + ["kill-server"], capture_output=True)


SGR = re.compile(r"\x1b\[([0-9;:]*)m")
OSC = re.compile(r"\x1b\]8;[^\x1b]*\x1b\\")


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


def crop(capture, top, bottom, left, right):
    lines = [cells(l) for l in capture.split("\n")]
    rows = []
    for row in lines[top:bottom + 1]:
        row = row + [(" ", None, None, False)] * (right + 1 - len(row))
        rows.append(row[left:right + 1])
    return rows


def find(capture, text, start=0):
    plain = [re.sub(r"\x1b\[[0-9;:]*m", "", OSC.sub("", l)) for l in capture.split("\n")]
    for index in range(start, len(plain)):
        if text in plain[index]:
            return index, plain[index].index(text)
    sys.exit(f"{text!r} not found in the capture")


def render(rows, out, page_bg, default_fg, work):
    def span(ch, fg, bg, bold):
        style = f"color:{fg or default_fg};background:{bg or page_bg}" + (";font-weight:700" if bold else "")
        return f'<span style="{style}">{html.escape(ch)}</span>'

    body = "\n".join("".join(span(*cell) for cell in row) for row in rows)
    width = len(rows[0]) * CELL_W + 2 * MARGIN
    height = len(rows) * CELL_H + 2 * MARGIN
    page = os.path.join(work, os.path.splitext(os.path.basename(out))[0] + ".html")
    open(page, "w", encoding="utf8").write(f"""<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>html,body{{margin:0;background:{page_bg}}}
pre{{margin:{MARGIN}px;font:400 {FONT_PX}px/{CELL_H}px 'IBM Plex Mono',monospace;white-space:pre;
letter-spacing:{CELL_W - FONT_PX * 0.6:.2f}px;-webkit-font-smoothing:antialiased}}</style>
</head><body><pre>{body}</pre></body></html>""")
    run(CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--virtual-time-budget=5000",
        "--force-device-scale-factor=2", f"--window-size={width},{height}", f"--screenshot={out}", f"file://{page}")


def build(mode, work, database):
    print(f"[{mode}] capturing")
    home, dialog = capture(write_launcher(work, mode, database))
    page_bg, fg = ("#ffffff", "#1a1a1a") if mode == "light" else ("#0a0a0a", "#eeeeee")

    # The dialog: from the row above its header to the row below its footer, edge to edge.
    header, _ = find(dialog, "Search sessions")
    footer, _ = find(dialog, "ctrl+a", header)
    width = min(116, COLS - 2)
    left = (COLS - width) // 2
    dialog_png = os.path.join(ASSETS, f"search-sessions-{mode}.png")
    render(crop(dialog, header - 1, footer + 1, left, left + width - 1), dialog_png, page_bg, fg, work)

    # Home: the prompt, its footer line and the search field under it. The field's bar sits
    # three cells before its text, in the prompt's column; the prompt is at most 75 wide.
    field, column = find(home, "Search sessions")
    prompt, _ = find(home, "Ask anything")
    home_png = os.path.join(ASSETS, f"search-sessions-home-{mode}.png")
    render(crop(home, prompt - 2, field + 1, column - 5, column + 73), home_png, page_bg, fg, work)
    print(f"[{mode}] wrote {dialog_png} and {home_png}")


def main():
    modes = sys.argv[1:] or ["light", "dark"]
    if not os.path.isdir(PLUGIN):
        sys.exit("packages/search-sessions/dist missing, run pnpm build first")
    # Resolved, so session directories match the TUI's cwd (/var is a symlink on macOS).
    work = os.path.realpath(tempfile.mkdtemp(prefix="opencode-search-shots-"))
    print(f"work dir {work}")
    database = fake_database(work)
    for mode in modes:
        build(mode, work, database)


if __name__ == "__main__":
    main()
