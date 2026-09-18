/**
 * Layered layout for the task graph.
 *
 * A blocker always ends up on a row strictly above the task it blocks, every
 * edge is routed down through empty horizontal bands (so it can never cross a
 * task box), and each connected group is squeezed into the narrowest width its
 * rows allow.
 *
 * This is the classic Sugiyama pipeline:
 *   1. split into connected groups
 *   2. break any cycles (the API refuses them, but old data might have some)
 *   3. assign rows by longest path, so blockers sit above what they block
 *   4. insert invisible waypoints for edges that skip rows -- they reserve the
 *      channel the curve will travel through
 *   5. reduce crossings by median ordering + adjacent swaps
 *   6. assign x by the priority method, then clamp every row into the group's
 *      minimum possible width
 *   7. stack the groups into shelves
 *
 * Pure geometry: no DOM, no knowledge of what a task is.
 */

export const DEFAULTS = {
	nodeGapX: 16, // between two task boxes side by side
	edgeGapX: 10, // channel width reserved for an edge passing a row
	// Empty band between rows, where the curves live. Card buttons stick out
	// about 10px above and below, so much less than this and they would meet.
	layerGapY: 36,
	componentGapX: 44, // between separate, unconnected groups
	componentGapY: 48,
	maxWidth: Infinity, // groups wrap onto a new shelf past this
	orderIterations: 12,
	priorityIterations: 8,
};

/**
 * @param {Array<{id:*, width:number, height:number}>} inputNodes
 * @param {Array<{from:*, to:*}>} inputEdges  `from` blocks `to`
 * @param {object} [options]
 * @returns {{nodes:Array, edges:Array, width:number, height:number}}
 */
export function layoutGraph(inputNodes, inputEdges, options = {}) {
	const opts = { ...DEFAULTS, ...options };

	const nodes = new Map();
	nodeRegistry = nodes;
	for (const n of inputNodes) {
		nodes.set(n.id, {
			id: n.id,
			w: n.width,
			h: n.height,
			gap: opts.nodeGapX,
			dummy: false,
			out: [],
			in: [],
			rank: 0,
			order: 0,
			x: 0,
			y: 0,
		});
	}

	const edges = [];
	const seenPairs = new Set();
	for (const e of inputEdges) {
		if (!nodes.has(e.from) || !nodes.has(e.to) || e.from === e.to) continue;
		const key = `${e.from}->${e.to}`;
		if (seenPairs.has(key)) continue;
		seenPairs.add(key);
		edges.push({ from: e.from, to: e.to, reversed: false, chain: [] });
	}

	const components = splitComponents(nodes, edges);

	const placed = [];
	const laidOutEdges = [];
	let shelfX = 0;
	let shelfY = 0;
	let shelfHeight = 0;
	let totalWidth = 0;

	for (const component of components) {
		const box = layoutComponent(component, nodes, opts);

		if (shelfX > 0 && shelfX + box.width > opts.maxWidth) {
			shelfY += shelfHeight + opts.componentGapY;
			shelfX = 0;
			shelfHeight = 0;
		}

		for (const node of component.nodes) {
			node.x += shelfX;
			node.y += shelfY;
		}
		for (const layer of component.layers) {
			layer.top += shelfY;
		}

		shelfHeight = Math.max(shelfHeight, box.height);
		shelfX += box.width + opts.componentGapX;
		totalWidth = Math.max(totalWidth, shelfX - opts.componentGapX);

		for (const node of component.nodes) {
			if (!node.dummy) {
				placed.push({
					id: node.id,
					x: node.x - node.w / 2,
					y: node.y,
					width: node.w,
					height: node.h,
				});
			}
		}
		for (const edge of component.edges) {
			laidOutEdges.push(buildEdgeGeometry(edge, nodes, component));
		}
	}

	return {
		nodes: placed,
		edges: laidOutEdges,
		width: Math.max(0, totalWidth),
		height: shelfY + shelfHeight,
	};
}

/* ------------------------------------------------------------------ groups */

