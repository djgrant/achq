type View = Record<string, unknown>;

const lookup = (view: View, name: string): unknown =>
  name.split(".").reduce<unknown>((value, key) => (value as View | undefined)?.[key], view);

const truthy = (value: unknown) => (Array.isArray(value) ? value.length > 0 : Boolean(value));

/**
 * A small Mustache subset: `{{name}}` (dotted paths allowed), `{{#name}}…{{/name}}`
 * repeated for each item of an array or shown when truthy, and `{{^name}}…{{/name}}`
 * shown when falsy or empty. A section tag's trailing newline is dropped so
 * sections can sit on their own lines. Values are inserted verbatim and never
 * re-parsed, so `{{…}}` in a comment stays as written.
 */
export const render = (template: string, view: View): string =>
  template
    .split(/(\{\{[#^](\w[\w.]*)\}\}\n?[\s\S]*?\{\{\/\2\}\}\n?)/)
    .map((part, i, parts) => {
      if (i % 3 === 2) return "";
      if (i % 3 === 0) return part.replace(/\{\{(\w[\w.]*)\}\}/g, (_, name) => String(lookup(view, name) ?? ""));
      const name = parts[i + 1];
      const [, kind, inner] = part.match(/^\{\{([#^])[\w.]+\}\}\n?([\s\S]*?)\{\{\/[\w.]+\}\}\n?$/)!;
      const value = lookup(view, name);
      if (kind === "^") return truthy(value) ? "" : render(inner, view);
      if (!truthy(value)) return "";
      return Array.isArray(value) ? value.map((item) => render(inner, { ...view, ...item })).join("") : render(inner, view);
    })
    .join("");
