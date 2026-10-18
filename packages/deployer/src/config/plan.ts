// Runs in the sandbox after the config, and returns the plan it registered as JSON.
import { collectPlan } from "@achq/core";

export default () => JSON.stringify(collectPlan());