function splitComponents(nodes, edges) {
	const neighbours = new Map();
	for (const id of nodes.keys()) neighbours.set(id, []);
	for (const e of edges) {
		neighbours.get(e.from).push(e.to);
		neighbours.get(e.to).push(e.from);
	}

	const groupOf = new Map();
	const groups = [];
	for (const id of nodes.keys()) {
		if (groupOf.has(id)) continue;
		const members = [];
		const stack = [id];
		groupOf.set(id, groups.length);
		while (stack.length) {
			const current = stack.pop();
			members.push(current);
			for (const other of neighbours.get(current)) {
				if (!groupOf.has(other)) {
					groupOf.set(other, groups.length);
					stack.push(other);
				}
			}
		}
		groups.push({ ids: members, edges: [], nodes: [], layers: [] });
	}

	for (const e of edges) groups[groupOf.get(e.from)].edges.push(e);

	// Stable order across re-layouts: biggest groups first, ties by first id.
	groups.sort(
		(a, b) =>
			b.ids.length - a.ids.length ||
			String(minId(a.ids)).localeCompare(String(minId(b.ids)))
	);
	return groups;
}

function minId(ids) {
	return ids.slice().sort((a, b) => String(a).localeCompare(String(b)))[0];
}

/* ----------------------------------------------------------------- one group */

function layoutComponent(component, nodes, opts) {
	const members = component.ids.map((id) => nodes.get(id));
	for (const node of members) {
		node.in = [];
		node.out = [];
	}

	breakCycles(component, nodes);
	assignRanks(component, nodes);
	const all = addWaypoints(component, nodes, opts);
	component.nodes = all;

	const layers = buildLayers(all);
	component.layers = layers;

	orderLayers(layers, opts);
	const width = assignX(layers, opts);
	const height = assignY(layers, opts);

	return { width, height };
}

/** Depth-first search; any edge back into the current path gets flipped. */
function breakCycles(component, nodes) {
	const state = new Map(); // 0 unseen, 1 on the current path, 2 done
	const outgoing = new Map();
	for (const id of component.ids) outgoing.set(id, []);
	for (const e of component.edges) outgoing.get(e.from).push(e);

	const visit = (startId) => {
		const stack = [[startId, 0]];
		state.set(startId, 1);
		while (stack.length) {
			const frame = stack[stack.length - 1];
			const [id, index] = frame;
			const list = outgoing.get(id);
			if (index >= list.length) {
				state.set(id, 2);
				stack.pop();
				continue;
			}
			frame[1] += 1;
			const edge = list[index];
			const next = edge.to;
			if (state.get(next) === 1) {
				edge.reversed = true; // a cycle: pretend it points the other way
				continue;
			}
			if (!state.has(next)) {
				state.set(next, 1);
				stack.push([next, 0]);
			}
		}
	};

	for (const id of component.ids) if (!state.has(id)) visit(id);

	for (const e of component.edges) {
		const from = e.reversed ? e.to : e.from;
		const to = e.reversed ? e.from : e.to;
		nodes.get(from).out.push(e);
		nodes.get(to).in.push(e);
	}
}

function edgeTail(edge) {
	return edge.reversed ? edge.to : edge.from;
}

function edgeHead(edge) {
	return edge.reversed ? edge.from : edge.to;
}

/** Longest path from the roots: every blocker lands above everything it blocks. */
function assignRanks(component, nodes) {
	const indegree = new Map();
	for (const id of component.ids) indegree.set(id, nodes.get(id).in.length);

	const queue = component.ids.filter((id) => indegree.get(id) === 0);
	for (const id of component.ids) nodes.get(id).rank = 0;

	let processed = 0;
	while (queue.length) {
		const id = queue.shift();
		processed += 1;
		const node = nodes.get(id);
		for (const edge of node.out) {
			const next = nodes.get(edgeHead(edge));
			next.rank = Math.max(next.rank, node.rank + 1);
			indegree.set(next.id, indegree.get(next.id) - 1);
			if (indegree.get(next.id) === 0) queue.push(next.id);
		}
	}

	if (processed !== component.ids.length) {
		// Shouldn't happen once cycles are broken; fall back to something sane.
		for (const id of component.ids) {
			const node = nodes.get(id);
			node.rank = Math.max(node.rank, 0);
		}
	}
}

