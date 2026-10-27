"""Step driver so a coordinator (not an API script) can run the society turn by turn.

  python drive.py init --days 5 --ticks 2 --split opus=2,sonnet=4,haiku=4
  python drive.py prompts            # writes turn_prompts.json, prints agent/model list
  python drive.py apply replies.json # {"Ada": "<raw reply>", ...}; advances the clock
  python drive.py status
"""
import argparse, json, os, random, sys
import society as S

STATE = "state.json"
LOG = "runs/driven.jsonl"


def save(w):
    d = json.loads(json.dumps(w, default=list))
    json.dump(d, open(STATE, "w"), indent=1)


def load():
    w = json.load(open(STATE))
    for p in w["proposals"]:
        p["yes"], p["no"] = set(p["yes"]), set(p["no"])
    S.TICKS_PER_DAY = w["ticks"]
    return w


def alive(w):
    return [a for a in w["agents"] if a["alive"]]


def cmd_init(a):
    random.seed(a.seed)
    split = {k: int(v) for k, v in (kv.split("=") for kv in a.split.split(","))}
    w = dict(agents=S.build_agents(split), laws=["no theft", "no violence"], proposals=[], events=[],
             crimes=[], deaths=[], day=1, tick=0, next_pid=1, days=a.days, ticks=a.ticks, done=False)
    os.makedirs("runs", exist_ok=True)
    open(LOG, "w").close()
    save(w)
    print("initialised", [(x["name"], x["model"]) for x in w["agents"]])


def cmd_prompts(a):
    w = load()
    out = {x["name"]: dict(model=x["model"],
                           prompt=S.SYSTEM.format(name=x["name"], job=x["job"]) + "\n\n" + S.observe(x, w))
           for x in alive(w)}
    os.makedirs("prompts", exist_ok=True)
    for n, v in out.items():
        open(f"prompts/{n}.txt", "w").write(v["prompt"])
    print(f"day {w['day']} turn {w['tick']+1}/{w['ticks']}; agents:", {n: v["model"] for n, v in out.items()})


def cmd_apply(a):
    w = load()
    replies = json.load(open(a.file))
    order = [x for x in alive(w)]
    random.shuffle(order)
    with open(LOG, "a") as log:
        for x in order:
            if x["alive"]:
                S.apply(x, S.parse(replies.get(x["name"], "")), w, log)
        w["tick"] += 1
        if w["tick"] >= w["ticks"]:
            S.end_of_day(w)
            print(f"day {w['day']} done: alive={len(alive(w))} crimes={len(w['crimes'])} laws={len(w['laws'])}")
            w["day"] += 1
            w["tick"] = 0
            if w["day"] > w["days"] or not alive(w):
                w["done"] = True
    save(w)
    if w["done"]:
        S.report(w, LOG)
        print("events:\n" + "\n".join(w["events"][-40:]))


def cmd_status(a):
    w = load()
    print(f"day {w['day']} tick {w['tick']} done={w['done']}")
    for x in w["agents"]:
        print(x["name"], x["model"], x["job"], x["credits"], "alive" if x["alive"] else "dead")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    i = sub.add_parser("init")
    i.add_argument("--days", type=int, default=5)
    i.add_argument("--ticks", type=int, default=2)
    i.add_argument("--split", default="opus=2,sonnet=4,haiku=4")
    i.add_argument("--seed", type=int, default=0)
    sub.add_parser("prompts")
    p = sub.add_parser("apply")
    p.add_argument("file")
    sub.add_parser("status")
    a = ap.parse_args()
    {"init": cmd_init, "prompts": cmd_prompts, "apply": cmd_apply, "status": cmd_status}[a.cmd](a)
