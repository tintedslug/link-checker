const fetch = require("node-fetch");

async function fetchURL(url) {
	return fetch(url, {
		headers: { "User-Agent": "Mozilla/5.0" }
	});
}

module.exports = { fetchURL };
