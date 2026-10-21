import { http } from "../http.ts";
import type { Data, Operation } from "./operations.ts";

export const RAILWAY_API = "https://backboard.railway.com/graphql/v2";

export class RailwayError extends Error {}

type GraphQLResponse = { data?: Data; errors?: { message: string }[] };

export class RailwayTransport {
  constructor(
    private readonly token: string,
    readonly endpoint = RAILWAY_API,
  ) {}

  async call<Vars, Result>(operation: Operation<Vars, Result>, variables: Vars) {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ query: operation.document, variables }),
    });
    const text = await res.text();
    let answer: GraphQLResponse;
    try {
      answer = JSON.parse(text);
    } catch {
      throw new RailwayError(`Railway: ${res.status} ${http.excerpt(text)}`);
    }
    const { data, errors } = answer;
    if (errors?.length || !data) throw new RailwayError(`Railway: ${errors?.map((e) => e.message).join("; ") ?? res.status}`);
    return operation.pick(data);
  }
}
