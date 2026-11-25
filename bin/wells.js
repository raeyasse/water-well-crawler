#!/usr/bin/env node
// Runs the TypeScript CLI directly via tsx so no build step is needed.
import { register } from "tsx/esm/api";

register();
await import("../src/cli/main.ts");
