/**
 * Pure helpers behind `check:dist`'s crawler-visible-content guard (issue #81).
 *
 * Extracted from `check-dist.mjs` so the boundary behaviour is unit-testable:
 * the script itself reads `dist/` (and may `process.exit`) at import time, so a
 * vitest case cannot import it directly.
 */

/** Length of the human-visible text: scripts, styles and tags stripped, whitespace collapsed. */
export const textLength = (markup) =>
  markup
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;

/**
 * Inner HTML of the `<div id="…">`, found by matching <div>/</div> depth.
 *
 * The crawler-visible content is exactly this region: head styles and scripts are not
 * page text. Scanning the whole document instead would let the `<style>` block in
 * <head> satisfy a `bbs-intro` needle even after the real prose inside #root was
 * deleted (confirmed by deliberately emptying #root: the whole-document check passed).
 *
 * Requires `id` to be the div's first attribute (the docs plugin emits it that way)
 * and the tag to be closed; anything else returns `null` and the caller reports it
 * as a static error instead of silently passing.
 */
export function innerHtmlById(markup, id) {
  const open = markup.indexOf(`<div id="${id}"`);
  if (open === -1) return null;
  const start = markup.indexOf('>', open) + 1;
  let depth = 1;
  const tag = /<\/?div\b/g;
  tag.lastIndex = start;
  for (let m = tag.exec(markup); m; m = tag.exec(markup)) {
    depth += m[0] === '</div' ? -1 : 1;
    if (depth === 0) return markup.slice(start, m.index);
  }
  return null;
}
