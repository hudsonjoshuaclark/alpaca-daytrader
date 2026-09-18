# Phone dashboard

`/phone` is the bots' status on an iPhone-sized screen. It reads the same
`/api/multi-status` endpoint `/multi` does, so it can never disagree with the desktop
dashboard — there is no second source of truth, only a second layout.

Added to the home screen it opens full-screen with its own icon and no Safari chrome, so
it behaves like an app. It is not an App Store app, and deliberately so: shipping a native
binary would mean a developer account, a signing identity, a rebuild-and-reinstall cycle
for every change, and a second copy of the rendering logic to keep in step with the
server. None of that buys anything here. The thing being tracked is a web server on a
desk; a web page pointed at it is the honest shape for this.

## Installing it

The bots run on a desk at home, so the phone needs a route in. That already exists:

1. On the trading machine, make sure both are up:
   - `scripts/start-status-server.ps1` — the dashboard on `localhost:4321`
   - `scripts/start-ngrok-tunnel.ps1` — publishes it at `$env:NGROK_DOMAIN`
2. On the iPhone, open `https://<your-ngrok-domain>/phone` **in Safari**. Chrome and
   Firefox on iOS cannot install to the home screen.
3. Enter the dashboard username and password when Safari asks.
4. Share → **Add to Home Screen** → Add.

It then launches from the icon like any other app.

Anything that reaches port 4321 works the same way — Tailscale, a VPN, or plain
`http://<lan-ip>:4321/phone` while on the house wifi. ngrok is just what this repo already
had wired up.

## What it shows

- **Today across all bots** — combined P&L against Alpaca's prior-day close equity, the
  same `equity - lastEquity` baseline the desktop page uses, so overnight holds are marked
  to market rather than being invisible until they close.
- **Problems** — dead runners and missed entry windows, criticals first. Market state and
  bot health stay separate: a quiet weekend renders neutral grey, never as a fault.
- **Open positions** — every leg across all four accounts, each with a Close button.
- **Bots** — per-strategy heartbeat, equity and fill count.
- **Today** — the unified fill timeline, or the last session that actually traded, labelled
  as such when it falls back.

Closing a position posts to the same `/api/close` the desktop page uses, with the same
confirmation, the same server-side leg-group resolution and the same same-origin check.
The phone gets no shortcut the browser does not have.

## When the tunnel is down

You will see this, and it is the common case rather than a rare one:

```
ERR_NGROK_3200
The endpoint <your-domain>.ngrok-free.dev is offline.
```

It means no ngrok agent is connected. The request never reached port 4321, so it says
nothing about the dashboard and everything about the machine at the other end. Usually that
machine is asleep — `keep-awake.ps1` releases its hold at 16:45 by default, so the tunnel
dies every evening unless something keeps it up.

Check it in this order, on the trading machine:

```powershell
Get-CimInstance Win32_Process -Filter "Name='ngrok.exe'" | Select ProcessId, CommandLine
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'status-server\.js' } | Select ProcessId

# Does the dashboard answer locally, with ngrok out of the picture? 401 counts as yes.
curl.exe -u $env:DASHBOARD_USER:$env:DASHBOARD_PASS http://localhost:4321/phone -o NUL -w "%{http_code}`n"
```

Then restart the dashboard first and the tunnel second — ngrok needs something to point at:

```powershell
.\scripts\start-status-server.ps1
.\scripts\start-ngrok-tunnel.ps1
```

Three causes worth ruling out before anything else:

- **Defender quarantined ngrok.exe.** It has happened before (2026-07-24,
  `Trojan:Win32/Kepavll!rfn`, a known false positive for ngrok). A self-update since then may
  sit outside the existing exclusion. Check quarantine history.
- **`NGROK_DOMAIN` missing from the scheduled task's environment.** `start-ngrok-tunnel.ps1`
  throws without it, and a task runs with a fresh environment that will not have a variable
  you only exported in a shell. Set it with `setx NGROK_DOMAIN "..."` and sign out and in.
- **The ngrok free tier allows one agent session.** A stale session elsewhere refuses the new
  one. `logs\ngrok-stderr.log` names it.

## Keeping it up by itself

`scripts\watchdog-tunnel.ps1` restarts whichever half has stopped answering. Register it to
run every five minutes:

```powershell
.\scripts\install-watchdog-task.ps1
Start-ScheduledTask -TaskName 'Alpaca Watchdog'   # run it once now
Get-Content logs\watchdog.log -Tail 20
```

It tests behaviour rather than process lists, because both failures it is there to catch are
invisible to `Get-Process`: node can be alive and wedged, and ngrok can be running with no
session at all after a wake from sleep. So it asks the dashboard for a page and asks ngrok's
local API whether a session for the domain exists. A 401 from the dashboard counts as
healthy — that is basic auth doing its job, and treating it as a fault would restart a
working server every five minutes forever.

It logs only when it acts, so `logs\watchdog.log` is a list of things that went wrong rather
than thousands of lines of nothing. The task is named to match the `Alpaca*` filter, so it
appears in the dashboard's scheduled-task panel with the bots' own tasks.

None of that helps while the machine is asleep. For the app to answer in the evening the
machine has to be awake:

```powershell
.\scripts\keep-awake.ps1 -Until 23:30    # or -Forever
```

The default is still 16:45. Never sleeping costs power and wear on a laptop, so it is a
choice rather than something changed on your behalf. Worth knowing: while the machine is
asleep the bots are not trading either, so "offline" is an honest answer rather than a
missing one — the only positions live at that hour are overnight holds sitting at the broker.

## Behaviour worth knowing

- Polls every 15 seconds while open; stops while backgrounded, and while a close is
  in flight so the button under your thumb is not re-rendered mid-tap.
- Pull down to refresh, or tap the ↻ in the header. Installed to the home screen there is
  no address bar, so these are the only manual refreshes.
- If the server cannot be reached the page **clears** and says so rather than leaving a
  stale number on screen, and offers a Try again button. A figure on this page is either
  current or visibly absent.
- A service worker (`sw.js`) caches the page shell, so the app opens to that screen instead
  of ngrok's error page when the tunnel is down. It caches the shell and the icon only —
  never `/api/` — so it can never show you a stale P&L. The first load after installing has
  to succeed once for there to be anything cached; iOS may also evict the cache after about
  a week unused, after which one online load restores it.
- The icon, `sw.js` and `manifest.webmanifest` are served without auth, because iOS fetches the
  touch icon outside the page's credentialed context and would otherwise install the app
  with a screenshot for an icon. They are static artwork; everything that reads an account
  stays behind basic auth.

## Regenerating the icon

`assets/phone-icon-{180,512}.png` are committed. Rebuild them only if the artwork changes:

```
node scripts/make-phone-icon.js
```

## Not built

**Push notifications.** iOS 16.4+ can push to a home-screen web app, but it needs a service
worker, a permission prompt, and a push service the desk machine can reach — and a bot
that has just died is exactly the one that cannot send you a notification about it. A
watchdog that alerts from somewhere other than the box being watched is the right shape
for that, and it is a separate piece of work from this page.
