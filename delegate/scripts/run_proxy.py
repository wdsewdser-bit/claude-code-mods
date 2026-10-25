"""ant2oai with one shim: Claude Code may send role='system' messages inside
`messages`; the proxy only accepts user/assistant. Each one is turned into a
user text block at the same position (merged into a neighbouring user turn),
so earlier turns never change and the upstream prefix cache keeps hitting.
Folding them into the top-level system prompt would rewrite the start of every
request each turn. An optional --effort low|high|max|off sets reasoning_effort (off: thinking disabled)
in the upstream body. Everything else is stock ant2oai."""
import sys

import a2o.server as server
from a2o.cli import main

_stock = server.parse_anthropic_request


def _blocks(content):
    if isinstance(content, list):
        return [b for b in content if isinstance(b, dict)]
    return [{"type": "text", "text": str(content)}]


def _unfold(data):
    msgs = data.get("messages")
    if not isinstance(msgs, list) or not any(
        isinstance(m, dict) and m.get("role") == "system" for m in msgs
    ):
        return data
    kept = []
    for m in msgs:
        if not isinstance(m, dict):
            kept.append(m)
            continue
        if m.get("role") == "system":
            c = m.get("content")
            if isinstance(c, list):
                c = "\n".join(b.get("text", "") for b in c if isinstance(b, dict))
            m = {"role": "user", "content": [{"type": "text", "text": str(c)}]}
        if kept and isinstance(kept[-1], dict) and kept[-1].get("role") == "user" and m.get("role") == "user":
            kept[-1] = {**kept[-1], "content": _blocks(kept[-1].get("content")) + _blocks(m.get("content"))}
        else:
            kept.append(m)
    data = dict(data)
    data["messages"] = kept
    return data


server.parse_anthropic_request = lambda data: _stock(_unfold(data))

def _take_effort(argv):
    rest, effort, i = [], None, 0
    while i < len(argv):
        if argv[i] == "--effort" and i + 1 < len(argv):
            effort = argv[i + 1]
            i += 2
        elif argv[i].startswith("--effort="):
            effort = argv[i].split("=", 1)[1]
            i += 1
        else:
            rest.append(argv[i])
            i += 1
    return rest, effort


def _patch_effort(effort):
    if effort not in ("low", "high", "max", "off"):
        return
    stock = server.convert_anthropic_to_openai

    def convert(*args, **kwargs):
        body = stock(*args, **kwargs)
        if effort == "off":
            body.pop("reasoning_effort", None)
            body["thinking"] = {"type": "disabled"}
        else:
            body["reasoning_effort"] = effort
        return body

    server.convert_anthropic_to_openai = convert


if __name__ == "__main__":
    _args, _effort = _take_effort(sys.argv[1:])
    _patch_effort(_effort)
    main(_args)
