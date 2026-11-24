/** Shared wire format. A rule is inert data with exact scope and finite limits. */
const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const keys = (x, required, optional = []) =>
	object(x) &&
	required.every((k) => Object.hasOwn(x, k)) &&
	Object.keys(x).every((k) => required.includes(k) || optional.includes(k));
const text = (s, max) =>
	typeof s === "string" && s.length > 0 && s.length <= max && !/[\p{Cc}\p{Bidi_Control}]/u.test(s);
const path = (s) =>
	text(s, 480) &&
	!/[\\:]/.test(s) &&
	s.split("/").every((part) => part && part !== "." && part !== ".." && !part.startsWith("."));
const id = (s) => text(s, 80) && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(s);
const name = (s) => text(s, 128) && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);
const symbol = (s) => keys(s, ["file", "name"]) && path(s.file) && name(s.name);
const bounded = (a, max, test) => Array.isArray(a) && a.length <= max && a.every(test);
const position = (n) => Number.isSafeInteger(n) && n > 0;
const severity = (s) => s === "warning" || s === "error";
const base = ["kind", "id", "severity", "file"];

const fingerprint = (s) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
function baseline(b) {
	return (
		keys(b, ["fingerprint", "count", "expiresAt"]) &&
		fingerprint(b.fingerprint) &&
		position(b.count) &&
		b.count <= 256 &&
		text(b.expiresAt, 24) &&
		Number.isFinite(Date.parse(b.expiresAt)) &&
		new Date(b.expiresAt).toISOString() === b.expiresAt
	);
}
function rule(r) {
	if (
		r?.baselines !== undefined &&
		(!bounded(r.baselines, 16, baseline) ||
			new Set(r.baselines.map((b) => b.fingerprint)).size !== r.baselines.length)
	)
		return false;
	if (!object(r) || !id(r.id) || !path(r.file) || !severity(r.severity)) return false;
	if (r.kind === "component-reuse")
		return (
			keys(r, [...base, "elements", "component"], ["baselines"]) &&
			symbol(r.component) &&
			bounded(r.elements, 16, name) &&
			r.elements.length > 0 &&
			new Set(r.elements).size === r.elements.length
		);
	return (
		keys(r, [...base, "template", "selector", "property", "token", "theme"], ["baselines"]) &&
		r.kind === "css-token" &&
		name(r.template) &&
		text(r.selector, 160) &&
		!/[{};@]/.test(r.selector) &&
		text(r.property, 80) &&
		/^[a-z][a-z0-9-]*$/.test(r.property) &&
		text(r.token, 128) &&
		/^--[A-Za-z0-9_-]+$/.test(r.token) &&
		["base", "dark", "light"].includes(r.theme)
	);
}

export function validDesignRules(rules) {
	return bounded(rules, 64, rule) && new Set(rules.map((r) => r.id)).size === rules.length;
}

/** Only a line reference inside the reviewed rule's own checkout-relative scope may be retained. */
export function validDesignExamples(rules, examples) {
	const files = new Map(rules.map((r) => [r.id, r.file]));
	return (
		bounded(
			examples,
			64,
			(x) =>
				keys(x, ["ruleId", "file", "line"]) &&
				id(x.ruleId) &&
				path(x.file) &&
				files.get(x.ruleId) === x.file &&
				position(x.line) &&
				x.line <= 1_000_000,
		) && new Set(examples.map((x) => x.ruleId)).size === examples.length
	);
}
export function validDesignQuery(q) {
	if (!object(q)) return false;
	if (q.kind === "suggest")
		return keys(q, ["kind"], ["target"]) && (q.target === undefined || path(q.target));
	return q.kind === "lint"
		? keys(q, ["kind", "rules"]) && validDesignRules(q.rules)
		: q.kind === "context" &&
				keys(q, ["kind", "target"], ["search"]) &&
				path(q.target) &&
				(q.search === undefined || text(q.search, 128));
}

export function validDesignResult(r) {
	if (!object(r) || typeof r.partial !== "boolean") return false;
	if (r.kind === "suggest")
		return (
			keys(r, ["kind", "rules", "examples", "partial"]) &&
			validDesignRules(r.rules) &&
			r.rules.length <= 32 &&
			validDesignExamples(r.rules, r.examples) &&
			r.examples.length === r.rules.length &&
			r.examples.every((x, i) => x.ruleId === r.rules[i].id)
		);
	if (r.kind === "context")
		return (
			keys(r, ["kind", "facts", "partial"]) &&
			bounded(
				r.facts,
				128,
				(f) =>
					keys(f, ["kind", "file", "name", "line"], ["declaration"]) &&
					["component", "caller", "token"].includes(f.kind) &&
					path(f.file) &&
					position(f.line) &&
					(f.kind === "token"
						? text(f.name, 128) && /^--[A-Za-z0-9_-]+$/.test(f.name)
						: name(f.name)) &&
					(f.declaration === undefined || symbol(f.declaration)),
			)
		);
	return (
		r.kind === "lint" &&
		keys(r, ["kind", "evaluated", "findings", "unknown", "partial"]) &&
		bounded(r.evaluated, 64, id) &&
		bounded(
			r.findings,
			256,
			(f) =>
				keys(f, ["ruleId", "file", "line", "column", "severity", "message", "fingerprint"]) &&
				fingerprint(f.fingerprint) &&
				id(f.ruleId) &&
				path(f.file) &&
				position(f.line) &&
				position(f.column) &&
				severity(f.severity) &&
				text(f.message, 480),
		) &&
		bounded(
			r.unknown,
			64,
			(u) =>
				keys(u, ["ruleId", "file", "reason"]) &&
				id(u.ruleId) &&
				path(u.file) &&
				text(u.reason, 240),
		)
	);
}
