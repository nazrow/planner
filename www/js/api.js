const TOKEN_KEY = "planner.token";

export function getToken() {
	try {
		return localStorage.getItem(TOKEN_KEY);
	} catch {
		return null;
	}
}

export function setToken(token) {
	try {
		localStorage.setItem(TOKEN_KEY, token);
	} catch {
		/* private mode: the session just won't survive a reload */
	}
}

export function clearToken() {
	try {
		localStorage.removeItem(TOKEN_KEY);
	} catch {
		/* nothing to do */
	}
}

export class ApiError extends Error {
	constructor(status, detail) {
		super(detail || "Request failed");
		this.status = status;
		this.detail = detail;
	}
}

async function request(method, path, body) {
	const headers = {};
	const token = getToken();
	if (token) headers.Authorization = "Bearer " + token;
	if (body !== undefined) headers["Content-Type"] = "application/json";

	// Relative on purpose: resolved against the page's own address, so calls
	// land under whatever path the proxy serves the app from.
	const response = await fetch(path, {
		method,
		// Data never comes from the HTTP cache, whatever an older version of
		// the server once said about the same address.
		cache: "no-store",
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});

	if (response.status === 204) return null;

	let payload = null;
	const text = await response.text();
	if (text) {
		try {
			payload = JSON.parse(text);
		} catch {
			payload = text;
		}
	}

	if (!response.ok) {
		const detail =
			payload && typeof payload === "object" && payload.detail
				? typeof payload.detail === "string"
					? payload.detail
					: JSON.stringify(payload.detail)
				: String(payload || response.statusText);
		throw new ApiError(response.status, detail);
	}
	return payload;
}

export const api = {
	login: (username, password) =>
		request("POST", "auth/login", { username, password }),
	me: () => request("GET", "auth/me"),
	logout: () => request("POST", "auth/logout"),
	workspace: (includeFinished) =>
		request(
			"GET",
			"workspace" + (includeFinished ? "?include_finished=true" : "")
		),
	suggestions: () => request("GET", "users/suggestions"),
	roleVocabulary: () => request("GET", "roles"),
	createTask: (task) => request("POST", "tasks", task),
	updateTask: (id, task) => request("PUT", "tasks/" + id, task),
	deleteTask: (id) => request("DELETE", "tasks/" + id),
	permissions: () => request("GET", "permissions"),
	grant: (entry) => request("POST", "permissions", entry),
	amend: (id, entry) => request("PUT", "permissions/" + id, entry),
	revoke: (id) => request("DELETE", "permissions/" + id),
};
