const express = require("express");
const path = require("path");
const { linewize } = require("./lib/linewize.js");
const { probe, closeBrowser } = require("./lib/probe.js");

const app = express();

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/check", async (req, res) => {
	const domain = req.query.domain;
	if (!domain) {
		return res.status(400).json({ error: "missing domain" });
	}

	// Linewize lookup and the headless-browser liveness probe run in parallel.
	// The probe runs on the server, not in the visitor's browser.
	const [lw, pr] = await Promise.all([
		linewize(domain),
		probe(domain).catch((e) => ({ broken: true, reason: String(e.message || e) }))
	]);

	res.json({ domain, linewize: lw, probe: pr });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
	console.log(`Running at http://localhost:${PORT}`);
});

process.on("SIGINT", async () => { await closeBrowser(); process.exit(0); });
