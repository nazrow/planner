/**
 * Layout for the task graph on a time axis.
 *
 * Time runs down the page. Vertically, every task goes as late as its own
 * dates and everything it blocks allow:
 *
 *   - a task with a deadline has its bottom edge on the deadline;
 *   - a task with no deadline of its own inherits one from what it blocks:
 *     it is needed by the time the earliest of those has to start (their
 *     deadline minus their estimate) -- see `effectiveDeadlines`;
 *   - a blocker sits at least `gapY` above everything it blocks, rising above
 *     its own deadline if that is what it takes;
 *   - tasks with no deadline of either kind start at "now"; finished ones sit
 *     at the moment they were finished;
 *   - a group with no date anywhere has nothing to pin it to a height, so such
 *     groups wrap into a few rows from "now" down instead of one wide row.
 *
 * Nothing ever moves later than its dates ask for, only earlier -- except as a
 * last resort, see below.
 *
 * Horizontally, each connected group is laid out in columns, and every edge
 * travels down the gutters between columns, where no box ever goes. An edge
 * bends sideways in exactly three kinds of place, each empty by construction:
 *
 *   - just under its own box (its column has `gapY` of free space there),
 *   - just over its target (likewise),
 *   - across a column, at a height where that column is empty.
 *
 * Boxes are placed in order of their top edge, so when a box goes in, every
 * box that could stand in the way of its incoming edges is already known. If
 * no column lets all of them through, the box moves down until one does; the
 * result reports how often that happened.
 *
 * Finally the groups are packed side by side, each as far left as it fits
 * against the others *at its own times*, keeping `componentGap` between them,
 * and the drawing is shifted to centre the cards' mass on the screen.
 *
 * With `optimize`, both steps are searched: each group is laid out several
 * times with its column choices nudged by seeded noise, keeping the variant
 * that moves the fewest boxes down and then the narrowest; then the packing is
 * tried in different orders and with groups mirrored, keeping the one with the
 * least width plus off-centre mass. Every variant is built by the same code,
 * so every guarantee above holds for whichever one wins.
 *
 * Pure geometry: no DOM, no knowledge of what a task is.
 */

export const DEFAULTS = {
	pxPerHour: 2,
	gapY: 36, // between a blocker and what it blocks, and between boxes in a column
	sweepH: 16, // the least height of the bend where an edge leaves or enters a box
	crossH: 16, // the least height of the bend where an edge crosses a column
	// Where there is free room, a bend grows up to this many times the distance
	// it moves sideways -- 2 keeps even its steepest point under about 37 degrees.
	bendRatio: 2,
	gutterMin: 16, // a gap between columns that no edge uses
	trackW: 8, // room per edge running down a gutter
	componentGap: 44, // between separate, unconnected groups
	margin: 24, // above the earliest thing drawn and below the latest
	maxPushes: 200, // per box, before giving up on a clean route
	// The width of the screen's drawing area. Groups with no date anywhere
	// ("floaters") wrap into rows no wider than this instead of one long row at
	// "now" -- at most `floaterRows` of them -- and the cards' mass is centred
	// in it.
	viewWidth: Infinity,
	floaterRows: 5,
	// Search for a narrower, better-centred arrangement: several variants of
	// each group's columns, then of the packing -- the order groups go in and
	// which of them are mirrored. Deterministic: the same input always gives
	// the same result. Without it, `hints` from an earlier search are replayed.
	optimize: false,
	hints: null,
	// How much a pixel of the cards' mass being off-centre counts against a
	// pixel of total width.
	centreWeight: 0.5,
};

const HOUR = 3600 * 1000;

/**
 * @param {Array<{id, width, height, due?, estimateMs?, doneAt?}>} inputNodes
 *   due: the deadline as a timestamp; estimateMs: the work, in ms;
 *   doneAt: for a finished task without a deadline, when it was finished.
 * @param {Array<{from, to}>} inputEdges  `from` blocks `to`
 * @param {object} [options]  DEFAULTS, plus `now` (a timestamp)
 */
