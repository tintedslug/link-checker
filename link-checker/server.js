const express = require("express");
const path = require("path");
const { linewize } = require("./lib/linewize.js");

const app = express();

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/check", async (req, res) => {
	const domain = req.query.domain;
	if (!domain) {
		return res.status(400).json({ error: "missing domain" });
	}

	const lw = await linewize(domain);

	res.json({ domain, linewize: lw });
});

const PORT = 3000;
app.listen(PORT, () => {
	console.log(`Running at http://localhost:${PORT}`);
});
