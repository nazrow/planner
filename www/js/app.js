import { api, clearToken, getToken } from "./api.js";
import { effectiveDeadlines, layoutTimeline, pathThrough } from "./layout.js";
import {
	dueMoment,
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
const ruler = document.getElementById("ruler");
const gridLayer = document.getElementById("grid-layer");
const nowLine = document.getElementById("now-line");
const zoomLabel = document.getElementById("zoom-label");

const PAD = 20; // breathing room between the ruler and the drawing
const RULER_W = 92; // the date column pinned to the left edge
const ORIGIN_X = RULER_W + PAD; // where the drawing itself starts
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// How many pixels an hour takes on screen, from very zoomed out to very in.
const ZOOM_LEVELS = [0.125, 0.25, 0.5, 1, 2, 4, 8, 16, 32];
const ZOOM_KEY = "planner.pxPerHour";

// The size of everything drawn -- cards, text, lines -- as a CSS zoom on the
// drawing and the header. Phone-sized screens start smaller.
const UI_SCALES = [0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5];
const UI_SCALE_KEY = "planner.uiScale";

function savedUiScale() {
	try {
		const value = Number(localStorage.getItem(UI_SCALE_KEY));
		if (UI_SCALES.includes(value)) return value;
	} catch {
		/* fall through to the default */
	}
	return document.documentElement.clientWidth < 560 ? 0.8 : 1;
}

function savedZoom() {
	try {
		const value = Number(localStorage.getItem(ZOOM_KEY));
		return ZOOM_LEVELS.includes(value) ? value : 2;
	} catch {
		return 2;
	}
}

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
	pxPerHour: savedZoom(),
	uiScale: savedUiScale(),
	time: null, // the last layout's time axis
	scrolledToNow: false,
	layoutHints: null, // the last search's choices, replayed between searches
	positions: null, // where the last layout put each box, by key
	hintsBeforeEdit: null, // the layout's choices before unsaved connections
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
	state.hintsBeforeEdit = null;
	render({ optimize: true });
	scrollToNowOnce();
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
		estimate_hours: task.estimate_hours,
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
		estimate_hours: null,
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

/**
 * The times that place a box: a card's come from the server, a form's from
 * whatever is typed into it -- which counts the next time things are laid out
 * (a connection drawn), never while typing.
 */
function timesOf(key) {
	const element = state.elements.get(key);
	const source =
		state.forms.has(key) && element ? readForm(element) : state.tasks.get(key);
	if (!source) return {};
	const due = source.deadline
		? dueMoment(source.deadline, source.deadline_has_time)
		: null;
	const task = state.tasks.get(key);
	return {
		due,
		estimateMs: source.estimate_hours ? source.estimate_hours * HOUR : null,
		// A finished task with no deadline sits where it was finished.
		doneAt:
			source.completion >= 100 && due === null && task && task.updated_at
				? Date.parse(task.updated_at)
				: null,
	};
}

/**
 * Draw the workspace. Things only move when the picture is meant to change:
 *
 *   - `relayout` (the default) works positions out afresh -- on load, after a
 *     save or delete, when a connection is drawn or removed, on zoom;
 *   - without it, every box goes back where the last layout put it, so
 *     opening, editing and closing a form never moves anything;
 *   - `optimize` searches for a better arrangement as well (load, save,
 *     zoom); a plain relayout replays the last search's choices.
 */
function render({ relayout = true, optimize = false } = {}) {
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

	if (!relayout && state.positions && placeFromMemory(freeKeys)) return;

	const nodes = [];
	for (const [key, element] of state.elements) {
		if (freeKeys.has(key)) continue;
		nodes.push({
			id: key,
			width: element.offsetWidth,
			height: element.offsetHeight,
			...timesOf(key),
		});
	}
	const edges = currentEdges().filter(
		(edge) => !freeKeys.has(edge.from) && !freeKeys.has(edge.to)
	);

	const result = layoutTimeline(nodes, edges, {
		pxPerHour: state.pxPerHour,
		now: Date.now(),
		// Dateless groups wrap at, and card mass centres in, the screen's width.
		viewWidth: Math.max(400, toDrawing(viewport.clientWidth) - ORIGIN_X - PAD),
		optimize,
		hints: state.layoutHints,
	});
	state.time = result.time;
	state.layoutHints = result.hints;
	state.positions = new Map(result.nodes.map((n) => [n.id, n]));

	let width = ORIGIN_X + result.width + PAD;
	let height = result.height;

	for (const placed of result.nodes) {
		const element = state.elements.get(placed.id);
		if (!element) continue;
		element.style.transform = `translate(${ORIGIN_X + placed.x}px, ${placed.y}px)`;
		element.classList.toggle("moved-down", placed.pushed);
	}

	for (const key of freeKeys) {
		const element = state.elements.get(key);
		const draft = state.forms.get(key);
		if (!element || !draft) continue;
		element.style.transform = `translate(${draft.free.x}px, ${draft.free.y}px)`;
		width = Math.max(width, draft.free.x + element.offsetWidth + PAD);
		height = Math.max(height, draft.free.y + element.offsetHeight + PAD);
	}

	width = Math.max(width, toDrawing(viewport.clientWidth));
	height = Math.max(height, toDrawing(viewport.clientHeight));
	surface.style.width = width + "px";
	surface.style.height = height + "px";
	svg.setAttribute("width", width);
	svg.setAttribute("height", height);

	drawTimeAxis(result.time, width, height);
	drawEdges(result.edges);

	emptyHint.hidden = state.elements.size > 0;
}

/** Before the first unsaved connection change: keep the layout's choices. */
function rememberLayout() {
	if (!state.hintsBeforeEdit) state.hintsBeforeEdit = state.layoutHints;
}

/**
 * An edit with unsaved connections was abandoned: replay the choices from
 * before it, which puts every box exactly back (a replay is deterministic).
 */
function restoreLayout() {
	if (state.hintsBeforeEdit) state.layoutHints = state.hintsBeforeEdit;
	state.hintsBeforeEdit = null;
	render();
}

/**
 * Put every box back where the last layout had it; free drafts where they
 * were dragged. A form opened on a card takes the card's place. False when
 * some box has no remembered place, and a real layout is needed after all.
 */
function placeFromMemory(freeKeys) {
	for (const [key, element] of state.elements) {
		if (freeKeys.has(key)) {
			const draft = state.forms.get(key);
			element.style.transform = `translate(${draft.free.x}px, ${draft.free.y}px)`;
			continue;
		}
		const placed = state.positions.get(key);
		if (!placed) return false;
		element.style.transform = `translate(${ORIGIN_X + placed.x}px, ${placed.y}px)`;
	}
	let width = parseFloat(surface.style.width) || 0;
	let height = parseFloat(surface.style.height) || 0;
	for (const key of freeKeys) {
		const element = state.elements.get(key);
		const draft = state.forms.get(key);
		width = Math.max(width, draft.free.x + element.offsetWidth + PAD);
		height = Math.max(height, draft.free.y + element.offsetHeight + PAD);
	}
	surface.style.width = width + "px";
	surface.style.height = height + "px";
	svg.setAttribute("width", width);
	svg.setAttribute("height", height);
	emptyHint.hidden = state.elements.size > 0;
	return true;
}

/* ------------------------------------------------------------- time axis */

function startOfDay(t) {
	const d = new Date(t);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function addDays(t, days) {
	const d = new Date(t);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime();
}

/** Gridlines across the drawing, dates in the ruler, and the red "now". */
function drawTimeAxis(time, width, height) {
	gridLayer.textContent = "";
	ruler.textContent = "";
	ruler.style.height = height + "px";

	const pxPerDay = state.pxPerHour * 24;
	const first = time.at(0);
	const last = time.at(height);

	// The finest step that still leaves room between two labels.
	const step = pxPerDay >= 36 ? "day" : pxPerDay * 7 >= 36 ? "week" : "month";

	let t = startOfDay(first);
	if (step === "week") t = addDays(t, -((new Date(t).getDay() + 6) % 7)); // Monday
	if (step === "month") {
		const d = new Date(t);
		t = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
	}
	const marks = [];
	while (t <= last) {
		marks.push(t);
		if (step === "day") t = addDays(t, 1);
		else if (step === "week") t = addDays(t, 7);
		else {
			const d = new Date(t);
			t = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
		}
	}

	// Finer, unlabelled lines within a day, once there is room for them.
	if (step === "day" && state.pxPerHour >= 4) {
		const every = state.pxPerHour >= 16 ? 1 : state.pxPerHour >= 8 ? 3 : 6;
		for (let h = startOfDay(first); h <= last; h += every * HOUR) {
			if (new Date(h).getHours() !== 0) gridLine(time.y(h), width, "minor");
		}
	}

	const format =
		step === "day"
			? { weekday: "short", day: "numeric", month: "short" }
			: step === "week"
				? { day: "numeric", month: "short" }
				: { month: "short", year: "numeric" };
	for (const mark of marks) {
		const y = time.y(mark);
		if (y < 0 || y > height) continue;
		gridLine(y, width, "major");
		const label = el("span", "tick", new Date(mark).toLocaleDateString(undefined, format));
		label.style.top = y + "px";
		ruler.appendChild(label);
	}

	nowLine.setAttribute("x1", 0);
	nowLine.setAttribute("x2", width);
	nowLine.setAttribute("y1", time.nowY);
	nowLine.setAttribute("y2", time.nowY);
	const nowLabel = el(
		"span",
		"tick now",
		new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
	);
	nowLabel.style.top = time.nowY + "px";
	ruler.appendChild(nowLabel);
}

function updateNowLine() {
	if (!state.time) return;
	const y = state.time.y(Date.now());
	nowLine.setAttribute("y1", y);
	nowLine.setAttribute("y2", y);
	const label = ruler.querySelector(".tick.now");
	if (label) {
		label.style.top = y + "px";
		label.textContent = new Date().toLocaleTimeString(undefined, {
			hour: "2-digit",
			minute: "2-digit",
		});
	}
}

function gridLine(y, width, kind) {
	const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
	line.setAttribute("x1", RULER_W);
	line.setAttribute("x2", width);
	line.setAttribute("y1", y);
	line.setAttribute("y2", y);
	line.setAttribute("class", "grid " + kind);
	gridLayer.appendChild(line);
}

/* ------------------------------------------------------------------ zoom */

function setZoom(direction) {
	const index = ZOOM_LEVELS.indexOf(state.pxPerHour);
	const next =
		ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, Math.max(0, index + direction))];
	if (next === state.pxPerHour) return;

	// Keep the moment in the middle of the screen where it is.
	const moment = momentMidScreen();
	state.pxPerHour = next;
	try {
		localStorage.setItem(ZOOM_KEY, String(next));
	} catch {
		/* the zoom just won't be remembered */
	}
	showZoom();
	render({ optimize: true });
	scrollMomentMidScreen(moment);
}

