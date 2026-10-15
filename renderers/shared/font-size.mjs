// Keep explicit font fields aligned with common.schema.json. Computed layout
// sizes are separate: they may be scaled or fitted rather than half steps.
const fontKeys = new Set(['label', 'sublabel', 'tag', 'title', 'subtitle', 'legend_title']);

function invalid(subject) {
  const error = new TypeError(`${subject}: expected a finite font size from 6 to 72 in steps of 0.5`);
  error.code = 'INVALID_FONT_SIZE';
  throw error;
}

export function assertFontSize(value, subject = 'font size') {
  if (typeof value !== 'number' || !Number.isFinite(value)
      || value < 6 || value > 72 || !Number.isInteger(value * 2)) invalid(subject);
  return value;
}

export function assertFontSizes(sizes, subject = 'font_sizes') {
  if (!sizes || typeof sizes !== 'object' || Array.isArray(sizes)) invalid(subject);
  for (const [key, value] of Object.entries(sizes)) {
    if (key === 'items') {
      if (!Array.isArray(value)) invalid(`${subject}.items`);
      value.forEach((size, index) => {
        if (size !== null) assertFontSize(size, `${subject}.items[${index}]`);
      });
    } else {
      if (!fontKeys.has(key)) invalid(`${subject}.${key}`);
      assertFontSize(value, `${subject}.${key}`);
    }
  }
}

// Validate only font fields, so drafts with repairable geometry remain editable.
export function assertFontFields(value, subject = 'candidate') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const field = `${subject}.${key}`;
    if (key === 'font_sizes') assertFontSizes(child, field);
    else if (key === 'font_size') assertFontSize(child, field);
    else assertFontFields(child, field);
  }
}
