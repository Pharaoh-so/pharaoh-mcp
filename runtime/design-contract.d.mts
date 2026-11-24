/** Repository-relative, reviewed symbol identity. */
export interface DesignSymbol {
	file: string;
	name: string;
}
export interface DesignBaseline {
	fingerprint: string;
	count: number;
	expiresAt: string;
}
interface RuleBase {
	baselines?: DesignBaseline[];
	id: string;
	severity: "error" | "warning";
	file: string;
}
export interface CssTokenRule extends RuleBase {
	kind: "css-token";
	template: string;
	selector: string;
	property: string;
	token: string;
	theme: "base" | "dark" | "light";
}
export interface ComponentReuseRule extends RuleBase {
	kind: "component-reuse";
	elements: string[];
	component: DesignSymbol;
}
export type DesignRule = CssTokenRule | ComponentReuseRule;
export type DesignQuery =
	| { kind: "context"; target: string; search?: string }
	| { kind: "suggest"; target?: string }
	| { kind: "lint"; rules: DesignRule[] };
export interface DesignFact extends DesignSymbol {
	kind: "component" | "caller" | "token";
	line: number;
	declaration?: DesignSymbol;
}
export interface DesignFinding {
	fingerprint: string;
	ruleId: string;
	file: string;
	line: number;
	column: number;
	severity: RuleBase["severity"];
	message: string;
}
export interface DesignUnknown {
	ruleId: string;
	file: string;
	reason: string;
}
export interface DesignContext {
	kind: "context";
	facts: DesignFact[];
	partial: boolean;
}
export interface DesignLint {
	kind: "lint";
	evaluated: string[];
	findings: DesignFinding[];
	unknown: DesignUnknown[];
	partial: boolean;
}
export interface DesignExample {
	ruleId: string;
	file: string;
	line: number;
}
export interface DesignSuggestions {
	kind: "suggest";
	rules: DesignRule[];
	examples: DesignExample[];
	partial: boolean;
}
export type DesignResult = DesignContext | DesignLint | DesignSuggestions;
export function validDesignExamples(
	rules: DesignRule[],
	examples: unknown,
): examples is DesignExample[];
export function validDesignRules(input: unknown): input is DesignRule[];
export function validDesignQuery(input: unknown): input is DesignQuery;
export function validDesignResult(input: unknown): input is DesignResult;
