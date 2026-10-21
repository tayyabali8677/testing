#!/usr/bin/env python3
"""Berkshire copy bot, Alpaca PAPER account only. Standard library only.

Runs the trader-skill tools in order: copycat -> budget -> risk -> Alpaca paper.
Only orders that risk marks PASS are sent. Default is a dry run.

    python3 trader-auto/run.py                # dry run, nothing sent
    python3 trader-auto/run.py --execute      # sends PASS orders to the paper account

Needs ALPACA_API_KEY and ALPACA_SECRET_KEY (paper keys) in the environment
and the trader-skill repo (--skill-dir or TRADER_SKILL_DIR).
The paper URL is hard coded on purpose. There is no live mode.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

PAPER = "https://paper-api.alpaca.markets/v2"
BERKSHIRE_CIK = "1067983"
ALPACA_FIELDS = ("symbol", "side", "qty", "notional", "type", "time_in_force", "limit_price")


def tool(skill_dir, script, *args, check=True):
    cmd = [sys.executable, os.path.join(skill_dir, script)] + list(args)
    p = subprocess.run(cmd, capture_output=True, text=True)
    if check and p.returncode != 0:
        sys.exit("%s failed:\n%s%s" % (script, p.stdout, p.stderr))
    return p


def alpaca(method, path, body=None):
    req = urllib.request.Request(
        PAPER + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"APCA-API-KEY-ID": os.environ["ALPACA_API_KEY"],
                 "APCA-API-SECRET-KEY": os.environ["ALPACA_SECRET_KEY"],
                 "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError("Alpaca %s %s: %s %s" % (method, path, e.code, e.read().decode()[:300]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skill-dir", default=os.environ.get("TRADER_SKILL_DIR", "trader-skill"))
    ap.add_argument("--workdir", default="trader-auto")
    ap.add_argument("--execute", action="store_true", help="send orders (paper account)")
    ap.add_argument("--top", default="5")
    a = ap.parse_args()

    os.makedirs(os.path.join(a.workdir, "trader"), exist_ok=True)
    os.chdir(a.workdir)
    skill = os.path.abspath(os.path.join("..", a.skill_dir)) if not os.path.isabs(a.skill_dir) else a.skill_dir
    if not os.path.isdir(skill):
        sys.exit("trader-skill not found at %s" % skill)
    if not os.path.exists("trader/config.json"):
        sys.exit("missing trader-auto/trader/config.json (copy config.example.json)")

    # 1. Berkshire's newest 13F -> target weights
    tool(skill, "trader-copycat/edgar13f.py", "copy", BERKSHIRE_CIK, "--top", a.top,
         "--out", "trader/targets.json")
    targets = json.load(open("trader/targets.json"))
    acc = re.search(r"accession ([0-9-]+)", targets.get("source", ""))
    acc = acc.group(1) if acc else "unknown"
    print("Targets from:", targets.get("source"))

    # 2. size to budget, 3. risk check
    tool(skill, "trader-budget/size.py", "--write")
    risk = json.loads(tool(skill, "trader-risk/check.py", "--json", check=False).stdout)
    orders = json.load(open("trader/orders.json"))
    orders = orders["orders"] if isinstance(orders, dict) else orders
    for r in risk["results"]:
        print("%-5s %s %s %s %s" % (r["verdict"], r["side"], r["symbol"], r["amount"], "; ".join(r["reasons"])))
    ready = [orders[r["index"] - 1] for r in risk["results"] if r["verdict"] == "PASS"]
    if not ready:
        sys.exit("nothing passed the risk check")

    if not a.execute:
        print("\nDRY RUN. Would send %d orders to the Alpaca paper account. Use --execute." % len(ready))
        return

    # 4. guard: already invested in these names? then do not buy again
    held = {p["symbol"] for p in alpaca("GET", "/positions")}
    dupes = held & {o["symbol"] for o in ready}
    if dupes:
        sys.exit("already holding %s. Not buying again. Rebalance by hand." % ", ".join(sorted(dupes)))

    state = json.load(open("trader/state/broker.json")) if os.path.exists("trader/state/broker.json") else {"orders": []}
    os.makedirs("trader/state", exist_ok=True)
    for o in ready:
        body = {k: o[k] for k in ALPACA_FIELDS if o.get(k) is not None}
        body["client_order_id"] = "berk-%s-%s" % (acc, o["symbol"])  # Alpaca rejects repeats
        res = alpaca("POST", "/orders", body)
        print("placed", o["symbol"], res.get("id"), res.get("status"))
        state["orders"].append({"date": __import__("datetime").date.today().isoformat(), "symbol": o["symbol"],
                                "side": o["side"], "status": "placed", "broker_order_id": res.get("id"),
                                "note": "auto-paper"})
        json.dump(state, open("trader/state/broker.json", "w"), indent=2)


if __name__ == "__main__":
    main()