export function layoutTimeline(inputNodes, inputEdges, options = {}) {
	const o = { ...DEFAULTS, ...options };
	const now = o.now ?? Date.now();
	const pxPerMs = o.pxPerHour / HOUR;
	// Raw coordinates put "now" at y = 0; everything is shifted at the end.
	const timeY = (t) => (t - now) * pxPerMs;

	const nodes = new Map();
	for (const n of inputNodes) {
		nodes.set(n.id, {
			id: n.id,
			w: n.width,
			h: n.height,
			due: n.due ?? null,
			est: n.estimateMs ?? null,
			doneAt: n.doneAt ?? null,
			preds: [],
			succs: [],
			pref: null,
			top: 0,
			anchored: false,
			timeTop: 0, // where its dates alone put it
			pushes: 0,
			waits: 0,
			col: null,
			placed: false,
		});
	}

	const seen = new Set();
	const edges = [];
	for (const e of inputEdges) {
		if (!nodes.has(e.from) || !nodes.has(e.to) || e.from === e.to) continue;
		const key = `${e.from}->${e.to}`;
		if (seen.has(key)) continue;
		seen.add(key);
		edges.push({ from: e.from, to: e.to, back: false, route: null });
	}

	markBackEdges(nodes, edges);
	for (const e of edges) {
		if (e.back) continue;
		nodes.get(e.from).succs.push(nodes.get(e.to));
		nodes.get(e.to).preds.push(nodes.get(e.from));
	}
	for (const n of nodes.values()) n.allPreds = n.preds.slice();
	const order = topologicalOrder(nodes);

	// ---- where each task would like to be, then as late as that allows ----

	const deadlines = effectiveDeadlines(inputNodes, inputEdges);
	for (const n of nodes.values()) {
		const due = deadlines.get(n.id)?.due ?? null;
		if (due !== null) {
			n.pref = timeY(due) - n.h; // bottom edge on the deadline
		} else if (n.doneAt !== null) {
			n.pref = timeY(n.doneAt) - n.h;
		}
	}

	for (let i = order.length - 1; i >= 0; i -= 1) {
		const n = order[i];
		let top = n.pref ?? Infinity;
		for (const s of n.succs) {
			if (s.anchored) top = Math.min(top, s.top - o.gapY - n.h);
		}
		if (top !== Infinity) {
			n.top = top;
			n.anchored = true;
		}
	}

	for (const n of order) {
		if (n.anchored) continue;
		let top = 0; // nothing pins it to a date: it can start now
		for (const p of n.preds) top = Math.max(top, p.top + p.h + o.gapY);
		n.top = top;
	}

	for (const n of nodes.values()) n.timeTop = n.top;

	// ---- columns and routes, one connected group at a time ----

	const components = splitComponents(nodes, edges);
	const hints = o.hints || null;
	const newHints = { trees: {}, plan: null };
	let trials = 0;
	const laidOut = components.map((c) => {
		c.key = componentKey(c);
		let seed = hints?.trees?.[c.key]?.seed ?? 0;
		if (o.optimize) {
			const found = searchTree(c, o, seed);
			seed = found.seed;
			trials += found.trials;
		}
		const result = runTree(c, o, seed);
		result.key = c.key;
		newHints.trees[c.key] = { seed };
		return result;
	});

	// ---- groups side by side, each as far left as it fits ----

	const packing = packWorkspace(laidOut, o, hints?.plan ?? null);
	newHints.plan = packing.plan;
	trials += packing.trials;

	// ---- shift so the earliest thing (or now) sits one margin from the top ----

	let minY = 0;
	let maxY = 0;
	for (const n of nodes.values()) {
		minY = Math.min(minY, n.top);
		maxY = Math.max(maxY, n.top + n.h);
	}
	const shift = o.margin - minY;

	const outNodes = [];
	const outEdges = [];
	let width = 0;
	for (const c of laidOut) {
		for (const n of c.nodes) {
			outNodes.push({
				id: n.id,
				x: c.x + n.x,
				y: n.top + shift,
				width: n.w,
				height: n.h,
				// Lower than its dates alone would put it: moved down to make
				// room for an arrow (directly, or because a blocker was).
				pushed: n.top > n.timeTop + 0.5,
			});
			width = Math.max(width, c.x + n.x + n.w);
		}
		for (const e of c.edges) {
			const move = ([x, y]) => [x + c.x, y + shift];
			const points = e.points.map(move);
			const segments = e.segments.map((seg) => seg.map(move));
			outEdges.push({
				from: e.from,
				to: e.to,
				back: e.back,
				points,
				segments,
				path: pathOf(segments),
			});
			for (const seg of segments) for (const [x] of seg) width = Math.max(width, x);
		}
	}

	const height = maxY + shift + o.margin;
	return {
		nodes: outNodes,
		edges: outEdges,
		width,
		height,
		time: {
			/** y of a timestamp on this drawing */
			y: (t) => timeY(t) + shift,
			/** timestamp at a y on this drawing */
			at: (y) => now + (y - shift) / pxPerMs,
			nowY: shift,
		},
		stats: {
			pushed: outNodes.filter((n) => n.pushed).length,
			trials,
			/** width plus off-centre mass: the first arrangement, and the chosen one */
			packing: { initial: packing.initialCost, chosen: packing.cost },
		},
		/** Pass back as `hints` to replay these choices without searching again. */
		hints: newHints,
	};
}

/* ------------------------------------------------------ calculated deadlines */

/**
 * Every task's deadline: its own, or else the one it inherits from what it
 * blocks -- it is needed by the time the earliest of those has to start,
 * which is their deadline (own or inherited) minus their estimate.
 *
 * @param {Array<{id, due?, estimateMs?}>} inputNodes
 * @param {Array<{from, to}>} inputEdges  `from` blocks `to`
 * @returns {Map<id, {due: number, calculated: boolean, from?: id}>}
 *   only for tasks that have one; `from` names the task a calculated one
 *   comes from.
 */
export function effectiveDeadlines(inputNodes, inputEdges) {
	const byId = new Map(inputNodes.map((n) => [n.id, n]));
	const blocks = new Map(inputNodes.map((n) => [n.id, []]));
	for (const e of inputEdges) {
		if (byId.has(e.from) && byId.has(e.to) && e.from !== e.to) blocks.get(e.from).push(e.to);
	}

	const result = new Map();
	const state = new Map(); // 1 working on it, 2 done -- a cycle just stops
	const resolve = (id) => {
		if (state.get(id) === 2) return result.get(id) ?? null;
		if (state.get(id) === 1) return null;
		state.set(id, 1);
		const n = byId.get(id);
		let found = null;
		if (n.due !== undefined && n.due !== null) {
			found = { due: n.due, calculated: false };
		} else {
			for (const next of blocks.get(id)) {
				const theirs = resolve(next);
				if (!theirs) continue;
				const start = theirs.due - (byId.get(next).estimateMs || 0);
				if (!found || start < found.due) found = { due: start, calculated: true, from: next };
			}
		}
		if (found) result.set(id, found);
		state.set(id, 2);
		return found;
	};
	for (const id of byId.keys()) resolve(id);
	return result;
}

/* ------------------------------------------------------------- graph basics */

