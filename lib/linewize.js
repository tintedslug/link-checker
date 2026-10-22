const { fetchURL } = require("../fetch.js");

async function linewize(domain) {
	try {
		const res = await fetchURL("placeholder" + encodeURIComponent(domain));
		const json = await res.json();
		const blockedCategories = [placeholder];
		let subCategory = json.signatures?.subCategory?.replaceAll("sphirewall.application.", "").replaceAll("sphirewall.category.", "");
		if (!subCategory) {
			subCategory = "Not rated";
		}
		let category = json.signatures?.category?.replaceAll("sphirewall.application.", "").replaceAll("sphirewall.category.", "");
		let blocked = blockedCategories.includes(category) || blockedCategories.includes(subCategory);
		if (subCategory === "Not rated") {
			blocked = false;
		}
		return [subCategory, subCategory.startsWith("blocklist.") ? true : blocked];
	} catch (err) {
		console.warn("Linewize Error: " + err);
		return `Error`;
	}
}

module.exports = {linewize};
