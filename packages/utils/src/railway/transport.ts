import { ERROR_BODY_CHARS } from "../http.ts";
import type { Data, Operation } from "./operations.ts";

export const RAILWAY_API = "https://backboard.railway.com/graphql/v2";

export class RailwayError extends Error {}

type GraphQLResponse = { data?: Data; errors?: { message: string }[] };

const parseResponse = (status: number, text: string): GraphQLResponse => {
  try {
    return JSON.parse(text);
  } catch {
    throw new RailwayError(`Railway: ${status} ${text.slice(0, ERROR_BODY_CHARS)}`);
  }
};

const dataOf = (status: number, { data, errors }: GraphQLResponse): Data => {
  if (errors?.length || !data) throw new RailwayError(`Railway: ${errors?.map((e) => e.message).join("; ") ?? status}`);
  return data;
};

export class RailwayTransport {
  constructor(
    private readonly token: string,
    readonly endpoint = RAILWAY_API,
  ) {}

  async call<Vars, Result>(operation: Operation<Vars, Result>, variables: Vars): Promise<Result> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ query: operation.document, variables }),
    });
    const json = parseResponse(res.status, await res.text());
    return operation.pick(dataOf(res.status, json));
  }
}