/** Depth-first search; an edge back into the current path closes a cycle. */
function markBackEdges(nodes, edges) {
	const out = new Map();
	for (const id of nodes.keys()) out.set(id, []);
	for (const e of edges) out.get(e.from).push(e);

	const state = new Map(); // 1 on the current path, 2 done
	for (const start of nodes.keys()) {
		if (state.has(start)) continue;
		const stack = [[start, 0]];
		state.set(start, 1);
		while (stack.length) {
			const frame = stack[stack.length - 1];
			const list = out.get(frame[0]);
			if (frame[1] >= list.length) {
				state.set(frame[0], 2);
				stack.pop();
				continue;
			}
			const edge = list[frame[1]];
			frame[1] += 1;
			if (state.get(edge.to) === 1) {
				edge.back = true;
			} else if (!state.has(edge.to)) {
				state.set(edge.to, 1);
				stack.push([edge.to, 0]);
			}
		}
	}
}

function topologicalOrder(nodes) {
	const indegree = new Map();
	for (const n of nodes.values()) indegree.set(n, n.preds.length);
	const ready = [...nodes.values()].filter((n) => indegree.get(n) === 0);
	const order = [];
	while (ready.length) {
		const n = ready.shift();
		order.push(n);
		for (const s of n.succs) {
			indegree.set(s, indegree.get(s) - 1);
			if (indegree.get(s) === 0) ready.push(s);
		}
	}
	return order;
}

function splitComponents(nodes, edges) {
	const group = new Map();
	const components = [];
	const neighbours = new Map();
	for (const id of nodes.keys()) neighbours.set(id, []);
	for (const e of edges) {
		neighbours.get(e.from).push(e.to);
		neighbours.get(e.to).push(e.from);
	}
	for (const id of nodes.keys()) {
		if (group.has(id)) continue;
		const members = [];
		const stack = [id];
		group.set(id, components.length);
		while (stack.length) {
			const current = stack.pop();
			members.push(nodes.get(current));
			for (const other of neighbours.get(current)) {
				if (!group.has(other)) {
					group.set(other, components.length);
					stack.push(other);
				}
			}
		}
		components.push({ nodes: members, edges: [] });
	}
	for (const e of edges) components[group.get(e.from)].edges.push(e);
	return components;
}

/* ----------------------------------------------------------- one group */

/**
 * Columns are objects in an ordered list; gutters are named by the column on
 * their left (null for the leftmost one), which stays true when a column is
 * inserted later -- anything inserted later only holds boxes below every edge
 * routed so far, so it is empty wherever those edges bend.
 */
function placeComponent(component, o, rng = null) {
	const cols = [];
	const byId = (a, b) => String(a.id).localeCompare(String(b.id));

	// A queue ordered by top edge; a box may come back later if it had to move.
	const queue = [...component.nodes];
	const takeNext = () => {
		let best = 0;
		for (let i = 1; i < queue.length; i += 1) {
			const a = queue[i];
			const b = queue[best];
			if (a.top < b.top - 1e-9 || (Math.abs(a.top - b.top) <= 1e-9 && byId(a, b) < 0)) {
				best = i;
			}
		}
		return queue.splice(best, 1)[0];
	};

	while (queue.length) {
		const v = takeNext();

		// Still has to clear every blocker, which may have moved down itself.
		let required = v.top;
		let waiting = false;
		for (const u of v.preds) {
			if (!u.placed) waiting = true;
			required = Math.max(required, u.top + u.h + o.gapY);
		}
		if (waiting || required > v.top + 1e-9) {
			v.top = Math.max(v.top, required);
			v.waits += 1;
			if (v.waits > 10000) {
				// Only reachable through a cycle that slipped past markBackEdges.
				v.preds = v.preds.filter((u) => u.placed);
			}
			queue.push(v);
			continue;
		}

		const choice = chooseColumn(v, cols, o, rng);
		if (!choice.ok && v.pushes < o.maxPushes) {
			v.top = Math.max(choice.needTop, v.top + 1);
			v.pushes += 1;
			queue.push(v);
			continue;
		}

		if (choice.insertAt !== undefined) {
			const col = { boxes: [], width: 0 };
			cols.splice(choice.insertAt, 0, col);
			choice.col = col;
		}
		const col = choice.col;
		// Route first: "is the blocker the last box in this column" has to be
		// asked before v itself becomes the last box.
		for (const u of v.preds) {
			const edge = component.edges.find((e) => e.from === u.id && e.to === v.id && !e.back);
			edge.route = routeEdge(u, col, v.top, cols, o).route;
		}
		v.col = col;
		col.boxes.push(v);
		col.width = Math.max(col.width, v.w);
		v.placed = true;
	}

	return finishComponent(component, cols, o);
}

const leftOf = (cols, g) => (g === 0 ? null : cols[g - 1]);
const gutterIndex = (cols, leftCol) => (leftCol === null ? 0 : cols.indexOf(leftCol) + 1);

function lastBox(col) {
	return col.boxes.length ? col.boxes[col.boxes.length - 1] : null;
}

/** Earliest y >= from where [y, y + height] crosses no box in the column. */
function freeBand(col, from, height) {
	const margin = 2;
	let y = from;
	for (const box of col.boxes) {
		const top = box.top - margin;
		const bottom = box.top + box.h + margin;
		if (bottom <= y) continue;
		if (top >= y + height) break;
		y = bottom;
	}
	return y;
}

/**
 * How the edge from u gets into column `vCol` at `vTop`, with the columns as
 * they stand now. Returns the route and the lowest vTop it needs; the route
 * works when that is no lower than the real vTop.
 */
