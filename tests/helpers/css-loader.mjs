// Node test loader: `import "x.css"` (side-effect stylesheet imports used by the split per-route / per-panel sheets)
// resolves to an empty module so component modules stay importable under `node --test`. Real bundling is vinext/Vite's job.
import { register } from "node:module";
register(new URL("./css-hooks.mjs", import.meta.url));
