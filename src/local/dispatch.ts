/** Classifies blast-radius calls before the proxy can serialize anything upstream. */

const BLAST_RADIUS = "get_blast_radius";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SLUG = /^[a-z\d](?:[a-z\d-]{0,38})\/[a-z\d_.-]{1,100}$/i;
const SELECTOR_LIMIT = 512;
const LOCAL_KEYS = new Set(["repo", "entity", "entity_type", "depth", "scope", "local_context"]);

type Args = Readonly<Record<string, unknown>>;

/** Checkout identity verified independently of model arguments. */
export interface VerifiedCheckout {
	/** Canonical, trusted repository root. */
	readonly root: string;
	/** Canonical GitHub owner/name of the checkout's origin. */
	readonly repoSlug: string;
	/** Device and worktree identity checked again before reading source. */
	readonly worktreeId: string;
	/** Root device number passed to the confined reader. */
	readonly device: string;
	/** Root inode passed to the confined reader. */
	readonly inode: string;
}

/** Result of resolving scope from a trusted invocation or a native hook. */
export type CheckoutEvidence =
	| { readonly kind: "hosted-only" }
	| { readonly kind: "unverified" }
	| { readonly kind: "checkout"; readonly checkout: VerifiedCheckout };

/** The inputs to local analysis after schema and scope verification. */
interface LocalBlastQuery {
	/** Exact selector from the tool arguments. */
	readonly entity: string;
	/** The graph entity the selector names. */
	readonly entityType: "function" | "file" | "module";
	/** Maximum caller hops (1–5). */
	readonly depth: number;
}

/** Route selection is immutable for the life of a call, including retries. */
export type BlastRoute =
	| { readonly kind: "hosted" }
	| {
			readonly kind: "local";
			readonly checkout: VerifiedCheckout;
			readonly query: LocalBlastQuery;
	  }
	| {
			readonly kind: "refused";
			readonly code: "invalid_local_request" | "unverified_worktree" | "repo_mismatch";
	  };

function matchesCheckout(repo: string, checkout: VerifiedCheckout): boolean {
	const slug = checkout.repoSlug.toLowerCase();
	const name = repo.toLowerCase();
	return name === slug || name === slug.split("/")[1];
}

function repoRelativePath(value: string): boolean {
	return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function reconClaimsLocal(args: Args): boolean {
	if (args.scope === "local") return true;
	const targets = Array.isArray(args.blast_radius) ? args.blast_radius : [args.blast_radius];
	return targets.some(
		(target: unknown) =>
			typeof target === "object" &&
			target !== null &&
			(Object.hasOwn(target, "local_context") || ("scope" in target && target.scope === "local")),
	);
}

function parseQuery(args: Args, checkout: VerifiedCheckout): LocalBlastQuery | undefined {
	const { entity, entity_type, depth = 3 } = args;
	if (
		Object.keys(args).some((key) => !LOCAL_KEYS.has(key)) ||
		typeof entity !== "string" ||
		entity.length === 0 ||
		entity.length > SELECTOR_LIMIT ||
		[...entity].some((char) => char.charCodeAt(0) < 32 || char === "\\") ||
		(entity_type !== "function" && entity_type !== "file" && entity_type !== "module") ||
		typeof depth !== "number" ||
		!Number.isInteger(depth) ||
		depth < 1 ||
		depth > 5
	) {
		return undefined;
	}
	if (entity_type === "file" && (!repoRelativePath(entity) || entity.includes(":")))
		return undefined;
	if (entity_type === "function" && entity.includes(":")) {
		const parts = entity.split(":");
		if (parts.length === 3 && matchesCheckout(parts[0], checkout)) parts.shift();
		if (parts.length !== 2 || !repoRelativePath(parts[0]) || !parts[1]) return undefined;
	}
	return { entity, entityType: entity_type, depth };
}

/**
 * Select local or hosted once. A refused local claim is terminal for this call.
 * @param name - Name of the requested tool
 * @param args - Original, unsent tool arguments
 * @param invocation - Trusted CLI checkout evidence or hosted-only MCP default
 * @param consume - Atomically validates and claims a hook marker for these exact arguments
 * @returns An immutable decision safe to retain across auth and backend changes
 */
export function selectBlastRoute(
	name: string,
	args: Args,
	invocation: CheckoutEvidence,
	consume: (token: string, args: Args) => VerifiedCheckout | undefined,
): BlastRoute {
	const hasProof = Object.hasOwn(args, "local_context");
	if (name !== BLAST_RADIUS) {
		return hasProof || (name === "pharaoh_recon" && reconClaimsLocal(args))
			? { kind: "refused", code: "invalid_local_request" }
			: { kind: "hosted" };
	}
	const scope = Object.hasOwn(args, "scope") ? args.scope : "auto";
	if (scope !== "auto" && scope !== "local" && scope !== "hosted")
		return { kind: "refused", code: "invalid_local_request" };
	if (scope === "hosted")
		return hasProof ? { kind: "refused", code: "invalid_local_request" } : { kind: "hosted" };

	let evidence = invocation;
	if (hasProof) {
		const token = args.local_context;
		if (typeof token !== "string" || !TOKEN.test(token))
			return { kind: "refused", code: "invalid_local_request" };
		const checkout = consume(token, args);
		evidence = checkout ? { kind: "checkout", checkout } : { kind: "unverified" };
	}

	const localIntent = hasProof || scope === "local";
	if (evidence.kind === "hosted-only" && !localIntent) return { kind: "hosted" };
	if (evidence.kind !== "checkout") return { kind: "refused", code: "unverified_worktree" };

	const repo = args.repo;
	if (typeof repo !== "string" || !matchesCheckout(repo, evidence.checkout)) {
		// Only an explicitly different full slug is unambiguous hosted scope.
		if (!localIntent && typeof repo === "string" && SLUG.test(repo)) return { kind: "hosted" };
		return { kind: "refused", code: "repo_mismatch" };
	}
	const query = parseQuery(args, evidence.checkout);
	return query
		? { kind: "local", checkout: evidence.checkout, query }
		: { kind: "refused", code: "invalid_local_request" };
}
