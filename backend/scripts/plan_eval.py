"""Check what the text model plans for representative requests (no browser). Usage: plan_eval.py [model ...]"""

import asyncio
import sys

from jarvis.llm import LlmClient, LlmConfig
from jarvis.planner import make_plan

CASES = [
    ("Search Google for the official Python documentation and open the official website.",
     lambda p: [s.tool for s in p.steps][:2] == ["search", "open_link"] and p.then == "done"),
    ("Open Wikipedia and find the article about artificial intelligence.",
     lambda p: p.steps[0].tool == "goto" and any(s.tool == "interact" for s in p.steps) and p.then == "done"
     and not any(s.tool in {"read", "extract"} for s in p.steps)),
    ("Find one-way direct flights from London to Madrid for one adult on a valid future date.",
     lambda p: p.steps[0].tool == "goto" and "flights" in p.steps[0].args["url"] and any(s.tool == "interact" for s in p.steps)
     and any(s.tool == "extract" for s in p.steps) and p.then == "answer"),
    ("Search Google Images for realistic tropical palm trees.",
     lambda p: p.steps[0].tool == "search" and p.steps[0].args["kind"] == "images" and any(s.tool == "images" for s in p.steps) and p.then == "answer"),
    ("Find three websites offering free 3D models and compare them.",
     lambda p: p.steps[0].tool == "search" and p.then == "replan"),
    ("Summarize the pricing plans on https://www.notion.so/pricing",
     lambda p: p.steps[0].tool == "goto" and any(s.tool in {"read", "extract"} for s in p.steps) and p.then == "answer"),
    ("Navigate to Google Maps and search for the Eiffel Tower.",
     lambda p: (p.steps[0].tool == "search" and p.steps[0].args["kind"] == "maps") or (p.steps[0].tool == "goto" and "maps" in p.steps[0].args["url"])),
]


async def main() -> None:
    for model in sys.argv[1:] or ["qwen3:30b-instruct"]:
        llm = LlmClient(LlmConfig(model=model))
        print(f"##### {model}")
        for request, check in CASES:
            try:
                plan, result = await make_plan(llm, request, "BROWSER STATE: no tabs are open yet.\n\n")
                ok = bool(check(plan))
                print(f"{'PASS' if ok else 'FAIL'} {result.latency_ms:5d}ms  {request[:60]}")
                if not ok:
                    print("     ", plan.then, [s.label() for s in plan.steps])
            except Exception as error:
                print(f"ERR  {request[:60]}: {error}")
        await llm.aclose()


asyncio.run(main())
