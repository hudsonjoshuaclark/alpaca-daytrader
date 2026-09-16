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

## Behaviour worth knowing

- Polls every 15 seconds while open; stops while backgrounded, and while a close is
  in flight so the button under your thumb is not re-rendered mid-tap.
- Pull down to refresh, or tap the ↻ in the header. Installed to the home screen there is
  no address bar, so these are the only manual refreshes.
- If the server cannot be reached the page **clears** and says so rather than leaving a
  stale number on screen. A figure on this page is either current or visibly absent.
- The icon and `manifest.webmanifest` are served without auth, because iOS fetches the
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
