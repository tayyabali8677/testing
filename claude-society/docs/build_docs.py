import collections
import json
import os
import pickle
import re
import shutil
import sys

ROOT = "/home/user/testing/claude-society"
V2 = ROOT + "/v2"
DOCS = ROOT + "/docs"
DATA = DOCS + "/data"
sys.path.insert(0, V2)
os.makedirs(DATA, exist_ok=True)

shutil.copy("/tmp/season1.log", DATA + "/season1_console.log")
shutil.copy("/tmp/season2.log", DATA + "/season2_console.log")
for s in (1, 2):
    for f in ("events.jsonl", "thoughts.jsonl"):
        shutil.copy(f"{V2}/runs/season{s}/{f}", f"{DATA}/season{s}_{f}")
shutil.copy(f"{ROOT}/runs/run1-uneven-wealth.jsonl", DATA + "/society_v1_run1_uneven_wealth.jsonl")
shutil.copy(f"{ROOT}/runs/driven.jsonl", DATA + "/society_v1_run2_even_wealth.jsonl")
shutil.copy(f"{ROOT}/runs/run-1793105044.jsonl", DATA + "/society_v1_mock_test_a.jsonl")
shutil.copy(f"{ROOT}/runs/run-1793105091.jsonl", DATA + "/society_v1_mock_test_b.jsonl")

VIS = lambda v: ("PUBLIC" if v == "public" else "PRIVATE" if v == "private"
                 else "HIDDEN FROM THE TOWN" if v == "omniscient" else "AT THE " + v.split(":")[1].upper())
worlds, evs, ths = {}, {}, {}
for s in (1, 2):
    worlds[s] = pickle.load(open(f"{V2}/runs/season{s}/state.pkl", "rb"))
    evs[s] = [json.loads(l) for l in open(f"{V2}/runs/season{s}/events.jsonl")]
    ths[s] = [json.loads(l) for l in open(f"{V2}/runs/season{s}/thoughts.jsonl")]


def end_lines(s):
    out = {}
    for l in open(f"{DATA}/season{s}_console.log"):
        m = re.match(r"== end of day (\d+): (.*)", l.strip())
        if m:
            out[int(m.group(1))] = m.group(2)
    return out


def status(a):
    if a["alive"] and a["status"] in ("free", "jailed"):
        return "alive"
    return {"taken": "handed to the envoys", "fled": "left town", "dead": "dead"}.get(a["status"], a["status"])


# ---------- transcripts ----------
TITLE = {1: "Season 1 (16 characters, medium difficulty)", 2: "Season 2 (20 characters, hard mode)"}
for s in (1, 2):
    w, ev, th = worlds[s], evs[s], ths[s]
    ends = end_lines(s)
    L = [f"# Ashgrove {TITLE[s]}: complete transcript", "",
         "Every event the engine recorded, every whisper, every public statement, and every private thought (the 'confessional') "
         "each character produced, in order, day by day and phase by phase. Text is as recorded; long messages were cut by the engine "
         "(statements at 300 characters, thoughts at 400). Events marked HIDDEN FROM THE TOWN were things nobody in the world saw "
         "at the time (burglaries, secret skimming, secret searches). Thoughts are never visible to other characters.", "",
         "## Cast and model assignment", "", "| Character | Job | Model | Final fate |", "|---|---|---|---|"]
    for a in w.agents.values():
        L.append(f"| {a['name']} | {a['job']} | {a['model']} | {status(a)} |")
    for d in range(1, w.days + 1):
        L += ["", f"---", "", f"# Day {d}"]
        for ph in ("morning", "afternoon", "night"):
            es = [e for e in ev if e["day"] == d and e["phase"] == ph]
            ts = [t for t in th if t["day"] == d and t["phase"] == ph]
            L += ["", f"## Day {d}, {ph}", ""]
            for e in es:
                L.append(f"- **[{e['kind'].upper()} / {VIS(e['vis'])}]** {e['text']}")
            if ts:
                L += ["", f"### Confessionals, day {d} {ph}", ""]
                for t in ts:
                    L.append(f"- **{t['name']}** ({t['model']}): {t['thought']}")
        if d in ends:
            L += ["", f"**End of day {d}:** {ends[d]}"]
    L += ["", "---", "", "# Final result", "", "| Character | Model | Final fate | Health | Coin on them | Hidden coin | Food |", "|---|---|---|---|---|---|---|"]
    for a in w.agents.values():
        L.append(f"| {a['name']} | {a['model']} | {status(a)} | {a['hp']} | {a['coin']} | {a['stash']} | {a.get('food', '-')} |")
    open(f"{DOCS}/0{s + 2}_TRANSCRIPT_SEASON{s}.md", "w").write("\n".join(L) + "\n")

# ---------- character bible ----------
from cast import CAST, PRIVATE_BONDS, PUBLIC_BONDS  # noqa: E402

B = ["# Ashgrove character bible", "",
     "Twenty characters. Each has a job, traits, a backstory, a secret nobody else knows, and a goal. "
     "The same model was pinned to each of the first sixteen characters in both seasons so the seasons can be compared "
     "(Magnus, Corin, Marta and Ezra appear only in season 2). Counts below are the number of recorded actions by that character.", ""]
