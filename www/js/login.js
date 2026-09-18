import { api, getToken, setToken } from "./api.js";

const form = document.getElementById("login");
const message = document.getElementById("message");
const submit = document.getElementById("submit");

// The page ships with the button disabled; only now can the form submit safely.
submit.disabled = false;

if (getToken()) {
	// Already carrying a token? Only believe it if the server still does.
	api.me()
		.then(() => {
			window.location.replace("/workspace");
		})
		.catch(() => {
			/* stale token, stay on the login screen */
		});
}

form.addEventListener("submit", async (event) => {
	event.preventDefault();
	message.textContent = "";
	message.className = "";
	submit.disabled = true;

	const username = document.getElementById("username").value.trim();
	const password = document.getElementById("password").value;

	try {
		const result = await api.login(username, password);
		setToken(result.token);
		window.location.replace("/workspace");
	} catch (error) {
		message.className = "error";
		message.textContent =
			error.status === 401
				? "That username is taken and the password does not match."
				: error.detail || "Could not sign in.";
		submit.disabled = false;
	}
});
