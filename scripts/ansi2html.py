#!/usr/bin/env python3
"""Render a `tmux capture-pane -e` dump (ANSI SGR) into a standalone HTML page.

Usage: ansi2html.py INPUT.ansi OUTPUT.html [--cols N] [--title TEXT]
Stdlib only, so it runs anywhere python3 exists.
"""
import argparse
import html
import re

BACKGROUND = "#1a1b1e"
FOREGROUND = "#d4d4d4"
ANSI_16 = [
    "#1a1b1e", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#d4d4d4",
    "#5c6370", "#ff7b86", "#b5e890", "#ffd88a", "#7cc4ff", "#de95f0", "#6fd6e2", "#ffffff",
]
ESCAPE_SEQUENCE = re.compile(r"\x1b\[([0-9;:]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]")


def xterm_256(index):
    if index < 16:
        return ANSI_16[index]
    if index < 232:
        index -= 16
        steps = [0, 95, 135, 175, 215, 255]
        return "#%02x%02x%02x" % (steps[index // 36], steps[(index // 6) % 6], steps[index % 6])
    gray = 8 + (index - 232) * 10
    return "#%02x%02x%02x" % (gray, gray, gray)


class Style:
    def __init__(self):
        self.reset()

    def reset(self):
        self.fg = None
        self.bg = None
        self.bold = self.dim = self.italic = self.underline = self.inverse = self.strike = False

    def key(self):
        return (self.fg, self.bg, self.bold, self.dim, self.italic, self.underline, self.inverse, self.strike)

    def css(self):
        fg, bg = self.fg or FOREGROUND, self.bg
        if self.inverse:
            fg, bg = (self.bg or BACKGROUND), (self.fg or FOREGROUND)
        rules = [f"color:{fg}"]
        if bg:
            rules.append(f"background:{bg}")
        if self.bold:
            rules.append("font-weight:700")
        if self.dim:
            rules.append("opacity:.55")
        if self.italic:
            rules.append("font-style:italic")
        decorations = [name for name, on in (("underline", self.underline), ("line-through", self.strike)) if on]
        if decorations:
            rules.append("text-decoration:" + " ".join(decorations))
        return ";".join(rules)

    def apply_extended_color(self, code, values):
        color = None
        if values and values[0] == 5 and len(values) >= 2:
            color = xterm_256(values[1])
        elif values and values[0] == 2 and len(values) >= 4:
            color = "#%02x%02x%02x" % tuple(values[-3:])
        if code == 38:
            self.fg = color
        else:
            self.bg = color

    def apply(self, raw_params):
        groups = raw_params.split(";") if raw_params else ["0"]
        params = []
        for group in groups:
            if ":" in group:
                parts = [int(p) if p else 0 for p in group.split(":")]
                if parts[0] in (38, 48):
                    self.apply_extended_color(parts[0], parts[1:])
                continue
            params.append(int(group) if group else 0)
        i = 0
        while i < len(params):
            code = params[i]
            if code == 0:
                self.reset()
            elif code == 1:
                self.bold = True
            elif code == 2:
                self.dim = True
            elif code == 3:
                self.italic = True
            elif code == 4:
                self.underline = True
            elif code == 7:
                self.inverse = True
            elif code == 9:
                self.strike = True
            elif code == 22:
                self.bold = self.dim = False
            elif code == 23:
                self.italic = False
            elif code == 24:
                self.underline = False
            elif code == 27:
                self.inverse = False
            elif code == 29:
                self.strike = False
            elif 30 <= code <= 37:
                self.fg = ANSI_16[code - 30]
            elif 90 <= code <= 97:
                self.fg = ANSI_16[code - 90 + 8]
            elif 40 <= code <= 47:
                self.bg = ANSI_16[code - 40]
            elif 100 <= code <= 107:
                self.bg = ANSI_16[code - 100 + 8]
            elif code == 39:
                self.fg = None
            elif code == 49:
                self.bg = None
            elif code in (38, 48) and i + 1 < len(params):
                width = 3 if params[i + 1] == 5 else 5 if params[i + 1] == 2 else 2
                self.apply_extended_color(code, params[i + 1:i + width])
                i += width - 1
            i += 1


def render_line(line, style):
    pieces, buffer, current_key, current_css = [], [], None, None

    def flush():
        if buffer:
            pieces.append(f'<span style="{current_css}">{html.escape("".join(buffer))}</span>')
            buffer.clear()

    position = 0
    for match in ESCAPE_SEQUENCE.finditer(line):
        text = line[position:match.start()]
        if text:
            if style.key() != current_key:
                flush()
                current_key, current_css = style.key(), style.css()
            buffer.append(text)
        if match.group(1) is not None or match.group(0).endswith("m"):
            style.apply(match.group(1) or "")
        position = match.end()
    text = line[position:]
    if text:
        if style.key() != current_key:
            flush()
            current_key, current_css = style.key(), style.css()
        buffer.append(text)
    flush()
    return "".join(pieces)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("destination")
    parser.add_argument("--cols", type=int, default=120)
    parser.add_argument("--title", default="")
    args = parser.parse_args()

    with open(args.source, encoding="utf-8", errors="replace") as handle:
        lines = handle.read().rstrip("\n").split("\n")

    style = Style()
    body = "\n".join(render_line(line, style) or " " for line in lines)
    caption = f'<div class="caption">{html.escape(args.title)}</div>' if args.title else ""
    page = f"""<!doctype html><html><head><meta charset="utf-8"><style>
html,body{{margin:0;background:{BACKGROUND}}}
.frame{{padding:14px 16px;display:inline-block}}
.caption{{font:600 12px -apple-system,Helvetica,sans-serif;color:#8a8f98;margin-bottom:8px}}
pre{{margin:0;font:14px/17px Menlo,"SF Mono",monospace;color:{FOREGROUND};width:{args.cols}ch;white-space:pre}}
</style></head><body><div class="frame">{caption}<pre>{body}</pre></div></body></html>"""
    with open(args.destination, "w", encoding="utf-8") as handle:
        handle.write(page)


if __name__ == "__main__":
    main()
