// Loaded via `node --import`: keep test output readable; tests that care
// about logging can reconfigure.
import { configureLog } from "../src/log.ts";

configureLog("error", "json");