function routeEdge(u, vCol, vTop, cols, o) {
	const uBottom = u.top + u.h;
	if (u.col === vCol && lastBox(vCol) === u) {
		return { needTop: uBottom + o.gapY, route: { straight: true }, crossings: 0 };
	}

	const a = cols.indexOf(u.col);
	const b = cols.indexOf(vCol);
	let best = null;
	for (const tailG of [a, a + 1]) {
		for (const headG of [b, b + 1]) {
			const step = headG > tailG ? 1 : -1;
			const crossings = [];
			let y = uBottom + o.sweepH;
			for (let g = tailG; g !== headG; g += step) {
				const crossed = cols[step > 0 ? g : g - 1];
				const at = freeBand(crossed, y, o.crossH);
				crossings.push({ y: at, to: g + step });
				y = at + o.crossH;
			}
			const needTop = Math.max(y + o.sweepH, uBottom + o.gapY);
			const candidate = {
				needTop,
				crossings: crossings.length,
				spread: Math.abs(headG - tailG),
				route: {
					straight: false,
					tail: leftOf(cols, tailG),
					crossings: crossings.map((c) => ({ y: c.y, to: leftOf(cols, c.to) })),
				},
			};
			const eps = 1e-9;
			const fits = candidate.needTop <= vTop + eps;
			const bestFits = best !== null && best.needTop <= vTop + eps;
			let better;
			if (best === null) better = true;
			else if (fits !== bestFits) better = fits;
			else if (!fits) better = candidate.needTop < best.needTop;
			else if (candidate.crossings !== best.crossings)
				better = candidate.crossings < best.crossings;
			else better = candidate.spread < best.spread;
			if (better) best = candidate;
		}
	}
	return best;
}

/** Pick the column for v: an existing one it fits in, or a new one anywhere. */
function chooseColumn(v, cols, o, rng = null) {
	const candidates = [];
	cols.forEach((col, i) => {
		const last = lastBox(col);
		if (!last || last.top + last.h + o.gapY <= v.top + 1e-9) {
			candidates.push({ col, index: i, fresh: false });
		}
	});
	for (let i = 0; i <= cols.length; i += 1) candidates.push({ insertAt: i, fresh: true });

	let best = null;
	for (const c of candidates) {
		// Evaluate against the column list as it would be.
		const trial = c.fresh ? cols.slice() : cols;
		const col = c.fresh ? { boxes: [], width: 0 } : c.col;
		if (c.fresh) trial.splice(c.insertAt, 0, col);
		const at = trial.indexOf(col);

		let needTop = -Infinity;
		let cost = c.fresh ? 150 : 0;
		cost += at; // a slight pull to the left keeps groups compact
		for (const u of v.preds) {
			const r = routeEdge(u, col, v.top, trial, o);
			needTop = Math.max(needTop, r.needTop);
			if (r.route.straight) cost -= 60;
			cost += r.crossings * 200 + (r.spread || 0) * 20;
		}
		const ok = needTop <= v.top + 1e-9;
		// A search run nudges the costs, to find layouts the plain greedy misses.
		if (rng && ok) cost += (rng() - 0.5) * rng.scale;
		const score = ok ? cost : 1e9 + needTop;
		if (!best || score < best.score) {
			best = { score, ok, needTop, col: c.fresh ? null : c.col, insertAt: c.insertAt };
		}
	}
	return best;
}

/** Gutter widths and tracks, column positions, and every edge's points. */
function finishComponent(component, cols, o) {
	// Each edge's vertical runs, gutter by gutter.
	const runs = new Map(); // leftCol (or null) -> [{edge, from, to}]
	const addRun = (leftCol, edge, from, to) => {
		if (!runs.has(leftCol)) runs.set(leftCol, []);
		const run = { edge, from, to, track: 0 };
		runs.get(leftCol).push(run);
		return run;
	};

	const byIdMap = new Map(component.nodes.map((n) => [n.id, n]));
	for (const e of component.edges) {
		if (e.back || !e.route || e.route.straight) continue;
		const u = byIdMap.get(e.from);
		const v = byIdMap.get(e.to);
		e.runs = [];
		let gutter = e.route.tail;
		let y = u.top + u.h;
		for (const c of e.route.crossings) {
			e.runs.push(addRun(gutter, e, y, c.y + o.crossH));
			gutter = c.to;
			y = c.y;
		}
		e.runs.push(addRun(gutter, e, y, v.top));
	}

	// Tracks: runs that overlap in height sit side by side.
	const gutterW = new Map();
	for (const [leftCol, list] of runs) {
		list.sort((p, q) => p.from - q.from || p.to - q.to);
		const trackEnds = [];
		for (const run of list) {
			let t = trackEnds.findIndex((end) => end <= run.from);
			if (t === -1) {
				t = trackEnds.length;
				trackEnds.push(run.to);
			} else {
				trackEnds[t] = run.to;
			}
			run.track = t;
		}
		gutterW.set(leftCol, { tracks: trackEnds.length });
	}
	const widthOf = (leftCol) => {
		const g = gutterW.get(leftCol);
		return g ? Math.max(o.gutterMin, (g.tracks + 1) * o.trackW) : o.gutterMin;
	};

	// Left to right: gutter, column, gutter, column, ..., gutter.
	const gutterX = new Map();
	let x = 0;
	gutterX.set(null, { left: x, width: widthOf(null) });
	x += widthOf(null);
	for (const col of cols) {
		col.left = x;
		col.center = x + col.width / 2;
		x += col.width;
		gutterX.set(col, { left: x, width: widthOf(col) });
		x += widthOf(col);
	}
	const trackX = (leftCol, track) => {
		const g = gutterX.get(leftCol);
		const tracks = gutterW.get(leftCol)?.tracks ?? 1;
		return g.left + (g.width - tracks * o.trackW) / 2 + (track + 0.5) * o.trackW;
	};

	for (const n of component.nodes) n.x = n.col.center - n.w / 2;

	const gutterAt = (x) => {
		for (const g of gutterX.values()) {
			if (x >= g.left - 1e-6 && x <= g.left + g.width + 1e-6) return g;
		}
		return null;
	};

	for (const e of component.edges) {
		const u = byIdMap.get(e.from);
		const v = byIdMap.get(e.to);
		const start = [u.col.center, u.top + u.h];
		const end = [v.col.center, v.top];
		if (e.back || !e.route || e.route.straight) {
			e.points = [start, end];
			e.segments = curveThrough(e.points, [corridor(start, end, null)]);
			continue;
		}
		// The route as a list of sideways moves ("bends"), each in the band
		// the router checked for it; between bends the edge runs straight down.
		const bends = [];
		let run = 0;
		let gx = trackX(e.route.tail, e.runs[0].track);
		bends.push({ x0: start[0], x1: gx, y0: start[1], y1: start[1] + o.sweepH });
		for (const c of e.route.crossings) {
			run += 1;
			const next = trackX(c.to, e.runs[run].track);
			bends.push({ x0: gx, x1: next, y0: c.y, y1: c.y + o.crossH });
			gx = next;
		}
		bends.push({ x0: gx, x1: end[0], y0: end[1] - o.sweepH, y1: end[1] });

		e.points = dedupe(smoothBends(bends, component.nodes, o));
		const corridors = [];
		for (let i = 1; i < e.points.length; i += 1) {
			corridors.push(corridor(e.points[i - 1], e.points[i], gutterAt));
		}
		e.segments = curveThrough(e.points, corridors);
	}

	return { nodes: component.nodes, edges: component.edges, width: x, x: 0 };
}

