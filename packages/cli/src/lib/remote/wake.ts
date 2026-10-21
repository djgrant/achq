import type { WakeRequest } from "@achq/core";
import { http } from "@achq/utils/http";

/** Asks the router to wake the container. It checks, on the repo's host, that you can push to the repo. */
export const wake = async (router: string, request: WakeRequest, token: string) => {
  const res = await fetch(`${router}/wake`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  await http.expectOk(res, `Couldn't wake ${request.container}`);
};
