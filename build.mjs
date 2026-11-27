import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "fs";
const out = "dom3d/app/www";
mkdirSync(out, { recursive: true });
const common = { bundle: true, minify: true, target: "es2020", legalComments: "none", logLevel: "info" };
await esbuild.build({ ...common, entryPoints: ["frontend/src/panel.js"], outfile: `${out}/panel.js`, format: "iife" });
await esbuild.build({ ...common, entryPoints: ["frontend/src/card.js"], outfile: `${out}/dom3d-card.js`, format: "esm" });
copyFileSync("frontend/index.html", `${out}/index.html`);
