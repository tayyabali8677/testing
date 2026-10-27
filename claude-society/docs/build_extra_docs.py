import collections, json, os, pickle, subprocess, sys
ROOT="/home/user/testing/claude-society"; DOCS=ROOT+"/docs"; DATA=DOCS+"/data"; V2=ROOT+"/v2"
sys.path.insert(0,V2)
VIS=lambda v:("PUBLIC" if v=="public" else "PRIVATE" if v=="private" else "HIDDEN FROM THE TOWN" if v=="omniscient" else "AT THE "+v.split(":")[1].upper())

# ---- 06b smoke tests and mock runs ----
L=["# Smoke tests, probes and mock runs","",
   "These are the small runs that were not full seasons: the one-day tests of the Ashgrove engine with real models, the free mock runs that checked the engine for crashes, and the probes of the command line tool. They are part of the record because they show how the engine was checked and what the first real-model behaviour looked like before the full seasons.",""]
L+=["## A. Command line probes (what I tried before building the Ashgrove backend)","",
 "| Probe | Result |","|---|---|",
 "| `claude --version` | 2.1.311 (the tool exists on this machine) |",
 "| `claude -p \"Reply with exactly: {\\\"ok\\\": 1}\" --model haiku ...` | Worked. Returned `{\"ok\": 1}`. Uses this session's own login, no API key. |",
 "| `claude --bare -p ... --model haiku` | **Failed**: \"Authentication error\". Bare mode skips the login, so it cannot work here. |",
 "| Lean call (system prompt replaced, no tools, empty MCP config, no settings, no slash commands, no session saved) | Worked. About 1,327 tokens of overhead, 0.0004 US dollars (Haiku, tiny prompt). |",
 "| Realistic late-season Sonnet turn (Elena, Season 2 prompt, 4,386 character system prompt, 4,516 character state) | 3,114 tokens written to cache, 1,661 read from cache, 782 output tokens, about 11 seconds, about 0.021 US dollars. |",""]
L+=["## B. Free mock runs (random agents, no model calls)","",
 "The mock backend picks random actions. It cannot tell us about behaviour. It exists to find crashes and to confirm that every mechanic can fire.","",
 "| Run | Engine | Seed | Result |","|---|---|---|---|"]
def last(p):
    t=[l.strip() for l in open(p) if l.strip()]
    return [x for x in t if x.startswith("SUMMARY") or x.startswith("alive") or x.startswith("crimes")]
for kind,name,seeds in (("Ashgrove Season 1 engine","mock",range(4)),("Ashgrove Season 2 engine","m2",range(3))):
    for s in seeds:
        p=f"{DATA}/mock_tests/ashgrove_s{1 if name=='mock' else 2}_mock_seed{s}_console.log"
        if os.path.exists(p):
            r=last(p); L.append(f"| mock | {kind} | {s} | {' ; '.join(x[:260] for x in r)} |")
L+=["","The first Season 1 mock runs crashed on every seed (an index error: the end-of-day logic ran after the phase counter had already moved past night). That was fixed before any real-model run. After the fix, all seven mock runs finished cleanly. Mock event counts show that famine, fever, the envoy, tribute, murders, elections, recalls, couples, bribes and burglaries could all fire. The 10-agent society also had two mock runs (`data/society_v1_mock_test_a.jsonl`, `..._b.jsonl`).",""]
for s,title,fn in ((1,"C. One-day smoke test, Ashgrove Season 1 engine (16 characters, real models)","real1"),(2,"D. One-day smoke test, Ashgrove Season 2 engine (20 characters, real models)","real2smoke")):
    ev=[json.loads(l) for l in open(f"{DATA}/smoke_tests/{fn}_events.jsonl")]
    th=[json.loads(l) for l in open(f"{DATA}/smoke_tests/{fn}_thoughts.jsonl")]
    w=pickle.load(open(f"/tmp/{fn}/state.pkl","rb"))
    L+=[f"## {title}","", "Each was one simulated day (three phases) to check that real models would read the prompt, return valid JSON and use the actions. The smoke tests were separate random draws from the full seasons, so they show a different day 1.","",
        "| Character | Model |","|---|---|"]+[f"| {a['name']} | {a['model']} |" for a in w.agents.values()]+[""]
    for ph in ("morning","afternoon","night"):
        L+=["",f"### Day 1, {ph}",""]
        for e in ev:
            if e["phase"]==ph: L.append(f"- **[{e['kind'].upper()} / {VIS(e['vis'])}]** {e['text']}")
        ts=[t for t in th if t["phase"]==ph]
        if ts:
            L+=["",f"#### Confessionals, {ph}",""]+[f"- **{t['name']}** ({t['model']}): {t['thought']}" for t in ts]
    L+=["",f"**Result:** {sum(1 for a in w.agents.values() if a['alive'])} of {len(w.agents)} alive, {len(w.crimes)} crimes.",""]
open(DOCS+"/06b_SMOKE_TESTS_AND_MOCKS.md","w").write("\n".join(L)+"\n")

# ---- 07 engine source and change history ----
G=subprocess.run(["git","log","--reverse","--stat","--format=%n### %h  %ad%n%n%s%n","--date=format:%H:%M UTC","--","claude-society"],cwd="/home/user/testing",capture_output=True,text=True).stdout
S=["# Engine source code and change history","",
   "This is the code as it stands at the end of the session, plus the history of how it changed. Nothing is paraphrased: the files are printed in full.","",
   "## Change history","",
   "The commits below are the checkpoints saved to the branch. Between commits several settings were changed in place; those changes are listed after the commits.","",
   "### Commits","", "```", G.strip(), "```", "",
   "### Changes made between commits (from the session record)","",
   "| Time (UTC) | Change |","|---|---|",
   "| 12:44 | Opus share of the 10-agent society cut from 3 to 2 agents (default split 3/4/3 became 2/4/4), at your request, to protect usage limits. |",
   "| 12:46 | `drive.py` written: a step driver that writes one prompt file per agent and applies replies, so subagents could play the agents. |",
   "| 12:47 | Per-agent prompt files introduced (`prompts/<Name>.txt`) so agents could not read each other's private notes. |",
   "| 12:51 | Pilot B rules: `START_CREDITS` 30 to 15, `DAILY_COST` 8 to 14. |",
   "| 14:39 | Run 1 rules: `START_CREDITS` 15 to 20, `DAILY_COST` 14 to 22, steal amount 5 to 10, rich agents at 60 coin (`--rich`, `--rich-credits`), a survival outlook line added to every prompt, start credit text changed to \"residents start with different amounts\". |",
   "| 14:47 | Run 2: same rules, `--rich Chen,Dara,Farah,Ada,Ivo`. |",
   "| 14:56 to 15:04 | Ashgrove Season 1 engine (`v2/world.py`, `cast.py`, `run.py`) written. Phase-index bug fixed before the first real run. |",
   "| 15:23 to 15:28 | Season 2 engine (`world2.py`) and four more characters added. |",
   "| 15:46 to 16:03 | Documentation build scripts added (this package). |","",
   "## Source files (final state)",""]
for f in ("society.py","drive.py","v2/cast.py","v2/world.py","v2/world2.py","v2/run.py"):
    S+=[f"### `{f}`","","```python",open(f"{ROOT}/{f}").read().rstrip(),"```",""]
open(DOCS+"/07_ENGINE_SOURCE_AND_CHANGELOG.md","w").write("\n".join(S)+"\n")
for f in ("06b_SMOKE_TESTS_AND_MOCKS.md","07_ENGINE_SOURCE_AND_CHANGELOG.md"): print(f,os.path.getsize(DOCS+"/"+f))
