import collections
import glob
import json
import os
import re

SESSION = "/root/.claude/projects/-home-user-testing/aa172fb1-cefa-568a-a21e-fd85bf450827"
OUT = "/home/user/testing/claude-society/docs"
rows = [json.loads(l) for l in open(SESSION + ".jsonl")]

# ---------- subagent metadata ----------
meta = {}
for p in glob.glob(SESSION + "/subagents/agent-*.meta.json"):
    aid = os.path.basename(p)[len("agent-"):-len(".meta.json")]
    meta[aid] = json.load(open(p))


def label(aid):
    m = meta.get(aid)
    return m["description"] if m else aid


def ts(r):
    t = r.get("timestamp", "")
    return t[11:19] if t else ""


def text_of(c):
    if isinstance(c, str):
        return c
    out = []
    for b in c:
        if b.get("type") == "text":
            out.append(b["text"])
        elif b.get("type") == "tool_result":
            out.append(text_of(b.get("content") or ""))
    return "\n".join(out)


# ---------- map tool_use ids ----------
tool_uses = {}
for r in rows:
    if r.get("type") == "assistant":
        for b in r["message"]["content"]:
            if b.get("type") == "tool_use":
                tool_uses[b["id"]] = dict(name=b["name"], input=b["input"], ts=r.get("timestamp"))

# human message boundaries for run labelling
human = [(r["timestamp"], text_of(r["message"]["content"])) for r in rows
         if r.get("type") == "user" and isinstance(r.get("origin"), dict) and r["origin"].get("kind") == "human"]


def seg(tsx):
    marks = [("yes do the smaller version", "Pilot A (easy rules: 30 start, cost 8)"),
             ("Option 1 restart tight", "Pilot B (tight rules: 15 start, cost 14)"),
             ("Option 1 fix the rules", "Run 1 (uneven wealth: 3 rich at 60, 7 poor at 20, cost 22)"),
             ("run the cleaner one", "Run 2 (even wealth inside each model: 5 rich, 5 poor, cost 22)"),
             ("This should be more complicated", "after the subagent experiments")]
    cur = "before the subagent experiments"
    for t, txt in human:
        for key, name in marks:
            if key in txt and t <= tsx:
                cur = name
    return cur


def short(s, n):
    s = s.strip()
    return s if len(s) <= n else s[:n] + f" ... [{len(s) - n} more characters]"


def tool_line(name, inp, full=False):
    if name == "Bash":
        cmd = inp.get("command", "")
        d = inp.get("description", "")
        return f"Bash: {d}" + ("" if not full else f"\n```\n{short(cmd, 3500)}\n```")
    if name == "Write":
        c = inp.get("content", "")
        return f"Write {inp.get('file_path')} ({len(c)} characters, {c.count(chr(10)) + 1} lines)"
    if name == "Edit":
        return f"Edit {inp.get('file_path')}" + ("" if not full else f"\n```\n- {short(inp.get('old_string',''), 600)}\n+ {short(inp.get('new_string',''), 600)}\n```")
    if name == "Read":
        return f"Read {inp.get('file_path')}"
    if name == "Agent":
        return f"Agent '{inp.get('description')}' on {inp.get('model') or 'default'}"
    if name == "ToolSearch":
        return f"ToolSearch {inp.get('query')}"
    if name == "WebSearch":
        return f"WebSearch ({inp.get('mode')}): {inp.get('query')}"
    if name == "Monitor":
        return f"Monitor: {inp.get('description')}" + ("" if not full else f"\n```\n{short(inp.get('command',''), 1200)}\n```")
    if name == "SendUserFile":
        return f"SendUserFile {inp.get('files')} ({inp.get('caption')})"
    if name == "ReadNotifications":
        return "ReadNotifications"
    if name.startswith("mcp__"):
        return f"{name} {short(json.dumps(inp), 300)}"
    return f"{name} {short(json.dumps(inp), 300)}"