/* ------------------------------------------------------- dateless groups */

function moveDown(c, dy) {
	for (const n of c.nodes) {
		n.top += dy;
		n.timeTop += dy; // part of where its (lack of) dates put it, not a push
	}
	for (const e of c.edges) {
		e.points = e.points.map(([x, y]) => [x, y + dy]);
		e.segments = e.segments.map((seg) => seg.map(([x, y]) => [x, y + dy]));
	}
}

/**
 * Stretch every bend over as much free height as it can use.
 *
 * A bend with vertical tangents at both ends never leaves the rectangle
 * between its two end points, so it is safe as long as that rectangle holds
 * no box. For each bend, find how far its rectangle can grow up and down
 * before touching one; share the room between neighbouring bends; then let
 * each take up to `bendRatio` times its sideways distance. The first bend
 * still starts at the tail box and the last still ends at the head box.
 */
function smoothBends(bends, boxes, o) {
	const pad = 2;
	for (const bend of bends) {
		const left = Math.min(bend.x0, bend.x1);
		const right = Math.max(bend.x0, bend.x1);
		let lo = -Infinity;
		let hi = Infinity;
		for (const b of boxes) {
			if (b.x + b.w + pad <= left || b.x - pad >= right) continue;
			const top = b.top - pad;
			const bottom = b.top + b.h + pad;
			if (bottom <= bend.y0 + 1e-6) lo = Math.max(lo, bottom);
			else if (top >= bend.y1 - 1e-6) hi = Math.min(hi, top);
			// A box straddling the band can only be the tail or head box
			// itself, touching the fixed end; nothing to widen there.
		}
		bend.lo = lo;
		bend.hi = hi;
		bend.from = bend.y0;
		bend.to = bend.y1;
		bend.need = Math.max(o.sweepH, o.bendRatio * Math.abs(bend.x1 - bend.x0));
	}

	// Share the straight stretch between two bends.
	for (let i = 0; i + 1 < bends.length; i += 1) {
		const upper = bends[i];
		const lower = bends[i + 1];
		const gapTop = upper.y1;
		const gapBottom = lower.y0;
		const reachDown = Math.min(upper.hi, gapBottom);
		const reachUp = Math.max(lower.lo, gapTop);
		if (reachDown <= reachUp) {
			upper.to = reachDown;
			lower.from = reachUp;
		} else {
			// Both could use the overlap: split it in proportion to need.
			const split = reachUp + ((reachDown - reachUp) * upper.need) / (upper.need + lower.need);
			upper.to = split;
			lower.from = split;
		}
	}

	const points = [];
	bends.forEach((bend, i) => {
		const room = bend.to - bend.from;
		const height = Math.min(room, bend.need);
		let y0;
		if (i === 0) y0 = bend.from; // leave the tail box right away
		else if (i === bends.length - 1) y0 = bend.to - height; // arrive last
		else y0 = bend.from + (room - height) / 2;
		points.push([bend.x0, y0], [bend.x1, y0 + height]);
	});
	return points;
}

/**
 * The free rectangle a section between two waypoints may use. A bend owns the
 * box between its end points, which smoothBends checked for cards. A straight
 * run down a gutter owns the gutter's whole width over its height -- no card is
 * ever put in a gutter -- which leaves it room to sway into the next bend.
 */
function corridor(a, b, gutterAt) {
	const top = Math.min(a[1], b[1]);
	const bottom = Math.max(a[1], b[1]);
	if (Math.abs(a[0] - b[0]) > 0.01 || !gutterAt) {
		return { l: Math.min(a[0], b[0]), r: Math.max(a[0], b[0]), t: top, b: bottom };
	}
	const g = gutterAt(a[0]);
	if (!g) return { l: a[0], r: a[0], t: top, b: bottom };
	const inset = 1;
	return { l: g.left + inset, r: g.left + g.width - inset, t: top, b: bottom };
}

