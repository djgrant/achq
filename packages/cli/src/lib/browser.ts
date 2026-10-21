import { subprocess } from "@achq/utils/subprocess";

export const openInBrowser = async (url: string) => subprocess.openUrl(url);
