"""Developer driver: run one or more requests through the real app core (real Chrome, real Laya, real text model).

    uv run python scripts/run_task.py --data-dir /tmp/jarvis-dev "Open github.com/torvalds/linux"

Prints the event stream and the final answer with timings. Pass several requests to simulate follow-ups.
"""

import argparse
import asyncio
import json
import logging
import sys
from pathlib import Path

from jarvis.app import App
from jarvis.settings import Secrets


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("requests", nargs="+")
    parser.add_argument("--data-dir", default="/tmp/jarvis-dev")
    parser.add_argument("--model", default="")
    parser.add_argument("--mode", default="managed")
    parser.add_argument("--keep-open", action="store_true")
    parser.add_argument("--json", action="store_true", help="print the final task JSON")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.WARNING, format="%(name)s: %(message)s")
    for noisy in ("httpx", "websockets", "asyncio", "httpcore", "huggingface_hub"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    app = App(Path(args.data_dir), downloads_dir=Path(args.data_dir) / "downloads", secrets=Secrets())
    await app.update_settings({"agent": {"allow_local_urls": True}, "chrome": {"mode": args.mode, **({"keep_open_on_quit": True} if args.keep_open else {})}})
    if args.model:
        await app.update_settings({"llm": {"model": args.model}})
    await app.start()
    queue = app.bus.subscribe()
    conversation = app.store.create_conversation()
    exit_code = 0
    for text in args.requests:
        print(f"\n=== {text}")
        _message, task = await app.send_message(conversation["id"], text)
        run = app.task(task["id"])

        async def pump(target):
            while True:
                event = await queue.get()
                t, d = event["type"], event["data"]
                if t == "step.started":
                    print(f"  ▸ [{d['kind']}] {d['title']} {d.get('detail') or ''}")
                elif t == "step.finished" and d["status"] == "error":
                    print(f"    ✗ {d['error']}")
                elif t == "confirm.request":
                    print(f"  ? CONFIRM: {d['question']} -> auto-denying")
                    target.answer_confirmation(d["confirmation_id"], False)
                elif t == "needs_user":
                    print(f"  ! NEEDS USER: {d['message']}")

        pumper = asyncio.create_task(pump(run))
        await run._asyncio_task
        pumper.cancel()
        final = run.to_dict()
        print(f"--- {final['status']} in {final['elapsed_ms']} ms  timings={final['timings']}")
        print("    profile:", {k: f"{int(v[0])}x {v[1]:.0f}ms" for k, v in app.browser.metrics.profile.items()})
        print(run.result["markdown"])
        for card in run.result["cards"]:
            n = len(card.get("items", card.get("rows", [])))
            print(f"  [card {card['type']}: {n}]")
        if final["status"] not in {"done"}:
            exit_code = 1
        if args.json:
            print(json.dumps(final, indent=2))
    await app.shutdown()
    return exit_code


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