/**
 * Give every edge a chain of zero-width waypoints, one per row it skips.
 * These reserve the vertical channel the curve will run through, which is what
 * keeps edges off the task boxes.
 */
function addWaypoints(component, nodes, opts) {
	const all = component.ids.map((id) => nodes.get(id));
	let counter = 0;

	for (const edge of component.edges) {
		const tail = nodes.get(edgeTail(edge));
		const head = nodes.get(edgeHead(edge));
		edge.chain = [];
		for (let rank = tail.rank + 1; rank < head.rank; rank += 1) {
			const waypoint = {
				id: `wp:${counter++}`,
				w: 0,
				h: 0,
				gap: opts.edgeGapX,
				dummy: true,
				edge,
				rank,
				order: 0,
				x: 0,
				y: 0,
				in: [],
				out: [],
			};
			edge.chain.push(waypoint);
			all.push(waypoint);
		}
	}
	return all;
}

function buildLayers(all) {
	const maxRank = all.reduce((m, n) => Math.max(m, n.rank), 0);
	const layers = [];
	for (let r = 0; r <= maxRank; r += 1) layers.push([]);
	for (const node of all) layers[node.rank].push(node);
	for (const layer of layers) {
		layer.forEach((node, index) => {
			node.order = index;
		});
	}
	return layers;
}

/**
 * Neighbours of a node in the row above (dir -1) or below (dir +1), following
 * waypoint chains so a long edge behaves like a straight line of segments.
 */
function neighboursOf(node, dir) {
	const result = [];
	if (node.dummy) {
		const chain = node.edge.chain;
		const index = chain.indexOf(node);
		if (dir === -1) {
			result.push(index === 0 ? tailNodeOf(node.edge) : chain[index - 1]);
		} else {
			result.push(
				index === chain.length - 1 ? headNodeOf(node.edge) : chain[index + 1]
			);
		}
		return result.filter(Boolean);
	}
	const list = dir === -1 ? node.in : node.out;
	for (const edge of list) {
		if (edge.chain.length) {
			result.push(dir === -1 ? edge.chain[edge.chain.length - 1] : edge.chain[0]);
		} else {
			result.push(dir === -1 ? tailNodeOf(edge) : headNodeOf(edge));
		}
	}
	return result;
}

let nodeRegistry = null;

function tailNodeOf(edge) {
	return nodeRegistry.get(edgeTail(edge));
}

function headNodeOf(edge) {
	return nodeRegistry.get(edgeHead(edge));
}

/* --------------------------------------------------------------- ordering */

function orderLayers(layers, opts) {
	let best = snapshot(layers);
	let bestCrossings = countAllCrossings(layers);

	for (let iteration = 0; iteration < opts.orderIterations; iteration += 1) {
		medianPass(layers, iteration % 2 === 0 ? 1 : -1);
		transposePass(layers);
		const crossings = countAllCrossings(layers);
		if (crossings < bestCrossings) {
			bestCrossings = crossings;
			best = snapshot(layers);
		}
		if (bestCrossings === 0) break;
	}

	restore(layers, best);
}

function snapshot(layers) {
	return layers.map((layer) => layer.slice());
}

function restore(layers, snap) {
	for (let r = 0; r < layers.length; r += 1) {
		layers[r].length = 0;
		for (const node of snap[r]) layers[r].push(node);
		reindex(layers[r]);
	}
}

function reindex(layer) {
	layer.forEach((node, index) => {
		node.order = index;
	});
}

function medianPass(layers, direction) {
	const range =
		direction === 1
			? [...layers.keys()].slice(1)
			: [...layers.keys()].slice(0, -1).reverse();

	for (const r of range) {
		const layer = layers[r];
		const keys = new Map();
		for (const node of layer) {
			const median = medianOf(neighboursOf(node, direction === 1 ? -1 : 1));
			// A node with nothing to line up with stays roughly where it is.
			keys.set(node, median < 0 ? node.order : median);
		}
		const decorated = layer.map((node, index) => ({ node, index }));
		decorated.sort(
			(a, b) => keys.get(a.node) - keys.get(b.node) || a.index - b.index
		);
		layer.length = 0;
		for (const entry of decorated) layer.push(entry.node);
		reindex(layer);
	}
}