function momentMidScreen() {
	const middle = toDrawing(viewport.scrollTop + viewport.clientHeight / 2);
	return state.time ? state.time.at(middle) : Date.now();
}

function scrollMomentMidScreen(moment) {
	viewport.scrollTop = state.time.y(moment) * state.uiScale - viewport.clientHeight / 2;
}

/* ------------------------------------------------------------- UI size */

function applyUiScale() {
	document.documentElement.style.setProperty("--ui-scale", String(state.uiScale));
	document.getElementById("ui-size-label").textContent =
		Math.round(state.uiScale * 100) + "%";
}

function setUiScale(direction) {
	const index = UI_SCALES.indexOf(state.uiScale);
	const next = UI_SCALES[Math.min(UI_SCALES.length - 1, Math.max(0, index + direction))];
	if (next === state.uiScale) return;
	const moment = momentMidScreen();
	state.uiScale = next;
	try {
		localStorage.setItem(UI_SCALE_KEY, String(next));
	} catch {
		/* the size just won't be remembered */
	}
	applyUiScale();
	// More (or less) drawing fits across the screen now: lay out for it.
	render({ optimize: true });
	scrollMomentMidScreen(moment);
}

document.getElementById("ui-smaller").addEventListener("click", () => setUiScale(-1));
document.getElementById("ui-larger").addEventListener("click", () => setUiScale(1));
applyUiScale();

