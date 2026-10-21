#!/usr/bin/env python3
"""Crypto backtester. Standard library only. Daily bars from Alpaca (no keys needed).

    python3 trader-auto/backtest.py                       # BTC/USD and ETH/USD
    python3 trader-auto/backtest.py --symbols BTC/USD --start 2021-01-01

Strategies are long only, no leverage. Fees and slippage are charged on every
trade. The first 60% of history is "train", the last 40% is "test". Trust the
test column, not the train one. If a strategy only wins on train, it is luck.
"""

import argparse
import json
import urllib.parse
import urllib.request

FEE = 0.0025 + 0.0010  # Alpaca crypto taker fee + guess for slippage, per trade side


def bars(symbol, start):
    out, token = [], None
    while True:
        q = {"symbols": symbol, "timeframe": "1Day", "start": start + "T00:00:00Z", "limit": 1000}
        if token:
            q["page_token"] = token
        url = "https://data.alpaca.markets/v1beta3/crypto/us/bars?" + urllib.parse.urlencode(q)
        with urllib.request.urlopen(url, timeout=30) as r:
            d = json.load(r)
        out += [b["c"] for b in d["bars"].get(symbol, [])]
        token = d.get("next_page_token")
        if not token:
            return out


def sma(p, i, n):
    return sum(p[i - n + 1:i + 1]) / n


def run(prices, signal, dca=0):
    """signal(i) -> 1 hold coin, 0 hold cash. dca>0: add that much cash every 7 days instead."""
    cash, coin, invested, curve = 1000.0, 0.0, 1000.0, []
    if dca:
        cash, invested = 0.0, 0.0
    for i, px in enumerate(prices):
        if dca and i % 7 == 0:
            coin += dca * (1 - FEE) / px
            invested += dca
        elif not dca and i > 0:
            want = signal(i)
            if want and cash > 0:
                coin, cash = cash * (1 - FEE) / px, 0.0
            elif not want and coin > 0:
                cash, coin = coin * px * (1 - FEE), 0.0
        curve.append(cash + coin * px)
    return curve, invested


def stats(curve, invested, days):
    peak, mdd = 0, 0
    for v in curve:
        peak = max(peak, v)
        mdd = max(mdd, 1 - v / peak) if peak else 0
    ret = curve[-1] / invested - 1
    return ret * 100, mdd * 100


def report(name, prices, n_start):
    p = prices
    sig = {
        "buy & hold": lambda i: 1,
        "trend 200d": lambda i: 1 if i >= 200 and p[i - 1] > sma(p, i - 1, 200) else 0,
        "trend 100d": lambda i: 1 if i >= 100 and p[i - 1] > sma(p, i - 1, 100) else 0,
        "cross 50/200": lambda i: 1 if i >= 200 and sma(p, i - 1, 50) > sma(p, i - 1, 200) else 0,
    }
    cut = int(len(p) * 0.6)
    print("\n%s  %d days from %s" % (name, len(p), n_start))
    print("%-14s %12s %10s   %12s %10s" % ("", "train ret%", "train DD%", "TEST ret%", "TEST DD%"))
    for label, f in list(sig.items()) + [("weekly DCA $50", None)]:
        row = []
        for a, b in ((0, cut), (cut, len(p))):
            seg = p[a:b]
            if f:
                off = a
                curve, inv = run(seg, lambda i, f=f, off=off: f(i + off))
            else:
                curve, inv = run(seg, None, dca=50)
            row += list(stats(curve, inv, len(seg)))
        print("%-14s %12.1f %10.1f   %12.1f %10.1f" % (label, *row))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbols", nargs="+", default=["BTC/USD", "ETH/USD"])
    ap.add_argument("--start", default="2021-01-01")
    a = ap.parse_args()
    for s in a.symbols:
        report(s, bars(s, a.start), a.start)
    print("\nPast results. Not a promise. Beating buy & hold on TEST with a smaller drawdown is the bar.")
