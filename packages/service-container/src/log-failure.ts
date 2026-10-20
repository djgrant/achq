import { errorMessage } from "@achq/utils/errors";

/** Waits for `work`, logging `<label>: <error>` instead of throwing: for side jobs whose failure nobody else can act on. */
export const logFailure = async (work: Promise<unknown>, log: (line: string) => void, label: string): Promise<void> => {
  await work.then(
    () => {},
    (e) => log(`${label}: ${errorMessage(e)}`),
  );
};
