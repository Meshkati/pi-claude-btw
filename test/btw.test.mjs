// Behaviour of /btw, exercised through pi's real extension loader, session manager and
// markdown renderer. Only the model call (network) and the terminal host are stubbed.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions, initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

const root = fileURLToPath(new URL("..", import.meta.url));
const ESC = "\x1b";
const DOWN = "\x1b[B";
const plainTheme = { fg: (_color, text) => text, bold: (text) => text, italic: (text) => text };

initTheme("dark", false);

async function loadBtwCommand() {
	const agentDir = mkdtempSync(join(tmpdir(), "btw-agent-"));
	const { extensions, errors } = await discoverAndLoadExtensions([join(root, "extensions/btw.ts")], root, agentDir);
	assert.deepEqual(errors, []);
	return extensions.flatMap((extension) => [...extension.commands.values()]).find((command) => command.name === "btw");
}

function reply(text, stopReason = "stop") {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "test",
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function userText(text) {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

/** A pi host with a real in-memory session; `answer` plays the model. */
function createHost({ conversation = [], answer = () => Promise.resolve(reply("ok")), rows = 40 } = {}) {
	const session = SessionManager.inMemory(root);
	for (const message of conversation) session.appendMessage(message);
	const host = { session, requests: [], notifications: [], panel: undefined };
	const tui = { terminal: { rows, columns: 100 }, requestRender() {} };
	host.ctx = {
		mode: "tui",
		hasUI: true,
		thinkingLevel: "off",
		model: { api: "test", provider: "test", id: "test-model" },
		isIdle: () => true,
		sessionManager: session,
		modelRegistry: {
			streamSimple(_model, context, options) {
				host.requests.push(context);
				return { result: () => answer(context, options.signal) };
			},
		},
		ui: {
			notify: (text) => host.notifications.push(text),
			custom: (factory) =>
				new Promise((resolve) => {
					host.panel = factory(tui, plainTheme, undefined, resolve);
				}),
		},
	};
	return host;
}

const settle = async () => {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

function screen(host, width = 100) {
	return host.panel.render(width).map((line) => stripTerminalSequences(line).trimEnd());
}

async function askAndClose(command, host, question) {
	const closed = command.handler(question, host.ctx);
	await settle();
	host.panel.handleInput(ESC);
	await closed;
}

test("loading the extension registers /btw as a side-question command", async () => {
	// when
	const command = await loadBtwCommand();

	// then
	assert.equal(command.description, "Ask a side question without interrupting the agent");
});

test("/btw without a question or an earlier answer shows the usage line", async () => {
	// given
	const command = await loadBtwCommand();
	const host = createHost();

	// when
	await command.handler("", host.ctx);

	// then
	assert.deepEqual(host.notifications, ["Usage: /btw <your question>"]);
});

test("an answer is shown under a full-width separator with copy, fork and close hints", async () => {
	// given
	const command = await loadBtwCommand();
	const host = createHost({ answer: async () => reply("Canberra.") });

	// when
	const closed = command.handler("what is the capital of Australia?", host.ctx);
	await settle();

	// then
	assert.deepEqual(screen(host), [
		"▔".repeat(100),
		"  /btw what is the capital of Australia?",
		"",
		"    Canberra.",
		"",
		"  c to copy · f to fork · Esc to close",
	]);
	host.panel.handleInput(ESC);
	await closed;
});

test("the side question is sent after the conversation, wrapped in the side-question reminder", async () => {
	// given
	const command = await loadBtwCommand();
	const host = createHost({ conversation: [userText("The codename is FALCON-7."), reply("Noted.")] });

	// when
	await askAndClose(command, host, "what's the codename?");

	// then
	const messages = host.requests[0].messages;
	assert.deepEqual(
		messages.map((message) => message.role),
		["user", "assistant", "user"],
	);
	const [reminder, question] = messages.at(-1).content.map((part) => part.text);
	assert.match(reminder, /^<system-reminder>This is a side question from the user\./);
	assert.equal(question, "what's the codename?");
});

test("tool calls the main agent is still running get an in-progress placeholder result", async () => {
	// given
	const command = await loadBtwCommand();
	const runningCall = { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test" } };
	const host = createHost({
		conversation: [userText("run the tests"), { ...reply(""), content: [runningCall], stopReason: "toolUse" }],
	});

	// when
	await askAndClose(command, host, "what are you running?");

	// then
	const placeholder = host.requests[0].messages.at(-2);
	assert.equal(placeholder.toolCallId, "call-1");
	assert.match(placeholder.content[0].text, /^\[No result yet/);
});

test("an earlier side question is listed above the current one", async () => {
	// given
	const command = await loadBtwCommand();
	const host = createHost();
	await askAndClose(command, host, "first question");

	// when
	const closed = command.handler("second question", host.ctx);
	await settle();

	// then
	assert.deepEqual(screen(host).slice(1, 3), ["  /btw first question", "  /btw second question"]);
	host.panel.handleInput(ESC);
	await closed;
});

test("an earlier side exchange is sent as context for the next side question", async () => {
	// given
	const command = await loadBtwCommand();
	const host = createHost({ answer: async (context) => reply(`answer ${context.messages.length}`) });
	await askAndClose(command, host, "first question");

	// when
	await askAndClose(command, host, "second question");

	// then
	const [earlierQuestion, earlierAnswer] = host.requests[1].messages.slice(0, 2);
	assert.equal(earlierQuestion.content[0].text, "first question");
	assert.equal(earlierAnswer.content[0].text, "answer 1");
});

test("a long answer fills rows minus 14 and marks that more is below", async () => {
	// given
	const command = await loadBtwCommand();
	const fruits = Array.from({ length: 45 }, (_, index) => `${index + 1}. fruit ${index + 1}`).join("\n");
	const host = createHost({ rows: 40, answer: async () => reply(fruits) });

	// when
	const closed = command.handler("list 45 fruits", host.ctx);
	await settle();

	// then
	const answerRows = screen(host).slice(3, -2);
	assert.equal(answerRows.length, 26);
	assert.ok(answerRows.at(-1).endsWith("↓"));
	host.panel.handleInput(ESC);
	await closed;
});

test("each down arrow scrolls a long answer by three lines", async () => {
	// given
	const command = await loadBtwCommand();
	const fruits = Array.from({ length: 45 }, (_, index) => `${index + 1}. fruit ${index + 1}`).join("\n");
	const host = createHost({ answer: async () => reply(fruits) });
	const closed = command.handler("list 45 fruits", host.ctx);
	await settle();

	// when
	host.panel.handleInput(DOWN);

	// then
	assert.match(screen(host)[3], /^ {4}4\. fruit 4 +↑$/);
	host.panel.handleInput(ESC);
	await closed;
});

test("closing the panel while answering cancels the question and keeps it out of history", async () => {
	// given
	const command = await loadBtwCommand();
	const host = createHost({
		answer: (_context, signal) =>
			new Promise((resolve) => signal.addEventListener("abort", () => resolve(reply("", "aborted")))),
	});

	// when
	await askAndClose(command, host, "write a long poem");

	// then
	await command.handler("", host.ctx);
	assert.deepEqual(host.notifications, ["Usage: /btw <your question>"]);
});

test("/btw without a question reopens the last answer without asking the model again", async () => {
	// given
	const command = await loadBtwCommand();
	const host = createHost({ answer: async () => reply("Canberra.") });
	await askAndClose(command, host, "what is the capital of Australia?");

	// when
	const closed = command.handler("", host.ctx);
	await settle();

	// then
	assert.equal(host.requests.length, 1);
	assert.equal(screen(host)[3], "    Canberra.");
	host.panel.handleInput(ESC);
	await closed;
});

test("asking a side question writes nothing to the session", async () => {
	// given
	const command = await loadBtwCommand();
	const host = createHost({ conversation: [userText("hello"), reply("hi")] });
	const entriesBefore = host.session.getEntries().length;

	// when
	await askAndClose(command, host, "what did I say?");

	// then
	assert.equal(host.session.getEntries().length, entriesBefore);
});
