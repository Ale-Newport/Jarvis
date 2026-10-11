"""Measure where time goes: Laya inference, CDP round trips, observation, task phases. Prints a table (no claims, just numbers).

    uv run python scripts/benchmark.py
"""

import asyncio
import statistics
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "tests"))

from fixture_site import FixtureSite  # noqa: E402

from jarvis.browser import BrowserSession  # noqa: E402
from jarvis.laya_engine import LayaEngine  # noqa: E402


def pct(values, q):
    values = sorted(values)
    return values[min(len(values) - 1, round(q * (len(values) - 1)))]


def row(name, values, unit="ms"):
    print(f"{name:<44} n={len(values):<3} median {statistics.median(values):7.1f} {unit}   p95 {pct(values, .95):7.1f} {unit}   max {max(values):7.1f} {unit}")


async def main() -> None:
    site = FixtureSite().start()
    data = Path(tempfile.mkdtemp())
    laya = LayaEngine()
    started = time.perf_counter()
    await laya.ensure_loaded()
    print(f"Laya load {laya.load_ms} ms + warm-up {laya.warm_ms} ms (first use in this process: {(time.perf_counter() - started) * 1000:.0f} ms)")
    questions = {"q": {"type": "choice", "instructions": "Which element sets the destination?", "criteria": {str(i): f"textbox Field {i} (placeholder {i})" for i in range(8)}}}
    state = "Requirement: destination = Madrid"
    laya_ms = []
    for _ in range(60):
        t = time.perf_counter()
        await laya.run(laya.system_one, state, questions)
        laya_ms.append((time.perf_counter() - t) * 1000)
    row("Laya choice question (8 options), end to end", laya_ms)

    session = BrowserSession(data)
    t = time.perf_counter()
    await session.connect("managed")
    print(f"Chrome launch + connect: {(time.perf_counter() - t) * 1000:.0f} ms")
    tab = await session.new_tab(f"{site.url}/site/flights.html")
    send, observe, fresh, goto = [], [], [], []
    for _ in range(40):
        t = time.perf_counter()
        await tab.evaluate("1+1")
        send.append((time.perf_counter() - t) * 1000)
    for _ in range(40):
        t = time.perf_counter()
        page = await tab.observe()
        observe.append((time.perf_counter() - t) * 1000)
    action = next(a for a in page["actions"] if a["kind"] == "click")
    for _ in range(40):
        t = time.perf_counter()
        await tab.fresh(page, action)
        fresh.append((time.perf_counter() - t) * 1000)
    for i in range(15):
        t = time.perf_counter()
        await tab.goto(f"{site.url}/search?q=bench{i}")
        goto.append((time.perf_counter() - t) * 1000)
    row("CDP round trip (Runtime.evaluate)", send)
    row("observe: indexed elements + visible text", observe)
    row("freshness check before an action", fresh)
    row("navigation to load event (local server)", goto)
    await session.shutdown()
    site.stop()


asyncio.run(main())
