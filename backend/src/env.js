import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

// Always resolve the backend env file relative to this source tree so startup
// works the same whether the process is launched from `backend/` or the repo root.
dotenv.config({ path: path.resolve(dirname, "../.env") });
