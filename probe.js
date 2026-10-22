const puppeteer = require("puppeteer");

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const NAV_TIMEOUT = 15000; // per navigation attempt
const HARD_TIMEOUT = 40000; // whole probe for one domain
const MAX_CONCURRENT = 3; // pages open at once
const CACHE_MS = 5 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* Signatures of "this site is dead" pages that still return HTTP 200 */
/* ------------------------------------------------------------------ */
// Add more here whenever you find a new kind of dead page.
const SIGNATURES = [
	[/domain suspended or not configured/i, "BunnyCDN: domain suspended"],
	[/<title>\s*bunnycdn node/i, "BunnyCDN: not configured"],
	[/<code>\s*allaccessdisabled\s*<\/code>/i, "S3 bucket: access disabled"],
	[/<code>\s*nosuchbucket\s*<\/code>/i, "S3 bucket: doesn't exist"],
	[/<code>\s*nosuchkey\s*<\/code>/i, "S3 object: doesn't exist"],
	[/<code>\s*accessdenied\s*<\/code>/i, "S3 bucket: access denied"],
	[/<error>\s*<code>[^<]+<\/code>\s*<message>/i, "XML error response"],
	[/there isn'?t a github pages site here/i, "GitHub Pages: no site"],
	[/deployment_not_found|the deployment could not be found/i, "Vercel: deployment not found"],
	[/no such app|nothing here yet/i, "Heroku: no such app"],
	[/site not found.*netlify|page not found.*netlify/i, "Netlify: site not found"],
	[/this site (has been|is) (suspended|disabled)/i, "Site suspended"],
	[/(account|website|site|domain) (has been |is )?suspended/i, "Suspended"],
	[/bandwidth limit exceeded|resource limit is reached/i, "Host limit reached"],
	[/domain is not (configured|connected|pointed)/i, "Domain not configured"],
	[/(default|test) page for the (apache|nginx)|welcome to nginx!|apache2 (ubuntu )?default page/i, "Default server page"],
	[/this domain (is|may be) for sale|buy this domain|domain parking|parked (free|domain)/i, "Parked / for sale"],
	[/sinkhole|dns_probe_finished|err_name_not_resolved/i, "DNS failure"],
	[/error 10(01|02|03|16|33)|error 52\d\b/i, "Cloudflare error"],
	[/origin (dns )?error|web server is (down|returning an unknown error)/i, "Origin down"],
];

// Pages that mean "a bot check", not "broken". We keep these visible.
const CHALLENGE = /just a moment\.\.\.|checking your browser|attention required! \| cloudflare|cf-chl|verify you are human/i;

/**
 * Pure function: decide whether the loaded page looks broken.
 * Returns a reason string if broken, or null if it looks fine.
 */
function classify({ status, html, text, contentType, hasContent }) {
	const raw = html || "";

	if (CHALLENGE.test(raw)) return null; // bot challenge, probably a real site

	for (const [re, reason] of SIGNATURES) {
		if (re.test(raw)) return reason;
	}

	if (status >= 400) return `HTTP ${status}`;

	// raw XML document (Chrome wraps these, but contentType gives it away)
	if (/xml/i.test(contentType || "") && /<error\b/i.test(raw)) return "XML error response";

	// Very short plain "not found" style bodies
	const t = (text || "").trim();
	if (t.length < 200 && /^(404|not found|forbidden|access denied|bad gateway|service unavailable|error)\b/i.test(t)) {
		return "Error text page";
	}

	if (!hasContent && t.length === 0) return "Blank page";

	return null;
}

/* ------------------------------------------------------------------ */
/* Browser management                                                  */
/* ------------------------------------------------------------------ */
let browserPromise = null;

function getBrowser() {
	if (!browserPromise) {
		browserPromise = puppeteer
			.launch({
				headless: true,
				args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--mute-audio"],
			})
			.then((b) => {
				b.on("disconnected", () => {
					browserPromise = null;
				});
				return b;
			})
			.catch((e) => {
				browserPromise = null;
				throw e;
			});
	}
	return browserPromise;
}

async function closeBrowser() {
	if (!browserPromise) return;
	try {
		(await browserPromise).close();
	} catch (_) {}
	browserPromise = null;
}

/* simple semaphore so 50 links don't open 50 tabs */
let active = 0;
const waiting = [];
async function acquire() {
	if (active < MAX_CONCURRENT) {
		active++;
		return;
	}
	await new Promise((r) => waiting.push(r));
	active++;
}
function release() {
	active--;
	const next = waiting.shift();
	if (next) next();
}

/* ------------------------------------------------------------------ */
/* Probe one URL                                                       */
/* ------------------------------------------------------------------ */
async function loadOnce(browser, url) {
	const context = await browser.createBrowserContext();
	const page = await context.newPage();
	try {
		await page.setUserAgent(UA);
		await page.setViewport({ width: 1280, height: 800 });

		// don't waste time on heavy media; we only need the page to render
		await page.setRequestInterception(true);
		page.on("request", (req) => {
			const t = req.resourceType();
			if (t === "media" || t === "font") return req.abort().catch(() => {});
			req.continue().catch(() => {});
		});

		const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });

		// let JS-rendered pages (games!) paint something
		await page.waitForNetworkIdle({ idleTime: 800, timeout: 4000 }).catch(() => {});

		const status = response ? response.status() : 0;
		const contentType = response ? response.headers()["content-type"] || "" : "";
		const html = await page.content();
		const info = await page.evaluate(() => {
			const body = document.body;
			return {
				text: body ? body.innerText || "" : "",
				hasContent: !!document.querySelector("canvas, iframe, video, embed, object, img, svg, input, button, a[href]"),
			};
		});

		return {
			status,
			contentType,
			html,
			text: info.text,
			hasContent: info.hasContent,
			finalUrl: page.url(),
		};
	} finally {
		await context.close().catch(() => {});
	}
}

