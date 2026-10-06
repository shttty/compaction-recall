CHARS_PER_TOKEN = 4.84

DEV8 = ("778164c6", "51b23612", "ceb54acb", "577d4d32", "3d86fd0a", "15745da0", "gpt4_65aabe59", "982b5123")

ASK = ("Please answer the question based on the relevant chat history above. Answer the question step by step: "
       "first extract all the relevant information, and then reason over the information to get the answer.\n\n"
       "Current Date: {}\nQuestion: {}\nAnswer (step by step):")

_BASE = ("I will give you a question, a correct answer, and a response from a model. Please answer yes if the response "
         "contains the correct answer. Otherwise, answer no. ")

_STEPS = ("If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct "
          "answer, you should also answer yes. If the response only contains a subset of the information required by the "
          "answer, answer no. ")

_TAIL = "\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only."

JUDGE = {
    "single-session-user": _BASE + _STEPS + _TAIL,
    "single-session-assistant": _BASE + _STEPS + _TAIL,
    "multi-session": _BASE + _STEPS + _TAIL,
    "temporal-reasoning": _BASE + _STEPS + "In addition, do not penalize off-by-one errors for the number of days. If the "
        "question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting "
        "19 days when the answer is 18), the model's response is still correct. " + _TAIL,
    "knowledge-update": _BASE + "If the response contains some previous information along with an updated answer, the "
        "response should be considered as correct as long as the updated answer is the required answer." + _TAIL,
    "single-session-preference": "I will give you a question, a rubric for desired personalized response, and a response "
        "from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model "
        "does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes "
        "the user's personal information correctly.\n\nQuestion: {}\n\nRubric: {}\n\nModel Response: {}\n\nIs the model "
        "response correct? Answer yes or no only.",
}

ABSTAIN = ("I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the "
           "model correctly identifies the question as unanswerable. The model could say that the information is incomplete, "
           "or some other information is given but the asked information is not.\n\nQuestion: {}\n\nExplanation: {}\n\n"
           "Model Response: {}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.")

def parse_date(s):  # "2023/05/20 (Sat) 02:21"
    return datetime.strptime(re.sub(r" \(\w+\)", "", s), "%Y/%m/%d %H:%M").replace(tzinfo=timezone.utc)

def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

def build_session(q, path, pi=False):
    """Haystack -> v3 session jsonl (OMP: title slot + header; Pi: header), linear message chain."""
    sessions = sorted(((parse_date(d), d, s) for d, s in zip(q["haystack_dates"], q["haystack_sessions"]) if s),
                      key=lambda x: x[0])
    start = sessions[0][0]
    title = json.dumps({"type": "title", "v": 1, "title": q["question_id"], "updatedAt": iso(start), "pad": ""},
                       separators=(",", ":"))
    lines = [] if pi else [title.replace('"pad":""', '"pad":"' + " " * (255 - len(title.encode())) + '"')]
    lines.append(json.dumps({"type": "session", "version": 3, "id": str(uuid.uuid4()), "timestamp": iso(start),
                             "cwd": str(RUNS / "cwd")}))
    parent, n, chars = None, 0, 0
    for when, label, turns in sessions:
        turns = [dict(t) for t in turns]
        if turns[0]["role"] == "user":
            turns[0]["content"] = f"[Session Date: {label}]\n{turns[0]['content']}"
        else:
            turns.insert(0, {"role": "user", "content": f"[Session Date: {label}]"})
        for t in turns:
            ts = when + timedelta(seconds=n)
            n += 1
            eid = f"{n:08x}"
            ms = int(ts.timestamp() * 1000)
            content = [{"type": "text", "text": t["content"]}]
            chars += len(t["content"])
            if t["role"] == "user":
                msg = {"role": "user", "content": content, "attribution": "user", "timestamp": ms}
            else:
                # ponytail: estimated usage for OMP's context accounting; a zero here makes snapcompact
                # refuse to run.
                est = int(chars / CHARS_PER_TOKEN)
                msg = {"role": "assistant", "content": content, "api": "openai-responses", "provider": "clp",
                       "model": MODEL, "usage": {"input": est, "output": 0, "cacheRead": 0, "cacheWrite": 0,
                       "totalTokens": est, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}},
                       "stopReason": "stop", "timestamp": ms}
            lines.append(json.dumps({"type": "message", "id": eid, "parentId": parent, "timestamp": iso(ts),
                                     "message": msg}, ensure_ascii=False))
            parent = eid
    assert pi or len(lines[0].encode()) == 255, len(lines[0].encode())
    path.write_text("\n".join(lines) + "\n")

def chunk_cuts(msgs, parts):
    """Indexes splitting msgs into `parts` roughly equal-size chunks, each starting at a user message."""
    sizes = [len(m) for m in msgs]
    total, cuts, acc, k = sum(sizes), [], 0, 1
    for i, s in enumerate(sizes):
        if k < parts and acc >= total * k / parts and json.loads(msgs[i])["message"]["role"] == "user":
            cuts.append(i); k += 1
        acc += s
    return cuts

def jsonl_lines(path):
    """JSONL rows split on '\\n' only; str.splitlines() also breaks on U+2028 etc. inside ensure_ascii=False JSON."""
    return [l for l in path.read_text().split("\n") if l]

def append_entries(sess, chunk):
    """Append raw history after the current leaf. Assistant usage is re-estimated from the latest
    compaction's tokensAfter so OMP's context accounting matches what is actually live."""
    rows = [json.loads(l) for l in jsonl_lines(sess)]
    parent = rows[-1]["id"]
    base = next((r.get("tokensAfter") or 0 for r in reversed(rows) if r.get("type") == "compaction"), 0)
    out, chars = [], 0
    for line in chunk:
        o = json.loads(line); o["parentId"] = parent; parent = o["id"]
        m = o["message"]
        chars += sum(len(b.get("text", "")) for b in m["content"])
        if m["role"] == "assistant":
            m["usage"]["input"] = m["usage"]["totalTokens"] = base + int(chars / CHARS_PER_TOKEN)
        out.append(json.dumps(o, ensure_ascii=False))
    with sess.open("a") as f:
        f.write("\n".join(out) + "\n")
