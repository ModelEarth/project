// Entry point for the standalone Goals Worker (wrangler.toml main). It exports only the
// fetch handler: the Workers runtime refuses to start a module whose other exports aren't
// handlers, such as index.js's MOUNT string ("Incorrect type for map entry 'MOUNT'").
// index.js keeps MOUNT, handleGoals and isGoalsPath for CloudRoot's worker/src/index.js,
// which imports them to mount /api/goals in its own Worker.
export { default } from "./index.js";