/** How far from p along dir before leaving the rectangle. */
function reach(p, dir, rect) {
	let t = Infinity;
	if (dir[0] > 1e-9) t = Math.min(t, (rect.r - p[0]) / dir[0]);
	if (dir[0] < -1e-9) t = Math.min(t, (rect.l - p[0]) / dir[0]);
	if (dir[1] > 1e-9) t = Math.min(t, (rect.b - p[1]) / dir[1]);
	if (dir[1] < -1e-9) t = Math.min(t, (rect.t - p[1]) / dir[1]);
	return Math.max(0, t);
}

/**
 * One cubic per section, with a shared direction wherever two sections meet,
 * so the curve turns smoothly through every waypoint. Only the two ends, where
 * it meets a card, are held vertical. Each control point is kept inside its
 * section's free rectangle; a cubic never leaves the hull of its control
 * points, so it never leaves that rectangle -- and never touches a card.
 */
function curveThrough(points, corridors) {
	const n = points.length;
	const chord = (i) => Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]);
	const dirs = points.map((p, i) => {
		if (i === 0 || i === n - 1) return [0, 1]; // straight down at a card
		// Catmull-Rom: along the line from the previous point to the next...
		const dx = points[i + 1][0] - points[i - 1][0];
		const dy = points[i + 1][1] - points[i - 1][1];
		// ...unless that points out of a neighbouring rectangle, which would
		// shrink that side's handle to nothing and leave a corner. Straight
		// down always fits both sides (the path only ever descends), so lean
		// towards it until the direction fits.
		const before = corridors[i - 1];
		const after = corridors[i];
		for (const w of [1, 0.75, 0.5, 0.25, 0]) {
			const x = dx * w;
			const y = dy * w + (1 - w) * Math.hypot(dx, dy);
			const len = Math.hypot(x, y) || 1;
			const d = [x / len, y / len];
			const fitsBefore = reach(p, [-d[0], -d[1]], before) >= 0.3 * (chord(i - 1) / 3);
			const fitsAfter = reach(p, d, after) >= 0.3 * (chord(i) / 3);
			if (fitsBefore && fitsAfter) return d;
		}
		return [0, 1];
	});

	const segments = [];
	for (let i = 0; i + 1 < n; i += 1) {
		const a = points[i];
		const b = points[i + 1];
		const rect = corridors[i];
		// A card end leaves or arrives vertically, bending over half the height;
		// elsewhere the usual third of the chord.
		const wantA = i === 0 ? Math.abs(b[1] - a[1]) / 2 : chord(i) / 3;
		const wantB = i + 1 === n - 1 ? Math.abs(b[1] - a[1]) / 2 : chord(i) / 3;
		const back = [-dirs[i + 1][0], -dirs[i + 1][1]];
		const ta = Math.min(wantA, reach(a, dirs[i], rect));
		const tb = Math.min(wantB, reach(b, back, rect));
		segments.push([
			a,
			[a[0] + dirs[i][0] * ta, a[1] + dirs[i][1] * ta],
			[b[0] + back[0] * tb, b[1] + back[1] * tb],
			b,
		]);
	}
	return segments;
}

/** SVG path data for a chain of cubic segments. */
export function pathOf(segments) {
	if (!segments.length) return "";
	const f = (q) => `${round(q[0])} ${round(q[1])}`;
	let d = `M ${f(segments[0][0])}`;
	for (const [, c1, c2, end] of segments) d += ` C ${f(c1)} ${f(c2)} ${f(end)}`;
	return d;
}

function dedupe(points) {
	const out = [];
	for (const p of points) {
		const last = out[out.length - 1];
		if (last && Math.abs(last[0] - p[0]) < 0.01 && Math.abs(last[1] - p[1]) < 0.01) continue;
		out.push(p);
	}
	return out;
}

/* -------------------------------------------------------- packing groups */

function componentRects(c, pad) {
	const rects = [];
	for (const n of c.nodes) {
		rects.push({ l: n.x - pad, r: n.x + n.w + pad, t: n.top - pad, b: n.top + n.h + pad });
	}
	for (const e of c.edges) {
		for (const seg of e.segments) {
			const xs = seg.map((q) => q[0]);
			const ys = seg.map((q) => q[1]);
			rects.push({
				l: Math.min(...xs) - pad,
				r: Math.max(...xs) + pad,
				t: Math.min(...ys) - pad,
				b: Math.max(...ys) + pad,
			});
		}
	}
	return rects;
}

const isFloater = (c) => c.nodes.every((n) => !n.anchored);

/* ------------------------------------------------------------- the search */

/** FNV-1a: a short, stable fingerprint of a string. */
function hash32(text) {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i += 1) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

/** Deterministic randomness (mulberry32), with a noise scale of its own. */
function seededRandom(seed) {
	let state = seed >>> 0;
	const next = () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	// From barely nudged to thoroughly shuffled.
	next.scale = 60 + next() * 240;
	return next;
}

/** Names a group by its tasks, so its choices can be found again later. */
function componentKey(c) {
	const ids = c.nodes.map((n) => String(n.id)).sort();
	return hash32(ids.join("")).toString(36) + ":" + ids.length;
}

/** Lay one group out from scratch; seed 0 is the plain greedy. */
function runTree(component, o, seed) {
	for (const n of component.nodes) {
		n.top = n.timeTop;
		n.placed = false;
		n.col = null;
		n.pushes = 0;
		n.waits = 0;
		n.x = 0;
		n.preds = n.allPreds.slice();
	}
	for (const e of component.edges) {
		e.route = null;
		e.runs = null;
		e.points = null;
		e.segments = null;
	}
	return placeComponent(component, o, seed ? seededRandom(seed) : null);
}

