# Heartbeat Tasks

The agent checks this file on every heartbeat tick and automatically runs the most relevant task.
Add, remove, or edit tasks below. Tasks with time qualifiers are only triggered during those windows.

---

## Morning Briefing (every morning)
- [ ] Fetch top NSE/BSE market movers and overnight global news that could affect Indian markets
- [ ] Summarize any major events (earnings, RBI decisions, FII/DII data) for today

## Market Hours (market hours)
- [ ] Check live prices of Nifty 50 and Sensex; note % change from previous close
- [ ] Alert if any Nifty 50 stock has moved more than 5% intraday

## Evening Recap (evening)
- [ ] Summarize today's stock market performance (Nifty 50, Sensex, top gainers/losers)
- [ ] List workspace files created or modified today
- [ ] Highlight any tasks left incomplete from today

## Research (daily)
- [ ] Check for major crypto price movements (BTC, ETH) and summarize in one paragraph
- [ ] Look for trending AI/ML papers or tools released in the last 24 hours

## Development (weekdays)
- [ ] Scan workspace for any Python or TypeScript errors in recently modified files
- [ ] Check git status and summarize uncommitted changes if any

---

*Edit this file to customize what the agent monitors. Supported time qualifiers:*
- *morning, evening, daily, weekday, market hours*
- *every Monday / every Friday (specific weekday)*
- *every 2 hours (frequency-based)*