def build(full):
    L = []
    buf = []  # buffered handbacks

    def flush():
        if not buf:
            return
        L.append(f"*Subagent replies received ({len(buf)}):*")
        L.append("")
        for t, who, rep in buf:
            L.append(f"- `{t}` **{who}**: {short(rep, 900 if full else 260)}")
        L.append("")
        buf.clear()

    for r in rows:
        typ = r.get("type")
        if typ == "assistant":
            for b in r["message"]["content"]:
                if b.get("type") == "text" and b["text"].strip():
                    flush()
                    L += [f"### CLAUDE · {ts(r)} UTC", "", b["text"].strip(), ""]
                elif b.get("type") == "tool_use":
                    flush()
                    L += [f"*Tool · {ts(r)}* — {tool_line(b['name'], b['input'], full)}", ""]
        elif typ == "user":
            c = r["message"]["content"]
            o = r.get("origin")
            kind = o.get("kind") if isinstance(o, dict) else None
            if kind == "peer" and o.get("handback"):
                buf.append((ts(r), label(o.get("from")), o.get("handbackReportText", "")))
                continue
            if kind == "task-notification":
                if full:
                    t = text_of(c)
                    m = re.search(r"<summary>(.*?)</summary>", t, re.S)
                    u = re.search(r"<usage>(.*?)</usage>", t, re.S)
                    flush()
                    L += [f"*Task notification · {ts(r)}*: {m.group(1).strip() if m else ''} {('| ' + u.group(1).strip()) if u else ''}", ""]
                continue
            if isinstance(c, list) and any(b.get("type") == "tool_result" for b in c):
                if not full:
                    continue
                for b in c:
                    if b.get("type") != "tool_result":
                        continue
                    tu = tool_uses.get(b.get("tool_use_id"), {})
                    nm = tu.get("name", "")
                    res = text_of(b.get("content") or "")
                    lim = 9000 if nm in ("WebSearch",) else 2200
                    if nm == "Agent":
                        m = re.search(r"agentId: (\w+)", res)
                        res = f"launched {label(m.group(1)) if m else ''}"
                        lim = 200
                    flush()
                    L += [f"*Result · {nm}*:", "", "```", short(res, lim), "```", ""]
                continue
            t = text_of(c)
            if kind == "human" or t.startswith("[Request interrupted"):
                flush()
                L += ["---", "", f"## USER · {ts(r)} UTC", "", t.strip(), ""]
            elif t.startswith("Stop hook feedback"):
                flush()
                L += [f"> **System (stop hook, {ts(r)}):** {t.strip().splitlines()[-1] if t.strip() else ''}", ""]
            elif t.startswith("<command-name>") or t.startswith("<local-command"):
                flush()
                if "<command-name>" in t or "stdout" in t:
                    L += [f"> **System command ({ts(r)}):** {re.sub(r'<[^>]+>', ' ', t).strip()}", ""]
            elif t.startswith("<system-reminder>") or "SYSTEM NOTIFICATION" in t[:200]:
                m = re.search(r"model for this session has been changed to ([\w.-]+)", t)
                if m or "MCP server" in t or "send_later" in t or "scheduled" in t[:400].lower():
                    flush()
                    L += [f"> **System notice ({ts(r)}):** {short(re.sub(r'<[^>]+>', ' ', t), 360 if not full else 900)}", ""]
            elif full and t.strip():
                flush()
                L += [f"> **Other system message ({ts(r)}):** {short(t, 700)}", ""]
    flush()
    return L


head = ["# Complete conversation record", "",
        "Everything said in the session, in order, from the first message to the last. Times are UTC on 27 October 2026. "
        "The session ran from 12:40 to about 16:00 (about three hours twenty minutes) on a phone client connected to a cloud container. "
        "The first 1 minute of the session ran on Sonnet 4.6; at 12:41 you switched the session to Sonnet 5.5 with the /model command.", "",
        "**What is included.** Every message you wrote, every reply I wrote, every tool I used (one line each), and every subagent hand-back. "
        "**What is left out.** My private reasoning blocks (internal scratch work that was never shown to you) and the large system context "
        "blocks the harness attached to messages (tool lists, skill lists, policy text). The tool-by-tool version with commands and outputs "
        "is `00b_FULL_SESSION_LOG.md`.", ""]
open(OUT + "/00_CONVERSATION.md", "w").write("\n".join(head + build(False)) + "\n")
head2 = list(head)
head2[0] = "# Full session log, with tool commands and outputs"
head2[-2] = ("**What is included.** Everything in `00_CONVERSATION.md` plus the commands I ran and their outputs (long outputs shortened at "
             "2,200 characters; web search results kept nearly whole). Written files are listed by path and size; their contents are in the repo "
             "and in `07_ENGINE_SOURCE_AND_CHANGELOG.md`.")
open(OUT + "/00b_FULL_SESSION_LOG.md", "w").write("\n".join(head2 + build(True)) + "\n")

# ---------- subagent raw transcripts ----------
S = {}
for aid, m in meta.items():
    p = f"{SESSION}/subagents/agent-{aid}.jsonl"
    if not os.path.exists(p):
        continue
    sub = [json.loads(l) for l in open(p)]
    prompt_ask, reads, calls, reply, first_ts = "", [], [], "", None
    for r in sub:
        first_ts = first_ts or r.get("timestamp")
        if r.get("type") == "user":
            c = r["message"]["content"]
            if isinstance(c, str) and not prompt_ask and not c.startswith("<system-reminder>"):
                prompt_ask = c
            elif isinstance(c, list):
                for b in c:
                    if b.get("type") == "tool_result":
                        reads.append(text_of(b.get("content") or ""))
        elif r.get("type") == "assistant":
            for b in r["message"]["content"]:
                if b.get("type") == "tool_use":
                    if b["name"].endswith("SubagentHandback"):
                        reply = b["input"].get("message", "")
                    elif b["name"] == "Read":
                        calls.append("Read (its prompt file)")
                    elif b["name"] == "ToolSearch" and "SubagentHandback" in json.dumps(b["input"]):
                        calls.append("ToolSearch (to load its reply tool)")
                    else:
                        calls.append("UNREQUESTED: " + b["name"] + " " + json.dumps(b["input"])[:200])
    launch = tool_uses.get(m.get("toolUseId"), {}).get("ts") or first_ts
    S[aid] = dict(desc=m["description"], model=m.get("model"), prompt_ask=prompt_ask, reads=reads, calls=calls,
                  reply=reply, ts=launch)