/**
 * Try the group with differently nudged column choices. Best is the variant
 * that moves the fewest boxes off their dates, then the narrowest; ties keep
 * the earlier one, and the previous choice goes first -- so a layout only
 * changes for something strictly better.
 */
function searchTree(component, o, startSeed) {
	const size = component.nodes.length;
	if (size < 3) return { seed: startSeed, trials: 0 }; // nothing to choose between
	// Cheap enough (well under a millisecond a try) to be generous.
	const count = Math.max(12, Math.min(80, Math.round(2000 / size)));
	const base = hash32(component.key);
	const seeds = [startSeed, 0];
	for (let i = 1; i <= count; i += 1) seeds.push((base + i * 0x9e3779b1) >>> 0 || i);

	let best = null;
	let trials = 0;
	for (const seed of [...new Set(seeds)]) {
		const result = runTree(component, o, seed);
		trials += 1;
		const pushed = component.nodes.filter((n) => n.top > n.timeTop + 0.5).length;
		const width = Math.round(result.width);
		if (!best || pushed < best.pushed || (pushed === best.pushed && width < best.width)) {
			best = { seed, pushed, width };
		}
	}
	return { seed: best.seed, trials };
}

/* ------------------------------------------------- mirroring and shifting */

/** Flip a laid-out group left to right; everything stays valid, mirrored. */
function setMirror(c, mirrored) {
	if (Boolean(c.mirrored) === mirrored) return;
	const flip = (x) => c.width - x;
	for (const n of c.nodes) n.x = c.width - n.x - n.w;
	for (const e of c.edges) {
		e.points = e.points.map(([x, y]) => [flip(x), y]);
		e.segments = e.segments.map((seg) => seg.map(([x, y]) => [flip(x), y]));
	}
	c.mirrored = mirrored;
}

function resetShift(c) {
	if (c.dy) moveDown(c, -c.dy);
	c.dy = 0;
}

function shiftDown(c, dy) {
	if (!dy) return;
	moveDown(c, dy);
	c.dy = (c.dy || 0) + dy;
}

/* ------------------------------------------------------------- packing */

/** The leftmost x >= 0 where these rectangles overlap nothing placed. */
function leftmostFit(rects, placed) {
	const candidates = new Set([0]);
	for (const q of rects) {
		for (const p of placed) {
			if (p.t < q.b && q.t < p.b) candidates.add(p.r - q.l);
		}
	}
	const xs = [...candidates].filter((x) => x >= 0).sort((p, q) => p - q);
	for (const x of xs) {
		const clash = rects.some((q) =>
			placed.some(
				(p) => p.l < q.r + x - 1e-6 && q.l + x < p.r - 1e-6 && p.t < q.b && q.t < p.b
			)
		);
		if (!clash) return x;
	}
	return 0;
}

function commit(c, x, rects, placed) {
	c.x = x;
	for (const q of rects) placed.push({ l: q.l + x, r: q.r + x, t: q.t, b: q.b });
}

/**
 * Pack the groups by a plan: dated groups in its order, each at the leftmost
 * x where it overlaps nothing placed so far; then the floaters, row by row --
 * each in the current row the same way, or, when its right edge would pass
 * `viewWidth`, at the start of the next row, a group gap below the tallest
 * floater so far (at most `floaterRows` rows; the last one just keeps going).
 * Returns what the arrangement costs.
 */
function packByPlan(plan, byKey, all, o) {
	const pad = o.componentGap / 2;
	const mirrored = new Set(plan.mirrored);
	for (const c of all) {
		setMirror(c, mirrored.has(c.key));
		resetShift(c);
	}

	const placed = [];
	for (const key of plan.dated) {
		const c = byKey.get(key);
		const rects = componentRects(c, pad);
		commit(c, leftmostFit(rects, placed), rects, placed);
	}

	const floaters = plan.floaters.map((key) => byKey.get(key));
	if (floaters.length) {
		const topOf = (c) => Math.min(...c.nodes.map((n) => n.top));
		const bottomOf = (c) => Math.max(...c.nodes.map((n) => n.top + n.h));
		let rowTop = Math.min(...floaters.map(topOf));
		let lowest = rowTop;
		let row = 0;
		let inRow = 0;
		for (const c of floaters) {
			shiftDown(c, rowTop - topOf(c));
			let rects = componentRects(c, pad);
			let x = leftmostFit(rects, placed);
			while (x + c.width > o.viewWidth && row < o.floaterRows - 1 && (inRow > 0 || row === 0)) {
				row += 1;
				inRow = 0;
				rowTop = lowest + o.componentGap;
				shiftDown(c, rowTop - topOf(c));
				rects = componentRects(c, pad);
				x = leftmostFit(rects, placed);
			}
			commit(c, x, rects, placed);
			inRow += 1;
			lowest = Math.max(lowest, bottomOf(c));
		}
	}

	// How wide, how tall, and where the cards' mass sits.
	let width = 0;
	let height = -Infinity;
	let mass = 0;
	let moment = 0;
	for (const c of all) {
		width = Math.max(width, c.x + c.width);
		for (const n of c.nodes) {
			height = Math.max(height, n.top + n.h);
			const area = n.w * n.h;
			mass += area;
			moment += area * (c.x + n.x + n.w / 2);
		}
	}
	const centre = mass ? moment / mass : 0;

	// Centring is free while the drawing is narrower than the screen: slide
	// it right, as far as it still fits, towards the middle.
	let shift = 0;
	let offCentre = 0;
	if (Number.isFinite(o.viewWidth)) {
		const target = o.viewWidth / 2;
		shift = Math.max(0, Math.min(target - centre, o.viewWidth - width));
		offCentre = Math.abs(centre + shift - target);
	}
	return { width, height, shift, cost: width + o.centreWeight * offCentre };
}