function medianOf(neighbours) {
	if (!neighbours.length) return -1;
	const positions = neighbours.map((n) => n.order).sort((a, b) => a - b);
	const middle = Math.floor(positions.length / 2);
	if (positions.length % 2 === 1) return positions[middle];
	return (positions[middle - 1] + positions[middle]) / 2;
}

function transposePass(layers) {
	let improved = true;
	let guard = 0;
	while (improved && guard < 8) {
		improved = false;
		guard += 1;
		for (let r = 0; r < layers.length - 1; r += 1) {
			const layer = layers[r];
			for (let i = 0; i < layer.length - 1; i += 1) {
				const before = crossingsAround(layers, r);
				swap(layer, i, i + 1);
				const after = crossingsAround(layers, r);
				if (after < before) {
					improved = true;
				} else {
					swap(layer, i, i + 1);
				}
			}
		}
	}
}

function swap(layer, i, j) {
	const tmp = layer[i];
	layer[i] = layer[j];
	layer[j] = tmp;
	layer[i].order = i;
	layer[j].order = j;
}

function crossingsAround(layers, r) {
	let total = countCrossings(layers, r);
	if (r > 0) total += countCrossings(layers, r - 1);
	return total;
}

/** Crossings between row r and row r+1. */
function countCrossings(layers, r) {
	if (r < 0 || r + 1 >= layers.length) return 0;
	const pairs = [];
	for (const node of layers[r]) {
		for (const other of neighboursOf(node, 1)) {
			pairs.push([node.order, other.order]);
		}
	}
	let crossings = 0;
	for (let i = 0; i < pairs.length; i += 1) {
		for (let j = i + 1; j < pairs.length; j += 1) {
			const [a1, b1] = pairs[i];
			const [a2, b2] = pairs[j];
			if ((a1 - a2) * (b1 - b2) < 0) crossings += 1;
		}
	}
	return crossings;
}

function countAllCrossings(layers) {
	let total = 0;
	for (let r = 0; r < layers.length - 1; r += 1) total += countCrossings(layers, r);
	return total;
}

/* ------------------------------------------------------------- x placement */

function separation(a, b) {
	return a.w / 2 + b.w / 2 + (a.gap + b.gap) / 2;
}

function packLayer(layer) {
	let cursor = 0;
	for (let i = 0; i < layer.length; i += 1) {
		const node = layer[i];
		if (i === 0) {
			node.x = node.w / 2;
		} else {
			node.x = cursor + separation(layer[i - 1], node);
		}
		cursor = node.x;
	}
	return layer.length ? layer[layer.length - 1].x + layer[layer.length - 1].w / 2 : 0;
}

function pushRight(layer, i, amount, priority) {
	if (amount <= 1e-9) return 0;
	const node = layer[i];
	if (i === layer.length - 1) {
		node.x += amount;
		return amount;
	}
	const next = layer[i + 1];
	let room = Math.max(0, next.x - node.x - separation(node, next));
	if (room < amount && next.priority < priority) {
		room += pushRight(layer, i + 1, amount - room, priority);
	}
	const moved = Math.min(amount, room);
	node.x += moved;
	return moved;
}

function pushLeft(layer, i, amount, priority) {
	if (amount <= 1e-9) return 0;
	const node = layer[i];
	if (i === 0) {
		node.x -= amount;
		return amount;
	}
	const previous = layer[i - 1];
	let room = Math.max(0, node.x - previous.x - separation(previous, node));
	if (room < amount && previous.priority < priority) {
		room += pushLeft(layer, i - 1, amount - room, priority);
	}
	const moved = Math.min(amount, room);
	node.x -= moved;
	return moved;
}

/** Squeeze a row into [0, limit] while keeping its order and separations. */
function enforceBounds(layer, limit) {
	for (let i = 0; i < layer.length; i += 1) {
		const node = layer[i];
		const floor =
			i === 0 ? node.w / 2 : layer[i - 1].x + separation(layer[i - 1], node);
		if (node.x < floor) node.x = floor;
	}
	for (let i = layer.length - 1; i >= 0; i -= 1) {
		const node = layer[i];
		const ceiling =
			i === layer.length - 1
				? limit - node.w / 2
				: layer[i + 1].x - separation(node, layer[i + 1]);
		if (node.x > ceiling) node.x = ceiling;
	}
}

