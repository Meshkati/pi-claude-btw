/**
 * /btw: ask a side question without interrupting the agent.
 *
 * A port of Claude Code's /btw to pi. The side question is answered in a bottom panel
 * that temporarily replaces the editor, from the conversation so far, with no tools and
 * without adding anything to the session. See references/README.md for the behaviour
 * this reproduces, captured from Claude Code itself.
 */
import type { AssistantMessage, Message, ThinkingLevel, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	copyToClipboard,
	type ExtensionAPI,
	type ExtensionCommandContext,
	getMarkdownTheme,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, Key, Markdown, matchesKey, type TUI, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// Claude Code's own wording, so the model behaves the same way it does there.
const SIDE_QUESTION_REMINDER = `<system-reminder>This is a side question from the user. You must answer this question directly in a single response.
IMPORTANT CONTEXT:
- You are a separate, lightweight agent spawned to answer this one question
- The main agent is NOT interrupted - it continues working independently in the background
- You share the conversation context but are a completely separate instance
- Do NOT reference being interrupted or what you were "previously doing" - that framing is incorrect
CRITICAL CONSTRAINTS:
- You have NO tools available - you cannot read files, run commands, search, or take any actions
- Do NOT write tool calls or tool output as text (for example invoke or function_calls XML blocks) - nothing you write here is executed; if answering would need reading files, running commands, or searching, say that can't be checked from a side question and suggest asking in the main conversation
- This is a one-off response - there will be no follow-up turns
- You can ONLY provide information based on what you already know from the conversation context
- NEVER say things like "Let me try...", "I'll now...", "Let me check...", or promise to take any action
- If you don't know the answer, say so - do not offer to look it up or investigate
Simply answer the question with the information you have.</system-reminder>
`;
const PENDING_TOOL_RESULT =
	"[No result yet — this call is still in progress in the main conversation (running, awaiting approval, or queued)]";
const FAKE_TOOL_CALLS_NOTICE =
	"_/btw can't run tools: any tool calls or tool output shown above were not executed and may not reflect your actual files or data. Ask in the main conversation to check._";
const CUT_OFF_NOTICE = "_(This answer was cut off before it finished. Ask again to retry.)_";
const TOOL_ATTEMPT_SUFFIX = " instead of answering directly. Try rephrasing or ask in the main conversation.)";
const FAKE_TOOL_CALLS_IN_HISTORY = "(That answer wrote tool calls as text. Nothing was executed, so it is omitted here.)";
const CUT_OFF_IN_HISTORY = "(That answer was cut off before it finished, so it is omitted here.)";
const FAKE_TOOL_CALL_MARKUP = /<\/?(?:antml:)?(?:function_calls|invoke)\b/;
const USAGE = "Usage: /btw <your question>";

const VISIBLE_HISTORY = 5;
const SCROLL_STEP = 3;
const MIN_ANSWER_ROWS = 5;
const ROWS_RESERVED_AROUND_ANSWER = 14;
const COPIED_FLASH_MS = 2000;
const SPINNER_FRAMES = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
const SPINNER_INTERVAL_MS = 120;
const PANEL_INDENT = "  ";
const ANSWER_INDENT = "    ";

interface Exchange {
	question: string;
	answer: string;
}

type Outcome = { answer: string; synthetic: boolean } | { error: string };

type PanelResult = { fork: Exchange } | undefined;

export default function btwExtension(pi: ExtensionAPI) {
	// One instance per session, so this history belongs to the current session only.
	let exchanges: Exchange[] = [];
	const inFlight = new Set<AbortController>();

	pi.on("session_shutdown", () => {
		for (const controller of inFlight) controller.abort();
	});

	pi.registerMessageRenderer<Exchange>("btw", (message, _options, theme) => {
		const exchange = message.details;
		return exchange ? new ForkedExchangeView(exchange, theme) : undefined;
	});

	pi.registerCommand("btw", {
		description: "Ask a side question without interrupting the agent",
		handler: async (args, ctx) => {
			const question = collapseWhitespace(args);
			if (!question) {
				const last = exchanges.at(-1);
				if (!last) {
					ctx.ui.notify(USAGE, "info");
					return;
				}
				return showPanel(ctx, { question: last.question, earlier: exchanges.slice(0, -1), answered: last });
			}
			if (ctx.mode !== "tui") {
				await answerWithoutPanel(ctx, question);
				return;
			}
			return showPanel(ctx, { question, earlier: [...exchanges] });
		},
	});

	async function answerWithoutPanel(ctx: ExtensionCommandContext, question: string) {
		const outcome = await ask(ctx, question, new AbortController());
		if (!ctx.hasUI || !outcome) return;
		if ("error" in outcome) ctx.ui.notify(outcome.error, "error");
		else ctx.ui.notify(outcome.answer, "info");
	}

	async function showPanel(
		ctx: ExtensionCommandContext,
		options: { question: string; earlier: Exchange[]; answered?: Exchange },
	) {
		const result = await ctx.ui.custom<PanelResult>((tui, theme, _keybindings, done) => {
			const panel = new SideQuestionPanel(tui, theme, {
				question: options.question,
				earlier: options.earlier,
				answer: options.answered?.answer,
				canFork: () => ctx.isIdle(),
				clearEarlier: (cleared) => {
					exchanges = exchanges.filter((exchange) => !cleared.includes(exchange));
				},
				close: done,
			});
			if (!options.answered) panel.waitFor((controller) => ask(ctx, options.question, controller));
			return panel;
		});
		if (result?.fork) await forkIntoSession(ctx, result.fork);
	}

	async function ask(ctx: ExtensionCommandContext, question: string, controller: AbortController): Promise<Outcome | null> {
		const model = ctx.model;
		if (!model) return { error: "No model selected. Pick one with /model." };
		inFlight.add(controller);
		try {
			const conversation = answerPendingToolCalls(convertToLlm(ctx.sessionManager.buildSessionProjection().messages));
			const sideThread = exchanges.flatMap((exchange) => [userMessage(exchange.question), replayedAnswer(exchange, model)]);
			const messages: Message[] = [
				...conversation,
				...sideThread,
				userMessage([SIDE_QUESTION_REMINDER, question]),
			];
			const reasoning = ctx.thinkingLevel === "off" ? undefined : (ctx.thinkingLevel as ThinkingLevel | undefined);
			const reply = await ctx.modelRegistry
				.streamSimple(model, { messages }, { signal: controller.signal, reasoning })
				.result();
			if (controller.signal.aborted || reply.stopReason === "aborted") return null;
			const outcome = readReply(reply);
			if ("answer" in outcome && !outcome.synthetic) exchanges.push({ question, answer: outcome.answer });
			return outcome;
		} catch (error) {
			if (controller.signal.aborted) return null;
			return { error: error instanceof Error && error.message ? error.message : "Couldn't get a response" };
		} finally {
			inFlight.delete(controller);
		}
	}

	async function forkIntoSession(ctx: ExtensionCommandContext, exchange: Exchange) {
		const leafId = ctx.sessionManager.getLeafId();
		if (!leafId) {
			ctx.ui.notify("Nothing to fork yet. Send a message first.", "info");
			return;
		}
		await ctx.fork(leafId, {
			position: "at",
			withSession: async (forked) => {
				await forked.sendMessage({
					customType: "btw",
					content: `The user asked this side question with /btw and got the answer below, given without tools. They forked it into this session to continue it.\n\nQuestion: ${exchange.question}\n\nAnswer:\n${exchange.answer}`,
					display: true,
					details: exchange,
				});
			},
		});
	}
}

class SideQuestionPanel implements Component {
	private answer: string | undefined;
	private synthetic = false;
	private error: string | undefined;
	private earlier: Exchange[];
	private browsing: number | null = null;
	private scrollTop = 0;
	private lastMaxScroll = 0;
	private lastAnswerRows = MIN_ANSWER_ROWS;
	private frame = 0;
	private copiedAt = 0;
	private controller: AbortController | undefined;
	private spinner: ReturnType<typeof setInterval> | undefined;
	private copiedTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly markdown = new Map<string, Markdown>();

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly options: {
			question: string;
			earlier: Exchange[];
			answer?: string;
			canFork: () => boolean;
			clearEarlier: (cleared: Exchange[]) => void;
			close: (result: PanelResult) => void;
		},
	) {
		this.earlier = options.earlier;
		this.answer = options.answer;
	}

	waitFor(run: (controller: AbortController) => Promise<Outcome | null>) {
		this.controller = new AbortController();
		this.spinner = setInterval(() => {
			this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
			this.tui.requestRender();
		}, SPINNER_INTERVAL_MS);
		run(this.controller).then((outcome) => {
			this.stopSpinner();
			this.controller = undefined;
			if (!outcome) return;
			if ("error" in outcome) this.error = outcome.error;
			else {
				this.answer = outcome.answer;
				this.synthetic = outcome.synthetic;
			}
			this.scrollTop = 0;
			this.tui.requestRender();
		});
	}

	render(width: number): string[] {
		const theme = this.theme;
		const questionWidth = Math.max(20, width - 7);
		const hiddenCount = Math.max(0, this.earlier.length - VISIBLE_HISTORY);
		const visibleEarlier = this.earlier.slice(hiddenCount);
		const lines = [theme.fg("border", "▔".repeat(width))];

		if (hiddenCount > 0) lines.push(PANEL_INDENT + theme.fg("dim", `(+${hiddenCount} earlier /btw)`));
		visibleEarlier.forEach((exchange, offset) => {
			const text = `/btw ${truncateToWidth(collapseWhitespace(exchange.question), questionWidth)}`;
			lines.push(PANEL_INDENT + (this.browsing === hiddenCount + offset ? theme.bold(text) : theme.fg("dim", text)));
		});
		const label = this.browsing === null ? theme.bold(theme.fg("border", "/btw ")) : theme.fg("dim", "/btw ");
		lines.push(PANEL_INDENT + label + theme.fg("dim", truncateToWidth(this.options.question, questionWidth)));
		lines.push("");

		const historyRows = visibleEarlier.length + (hiddenCount > 0 ? 1 : 0);
		const answerRows = Math.max(MIN_ANSWER_ROWS, this.tui.terminal.rows - ROWS_RESERVED_AROUND_ANSWER - historyRows);
		const body = this.renderBody(width - ANSWER_INDENT.length);
		const maxScroll = Math.max(0, body.length - answerRows);
		this.scrollTop = Math.min(this.scrollTop, maxScroll);
		this.lastMaxScroll = maxScroll;
		this.lastAnswerRows = answerRows;
		const shown = body.slice(this.scrollTop, this.scrollTop + answerRows);
		shown.forEach((line, row) => {
			const marker =
				row === 0 && this.scrollTop > 0 ? "↑" : row === shown.length - 1 && this.scrollTop < maxScroll ? "↓" : "";
			const text = ANSWER_INDENT + line;
			lines.push(marker ? truncateToWidth(text, width - 1, "", true) + theme.fg("dim", marker) : truncateToWidth(text, width));
		});

		lines.push("");
		for (const hintLine of wrapTextWithAnsi(this.renderHints(maxScroll > 0), width - PANEL_INDENT.length)) {
			lines.push(PANEL_INDENT + hintLine);
		}
		return lines;
	}

	private renderBody(width: number): readonly string[] {
		const shownAnswer = this.shownAnswer();
		if (shownAnswer !== undefined) return this.markdownFor(shownAnswer).render(width);
		if (this.error) return [this.theme.fg("error", this.error)];
		return [`${this.theme.fg("text", SPINNER_FRAMES[this.frame])} Answering…`];
	}

	private renderHints(scrollable: boolean): string {
		const theme = this.theme;
		const dim = (text: string) => theme.fg("dim", text);
		const hints: string[] = [];
		if (scrollable) hints.push(dim("↑/↓ to scroll"));
		if (this.earlier.length > 0) hints.push(dim("⇧←/→ to browse"));
		if (this.shownAnswer() !== undefined) {
			hints.push(this.isCopiedFlashOn() ? theme.fg("success", "Copied to clipboard") : dim("c to copy"));
		}
		if (this.canFork()) hints.push(dim("f to fork"));
		if (this.earlier.length > 0) hints.push(dim("x to clear history"));
		hints.push(dim("Esc to close"));
		return hints.map((hint) => theme.italic(hint)).join(theme.italic(dim(" · ")));
	}

	handleInput(data: string): void {
		if (
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.enter) ||
			matchesKey(data, Key.space) ||
			matchesKey(data, Key.ctrl("c")) ||
			matchesKey(data, Key.ctrl("d"))
		) {
			this.finish(undefined);
		} else if (matchesKey(data, "[") || matchesKey(data, Key.shift("left"))) {
			this.browse("older", false);
		} else if (matchesKey(data, "]") || matchesKey(data, Key.shift("right"))) {
			this.browse("newer", false);
		} else if (matchesKey(data, Key.tab)) {
			this.browse("older", true);
		} else if (matchesKey(data, Key.shift("tab"))) {
			this.browse("newer", true);
		} else if (matchesKey(data, "x") && this.earlier.length > 0) {
			this.options.clearEarlier(this.earlier);
			this.earlier = [];
			this.browsing = null;
			this.scrollTop = 0;
		} else if (matchesKey(data, "c") && this.shownAnswer() !== undefined) {
			this.copy(this.shownAnswer()!);
		} else if (matchesKey(data, "f") && this.canFork()) {
			this.finish({ fork: { question: this.options.question, answer: this.answer! } });
		} else if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) {
			this.scrollBy(-SCROLL_STEP);
		} else if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) {
			this.scrollBy(SCROLL_STEP);
		} else if (matchesKey(data, Key.pageUp)) {
			this.scrollBy(-this.lastAnswerRows);
		} else if (matchesKey(data, Key.pageDown)) {
			this.scrollBy(this.lastAnswerRows);
		} else if (matchesKey(data, Key.home)) {
			this.scrollTop = 0;
		} else if (matchesKey(data, Key.end)) {
			this.scrollTop = this.lastMaxScroll;
		} else {
			return;
		}
		this.tui.requestRender();
	}

	invalidate(): void {
		for (const markdown of this.markdown.values()) markdown.invalidate();
	}

	private shownAnswer(): string | undefined {
		return this.browsing === null ? this.answer : this.earlier[this.browsing]?.answer;
	}

	private canFork(): boolean {
		return this.answer !== undefined && !this.synthetic && this.browsing === null && this.options.canFork();
	}

	/** Same stepping as Claude Code: only the visible (last five) earlier questions can be browsed. */
	private browse(direction: "older" | "newer", wrap: boolean) {
		const total = this.earlier.length;
		const reachable = Math.min(total, VISIBLE_HISTORY);
		const current = this.browsing === null ? 0 : total - this.browsing;
		const step = direction === "older" ? 1 : -1;
		const next = wrap ? (current + step + reachable + 1) % (reachable + 1) : Math.min(Math.max(current + step, 0), reachable);
		if (next === current) return;
		this.browsing = next === 0 ? null : total - next;
		this.scrollTop = 0;
	}

	private scrollBy(rows: number) {
		this.scrollTop = Math.min(Math.max(this.scrollTop + rows, 0), this.lastMaxScroll);
	}

	private copy(text: string) {
		copyToClipboard(text).catch(() => {});
		this.copiedAt = Date.now();
		clearTimeout(this.copiedTimer);
		this.copiedTimer = setTimeout(() => this.tui.requestRender(), COPIED_FLASH_MS);
	}

	private isCopiedFlashOn(): boolean {
		return Date.now() - this.copiedAt < COPIED_FLASH_MS;
	}

	private markdownFor(text: string): Markdown {
		let markdown = this.markdown.get(text);
		if (!markdown) {
			markdown = new Markdown(text, 0, 0, getMarkdownTheme());
			this.markdown.set(text, markdown);
		}
		return markdown;
	}

	private stopSpinner() {
		clearInterval(this.spinner);
		this.spinner = undefined;
	}

	private finish(result: PanelResult) {
		this.stopSpinner();
		clearTimeout(this.copiedTimer);
		this.controller?.abort();
		this.options.close(result);
	}
}

