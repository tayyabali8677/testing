# trader-auto

Copies Berkshire's latest 13F into an Alpaca **paper** account. Paper only. No live mode in the code.

Flow: copycat, budget, risk, then Alpaca. Only risk PASS orders go out.
It will not buy again if the account already holds those stocks.

Setup:
1. `git clone https://github.com/Jakeschincariol/trader-skill`
2. `mkdir -p trader-auto/trader && cp trader-auto/config.example.json trader-auto/trader/config.json`
3. Put your name and email in `sec_user_agent` in that file.
4. Export `ALPACA_API_KEY` and `ALPACA_SECRET_KEY` (paper keys).

Run:
    python3 trader-auto/run.py             # dry run
    python3 trader-auto/run.py --execute   # sends orders to paper

Schedule: `.github/workflows/trader-auto.yml` runs it weekly on GitHub.
Add repo secrets `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`, `SEC_USER_AGENT`.
