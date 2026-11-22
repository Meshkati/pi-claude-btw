#!/usr/bin/env python3
"""Record a tmux pane as timestamped ANSI frames until <out>/STOP exists.

Usage: record_frames.py <out-dir> <tmux-socket> <tmux-target>
Writes <out>/NNNNN.ansi for every change and <out>/timeline.txt ("<frame> <seconds>").
"""
import pathlib
import subprocess
import sys
import time

POLL_SECONDS = 0.05


def capture(socket, target):
    return subprocess.run(
        ["tmux", "-L", socket, "capture-pane", "-p", "-e", "-t", target],
        capture_output=True, text=True,
    ).stdout


def main():
    out, socket, target = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
    out.mkdir(parents=True, exist_ok=True)
    stop = out / "STOP"
    start = time.monotonic()
    previous, count, timeline = None, 0, []
    while not stop.exists():
        frame = capture(socket, target)
        if frame != previous:
            count += 1
            (out / f"{count:05d}.ansi").write_text(frame, encoding="utf-8")
            timeline.append(f"{count:05d} {time.monotonic() - start:.3f}")
            previous = frame
        time.sleep(POLL_SECONDS)
    timeline.append(f"end {time.monotonic() - start:.3f}")
    (out / "timeline.txt").write_text("\n".join(timeline) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