function assignX(layers, opts) {
	let ideal = 0;
	for (const layer of layers) ideal = Math.max(ideal, packLayer(layer));

	for (const layer of layers) {
		for (const node of layer) {
			// Waypoints outrank real boxes, so long edges stay straight.
			node.priority = node.dummy
				? Number.MAX_SAFE_INTEGER
				: neighboursOf(node, -1).length + neighboursOf(node, 1).length;
		}
	}

	for (let iteration = 0; iteration < opts.priorityIterations; iteration += 1) {
		const down = iteration % 2 === 0;
		const order = down
			? [...layers.keys()].slice(1)
			: [...layers.keys()].slice(0, -1).reverse();

		for (const r of order) {
			const layer = layers[r];
			const byPriority = layer
				.map((node, index) => ({ node, index }))
				.sort((a, b) => b.node.priority - a.node.priority || a.index - b.index);

			for (const { node } of byPriority) {
				const neighbours = neighboursOf(node, down ? -1 : 1);
				if (!neighbours.length) continue;
				const target = averageX(neighbours);
				const index = layer.indexOf(node);
				const delta = target - node.x;
				if (delta > 0) pushRight(layer, index, delta, node.priority);
				else if (delta < 0) pushLeft(layer, index, -delta, node.priority);
			}
			enforceBounds(layer, ideal);
		}
	}

	for (const layer of layers) enforceBounds(layer, ideal);

	// Shift the whole group so its left edge sits at 0.
	let left = Infinity;
	for (const layer of layers) {
		for (const node of layer) left = Math.min(left, node.x - node.w / 2);
	}
	if (left !== Infinity && left !== 0) {
		for (const layer of layers) for (const node of layer) node.x -= left;
	}

	return ideal;
}

function averageX(neighbours) {
	const xs = neighbours.map((n) => n.x).sort((a, b) => a - b);
	const middle = Math.floor(xs.length / 2);
	if (xs.length % 2 === 1) return xs[middle];
	return (xs[middle - 1] + xs[middle]) / 2;
}

/* ------------------------------------------------------------- y placement */

function assignY(layers, opts) {
	let y = 0;
	for (const layer of layers) {
		let height = 0;
		for (const node of layer) height = Math.max(height, node.h);
		layer.top = y;
		layer.height = height;
		for (const node of layer) node.y = y;
		y += height + opts.layerGapY;
	}
	return Math.max(0, y - opts.layerGapY);
}

/* ----------------------------------------------------------- edge geometry */

function buildEdgeGeometry(edge, nodes, component) {
	const tail = nodes.get(edgeTail(edge));
	const head = nodes.get(edgeHead(edge));
	const layers = component.layers;

	const points = [[tail.x, tail.y + tail.h]];
	// Rows are top-aligned, so a short box ends above its row's bottom, level
	// with the lower part of any taller neighbour. Drop straight down to the
	// row's bottom first -- that column is the box's own -- and only curve in
	// the empty band below, or the curve can swing into the neighbour.
	const tailRow = layers[tail.rank];
	const rowBottom = tailRow.top + tailRow.height;
	if (rowBottom > tail.y + tail.h + 0.5) points.push([tail.x, rowBottom]);
	for (const waypoint of edge.chain) {
		const layer = layers[waypoint.rank];
		points.push([waypoint.x, layer.top]);
		points.push([waypoint.x, layer.top + layer.height]);
	}
	points.push([head.x, head.y]);

	// A flipped edge still has to point at the task it really blocks.
	const ordered = edge.reversed ? points.slice().reverse() : points;

	return {
		from: edge.from,
		to: edge.to,
		reversed: edge.reversed,
		points: ordered,
		path: pathThrough(ordered),
	};
}

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
		// Vertical tangents at both ends: the curve leaves straight down and
		// arrives straight down, and stays inside the empty band between rows.
		const k = Math.max(16, Math.abs(y1 - y0) * 0.5);
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

