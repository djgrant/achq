export const text = (body: string, status = 200) => new Response(body, { status });
export const json = (value: unknown, status = 200) => Response.json(value, { status });
export const noContent = () => new Response(null, { status: 204 });

/** A request body as an object, or undefined if it isn't one. */
export const parse = <T>(body: string): Partial<T> | undefined => {
  try {
    const value = JSON.parse(body);
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
};