# tokens from task notifications
tok = {}
for r in rows:
    o = r.get("origin")
    if r.get("type") == "user" and isinstance(o, dict) and o.get("kind") == "task-notification":
        t = text_of(r["message"]["content"])
        m = re.search(r"<task-id>(\w+)</task-id>", t)
        u = re.search(r"<subagent_tokens>(\d+)</subagent_tokens><tool_uses>(\d+)</tool_uses><duration_ms>(\d+)", t)
        if m and u:
            tok[m.group(1)] = (int(u.group(1)), int(u.group(2)), int(u.group(3)))

G = collections.defaultdict(list)
for aid, d in S.items():
    G[seg(d["ts"])].append((d["ts"], aid, d))
R = ["# The raw subagent transcripts of the first experiment", "",
     "Every one of the 154 subagents that played an agent in the ten-agent society, with the exact prompt it was shown, "
     "the tools it used, and the exact reply it returned. Grouped by run, then by time. "
     "Each agent was told to read only its own prompt file and answer with one JSON object. The prompt text below is what the agent "
     "actually read from its file. Token figures are the totals the harness reported for that subagent.", ""]
order = ["Pilot A (easy rules: 30 start, cost 8)", "Pilot B (tight rules: 15 start, cost 14)",
         "Run 1 (uneven wealth: 3 rich at 60, 7 poor at 20, cost 22)", "Run 2 (even wealth inside each model: 5 rich, 5 poor, cost 22)"]
summary = []
for g in order:
    items = sorted(G.get(g, []))
    toks = [tok[a][0] for _, a, _ in items if a in tok]
    avg = (sum(toks) / len(toks)) if toks else 0
    extra = [(d["desc"], d["calls"]) for _, a, d in items if any(c.startswith("UNREQUESTED") for c in d["calls"])]
    summary.append(f"| {g} | {len(items)} | {len(toks)} | {avg:,.0f} | {avg * len(items):,.0f} | {len(extra)} |")
R += ["| Run | Subagent calls | Calls with a token figure | Average tokens per call | Estimated total tokens | Calls with unrequested tool use |", "|---|---|---|---|---|---|"] + summary + [""]
R += ["## Unrequested tool use by subagents", "",
      "Each agent was told to read only its own file and use no other tool. Two of 154 agents did something else:", ""]
for g in order:
    for t, aid, d in sorted(G.get(g, [])):
        for c in d["calls"]:
            if c.startswith("UNREQUESTED"):
                R.append(f"- **{d['desc']}** ({g.split(' (')[0]}, {t[11:19]} UTC): {c}" + (" Result: the call was **denied** by the session's safety classifier as an unrequested action." if "send_message" in c else " Result: the call succeeded (it only read the environment documentation index) and the agent disclosed it in its reply."))
R.append("")
for g in order:
    items = sorted(G.get(g, []))
    R += ["", "---", "", f"# {g}", ""]
    last = None
    for t, aid, d in items:
        turn = re.search(r"(d\d+t\d+|turn \d+)", d["desc"])
        tn = turn.group(1) if turn else ""
        if tn != last:
            R += ["", f"## Turn {tn.replace('turn ', 'd1t') if tn.startswith('turn') else tn}", ""]
            last = tn
        tk = tok.get(aid)
        R.append(f"### {d['desc']} · model `{d['model']}` · launched {t[11:19]} UTC" + (f" · {tk[0]:,} tokens, {tk[1]} tool uses, {tk[2] / 1000:.1f}s" if tk else ""))
        R.append("")
        if d["prompt_ask"]:
            R += ["**Instruction it received:**", "", f"> {d['prompt_ask'].strip()}", ""]
        for rd in d["reads"][:1]:
            R += ["**The situation it read (its whole prompt):**", "", "```", rd.strip(), "```", ""]
        if d["calls"]:
            R += ["**Tools it used:** " + "; ".join(d["calls"]), ""]
        R += ["**Its raw reply:**", "", "```", d["reply"].strip(), "```", ""]
open(OUT + "/06_SUBAGENT_RAW_TRANSCRIPTS.md", "w").write("\n".join(R) + "\n")
print("subagents parsed:", len(S), {g: len(v) for g, v in G.items()})
for f in ("00_CONVERSATION.md", "00b_FULL_SESSION_LOG.md", "06_SUBAGENT_RAW_TRANSCRIPTS.md"):
    print(f, os.path.getsize(f"{OUT}/{f}"))
