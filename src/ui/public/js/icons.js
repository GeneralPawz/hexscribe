/**
 * The small set of icons this page uses.
 *
 * Inline SVG rather than emoji: an emoji is a picture in somebody else's colour
 * scheme, at somebody else's weight, and half of them render as a box on a
 * machine that is missing the font. These are one stroke colour — the text
 * colour of whatever they sit in — so a menu item, a red one and a button on a
 * dark background all get the same drawing.
 *
 * Each is a factory rather than a string, because callers append them to the
 * DOM and two menu items must not share one element.
 */

const draw = (paths, { fill = 'none' } = {}) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.classList.add('icon__glyph')
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    if (fill !== 'none') path.setAttribute('fill', fill)
    svg.append(path)
  }
  return svg
}

export const icons = {
  play: () => draw(['M5 3.5 12.5 8 5 12.5Z'], { fill: 'currentColor' }),
  pause: () => draw(['M6 3.5v9', 'M10 3.5v9']),
  stop: () => draw(['M4.5 4.5h7v7h-7Z']),
  replay: () => draw(['M3 8a5 5 0 1 0 1.6-3.7', 'M3 3v3h3']),
  faster: () => draw(['M2.5 4 7 8l-4.5 4', 'M8.5 4 13 8l-4.5 4']),
  pencil: () => draw(['M11 3.5 12.5 5 6 11.5 3.5 12l.5-2.5Z']),
  trash: () => draw(['M3.5 4.5h9', 'M6.5 4.5V3h3v1.5', 'M5 4.5 5.6 13h4.8l.6-8.5']),
  find: () => draw(['M7 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8', 'M10 10l3 3']),
  merge: () => draw(['M3 3.5h3l4 4.5 3 .5', 'M3 12.5h3l2-2.2', 'M11 6l2 2.5-2 2.5']),
  plus: () => draw(['M8 3.5v9', 'M3.5 8h9']),
  person: () => draw(['M8 8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5', 'M3.5 13c.8-2 2.4-3 4.5-3s3.7 1 4.5 3']),
  label: () => draw(['M8.5 3.5H13v4.5L8 13 3.5 8.5Z', 'M10.5 6h.01']),
  list: () => draw(['M3.5 4.5h9', 'M3.5 8h9', 'M3.5 11.5h6']),
  jump: () => draw(['M3.5 8h8', 'M8.5 5l3 3-3 3']),
  cross: () => draw(['M4.5 4.5l7 7', 'M11.5 4.5l-7 7']),
}
