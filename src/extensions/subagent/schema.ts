/**
 * Minimal JSON Schema validation for subagent structured output.
 *
 * Supports the subset of JSON Schema used by agent frontmatter `output`
 * declarations: `type`, `required`, `properties` (one level of nesting is
 * enough for agent reports), and `items` for arrays. Everything else
 * (`description`, `metadata`, …) is ignored. A schema that is not an object
 * is a configuration error and fails validation.
 */

export type SchemaValidationResult = { success: true } | { success: false; errors: string[] };

function typeMatches(value: unknown, type: string): boolean {
	switch (type) {
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number";
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "null":
			return value === null;
		case "object":
			return typeof value === "object" && value !== null && !Array.isArray(value);
		case "array":
			return Array.isArray(value);
		default:
			return true; // unknown type keyword: no constraint
	}
}

function checkValue(schema: unknown, value: unknown, path: string, errors: string[]): void {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		errors.push(`${path}: invalid schema (must be an object)`);
		return;
	}
	const record = schema as Record<string, unknown>;
	const type = record.type;
	if (typeof type === "string" && !typeMatches(value, type)) {
		errors.push(`${path}: expected ${type}, got ${value === null ? "null" : typeof value}`);
		return;
	}
	if (type === "array" || (typeof type !== "string" && Array.isArray(value))) {
		const items = record.items;
		if (items) {
			for (let i = 0; i < (value as unknown[]).length; i++) {
				checkValue(items, (value as unknown[])[i], `${path}[${i}]`, errors);
			}
		}
		return;
	}
	if (type === "object" || (typeof type !== "string" && typeof value === "object" && value !== null && !Array.isArray(value))) {
		const recordValue = value as Record<string, unknown>;
		const required = record.required;
		if (Array.isArray(required)) {
			for (const key of required) {
				if (typeof key === "string" && !(key in recordValue)) {
					errors.push(`${path}: missing required field "${key}"`);
				}
			}
		}
		const properties = record.properties;
		if (properties && typeof properties === "object" && !Array.isArray(properties)) {
			for (const [key, propSchema] of Object.entries(properties as Record<string, unknown>)) {
				if (key in recordValue) {
					checkValue(propSchema, recordValue[key], `${path === "$" ? "$" : path}.${key}`, errors);
				}
			}
		}
	}
}

export function validateOutputSchema(schema: unknown, value: unknown): SchemaValidationResult {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		return { success: false, errors: ["$: invalid output schema (must be an object)"] };
	}
	const errors: string[] = [];
	checkValue(schema, value, "$", errors);
	return errors.length > 0 ? { success: false, errors } : { success: true };
}