function showZoom() {
	const day = state.pxPerHour * 24;
	zoomLabel.textContent = day >= 12 ? `${day} px/day` : `${day * 7} px/week`;
}

document.getElementById("zoom-in").addEventListener("click", () => setZoom(1));
document.getElementById("zoom-out").addEventListener("click", () => setZoom(-1));
showZoom();

/** Once, after the first layout: bring "now" into view, a third of the way down. */
function scrollToNowOnce() {
	if (state.scrolledToNow || !state.time) return;
	state.scrolledToNow = true;
	viewport.scrollTop = Math.max(
		0,
		state.time.nowY * state.uiScale - viewport.clientHeight / 3
	);
}

/**
 * Deadlines inherited through what each task blocks, from the saved data --
 * so, like positions, they change with a save, not while typing.
 */
function inheritedDeadlines() {
	const nodes = [];
	const edges = [];
	for (const [key, task] of state.tasks) {
		nodes.push({
			id: key,
			due: task.deadline ? dueMoment(task.deadline, task.deadline_has_time) : null,
			estimateMs: task.estimate_hours ? task.estimate_hours * HOUR : null,
		});
		for (const other of task.blocked_by) edges.push({ from: keyOf(other), to: key });
	}
	const all = effectiveDeadlines(nodes, edges);
	return (id) => {
		const entry = all.get(keyOf(id));
		return entry && entry.calculated ? entry : null;
	};
}