function friendlyNetError(msg) {
	const m = /net::(ERR_[A-Z_]+)/.exec(msg || "");
	if (m) {
		const code = m[1];
		const map = {
			ERR_NAME_NOT_RESOLVED: "DNS: domain doesn't exist",
			ERR_CONNECTION_REFUSED: "Connection refused",
			ERR_CONNECTION_RESET: "Connection reset",
			ERR_CONNECTION_CLOSED: "Connection closed",
			ERR_CONNECTION_TIMED_OUT: "Connection timed out",
			ERR_TIMED_OUT: "Timed out",
			ERR_CERT_COMMON_NAME_INVALID: "Bad SSL certificate",
			ERR_CERT_DATE_INVALID: "Expired SSL certificate",
			ERR_CERT_AUTHORITY_INVALID: "Untrusted SSL certificate",
			ERR_SSL_PROTOCOL_ERROR: "SSL error",
			ERR_TOO_MANY_REDIRECTS: "Redirect loop",
			ERR_EMPTY_RESPONSE: "Empty response",
			ERR_ADDRESS_UNREACHABLE: "Address unreachable",
		};
		return map[code] || code;
	}
	if (/timeout/i.test(msg || "")) return "Timed out";
	return (msg || "Unknown error").split("\n")[0].slice(0, 120);
}

async function runProbe(domain) {
	const browser = await getBrowser();
	let lastErr = null;

	// try https first, fall back to http if the connection itself fails
	for (const scheme of ["https://", "http://"]) {
		try {
			const r = await loadOnce(browser, scheme + domain);
			const reason = classify(r);
			return {
				broken: !!reason,
				reason: reason || "OK",
				status: r.status,
				finalUrl: r.finalUrl,
			};
		} catch (err) {
			lastErr = err;
			// DNS failure will fail on http too, no point retrying
			if (/ERR_NAME_NOT_RESOLVED/.test(String(err.message))) break;
		}
	}
	return { broken: true, reason: friendlyNetError(lastErr && lastErr.message), status: 0, finalUrl: null };
}

const cache = new Map();

async function probe(domain) {
	const hit = cache.get(domain);
	if (hit && Date.now() - hit.t < CACHE_MS) return hit.v;

	await acquire();
	let timer;
	try {
		const result = await Promise.race([
			runProbe(domain),
			new Promise((_, rej) => {
				timer = setTimeout(() => rej(new Error("Timed out")), HARD_TIMEOUT);
			}),
		]);
		cache.set(domain, { t: Date.now(), v: result });
		return result;
	} catch (err) {
		// If the checker itself is broken (e.g. Chrome missing) say so rather than
		// claiming the site is dead, so good links don't get hidden by mistake.
		if (/Could not find|Failed to launch|spawn|ENOENT/i.test(String(err.message))) {
			return { broken: false, reason: "Probe unavailable: " + err.message.split("\n")[0], status: 0, finalUrl: null, probeFailed: true };
		}
		return { broken: true, reason: friendlyNetError(err.message), status: 0, finalUrl: null };
	} finally {
		clearTimeout(timer);
		release();
	}
}

process.on("exit", () => {
	closeBrowser();
});

module.exports = { probe, classify, closeBrowser };
