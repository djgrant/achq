/** Asks the router to wake the container. It checks you can push to the repo. */
export const wake = async (router: string, repo: string, container: string, token: string) => {
  const res = await fetch(`${router}/wake`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ repo, container }),
  });
  if (!res.ok) throw new Error(`Couldn't wake ${container}: ${res.status} ${await res.text()}`);
};
