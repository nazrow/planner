/**
 * Builds the DOM for a task, in either of its two states: a read-only card, or
 * the form it turns into while being created or edited.
 *
 * Nothing here listens to anything -- app.js does that by delegation, so the
 * markup can be rebuilt freely.
 */

export function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined && text !== null) node.textContent = text;
	return node;
}

export function formatDeadline(iso) {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	const sameYear = date.getFullYear() === new Date().getFullYear();
	return date.toLocaleString(undefined, {
		year: sameYear ? undefined : "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/** ISO string -> the value a datetime-local input wants, in local time. */
export function toInputValue(iso) {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	const pad = (n) => String(n).padStart(2, "0");
	return (
		date.getFullYear() +
		"-" +
		pad(date.getMonth() + 1) +
		"-" +
		pad(date.getDate()) +
		"T" +
		pad(date.getHours()) +
		":" +
		pad(date.getMinutes())
	);
}

export function fromInputValue(value) {
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function deadlineTone(iso, completion) {
	if (!iso || completion >= 100) return "";
	const left = new Date(iso).getTime() - Date.now();
	if (Number.isNaN(left)) return "";
	if (left < 0) return "overdue";
	if (left < 3 * 24 * 3600 * 1000) return "soon";
	return "";
}

/** A role is free text, so make it safe to hang a class name off. */
export function slug(role) {
	return String(role).replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

function connectors() {
	const fragment = document.createDocumentFragment();
	const top = el("button", "connector top");
	top.type = "button";
	top.dataset.action = "connect";
	top.dataset.side = "top";
	top.title = "Draw a connection from a task that blocks this one";
	top.textContent = "↑";

	const bottom = el("button", "connector bottom");
	bottom.type = "button";
	bottom.dataset.action = "connect";
	bottom.dataset.side = "bottom";
	bottom.title = "Draw a connection to a task this one blocks";
	bottom.textContent = "↓";

	fragment.append(top, bottom);
	return fragment;
}

function terminators() {
	const fragment = document.createDocumentFragment();
	for (const side of ["top", "bottom"]) {
		const button = el("button", "terminator " + side);
		button.type = "button";
		button.dataset.action = "terminate";
		button.dataset.side = side;
		button.textContent = "•";
		fragment.appendChild(button);
	}
	return fragment;
}

/* ------------------------------------------------------------- read-only */

export function renderCard(task, ctx) {
	const card = el("article", "task card");
	card.dataset.id = String(task.id);
	if (task.completion >= 100) card.classList.add("done");
	const tone = deadlineTone(task.deadline, task.completion);
	if (tone) card.classList.add(tone);
	if (!ctx.doable(task.id)) card.classList.add("blocked");

	const corners = el("div", "corners");
	if (task.can_edit) {
		const edit = el("button", "corner edit", "✎");
		edit.type = "button";
		edit.dataset.action = "edit";
		edit.title = "Edit this task";
		corners.appendChild(edit);
	}
	card.appendChild(corners);

	card.appendChild(el("div", "row title", task.title));

	if (task.description) {
		card.appendChild(el("div", "row description", task.description));
	}

	if (task.links && task.links.length) {
		const row = el("div", "row links");
		for (const link of task.links) {
			const anchor = el("a", null, link.label || link.url);
			anchor.href = link.url;
			anchor.target = "_blank";
			anchor.rel = "noreferrer noopener";
			row.appendChild(anchor);
		}
		card.appendChild(row);
	}

	if (task.deadline) {
		const row = el("div", "row deadline");
		row.appendChild(el("span", "label", "by"));
		row.appendChild(el("span", "value", formatDeadline(task.deadline)));
		card.appendChild(row);
	}

	const progress = el("div", "row completion");
	const bar = el("div", "bar");
	const fill = el("i");
	fill.style.width = Math.max(0, Math.min(100, task.completion)) + "%";
	bar.appendChild(fill);
	progress.appendChild(bar);
	progress.appendChild(el("span", "pct", task.completion + "%"));
	card.appendChild(progress);

	const people = task.roles || [];
	if (people.length) {
		const row = el("div", "row people");
		for (const entry of people) {
			const chip = el("span", "chip role-" + slug(entry.role));
			chip.appendChild(el("span", "who", entry.username));
			chip.appendChild(el("span", "what", entry.role));
			row.appendChild(chip);
		}
		card.appendChild(row);
	}

	card.appendChild(terminators());
	return card;
}

/* ------------------------------------------------------------------ form */

function personRow(entry) {
	const row = el("div", "person-row");
	const who = el("input", "f-person-name");
	who.type = "text";
	who.placeholder = "username";
	who.setAttribute("list", "user-names");
	who.autocomplete = "off";
	who.value = entry ? entry.username : "";

	const what = el("input", "f-person-role");
	what.type = "text";
	what.placeholder = "role";
	what.setAttribute("list", "role-names");
	what.autocomplete = "off";
	what.value = entry ? entry.role : "";

	const drop = el("button", "mini drop", "×");
	drop.type = "button";
	drop.dataset.action = "drop-person";
	drop.title = "Take this person off the task";

	row.append(who, what, drop);
	return row;
}

function linkRow(link) {
	const row = el("div", "link-row");
	const url = el("input", "f-link-url");
	url.type = "url";
	url.placeholder = "https://";
	url.value = link ? link.url : "";
	const label = el("input", "f-link-label");
	label.type = "text";
	label.placeholder = "label";
	label.value = link && link.label ? link.label : "";
	const drop = el("button", "mini drop", "×");
	drop.type = "button";
	drop.dataset.action = "drop-link";
	drop.title = "Remove this link";
	row.append(url, label, drop);
	return row;
}

export function renderForm(draft, ctx) {
	const form = el("form", "task editing");
	form.dataset.id = String(draft.id);
	form.setAttribute("novalidate", "novalidate");
	if (draft.mode === "create") form.classList.add("fresh");

	const corners = el("div", "corners");
	const scrap = el("button", "corner scrap", "✕");
	scrap.type = "button";
	scrap.dataset.action = "scrap";
	scrap.title =
		draft.mode === "create" ? "Throw this away" : "Delete this task";
	const submit = el("button", "corner submit", "✓");
	submit.type = "submit";
	submit.dataset.action = "submit";
	submit.title = "Save";
	corners.append(scrap, submit);
	form.appendChild(corners);

	if (draft.mode === "create") {
		const handle = el("div", "drag-handle", "⠿");
		handle.dataset.action = "drag";
		handle.title = "Drag to move";
		form.appendChild(handle);
	}

	const titleRow = el("div", "row title");
	const title = el("input", "f-title");
	title.type = "text";
	title.placeholder = "What needs doing";
	title.value = draft.title || "";
	title.required = true;
	titleRow.appendChild(title);
	form.appendChild(titleRow);

	const descriptionRow = el("div", "row description");
	const description = el("textarea", "f-description");
	description.placeholder = "Description";
	description.rows = 2;
	description.value = draft.description || "";
	descriptionRow.appendChild(description);
	form.appendChild(descriptionRow);

	const linksRow = el("div", "row links");
	const list = el("div", "link-list");
	for (const link of draft.links && draft.links.length ? draft.links : [null]) {
		list.appendChild(linkRow(link));
	}
	const add = el("button", "mini add", "+ link");
	add.type = "button";
	add.dataset.action = "add-link";
	linksRow.append(list, add);
	form.appendChild(linksRow);

	const deadlineRow = el("div", "row deadline");
	deadlineRow.appendChild(el("span", "label", "by"));
	const deadline = el("input", "f-deadline");
	deadline.type = "datetime-local";
	deadline.value = toInputValue(draft.deadline);
	deadlineRow.appendChild(deadline);
	form.appendChild(deadlineRow);

	const completionRow = el("div", "row completion");
	const range = el("input", "f-completion");
	range.type = "range";
	range.min = "0";
	range.max = "100";
	range.step = "5";
	range.value = String(draft.completion ?? 0);
	const readout = el("span", "pct", (draft.completion ?? 0) + "%");
	completionRow.append(range, readout);
	form.appendChild(completionRow);

	const peopleRow = el("div", "row people editing-people");
	const peopleList = el("div", "people-list");
	const cast = draft.roles && draft.roles.length ? draft.roles : [null];
	for (const entry of cast) peopleList.appendChild(personRow(entry));
	const addPerson = el("button", "mini add", "+ person");
	addPerson.type = "button";
	addPerson.dataset.action = "add-person";
	peopleRow.append(peopleList, addPerson);
	form.appendChild(peopleRow);

	const connectionsRow = el("div", "row connections");
	fillConnections(connectionsRow, draft, ctx);
	form.appendChild(connectionsRow);

	form.appendChild(connectors());
	form.appendChild(terminators());
	return form;
}

export function fillConnections(row, draft, ctx) {
	row.textContent = "";
	const groups = [
		["blocked by", draft.blockedBy, "blocker"],
		["blocks", draft.blocks, "blocked"],
	];
	let any = false;
	for (const [label, ids, kind] of groups) {
		if (!ids || !ids.size) continue;
		any = true;
		const group = el("div", "connection-group");
		group.appendChild(el("span", "label", label));
		for (const id of ids) {
			const chip = el("span", "chip connection " + kind);
			chip.appendChild(el("span", "chip-text", ctx.titleOf(id)));
			const drop = el("button", "mini drop", "×");
			drop.type = "button";
			drop.dataset.action = "drop-connection";
			drop.dataset.kind = kind;
			drop.dataset.other = String(id);
			chip.appendChild(drop);
			group.appendChild(chip);
		}
		row.appendChild(group);
	}
	row.classList.toggle("empty", !any);
	if (!any) {
		row.appendChild(
			el("span", "hint", "use ↑ / ↓ to connect this to other tasks")
		);
	}
}

/** Read a form back into a plain task payload. */
export function readForm(form) {
	const links = [];
	for (const row of form.querySelectorAll(".link-row")) {
		const url = row.querySelector(".f-link-url").value.trim();
		if (!url) continue;
		links.push({
			url,
			label: row.querySelector(".f-link-label").value.trim() || null,
		});
	}
	const roles = [];
	for (const row of form.querySelectorAll(".person-row")) {
		const username = row.querySelector(".f-person-name").value.trim();
		const role = row.querySelector(".f-person-role").value.trim();
		if (!username || !role) continue;
		roles.push({ username, role });
	}

	return {
		title: form.querySelector(".f-title").value.trim(),
		description: form.querySelector(".f-description").value.trim() || null,
		deadline: fromInputValue(form.querySelector(".f-deadline").value),
		completion: Number(form.querySelector(".f-completion").value) || 0,
		links,
		roles,
	};
}

export function growTextarea(textarea) {
	textarea.style.height = "auto";
	textarea.style.height = textarea.scrollHeight + "px";
}
