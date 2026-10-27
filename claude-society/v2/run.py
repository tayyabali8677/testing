"""Ashgrove: a town of AI characters with secrets, crime, politics, love and survival.

  python run.py play --backend mock --days 10            # engine test, no model calls
  python run.py play --backend cli  --days 10            # real models via the logged-in claude CLI
  python run.py play --backend api  --days 10            # real models via ANTHROPIC_API_KEY
  python run.py play --backend cli --days 3 --agents 10 --split opus=1,sonnet=4,haiku=5
  python run.py play --assign Mara=opus,Silas=opus       # pin specific characters to a model
  python run.py recap runs/<id> --day 3                  # omniscient story of one day, for episode scripts
"""
import argparse
import json
import os
import pickle
import random
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

from world import PHASES, PLACES, World

ALIAS = {"opus": "opus", "sonnet": "sonnet", "haiku": "haiku"}
API_IDS = {"opus": "claude-opus-5-5", "sonnet": "claude-sonnet-5-5", "haiku": "claude-haiku-5-5"}


def parse(raw):
    m = re.search(r"\{.*\}", raw or "", re.S)
    if not m:
        return {}
    try:
        d = json.loads(m.group(0))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def ask_cli(w, a):
    cmd = ["claude", "-p", "--model", ALIAS[a["model"]], "--no-session-persistence", "--disable-slash-commands",
           "--system-prompt", w.system_prompt(a), "--tools", "", "--strict-mcp-config",
           "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "", "--output-format", "text"]
    for attempt in range(3):
        try:
            r = subprocess.run(cmd, input=w.user_prompt(a), capture_output=True, text=True, timeout=180, cwd="/tmp")
            if r.stdout.strip():
                return r.stdout
        except Exception:
            pass
        time.sleep(2 ** attempt)
    return ""


_client = None


def ask_api(w, a):
    global _client
    import anthropic
    _client = _client or anthropic.Anthropic()
    for attempt in range(4):
        try:
            r = _client.messages.create(model=API_IDS[a["model"]], max_tokens=500, system=w.system_prompt(a),
                                        messages=[{"role": "user", "content": w.user_prompt(a)}])
            return "".join(b.text for b in r.content if b.type == "text")
        except Exception:
            time.sleep(2 ** attempt)
    return ""


def ask_mock(w, a):
    rng = random
    others = [x["name"] for x in w.agents.values() if x["alive"] and x["name"] != a["name"]]
    here = [x["name"] for x in w.at(a["place"], a["name"])]
    poor = a["coin"] + a["stash"] < w.price * 2
    acts = {"work": 30, "rest": 4, "say": 10, "whisper": 8, "give": 4, "steal": 6 if poor else 1, "burgle": 4 if poor else 0.5,
            "attack": 1, "kill": 1, "accuse": 2, "protest": 3, "run_for_mayor": 1, "vote_mayor": 3, "propose_law": 2,
            "vote_law": 4, "gamble": 3, "romance": 4, "marry": 1, "hide": 2, "investigate": 1, "announce": 2,
            "donate": 1, "enter_tournament": 3, "flee": 0.3, "bribe": 1, "note": 1}
    if a["name"] == w.mayor:
        acts.update(decree=2, skim=2, distribute=2, judge=3, decide_tribute=4)
    if a["name"] in (w.sheriff, w.deputy):
        acts.update(arrest=3, release=1)
    if a["job"] == "doctor":
        acts["heal"] = 6
    act = rng.choices(list(acts), list(acts.values()))[0]
    pool = here if act in ("steal", "attack", "kill", "gamble", "romance", "marry", "heal", "arrest") and here else others
    tgt = rng.choice(pool) if pool else None
    d = dict(thought=f"I need to {act}.", move_to=rng.choice(PLACES[:5]) if rng.random() < 0.5 else None, action=act,
             target=tgt, amount=rng.randint(1, 12), text=rng.choice(["yes", "no", "we cannot go on like this", "trust me", "pay the debt"]))
    if act in ("propose_law", "decree"):
        k = rng.choice(["wealth_tax", "welfare", "death_penalty", "curfew", "gambling", "theft_penalty"])
        d["law"] = k
        d["value"] = rng.choice(["fine", "jail", "exile", "death"]) if k == "theft_penalty" else (rng.randint(0, 30) if k == "wealth_tax" else rng.randint(0, 1))
    if act == "vote_law" and w.proposals:
        d["target"] = str(rng.choice(w.proposals)["id"])
    if act == "investigate" and w.incidents:
        d["target"] = str(rng.choice(w.incidents)["id"])
    if act == "decide_tribute":
        d["target"] = rng.choice(["pay", "refuse"] + others[:2])
    if act == "judge":
        d["text"] = rng.choice(["acquit", "fine 15", "jail 3", "exile", "execute"])
        d["target"] = rng.choice(others)
    return json.dumps(d)


BACKENDS = {"cli": ask_cli, "api": ask_api, "mock": ask_mock}


def save(w, out):
    with open(os.path.join(out, "state.pkl"), "wb") as f:
        pickle.dump(w, f)
    with open(os.path.join(out, "events.jsonl"), "w") as f:
        for e in w.chron:
            f.write(json.dumps(e) + "\n")
    with open(os.path.join(out, "thoughts.jsonl"), "w") as f:
        for t in w.thoughts:
            f.write(json.dumps(t) + "\n")


def play(a):
    out = a.out or os.path.join("runs", time.strftime("%Y%m%d-%H%M%S") + "-" + a.backend)
    os.makedirs(out, exist_ok=True)
    split = {k: int(v) for k, v in (kv.split("=") for kv in a.split.split(","))}
    assign = dict(kv.split("=") for kv in a.assign.split(",")) if a.assign else {}
    w = World(seed=a.seed, days=a.days, split=split, assign=assign, n=a.agents)
    ask = BACKENDS[a.backend]
    print("cast:", ", ".join(f"{x['name']}({x['model']})" for x in w.agents.values()))
    with ThreadPoolExecutor(a.workers) as pool:
        while not w.done:
            live = w.live()
            raws = list(pool.map(lambda x: ask(w, x), live))
            replies = {x["name"]: parse(r) for x, r in zip(live, raws)}
            before = len(w.chron)
            w.step(replies)
            for e in w.chron[before:]:
                if e["vis"] in ("public", "omniscient", "private") and e["kind"] not in ("ballot", "say", "whisper"):
                    print(f"  D{e['day']} {e['phase'][:3]} {e['text']}")
            if w.phase == 0:
                print(f"== end of day {w.day - 1}: alive {len(w.live())}/{len(w.agents)} mayor {w.mayor} treasury {w.treasury} laws {w.laws}")
            save(w, out)
    save(w, out)
    print("\nSUMMARY BY MODEL:", json.dumps(w.summary()))
    print("alive:", [x["name"] for x in w.live()])
    print("crimes:", len(w.crimes), "| out:", out)


def recap(a):
    with open(os.path.join(a.run, "events.jsonl")) as f:
        ev = [json.loads(l) for l in f]
    with open(os.path.join(a.run, "thoughts.jsonl")) as f:
        th = [json.loads(l) for l in f]
    for ph in PHASES:
        print(f"\n### DAY {a.day} {ph.upper()}")
        for e in ev:
            if e["day"] == a.day and e["phase"] == ph:
                print(f"[{e['vis']}] {e['text']}")
        if a.thoughts:
            for t in th:
                if t["day"] == a.day and t["phase"] == ph:
                    print(f"  (thinks, {t['name']}/{t['model']}) {t['thought']}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("play")
    p.add_argument("--backend", choices=list(BACKENDS), default="mock")
    p.add_argument("--days", type=int, default=10)
    p.add_argument("--agents", type=int, default=16)
    p.add_argument("--split", default="opus=2,sonnet=7,haiku=7")
    p.add_argument("--assign", default="")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--workers", type=int, default=6)
    p.add_argument("--out", default="")
    r = sub.add_parser("recap")
    r.add_argument("run")
    r.add_argument("--day", type=int, default=1)
    r.add_argument("--thoughts", action="store_true")
    a = ap.parse_args()
    {"play": play, "recap": recap}[a.cmd](a)
