import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, cpSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstream = resolve(root, ".cache/vencord");
const revision = "443688b5366a4d43e9868519f48a4544cd7520d4";
const cache = "/tmp/call-recorder-npm-cache";
const run = (cmd, args, cwd = upstream) => {
    const result = spawnSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, npm_config_cache: cache, COREPACK_HOME: resolve(root, ".cache/corepack"), XDG_CACHE_HOME: resolve(root, ".cache") } });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
};
const pnpm = args => run("npx", ["--yes", "pnpm@11.9.0", ...args]);
if (!existsSync(resolve(upstream, ".git"))) {
    mkdirSync(dirname(upstream), { recursive: true });
    run("git", ["clone", "--no-checkout", "https://github.com/Vendicated/Vencord.git", upstream], root);
    run("git", ["checkout", "--detach", revision]);
}
const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: upstream, encoding: "utf8" }).stdout.trim();
if (sha !== revision) throw new Error(`Expected Vencord ${revision}; found ${sha}. Preserve local work before changing the checkout.`);
const destination = resolve(upstream, "src/userplugins/callRecorder");
// Only this script's generated copy is refreshed. Edit plugin/ in this project.
if (existsSync(destination) && !existsSync(resolve(destination, ".call-recorder-generated"))) {
    throw new Error(`Refusing to overwrite an unrecognized plugin directory: ${destination}`);
}
rmSync(destination, { recursive: true, force: true });
cpSync(resolve(root, "plugin"), destination, { recursive: true });
writeFileSync(resolve(destination, ".call-recorder-generated"), "Edit the original project's plugin/ directory.\n");
if (!existsSync(resolve(upstream, "node_modules/.modules.yaml")) || process.argv[2] === "prepare") {
    pnpm(["install", "--frozen-lockfile", "--store-dir", resolve(root, ".cache/pnpm-store")]);
}
switch (process.argv[2]) {
    case "prepare": break;
    case "typecheck": pnpm(["testTsc"]); break;
    case "watch": pnpm(["watch", "--disable-updater"]); break;
    case "build":
        pnpm(["build", "--disable-updater"]);
        mkdirSync(resolve(root, "dist"), { recursive: true });
        cpSync(resolve(upstream, "dist"), resolve(root, "dist"), { recursive: true });
        console.log(`Custom Vencord built at ${resolve(root, "dist")}`);
        break;
    default: throw new Error("Use prepare, build, typecheck, or watch");
}
