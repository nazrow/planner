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

const pad = (n) => String(n).padStart(2, "0");

/**
 * Deadlines come in two kinds. With a time, it is an exact instant, shown in
 * the viewer's own zone. Without one, it is a calendar day stored as midnight
 * UTC, so it is read back in UTC and comes out as the same date everywhere.
 */
export function formatDeadline(iso, hasTime = true) {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	if (!hasTime) {
		const sameYear = date.getUTCFullYear() === new Date().getFullYear();
		return date.toLocaleDateString(undefined, {
			timeZone: "UTC",
			year: sameYear ? undefined : "numeric",
			month: "short",
			day: "numeric",
		});
	}
	const sameYear = date.getFullYear() === new Date().getFullYear();
	return date.toLocaleString(undefined, {
		year: sameYear ? undefined : "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/** The values for the form's date and time fields; time is "" for a day. */
export function toInputValues(iso, hasTime = true) {
	if (!iso) return { date: "", time: "" };
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return { date: "", time: "" };
	if (!hasTime) {
		return {
			date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
			time: "",
		};
	}
	return {
		date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
		time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
	};
}

/** Back from the form: no date means no deadline, no time means a whole day. */
export function fromInputValues(date, time) {
	if (!date) return { deadline: null, deadline_has_time: true };
	if (!time) {
		return { deadline: `${date}T00:00:00Z`, deadline_has_time: false };
	}
	const local = new Date(`${date}T${time}`);
	if (Number.isNaN(local.getTime())) {
		return { deadline: null, deadline_has_time: true };
	}
	return { deadline: local.toISOString(), deadline_has_time: true };
}

/** When the deadline actually passes: a whole day lasts to its local midnight. */
export function dueMoment(iso, hasTime) {
	const d = new Date(iso);
	if (hasTime) return d.getTime();
	return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1).getTime();
}

function deadlineTone(iso, hasTime, completion) {
	if (!iso || completion >= 100) return "";
	const left = dueMoment(iso, hasTime) - Date.now();
	if (Number.isNaN(left)) return "";
	if (left < 0) return "overdue";
	if (left < 3 * 24 * 3600 * 1000) return "soon";
	return "";
}

export function formatHours(hours) {
	if (hours === null || hours === undefined) return "";
	const rounded = Math.round(hours * 100) / 100;
	return `${rounded} h`;
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
	const tone = deadlineTone(task.deadline, task.deadline_has_time, task.completion);
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
		row.appendChild(
			el("span", "value", formatDeadline(task.deadline, task.deadline_has_time))
		);
		card.appendChild(row);
	}

	if (task.estimate_hours) {
		const row = el("div", "row estimate");
		row.appendChild(el("span", "label", "work"));
		row.appendChild(el("span", "value", formatHours(task.estimate_hours)));
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
	const due = toInputValues(draft.deadline, draft.deadline_has_time);
	const deadlineDate = el("input", "f-deadline-date");
	deadlineDate.type = "date";
	deadlineDate.value = due.date;
	const deadlineTime = el("input", "f-deadline-time");
	deadlineTime.type = "time";
	deadlineTime.value = due.time;
	deadlineTime.title = "Optional: leave empty for the whole day";
	deadlineRow.append(deadlineDate, deadlineTime);
	form.appendChild(deadlineRow);

	const estimateRow = el("div", "row estimate");
	estimateRow.appendChild(el("span", "label", "work"));
	const estimate = el("input", "f-estimate");
	estimate.type = "number";
	estimate.min = "0";
	estimate.step = "0.5";
	estimate.placeholder = "hours";
	estimate.title = "Hours of work; the deadline minus this is the latest start";
	estimate.value = draft.estimate_hours ?? "";
	estimateRow.append(estimate, el("span", "unit", "h"));
	form.appendChild(estimateRow);

	const completionRow = el("div", "row completion");
	if ((draft.completion ?? 0) >= 100) completionRow.classList.add("complete");
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
		...fromInputValues(
			form.querySelector(".f-deadline-date").value,
			form.querySelector(".f-deadline-time").value
		),
		completion: Number(form.querySelector(".f-completion").value) || 0,
		estimate_hours: readEstimate(form),
		links,
		roles,
	};
}

/** The form's estimate in hours, or null when empty or not a positive number. */
export function readEstimate(form) {
	const raw = form.querySelector(".f-estimate")?.value ?? "";
	const hours = Number.parseFloat(raw);
	return Number.isFinite(hours) && hours > 0 ? hours : null;
}

export function growTextarea(textarea) {
	textarea.style.height = "auto";
	textarea.style.height = textarea.scrollHeight + "px";
}
