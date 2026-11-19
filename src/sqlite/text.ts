/*
 * Reading the parts of a SQLite CREATE statement that its pragmas don't
 * give: what's inside a pair of brackets, split at its top-level commas,
 * and the clauses of a column or index. Quotes of every kind SQLite takes
 * ('text', "name", `name`, [name]) are stepped over, so a bracket or comma
 * inside one never counts.
 */

const CLOSERS: Record<string, string> = {
	"'": "'",
	'"': '"',
	'[': ']',
	'`': '`'
};

/** Where the quoted run starting at `start` ends (the index after it). */
const pastQuote = (text: string, start: number) => {
	const close = CLOSERS[text[start] ?? ''] ?? '';
	let index = start + 1;
	while (index < text.length) {
		if (text[index] === close && text[index + 1] === close && close !== ']')
			index += 2;
		else if (text[index] === close) return index + 1;
		else index += 1;
	}

	return text.length;
};

const DEPTH: Record<string, number> = { '(': 1, ')': -1 };

/* Each character outside quotes, from `from` on, with the bracket depth
 * after it. */
const unquoted = (text: string, from: number) => {
	const marks: { character: string; depth: number; index: number }[] = [];
	let depth = 0;
	let index = from;
	while (index < text.length) {
		const character = text[index] ?? '';
		const quoted = character in CLOSERS;
		depth += quoted ? 0 : (DEPTH[character] ?? 0);
		if (!quoted) marks.push({ character, depth, index });
		index = quoted ? pastQuote(text, index) : index + 1;
	}

	return marks;
};

/** The text inside the bracket opening at `open`, and where it closes. */
export const bracketed = (text: string, open: number) => {
	const end = unquoted(text, open).find(
		(mark) => mark.character === ')' && mark.depth === 0
	);

	return end
		? { close: end.index, inner: text.slice(open + 1, end.index) }
		: undefined;
};

/** Splits at commas that aren't inside brackets or quotes. */
export const topLevel = (text: string) => {
	const commas = unquoted(text, 0)
		.filter((mark) => mark.character === ',' && mark.depth === 0)
		.map((mark) => mark.index);
	const bounds = [-1, ...commas, text.length];

	return bounds
		.slice(1)
		.map((bound, position) =>
			text.slice((bounds[position] ?? -1) + 1, bound).trim()
		)
		.filter((part) => part !== '');
};

/** An identifier as written, its quotes taken off. */
export const unquote = (name: string) => {
	const trimmed = name.trim();
	const first = trimmed[0] ?? '';
	if (!(first in CLOSERS)) return trimmed;
	const close = CLOSERS[first] ?? '';

	return trimmed.slice(1, -1).replaceAll(close + close, close);
};

/** The first word of a definition (a column's name), quotes and all. */
export const leadingName = (definition: string) => {
	const first = definition[0] ?? '';
	if (first in CLOSERS) return definition.slice(0, pastQuote(definition, 0));

	return /^[^\s(]+/u.exec(definition)?.[0] ?? '';
};

/** The expression in brackets that follows a keyword (CHECK, AS), or
 *  undefined when the keyword isn't there. */
export const afterKeyword = (text: string, keyword: RegExp) => {
	const match = keyword.exec(text);
	if (!match) return undefined;
	const open = text.indexOf('(', match.index + match[0].length - 1);

	return open === -1 ? undefined : bracketed(text, open);
};

/** Every CHECK in a definition list, with the constraint name before it. */
export const checksIn = (definition: string) => {
	const checks: { expression: string; name?: string }[] = [];
	const pattern =
		/(?:\bCONSTRAINT\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|\S+)\s+)?\bCHECK\s*\(/giu;
	let match = pattern.exec(definition);
	while (match) {
		const open = match.index + match[0].length - 1;
		const found = bracketed(definition, open);
		if (found)
			checks.push({
				expression: found.inner.trim(),
				...(match[1] ? { name: unquote(match[1]) } : {})
			});
		pattern.lastIndex = (found?.close ?? open) + 1;
		match = pattern.exec(definition);
	}

	return checks;
};
