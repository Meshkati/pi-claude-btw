# Claude Code `/btw` reference captures

These screenshots are the ground truth the pi extension copies. They come from a real Claude Code session (v2.1.330, Sonnet 5.5, dark theme) driven through tmux at 120×40 by [`scripts/capture-references.sh`](../scripts/capture-references.sh). Each scenario has three files:

- `NN-name.png`: the rendered screen.
- `raw/NN-name.ansi`: the pane with its colour escapes (`tmux capture-pane -e`). Use this to check exact colours and spacing.
- `raw/NN-name.txt`: the plain text of the pane.

To recapture, run `scripts/capture-references.sh`. To rerun a few scenarios in a fresh session, run `ONLY="05 12" scripts/capture-references.sh`.

## Scenarios

| # | Scenario | What it shows |
|---|---|---|
| 01 | Typing `/btw` | The slash menu describes it as "Ask a side question without interrupting Claude". |
| 02 | `/btw` with nothing after it, and no history | The transcript gets `❯ /btw` then `⎿ Usage: /btw <your question>`. No panel opens. |
| 03a | Question submitted | The panel replaces the prompt box and status line. It shows a spinner, `Answering…`, and only `Esc to close`. |
| 03b | Answer arrived | The answer is indented 4 columns. Hints: `c to copy · f to fork · Esc to close`. |
| 04 | Esc | The panel closes and the transcript is unchanged: no question and no answer in it. |
| 05 | Question about the main conversation | btw knows the codename and colour from the main chat. The earlier btw question is listed above the current one. |
| 06a/b | Shift+← / Shift+→ | Shift+← selects the older exchange: its line turns bold, its answer is shown, and `f to fork` disappears. Shift+→ returns to the newest. |
| 07 | `c` | Copies the answer. For 2 s the `c to copy` hint is replaced by a green `Copied to clipboard`. |
| 08 | btw remembers earlier btw | Earlier side exchanges are part of the next side question's context. |
| 09 | Main agent asked about btw | The main agent never sees side questions. |
| 10a–d | `/btw` while the main agent runs a 25 s command | The main spinner keeps going above the panel. The side answer arrives first, and the main turn then finishes unaware of it. |
| 11 | "run ls" | No tools. btw says it can't run commands from a side question and points to the main conversation. |
| 12a–c | 45-line answer | The answer area is bounded: ↑/↓ markers sit in the last column, `↑/↓ to scroll` appears, each arrow press moves 3 lines, and End jumps to the bottom. |
| 13 | Ten questions | Only the last 5 earlier questions are listed, with a dim `(+N earlier /btw)` line above them. |
| 14 | `x` | Clears the earlier history. The exchange on screen stays. |
| 15 | `/btw` with nothing after it, history present | Reopens the last answer without asking again. |
| 16a/b | Esc while answering | Cancels the request. The cancelled question is not kept in history. |
| 17 | Markdown answer | Rendered with Claude Code's transcript markdown renderer. |
| 18 | 64×30 terminal | The separator still spans the full width. The answer and the hint line wrap. |
| 19a/b | Long context (a 1,400-line log read by the main agent) | btw answers a detail from deep in that context without reading the file again. |
| 20a/b | `f` | Forks the side question into a background agent that has tools. The transcript records `⑂ forked …`, and the agent's result comes back to the main conversation. |

## Behaviour spec

Everything below comes from these captures, plus strings and code read from the installed Claude Code binary.

### Panel layout, top to bottom

```
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔   full width, colour 153 (the "permission" colour)
  (+4 earlier /btw)                       dim, only when more than 5 earlier questions exist
  /btw earlier question …                 dim; bold when selected while browsing
  /btw current question                   "/btw " bold + colour 153, question dim; whole line dim while browsing

    answer, rendered as markdown         indent 4, scrollable, ↑/↓ markers dim in the last column

  ↑/↓ to scroll · ⇧←/→ to browse · c to copy · f to fork · x to clear history · Esc to close   italic, dim
```

- Questions are whitespace-collapsed and truncated to `max(20, columns − 7)`.
- Answer height is `max(5, rows − 14 − historyLines)`, where `historyLines` counts the `(+N…)` line too. At 40 rows with 5 earlier questions that gives 21 lines.
- Each hint appears only when it applies:
  - scroll: only when the answer overflows.
  - browse and clear history: only when there is earlier history.
  - copy: only when an answer is shown.
  - fork: only for the newest real answer, and not while browsing.
- While loading, the body is a spinner glyph (`·✢✳✶✻✽`, shimmering) followed by `Answering…`.
- After `c`, the copy hint becomes `Copied to clipboard` in the success colour (114) for 2 s.

### Keys

| Key | Action |
|---|---|
| Esc, Enter, Space, Ctrl+C, Ctrl+D | Close. A question still loading is cancelled. |
| ↑ / Ctrl+P, ↓ / Ctrl+N | Scroll 3 lines |
| PgUp / PgDn, Home / End | Page; jump to top or bottom |
| Shift+← / Shift+→, `[` / `]` | Browse older or newer, limited to the 5 visible earlier entries |
| Tab / Shift+Tab | Browse, wrapping around |
| `c` | Copy the answer on screen |
| `x` | Clear earlier history |
| `f` | Fork (newest answer only) |

### Model request

- Context: the whole main conversation, then each earlier side exchange as a user/assistant pair, then one user message. That message is a `<system-reminder>` block followed by the question. The reminder says btw is a separate lightweight agent, has no tools, answers in one response, and must not promise to do anything.
- Same model, system prompt and tool declarations as the main agent, so the prompt cache is reused. Tool use is denied: if the model tries a tool, the answer says `(The model tried to call X instead of answering directly. …)`.
- If the main agent is mid-turn, its unanswered tool calls get a placeholder result: `[No result yet — this call is still in progress in the main conversation …]`.
- Nothing is written to the transcript. Failed, cancelled and synthetic answers are not kept in the side history.