function shuffled(list, rng) {
	const out = list.slice();
	for (let i = out.length - 1; i > 0; i -= 1) {
		const j = Math.floor(rng() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

/** A plan from earlier hints, fitted to the groups there are now. */
function planFromHint(hint, fallback) {
	const keep = (hinted, current) => {
		const now = new Set(current);
		const ordered = (hinted || []).filter((k) => now.has(k));
		const seen = new Set(ordered);
		return [...ordered, ...current.filter((k) => !seen.has(k))];
	};
	const all = new Set([...fallback.dated, ...fallback.floaters]);
	return {
		dated: keep(hint.dated, fallback.dated),
		floaters: keep(hint.floaters, fallback.floaters),
		mirrored: (hint.mirrored || []).filter((k) => all.has(k)),
	};
}

/**
 * Pack the whole workspace, searching the plan when asked: the order dated
 * groups go in, the order of the floaters, and which groups are mirrored.
 * Half the tries are fresh random plans, half small changes to the best so
 * far (swap two, flip one). A plan only wins by being strictly cheaper, or as
 * cheap and shorter -- and the previous plan is where the search starts.
 */
function packWorkspace(laidOut, o, hintPlan) {
	const byKey = new Map(laidOut.map((c) => [c.key, c]));
	for (const c of laidOut) {
		c.mirrored = false;
		c.dy = 0;
	}
	const firstId = (c) =>
		c.nodes
			.map((n) => String(n.id))
			.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0];

	const initial = {
		dated: laidOut
			.map((c, i) => ({ c, i }))
			.filter(({ c }) => !isFloater(c))
			.sort((p, q) => q.c.nodes.length - p.c.nodes.length || p.i - q.i)
			.map(({ c }) => c.key),
		floaters: laidOut
			.filter(isFloater)
			.sort((a, b) => firstId(a).localeCompare(firstId(b), undefined, { numeric: true }))
			.map((c) => c.key),
		mirrored: [],
	};
	const start = hintPlan ? planFromHint(hintPlan, initial) : initial;

	let trials = 0;
	const tryPlan = (plan) => {
		trials += 1;
		return { plan, ...packByPlan(plan, byKey, laidOut, o) };
	};
	const better = (a, b) =>
		a.cost < b.cost - 0.5 || (Math.abs(a.cost - b.cost) <= 0.5 && a.height < b.height - 0.5);

	const initialResult = start === initial ? tryPlan(initial) : null;
	let best = tryPlan(start);
	const initialCost = (initialResult ?? tryPlan(initial)).cost;
	if (!initialResult && better(tryPlan(initial), best)) best = tryPlan(initial);

	if (o.optimize && laidOut.length > 1) {
		const rng = seededRandom(hash32(laidOut.map((c) => c.key).sort().join(",")) || 1);
		const count = Math.max(24, Math.min(160, Math.round(4000 / laidOut.length)));
		const everyone = laidOut.map((c) => c.key);
		for (let i = 0; i < count; i += 1) {
			let plan;
			if (i % 2 === 0) {
				plan = {
					dated: shuffled(initial.dated, rng),
					floaters: rng() < 0.5 ? initial.floaters.slice() : shuffled(initial.floaters, rng),
					mirrored: everyone.filter(() => rng() < 0.5),
				};
			} else {
				plan = {
					dated: best.plan.dated.slice(),
					floaters: best.plan.floaters.slice(),
					mirrored: best.plan.mirrored.slice(),
				};
				const move = rng();
				const list = move < 0.4 ? plan.dated : plan.floaters;
				if (move < 0.8 && list.length > 1) {
					const a = Math.floor(rng() * list.length);
					const b = Math.floor(rng() * list.length);
					[list[a], list[b]] = [list[b], list[a]];
				} else {
					const key = everyone[Math.floor(rng() * everyone.length)];
					plan.mirrored = plan.mirrored.includes(key)
						? plan.mirrored.filter((k) => k !== key)
						: [...plan.mirrored, key];
				}
			}
			const result = tryPlan(plan);
			if (better(result, best)) best = result;
		}
	}

	// Lay the winner out for real, then centre it.
	const final = packByPlan(best.plan, byKey, laidOut, o);
	for (const c of laidOut) c.x += final.shift;
	return { plan: best.plan, trials, initialCost, cost: final.cost };
}

/* ---------------------------------------------------------------- drawing */

export function pathThrough(points) {
	if (points.length < 2) return "";
	let d = `M ${round(points[0][0])} ${round(points[0][1])}`;
	for (let i = 1; i < points.length; i += 1) {
		const [x0, y0] = points[i - 1];
		const [x1, y1] = points[i];
		if (Math.abs(x1 - x0) < 0.01) {
			d += ` L ${round(x1)} ${round(y1)}`;
			continue;
		}
		// Vertical tangents at both ends: every bend leaves and arrives
		// straight down, and stays inside the band between its two points.
		const k = Math.abs(y1 - y0) / 2;
		const sign = y1 >= y0 ? 1 : -1;
		d +=
			` C ${round(x0)} ${round(y0 + sign * k)}` +
			` ${round(x1)} ${round(y1 - sign * k)}` +
			` ${round(x1)} ${round(y1)}`;
	}
	return d;
}

function round(value) {
	return Math.round(value * 100) / 100;
}