function syncElements() {
	const wanted = new Set();
	const neededBy = inheritedDeadlines();

	for (const [key, draft] of state.forms) {
		wanted.add(key);
		if (!state.elements.has(key)) {
			const form = renderForm(draft, { titleOf, neededBy });
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
		const card = renderCard(task, { doable, neededBy, titleOf });
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
	// The layout's coordinates start where the drawing starts, right of the ruler.
	edgeLayer.setAttribute("transform", `translate(${ORIGIN_X} 0)`);
	for (const edge of laidOut) {
		const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
		path.setAttribute("d", edge.path);
		path.setAttribute("class", "edge");
		path.dataset.from = edge.from;
		path.dataset.to = edge.to;
		edgeLayer.appendChild(path);
	}
}

/* ---------------------------------------------------------- the "+" spot */

/**
 * The drawing is zoomed by the size control, so distances on screen are the
 * drawing's own units times `uiScale`. Pointer positions and element boxes
 * come in screen pixels; scroll offsets and the viewport's size come in
 * unzoomed pixels too. These turn them into drawing units.
 */
const toDrawing = (screenPx) => screenPx / state.uiScale;

function surfacePoint(event) {
	const rect = surface.getBoundingClientRect();
	return {
		x: toDrawing(event.clientX - rect.left),
		y: toDrawing(event.clientY - rect.top),
	};
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
		render({ relayout: false });
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
		x: toDrawing(rect.left - surfaceRect.left + rect.width / 2),
		y: toDrawing((side === "top" ? rect.top : rect.bottom) - surfaceRect.top),
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
	rememberLayout();
	if (side === "top") draft.blockedBy.add(otherKey);
	else draft.blocks.add(otherKey);
	draft.connectionsChanged = true;
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
	render({ relayout: false });
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
		if (draft.connectionsChanged) restoreLayout();
		else render({ relayout: false });
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
			break;
		}
		case "add-person": {
			const list = host.querySelector(".people-list");
			const row = el("div", "person-row");
			row.innerHTML = list.firstElementChild.innerHTML;
			for (const input of row.querySelectorAll("input")) input.value = "";
			list.appendChild(row);
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
			break;
		}
		case "drop-connection": {
			const draft = state.forms.get(key);
			if (!draft) break;
			const other = trigger.dataset.other;
			rememberLayout();
			if (trigger.dataset.kind === "blocker") draft.blockedBy.delete(other);
			else draft.blocks.delete(other);
			draft.connectionsChanged = true;
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
	// The form grows with its text; the layout waits for the save.
	if (event.target.tagName === "TEXTAREA") growTextarea(event.target);
});

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
		render({ relayout: false });
	};
	handle.addEventListener("pointermove", move);
	handle.addEventListener("pointerup", up);
});

viewport.addEventListener("click", (event) => {
	if (event.target.closest(".task")) return;
	if (event.target.closest(".plus")) return;
	if (event.target.closest("#ruler")) return;

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
		// Unsaved connections moved things; walking away puts them back.
		if (draft && draft.connectionsChanged) restoreLayout();
		else render({ relayout: false });
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

// Time moves: the red line creeps down. Nothing else does until the next
// load or save.
setInterval(updateNowLine, 60 * 1000);

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
