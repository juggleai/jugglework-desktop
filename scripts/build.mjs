import { execSync } from "node:child_process";

execSync("pnpm --filter @jugglework/desktop build", { stdio: "inherit" });
