import { api, clearToken, getToken } from "./api.js";
import { layoutGraph, pathThrough } from "./layout.js";
import {
	el,
	fillConnections,
	growTextarea,
	readForm,
	renderCard,
	renderForm,
} from "./views.js";

if (!getToken()) window.location.replace("./");

const viewport = document.getElementById("viewport");
const surface = document.getElementById("surface");
const nodesLayer = document.getElementById("nodes");
const svg = document.getElementById("edges");
const edgeLayer = document.getElementById("edge-layer");
const liveEdge = document.getElementById("live-edge");
const statusBar = document.getElementById("status");
const whoBar = document.getElementById("who");
const emptyHint = document.getElementById("empty-hint");

const PAD = 20; // breathing room around the whole drawing

const state = {
	me: null,
	tasks: new Map(), // key -> task as the server sees it
	forms: new Map(), // key -> the draft being typed into
	elements: new Map(), // key -> its DOM node
	connecting: null, // { key, side }
	plus: null, // the floating "+" affordance
	draftSeq: 0,
	hiddenFinished: 0,
	includeFinished: false,
};

const keyOf = (id) => String(id);
const isDraftKey = (key) => key.startsWith("new:");
const present = (key) => state.tasks.has(key) || state.forms.has(key);

function setStatus(text, kind) {
	statusBar.textContent = text || "";
	statusBar.className = kind || "";
	if (text) {
		clearTimeout(setStatus.timer);
		setStatus.timer = setTimeout(() => {
			statusBar.textContent = "";
			statusBar.className = "";
		}, 6000);
	}
}

/* ------------------------------------------------------------------ data */

async function load() {
	const data = await api.workspace(state.includeFinished);
	state.me = data.me;
	whoBar.textContent = data.me.username;
	state.tasks = new Map(data.tasks.map((task) => [keyOf(task.id), task]));
	state.hiddenFinished = data.hidden_finished || 0;
	showHiddenNote();
	// Forms for tasks that vanished (deleted elsewhere) no longer make sense.
	for (const key of [...state.forms.keys()]) {
		if (!isDraftKey(key) && !state.tasks.has(key)) state.forms.delete(key);
	}
	render();
}

function titleOf(key) {
	const form = state.forms.get(key);
	if (form && form.title) return form.title;
	const task = state.tasks.get(key);
	if (task) return task.title;
	return form ? "(new task)" : "task " + key;
}

/**
 * The connections as they stand right now: stored ones, except where an open
 * form has something different to say about its own end.
 */
function currentEdges() {
	const found = new Map();
	const add = (from, to) => {
		if (from === to) return;
		found.set(from + "->" + to, { from, to });
	};

	for (const [key, task] of state.tasks) {
		if (state.forms.has(key)) continue; // the form speaks for this task now
		for (const other of task.blocked_by) add(keyOf(other), key);
		for (const other of task.blocks) add(key, keyOf(other));
	}
	for (const [key, draft] of state.forms) {
		for (const other of draft.blockedBy) add(other, key);
		for (const other of draft.blocks) add(key, other);
	}

	const result = [];
	for (const edge of found.values()) {
		if (!present(edge.from) || !present(edge.to)) continue;
		const tailForm = state.forms.get(edge.from);
		if (tailForm && !tailForm.blocks.has(edge.to)) continue;
		const headForm = state.forms.get(edge.to);
		if (headForm && !headForm.blockedBy.has(edge.from)) continue;
		result.push(edge);
	}
	return result;
}

function wouldLoop(from, to) {
	const edges = currentEdges();
	const out = new Map();
	for (const edge of edges) {
		if (!out.has(edge.from)) out.set(edge.from, []);
		out.get(edge.from).push(edge.to);
	}
	if (!out.has(from)) out.set(from, []);
	out.get(from).push(to);

	const seen = new Set();
	const stack = [to];
	while (stack.length) {
		const current = stack.pop();
		if (current === from) return true;
		if (seen.has(current)) continue;
		seen.add(current);
		for (const next of out.get(current) || []) stack.push(next);
	}
	return false;
}

/** A task nobody is waiting on can be started. */
function doable(id) {
	const task = state.tasks.get(keyOf(id));
	if (!task) return true;
	return task.blocked_by.every((other) => {
		const blocker = state.tasks.get(keyOf(other));
		return !blocker || blocker.completion >= 100;
	});
}

