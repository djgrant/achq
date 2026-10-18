// The sandbox's last module: the plan the config's resources registered, as JSON.
import { collectPlan } from "@achq/core";

export default () => JSON.stringify(collectPlan());