/** How a forked side question shows up in the new session's transcript. */
class ForkedExchangeView implements Component {
	private readonly answer: Markdown;

	constructor(
		private readonly exchange: Exchange,
		private readonly theme: Theme,
	) {
		this.answer = new Markdown(exchange.answer, 0, 0, getMarkdownTheme());
	}

	render(width: number): string[] {
		const theme = this.theme;
		const question = truncateToWidth(collapseWhitespace(this.exchange.question), Math.max(20, width - 7));
		return [
			PANEL_INDENT + theme.bold(theme.fg("border", "/btw ")) + theme.fg("dim", question),
			"",
			...this.answer.render(width - ANSWER_INDENT.length).map((line) => ANSWER_INDENT + line),
		];
	}

	invalidate(): void {
		this.answer.invalidate();
	}
}

function readReply(reply: AssistantMessage): Outcome {
	const text = reply.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n")
		.trim();
	const toolCall = reply.content.find((block): block is ToolCall => block.type === "toolCall");
	const failed = reply.stopReason === "error";
	if (text) {
		const notes = [
			...(FAKE_TOOL_CALL_MARKUP.test(text) ? [FAKE_TOOL_CALLS_NOTICE] : []),
			...(toolCall ? [toolAttemptNotice(toolCall.name)] : []),
			...(failed ? [CUT_OFF_NOTICE] : []),
		];
		return { answer: [text, ...notes].join("\n"), synthetic: false };
	}
	if (toolCall) return { answer: toolAttemptNotice(toolCall.name), synthetic: true };
	if (failed) return { answer: `(API error: ${reply.errorMessage ?? "unknown error"})`, synthetic: true };
	return { error: "No response received" };
}