/* ----------------------------------------------------------------- drafts */

function draftFromTask(task) {
	return {
		id: keyOf(task.id),
		mode: "edit",
		title: task.title,
		description: task.description,
		links: task.links.map((link) => ({ url: link.url, label: link.label })),
		deadline: task.deadline,
		deadline_has_time: task.deadline_has_time,
		completion: task.completion,
		blockedBy: new Set(task.blocked_by.map(keyOf)),
		blocks: new Set(task.blocks.map(keyOf)),
		roles: task.roles.map((entry) => ({
			username: entry.username,
			role: entry.role,
		})),
		free: null,
	};
}

function newDraft(x, y) {
	const key = "new:" + ++state.draftSeq;
	return {
		id: key,
		mode: "create",
		title: "",
		description: "",
		links: [],
		deadline: null,
		deadline_has_time: true,
		completion: 0,
		blockedBy: new Set(),
		blocks: new Set(),
		// Whoever makes a task owns it until they say otherwise.
		roles: [{ username: state.me ? state.me.username : "", role: "owner" }],
		free: { x, y },
	};
}

const isFree = (draft) =>
	draft.free && !draft.blockedBy.size && !draft.blocks.size;

/* ---------------------------------------------------------------- render */

function render() {
	syncElements();

	for (const [key, element] of state.elements) {
		if (element.classList.contains("editing")) {
			const draft = state.forms.get(key);
			const row = element.querySelector(".row.connections");
			if (row && draft) fillConnections(row, draft, { titleOf });
			for (const area of element.querySelectorAll("textarea")) {
				growTextarea(area);
			}
		}
	}

	const freeKeys = new Set();
	for (const [key, draft] of state.forms) if (isFree(draft)) freeKeys.add(key);

	const nodes = [];
	for (const [key, element] of state.elements) {
		if (freeKeys.has(key)) continue;
		nodes.push({
			id: key,
			width: element.offsetWidth,
			height: element.offsetHeight,
		});
	}
	const edges = currentEdges().filter(
		(edge) => !freeKeys.has(edge.from) && !freeKeys.has(edge.to)
	);

	const available = Math.max(600, viewport.clientWidth - 2 * PAD);
	const result = layoutGraph(nodes, edges, { maxWidth: available });

	let width = result.width;
	let height = result.height;

	for (const placed of result.nodes) {
		const element = state.elements.get(placed.id);
		if (!element) continue;
		element.style.transform = `translate(${PAD + placed.x}px, ${
			PAD + placed.y
		}px)`;
	}

	for (const key of freeKeys) {
		const element = state.elements.get(key);
		const draft = state.forms.get(key);
		if (!element || !draft) continue;
		element.style.transform = `translate(${draft.free.x}px, ${draft.free.y}px)`;
		width = Math.max(width, draft.free.x - PAD + element.offsetWidth);
		height = Math.max(height, draft.free.y - PAD + element.offsetHeight);
	}

	surface.style.width = width + 2 * PAD + "px";
	surface.style.height = height + 2 * PAD + "px";
	svg.setAttribute("width", width + 2 * PAD);
	svg.setAttribute("height", height + 2 * PAD);

	drawEdges(result.edges);

	emptyHint.hidden = state.elements.size > 0;
}

function syncElements() {
	const wanted = new Set();

	for (const [key, draft] of state.forms) {
		wanted.add(key);
		if (!state.elements.has(key)) {
			const form = renderForm(draft, { titleOf });
			nodesLayer.appendChild(form);
			state.elements.set(key, form);
		}
	}

	for (const [key, task] of state.tasks) {
		if (state.forms.has(key)) continue;
		wanted.add(key);
		const existing = state.elements.get(key);
		// Typing in a form re-lays-out everything; don't rebuild untouched cards.
		if (existing && existing.__task === task) continue;
		const card = renderCard(task, { doable });
		card.__task = task;
		if (existing) {
			existing.replaceWith(card);
		} else {
			nodesLayer.appendChild(card);
		}
		state.elements.set(key, card);
	}

	for (const [key, element] of [...state.elements]) {
		if (!wanted.has(key)) {
			element.remove();
			state.elements.delete(key);
		}
	}
}

function drawEdges(laidOut) {
	edgeLayer.textContent = "";
	for (const edge of laidOut) {
		const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
		const shifted = edge.points.map(([x, y]) => [x + PAD, y + PAD]);
		path.setAttribute("d", pathThrough(shifted));
		path.setAttribute("class", "edge");
		path.dataset.from = edge.from;
		path.dataset.to = edge.to;
		edgeLayer.appendChild(path);
	}
}

