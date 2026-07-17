# Backtest baseline — ORB-15 strategy (established 2026-07-16)

Reference numbers the live bot is expected to track. Derived from scripts/sweep2.js and
scripts/sweep3.js over 90 calendar days (~61 sessions) of 5-min IEX bars on the 12-name
liquid universe. All figures are on the UNDERLYING move (options add leverage, spread
cost, and theta on top).

| Metric | Backtest value |
|---|---|
| Expectancy per trade (underlying) | +8.1 bp |
| Win rate | 43.6% |
| Avg winner | +1.20% |
| Avg loser | -0.79% |
| Trades per day (12 symbols, pooled) | ~10 signals/day pooled; live bot takes max 2 concurrent, one per symbol/day |
| Monthly consistency | positive 3 of 4 months (May 2026 was -10.5bp — losing months HAPPEN) |
| Best entry window | 09:45–11:00 (+14.3bp); decays after |

Failed alternatives (do NOT re-adopt without new evidence):
- EMA9/21 crossover + VWAP + RVOL (original strategy): negative in every configuration
  tested (-0.3 to -3.6bp across 30 combos, sweep.js)
- Fading the EMA crossover: ~0 to negative after realistic brackets (sweep2.js)
- Daily "hot name" screener gating of ORB entries: made it WORSE (-21.6bp vs +1.1bp
  ungated on the affordable cohort, sweep4.js) — yesterday's heat selects next-day chop
- Cheap/meme-stock cohort (SOFI, MARA, RIOT, MU, INTC): pooled ~0bp, unstable

Live-vs-backtest divergence is EXPECTED from: option spread costs (entry limit at
mid+¼ spread saves most but not all), theta on held winners, 20s polling granularity
on stops, and unfilled entry limit orders (missed trades).