function toolAttemptNotice(toolName: string): string {
	return `(The model tried to call ${toolName}${TOOL_ATTEMPT_SUFFIX}`;
}

/** Earlier side answers are replayed as the model wrote them, minus anything that would mislead it. */
function replayedAnswer(exchange: Exchange, model: { api: string; provider: string; id: string }): AssistantMessage {
	const answer = FAKE_TOOL_CALL_MARKUP.test(exchange.answer)
		? FAKE_TOOL_CALLS_IN_HISTORY
		: exchange.answer.endsWith(CUT_OFF_NOTICE) || exchange.answer.endsWith(TOOL_ATTEMPT_SUFFIX)
			? CUT_OFF_IN_HISTORY
			: exchange.answer;
	return {
		role: "assistant",
		content: [{ type: "text", text: answer }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	} as AssistantMessage;
}

/**
 * The main agent may be mid-turn: its last assistant message can hold tool calls that are
 * still running. Give each one a placeholder result so the request is valid and the model
 * knows the work is in progress.
 */
function answerPendingToolCalls(messages: Message[]): Message[] {
	const lastAssistantIndex = messages.findLastIndex((message) => message.role === "assistant");
	if (lastAssistantIndex === -1) return messages;
	const lastAssistant = messages[lastAssistantIndex] as AssistantMessage;
	const answered = new Set(
		messages
			.slice(lastAssistantIndex + 1)
			.flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : [])),
	);
	const pending = lastAssistant.content.filter(
		(block): block is ToolCall => block.type === "toolCall" && !answered.has(block.id),
	);
	if (pending.length === 0) return messages;
	const placeholders = pending.map(
		(call): ToolResultMessage => ({
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text: PENDING_TOOL_RESULT }],
			isError: false,
			timestamp: Date.now(),
		}),
	);
	return [...messages, ...placeholders];
}

function userMessage(text: string | string[]): UserMessage {
	const parts = Array.isArray(text) ? text : [text];
	return { role: "user", content: parts.map((part) => ({ type: "text" as const, text: part })), timestamp: Date.now() };
}

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}
