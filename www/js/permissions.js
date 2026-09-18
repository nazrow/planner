import { api, clearToken, getToken } from "./api.js";
import { el, slug } from "./views.js";

if (!getToken()) window.location.replace("./");

const grantedBox = document.getElementById("granted");
const receivedBox = document.getElementById("received");
const statusBar = document.getElementById("status");
const whoBar = document.getElementById("who");

const state = {
	me: null,
	book: { granted: [], received: [] },
	vocabulary: [],
	//: A row being typed into; `null` id means it has not been saved yet.
	editing: null,
};

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

/* ------------------------------------------------------------------ views */

function sentence(entry, mine) {
	const line = el("div", "grant-line");
	const subject = el("strong", null, mine ? entry.grantee : entry.grantor);
	line.append(
		subject,
		document.createTextNode(" may "),
		el("span", "level " + entry.level, entry.level),
		document.createTextNode(
			mine ? " every task where I am " : " every task where they are "
		)
	);
	for (const role of entry.roles) {
		line.appendChild(el("span", "chip role-" + slug(role), role));
	}
	return line;
}

function renderRow(entry) {
	const row = el("div", "grant");
	row.appendChild(sentence(entry, true));

	const actions = el("div", "grant-actions");
	const edit = el("button", "mini", "edit");
	edit.type = "button";
	edit.addEventListener("click", () => {
		state.editing = { ...entry, roles: [...entry.roles] };
		renderAll();
	});
	const drop = el("button", "mini drop", "revoke");
	drop.type = "button";
	drop.addEventListener("click", async () => {
		if (!window.confirm(`Stop letting ${entry.grantee} in?`)) return;
		try {
			state.book = await api.revoke(entry.id);
			setStatus("Permission revoked.", "ok");
			renderAll();
		} catch (error) {
			setStatus(error.detail || "Could not revoke.", "error");
		}
	});
	actions.append(edit, drop);
	row.appendChild(actions);
	return row;
}

function renderEditor() {
	const draft = state.editing;
	const form = el("form", "grant editor");

	const who = el("input", "grant-user");
	who.placeholder = "username";
	who.setAttribute("list", "user-names");
	who.autocomplete = "off";
	who.required = true;
	who.value = draft.grantee || "";

	const level = el("select", "grant-level");
	for (const option of ["view", "modify"]) {
		const item = el("option", null, "may " + option);
		item.value = option;
		if (draft.level === option) item.selected = true;
		level.appendChild(item);
	}

	const first = el("div", "grant-line");
	first.append(who, level, el("span", "phrase", "every task where I am:"));
	form.appendChild(first);

	const roles = el("div", "role-choices");
	for (const role of state.vocabulary) {
		const label = el("label", "role-choice");
		const box = el("input");
		box.type = "checkbox";
		box.value = role;
		box.checked = draft.roles.includes(role);
		label.append(box, el("span", "chip role-" + slug(role), role));
		roles.appendChild(label);
	}
	form.appendChild(roles);

	const actions = el("div", "grant-actions");
	const save = el("button", null, draft.id ? "Save" : "Grant");
	save.type = "submit";
	const cancel = el("button", "mini", "cancel");
	cancel.type = "button";
	cancel.addEventListener("click", () => {
		state.editing = null;
		renderAll();
	});
	actions.append(cancel, save);
	form.appendChild(actions);

	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		const picked = [...roles.querySelectorAll("input:checked")].map(
			(box) => box.value
		);
		if (!picked.length) {
			setStatus("Pick at least one role for the grant to cover.", "error");
			return;
		}
		const payload = {
			username: who.value.trim(),
			level: level.value,
			roles: picked,
		};
		try {
			state.book = draft.id
				? await api.amend(draft.id, payload)
				: await api.grant(payload);
			state.editing = null;
			setStatus("Saved.", "ok");
			renderAll();
		} catch (error) {
			setStatus(error.detail || "Could not save.", "error");
		}
	});

	return form;
}

function renderAll() {
	grantedBox.textContent = "";
	for (const entry of state.book.granted) {
		if (state.editing && state.editing.id === entry.id) {
			grantedBox.appendChild(renderEditor());
		} else {
			grantedBox.appendChild(renderRow(entry));
		}
	}
	if (state.editing && !state.editing.id) {
		grantedBox.appendChild(renderEditor());
	}
	if (!state.book.granted.length && !state.editing) {
		grantedBox.appendChild(
			el("p", "empty", "You have not let anybody into your tasks yet.")
		);
	}
	document.getElementById("add").hidden = Boolean(state.editing);

	receivedBox.textContent = "";
	for (const entry of state.book.received) {
		const row = el("div", "grant");
		row.appendChild(sentence(entry, false));
		receivedBox.appendChild(row);
	}
	if (!state.book.received.length) {
		receivedBox.appendChild(
			el("p", "empty", "Nobody has given you access to their tasks.")
		);
	}
}

/* ----------------------------------------------------------------- events */

document.getElementById("add").addEventListener("click", () => {
	state.editing = { id: null, grantee: "", level: "view", roles: ["owner"] };
	renderAll();
	grantedBox.querySelector(".grant-user")?.focus();
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

/* ------------------------------------------------------------------- boot */

Promise.all([api.me(), api.permissions(), api.roleVocabulary(), api.suggestions()])
	.then(([me, book, vocabulary, people]) => {
		state.me = me;
		whoBar.textContent = me.username;
		state.book = book;
		state.vocabulary = vocabulary;

		const list = document.getElementById("user-names");
		for (const person of people) {
			if (person.username === me.username) continue;
			const option = document.createElement("option");
			option.value = person.username;
			list.appendChild(option);
		}
		renderAll();
	})
	.catch((error) => {
		if (error.status === 401) {
			clearToken();
			window.location.replace("./");
			return;
		}
		setStatus(error.detail || "Could not load permissions.", "error");
	});
