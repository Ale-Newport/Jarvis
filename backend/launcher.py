"""PyInstaller entry point for the packaged sidecar (run with `python -m jarvis.server` in development)."""

import multiprocessing

from jarvis.server import main

if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