/* ---------------------------------------------------------- the "+" spot */

function surfacePoint(event) {
	const rect = surface.getBoundingClientRect();
	return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function showPlus(point) {
	hidePlus();
	const button = el("button", "plus", "+");
	button.type = "button";
	button.style.transform = `translate(${point.x}px, ${point.y}px)`;
	button.addEventListener("click", (event) => {
		event.stopPropagation();
		const draft = newDraft(point.x, point.y);
		state.forms.set(draft.id, draft);
		hidePlus();
		render();
		const element = state.elements.get(draft.id);
		if (element) element.querySelector(".f-title").focus();
	});
	surface.appendChild(button);
	state.plus = button;
}

function hidePlus() {
	if (state.plus) {
		state.plus.remove();
		state.plus = null;
	}
}

/* ------------------------------------------------------ drawing a link */

function anchorOf(key, side) {
	const element = state.elements.get(key);
	if (!element) return { x: 0, y: 0 };
	const rect = element.getBoundingClientRect();
	const surfaceRect = surface.getBoundingClientRect();
	return {
		x: rect.left - surfaceRect.left + rect.width / 2,
		y: (side === "top" ? rect.top : rect.bottom) - surfaceRect.top,
	};
}

function startConnecting(key, side) {
	stopConnecting();
	state.connecting = { key, side };
	surface.classList.add(side === "top" ? "connecting-up" : "connecting-down");
	const element = state.elements.get(key);
	if (element) element.classList.add("connect-origin");
	surface.addEventListener("pointermove", trackPointer);
	setStatus(
		side === "top"
			? "Pick the task that blocks this one"
			: "Pick the task this one blocks",
		"info"
	);
}

function trackPointer(event) {
	if (!state.connecting) return;
	const { key, side } = state.connecting;
	const anchor = anchorOf(key, side);
	const point = surfacePoint(event);
	const points =
		side === "top" ? [[point.x, point.y], [anchor.x, anchor.y]] : [
			[anchor.x, anchor.y],
			[point.x, point.y],
		];
	liveEdge.setAttribute("d", pathThrough(points));
	liveEdge.classList.add("visible");
}

function stopConnecting() {
	if (!state.connecting) return;
	const element = state.elements.get(state.connecting.key);
	if (element) element.classList.remove("connect-origin");
	surface.classList.remove("connecting-up", "connecting-down");
	surface.removeEventListener("pointermove", trackPointer);
	liveEdge.classList.remove("visible");
	liveEdge.removeAttribute("d");
	state.connecting = null;
}

function terminateConnection(otherKey) {
	const { key, side } = state.connecting;
	const draft = state.forms.get(key);
	stopConnecting();
	if (!draft || otherKey === key) return;

	const from = side === "top" ? otherKey : key;
	const to = side === "top" ? key : otherKey;
	if (wouldLoop(from, to)) {
		setStatus("That would make the two tasks wait for each other.", "error");
		return;
	}
	if (side === "top") draft.blockedBy.add(otherKey);
	else draft.blocks.add(otherKey);
	setStatus("");
	render();
}

/* ----------------------------------------------------------- form actions */

function openEdit(key) {
	const task = state.tasks.get(key);
	if (!task || !task.can_edit) return;
	state.forms.set(key, draftFromTask(task));
	state.elements.get(key)?.remove();
	state.elements.delete(key);
	render();
}

function closeForm(key) {
	state.forms.delete(key);
	state.elements.get(key)?.remove();
	state.elements.delete(key);
}

function payloadFrom(form, draft) {
	const values = readForm(form);
	return {
		...values,
		blocked_by: [...draft.blockedBy]
			.filter((key) => !isDraftKey(key))
			.map(Number),
		blocks: [...draft.blocks].filter((key) => !isDraftKey(key)).map(Number),
	};
}

async function submitForm(form) {
	const key = form.dataset.id;
	const draft = state.forms.get(key);
	if (!draft) return;

	const payload = payloadFrom(form, draft);
	if (!payload.title) {
		setStatus("A task needs a title.", "error");
		form.querySelector(".f-title").focus();
		return;
	}
	if (!payload.roles.some((entry) => entry.role.toLowerCase() === "owner")) {
		setStatus("Somebody has to own the task.", "error");
		return;
	}

	const pendingToDrafts = [...draft.blockedBy, ...draft.blocks].some(isDraftKey);
	if (pendingToDrafts) {
		setStatus("Save the other new task first, then connect to it.", "error");
		return;
	}

	form.classList.add("busy");
	try {
		if (draft.mode === "create") {
			await api.createTask(payload);
			setStatus("Task created.", "ok");
		} else {
			await api.updateTask(Number(key), payload);
			setStatus("Task saved.", "ok");
		}
		closeForm(key);
		await load();
		loadPickers().catch(() => {});
	} catch (error) {
		form.classList.remove("busy");
		setStatus(error.detail || "Could not save.", "error");
	}
}

async function scrapForm(key) {
	const draft = state.forms.get(key);
	if (!draft) return;
	if (draft.mode === "create") {
		closeForm(key);
		render();
		return;
	}
	if (!window.confirm(`Delete "${titleOf(key)}" for good?`)) return;
	try {
		await api.deleteTask(Number(key));
		closeForm(key);
		state.tasks.delete(key);
		setStatus("Task deleted.", "ok");
		await load();
	} catch (error) {
		setStatus(error.detail || "Could not delete.", "error");
	}
}

/* --------------------------------------------------------------- events */

nodesLayer.addEventListener("click", (event) => {
	const trigger = event.target.closest("[data-action]");
	const host = event.target.closest(".task");
	if (!host) return;
	const key = host.dataset.id;

	if (state.connecting && !trigger) {
		event.stopPropagation();
		return;
	}
	if (!trigger) return;

	const action = trigger.dataset.action;
	event.stopPropagation();

	switch (action) {
		case "edit":
			openEdit(key);
			break;
		case "scrap":
			scrapForm(key);
			break;
		case "connect":
			startConnecting(key, trigger.dataset.side);
			break;
		case "terminate":
			if (state.connecting) terminateConnection(key);
			break;
		case "add-link": {
			const list = host.querySelector(".link-list");
			const row = el("div", "link-row");
			row.innerHTML = list.firstElementChild.innerHTML;
			for (const input of row.querySelectorAll("input")) input.value = "";
			list.appendChild(row);
			render();
			row.querySelector(".f-link-url").focus();
			break;
		}
		case "drop-link": {
			const row = trigger.closest(".link-row");
			const list = row.parentElement;
			if (list.children.length === 1) {
				for (const input of row.querySelectorAll("input")) input.value = "";
			} else {
				row.remove();
			}
			render();
			break;
		}
		case "add-person": {
			const list = host.querySelector(".people-list");
			const row = el("div", "person-row");
			row.innerHTML = list.firstElementChild.innerHTML;
			for (const input of row.querySelectorAll("input")) input.value = "";
			list.appendChild(row);
			render();
			row.querySelector(".f-person-name").focus();
			break;
		}
		case "drop-person": {
			const row = trigger.closest(".person-row");
			const list = row.parentElement;
			if (list.children.length === 1) {
				for (const input of row.querySelectorAll("input")) input.value = "";
			} else {
				row.remove();
			}
			render();
			break;
		}
		case "drop-connection": {
			const draft = state.forms.get(key);
			if (!draft) break;
			const other = trigger.dataset.other;
			if (trigger.dataset.kind === "blocker") draft.blockedBy.delete(other);
			else draft.blocks.delete(other);
			render();
			break;
		}
		default:
			break;
	}
});

nodesLayer.addEventListener("submit", (event) => {
	event.preventDefault();
	const form = event.target.closest("form.task");
	if (form) submitForm(form);
});

nodesLayer.addEventListener("input", (event) => {
	const host = event.target.closest(".task.editing");
	if (!host) return;
	const draft = state.forms.get(host.dataset.id);
	if (event.target.classList.contains("f-completion")) {
		const row = host.querySelector(".row.completion");
		row.querySelector(".pct").textContent = event.target.value + "%";
		row.classList.toggle("complete", Number(event.target.value) >= 100);
	}
	if (event.target.classList.contains("f-title") && draft) {
		draft.title = event.target.value;
	}
	if (event.target.tagName === "TEXTAREA") growTextarea(event.target);
	scheduleRelayout();
});

let relayoutPending = false;
function scheduleRelayout() {
	if (relayoutPending) return;
	relayoutPending = true;
	requestAnimationFrame(() => {
		relayoutPending = false;
		render();
	});
}

/* dragging an unconnected new task around */
nodesLayer.addEventListener("pointerdown", (event) => {
	const handle = event.target.closest('[data-action="drag"]');
	if (!handle) return;
	const host = handle.closest(".task");
	const draft = state.forms.get(host.dataset.id);
	if (!draft || !isFree(draft)) return;

	event.preventDefault();
	handle.setPointerCapture(event.pointerId);
	const start = surfacePoint(event);
	const origin = { ...draft.free };

	const move = (moveEvent) => {
		const now = surfacePoint(moveEvent);
		draft.free = {
			x: Math.max(0, origin.x + now.x - start.x),
			y: Math.max(0, origin.y + now.y - start.y),
		};
		host.style.transform = `translate(${draft.free.x}px, ${draft.free.y}px)`;
	};
	const up = () => {
		handle.removeEventListener("pointermove", move);
		handle.removeEventListener("pointerup", up);
		render();
	};
	handle.addEventListener("pointermove", move);
	handle.addEventListener("pointerup", up);
});

viewport.addEventListener("click", (event) => {
	if (event.target.closest(".task")) return;
	if (event.target.closest(".plus")) return;

	if (state.connecting) {
		stopConnecting();
		setStatus("");
		return;
	}
	showPlus(surfacePoint(event));
});

document.addEventListener("keydown", (event) => {
	if (event.key !== "Escape") return;
	if (state.connecting) {
		stopConnecting();
		setStatus("");
		return;
	}
	// The scrap button deletes; Escape is the way to just walk away from a form.
	const form = document.activeElement?.closest?.(".task.editing");
	if (form) {
		const draft = state.forms.get(form.dataset.id);
		closeForm(form.dataset.id);
		render();
		setStatus(
			draft && draft.mode === "edit" ? "Edit abandoned." : "Draft discarded.",
			"info"
		);
		return;
	}
	hidePlus();
});

nodesLayer.addEventListener("pointerover", (event) => {
	const host = event.target.closest(".task");
	if (!host) return;
	for (const path of edgeLayer.children) {
		path.classList.toggle(
			"lit",
			path.dataset.from === host.dataset.id ||
				path.dataset.to === host.dataset.id
		);
	}
});

nodesLayer.addEventListener("pointerout", (event) => {
	if (event.relatedTarget && event.relatedTarget.closest(".task")) return;
	for (const path of edgeLayer.children) path.classList.remove("lit");
});

document.getElementById("logout").addEventListener("click", async () => {
	try {
		await api.logout();
	} catch {
		/* the token is going away locally either way */
	}
	clearToken();
	window.location.replace("./");
});

let resizeTimer = null;
window.addEventListener("resize", () => {
	clearTimeout(resizeTimer);
	resizeTimer = setTimeout(render, 150);
});

/* --------------------------------------------- finished-and-forgotten tasks */

const hiddenNote = document.getElementById("hidden-note");

function showHiddenNote() {
	if (state.includeFinished) {
		hiddenNote.textContent = "showing finished tasks";
		hiddenNote.hidden = false;
		return;
	}
	const count = state.hiddenFinished;
	hiddenNote.hidden = count === 0;
	hiddenNote.textContent =
		count === 1 ? "1 finished task hidden" : count + " finished tasks hidden";
}

hiddenNote.addEventListener("click", async () => {
	state.includeFinished = !state.includeFinished;
	await load();
});

/* ------------------------------------------------------- pickers for people */

async function loadPickers() {
	const [people, vocabulary] = await Promise.all([
		api.suggestions(),
		api.roleVocabulary(),
	]);
	fillDatalist("user-names", people.map((entry) => entry.username));
	fillDatalist("role-names", vocabulary);
}

function fillDatalist(id, values) {
	const list = document.getElementById(id);
	list.textContent = "";
	// Document order is the order the browser offers them in, and the API
	// already sorted people by how often they turn up on my tasks.
	for (const value of values) {
		const option = document.createElement("option");
		option.value = value;
		list.appendChild(option);
	}
}

/* ------------------------------------------------------------------ boot */

load()
	.then(loadPickers)
	.catch((error) => {
		if (error.status === 401) {
			clearToken();
			window.location.replace("./");
			return;
		}
		setStatus(error.detail || "Could not load the workspace.", "error");
	});
