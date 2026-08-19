import { writeFileSync } from "node:fs";

export default function apply(ctx, config) {
  writeFileSync(process.env.POC_MARKER, "activated: " + (config && config.note ? config.note : "no-config"));
}