for c in CAST:
    n = c["name"]
    B += [f"## {n}, {c['age']}, {c['job']}", ""]
    B.append(f"- **Model (both seasons):** {worlds[2].agents[n]['model']}")
    B.append(f"- **Traits:** {c['traits']}")
    B.append(f"- **Backstory:** {c['backstory']}")
    B.append(f"- **Secret:** {c['secret']}")
    B.append(f"- **Goal:** {c['goal']}")
    B.append(f"- **Starting coin / hidden coin:** {c['coin']} / {c['stash']}")
    bonds = []
    for x, y in PUBLIC_BONDS["married"]:
        if n == x: bonds.append(f"married to {y}")
        if n == y: bonds.append(f"married to {x}")
    for p, ch in PUBLIC_BONDS["parent"]:
        if n == p: bonds.append(f"parent of {ch}")
        if n == ch: bonds.append(f"child of {p}")
    for x, y, k in PRIVATE_BONDS:
        if n == x: bonds.append(f"{y}: {k}")
    B.append(f"- **Relationships:** {'; '.join(bonds) if bonds else 'none designed'}")
    for s in (1, 2):
        if n not in worlds[s].agents:
            B.append(f"- **Season {s}:** not in the cast")
            continue
        a = worlds[s].agents[n]
        deaths = [e for e in evs[s] if e["kind"] == "death" and n in e["actors"]]
        fate = status(a)
        if deaths:
            fate += f" (died day {deaths[0]['day']}: {deaths[0]['text'].split('(')[1].split(')')[0] if '(' in deaths[0]['text'] else ''})"
        cnt = collections.Counter(e["kind"] for e in evs[s] if e["actors"] and e["actors"][0] == n)
        B.append(f"- **Season {s} fate:** {fate}. Recorded actions: " + ", ".join(f"{k} {v}" for k, v in cnt.most_common()))
        mine = [t for t in ths[s] if t["name"] == n]
        if mine:
            pick = [mine[0], mine[len(mine) // 2], mine[-1]]
            B.append(f"- **Season {s} confessionals (first, middle, last):**")
            for t in pick:
                B.append(f"  - Day {t['day']} {t['phase']}: \"{t['thought']}\"")
    B.append("")
open(f"{DOCS}/02_CHARACTER_BIBLE.md", "w").write("\n".join(B) + "\n")

# ---------- society v1 run tables ----------
R = ["# The first experiment: the ten-agent society (every action of every run)", "",
     "This is the engine I built first: 10 agents, mixed Opus / Sonnet / Haiku, one shared town, credits, a daily cost of living, "
     "and nine possible actions (work, rest, give, steal, attack, say, propose a law, vote, note). Agents were run as subagents, "
     "one per agent per turn. Below is every recorded action of the two full runs whose logs survived (Run 1 and Run 2). "
     "Pilots A and B (short runs with easier rules) are described in the main report; their logs were overwritten when the world was re-initialised.", ""]
RUNS = [("Run 1: uneven wealth (3 rich agents at 60 coin, 7 poor at 20; daily cost 22)", "society_v1_run1_uneven_wealth.jsonl"),
        ("Run 2: even wealth inside each model (5 rich at 60, 5 poor at 20; daily cost 22)", "society_v1_run2_even_wealth.jsonl")]
for title, f in RUNS:
    rows = [json.loads(l) for l in open(f"{DATA}/{f}")]
    R += [f"## {title}", ""]
    R += ["| Day | Turn | Agent | Model | Action | Target | Said or written | Coin after |", "|---|---|---|---|---|---|---|---|"]
    for r in rows:
        tx = (r.get("text") or "").replace("|", "/").replace("\n", " ")
        R.append(f"| {r['day']} | {r['tick'] + 1} | {r['agent']} | {r['model']} | {r['action']} | {r.get('target') or ''} | {tx} | {r['credits']} |")
    R.append("")
    c = collections.defaultdict(collections.Counter)
    for r in rows:
        c[r["model"]][r["action"]] += 1
    R += ["**Actions by model:**", ""]
    for m in ("opus", "sonnet", "haiku"):
        R.append(f"- {m}: " + ", ".join(f"{k} {v}" for k, v in c[m].most_common()))
    R.append("")
open(f"{DOCS}/05_SOCIETY_V1_RUNS.md", "w").write("\n".join(R) + "\n")

# ---------- roster json ----------
roster = {}
for s in (1, 2):
    roster[f"season{s}"] = [dict(name=a["name"], model=a["model"], job=a["job"], fate=status(a), hp=a["hp"],
                                 coin=a["coin"], stash=a["stash"], food=a.get("food")) for a in worlds[s].agents.values()]
json.dump(roster, open(f"{DATA}/final_rosters.json", "w"), indent=1)
print("built:", sorted(os.listdir(DOCS)))
for f in sorted(os.listdir(DOCS)):
    p = os.path.join(DOCS, f)
    if os.path.isfile(p):
        print(f, os.path.getsize(p))
