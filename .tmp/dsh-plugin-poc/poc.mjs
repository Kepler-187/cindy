import { pathToFileURL } from "node:url";
import { boot, loadOptionalPatches } from "@deepseek-ai/dsh-app-boot";

process.env.POC_MARKER = "E:/Workshop/cindy/.tmp/dsh-plugin-poc/marker.txt";
const patches = loadOptionalPatches("poc", "E:/Workshop/cindy/.tmp/dsh-plugin-poc/cordis.patch.yml") ?? [];
const bareBase = pathToFileURL("E:/Workshop/cindy/node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/packaged-bin.js").href;
const ctx = await boot("poc", "E:/Workshop/cindy/.tmp/dsh-plugin-poc/cordis.yml", patches, undefined, bareBase);
console.log("BOOT OK");
await ctx.fiber.dispose();
console.log("DISPOSED");
