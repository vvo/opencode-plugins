# opencode-awake

[OpenCode](https://opencode.ai) plugin that keeps your computer awake while a session works, including with the laptop lid closed.

Other sleep plugins run `caffeinate`, which stops idle sleep but not lid sleep: close a MacBook on battery and OpenCode pauses mid-task. This plugin also blocks lid sleep, on macOS through `pmset` and on Linux through `systemd-inhibit`, and gives it back as soon as every session is idle.

## Install

OpenCode 2:

```sh
opencode plugin add opencode-awake
```

OpenCode 1, in `opencode.json`:

```json
{ "plugin": ["opencode-awake"] }
```

Without any setup, the plugin keeps the machine from idling to sleep while a session works. The lid needs one more step on macOS.

## Closed lid on macOS

macOS always sleeps on lid close unless a root process says otherwise. Allow `pmset` to toggle that one setting without a password:

```sh
echo "$(whoami) ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1" | sudo tee /etc/sudoers.d/opencode-awake
sudo chmod 440 /etc/sudoers.d/opencode-awake
```

The rule allows exactly those two commands and nothing else. Remove it with `sudo rm /etc/sudoers.d/opencode-awake`.

While the lid hold is on, the Mac can run hot in a closed bag, so the plugin gives it back early:

- when every session is idle
- after `lidMaxMinutes` (3 hours by default)
- when the battery drops below `lidMinBattery` percent (20 by default)
- when OpenCode exits or crashes: a small watchdog process restores sleep once OpenCode's process is gone

If something else already disabled sleep (you ran `pmset disablesleep 1` yourself), the plugin leaves it alone.

## Closed lid on Linux

`systemd-inhibit --what=idle:sleep:handle-lid-switch` blocks lid sleep without root on most desktops. If your polkit rules refuse the lid switch, the plugin falls back to `idle:sleep`. The inhibitor is tied to OpenCode's process, so it can never outlive it.

## Options

```jsonc
{
  "plugins": [
    {
      "package": "opencode-awake",
      "options": {
        "lid": true, // false to only block idle sleep
        "lidMaxMinutes": 180,
        "lidMinBattery": 20,
        "graceSeconds": 60,
      },
    },
  ],
}
```

`graceSeconds` covers sessions the plugin saw mid-run, for example after OpenCode reloaded it. Those stay held for that long after their last activity. Sessions it saw start stay held until they finish, however long a tool call takes.

## How it works

On OpenCode 2 the plugin reads the server event stream: `session.execution.started` begins a hold, and `succeeded`, `failed`, `interrupted` or `deleted` ends it. On OpenCode 1 it reads `session.status` and `session.idle`. One hold covers every session, so several sessions in parallel start one `caffeinate` process.

On macOS, `caffeinate -i -s -w <pid>` blocks idle sleep, and system sleep on AC power, and exits by itself if OpenCode dies.

## Development

```sh
pnpm typecheck
pnpm test
```
