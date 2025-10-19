import dotenv from "dotenv";
import axios from "axios";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const rawToken = process.env.GITLAB_TOKEN || "";
const token = rawToken.replace(/^"|"$/g, "");

if (!token) {
  console.error("Missing GITLAB_TOKEN in environment.");
  process.exit(1);
}

const projectId = process.argv[2];

if (!projectId) {
  console.error("Usage: node scripts/show-project.mjs <project_id>");
  process.exit(1);
}

const client = axios.create({
  baseURL: "https://gitlab.com/api/v4",
  headers: { "PRIVATE-TOKEN": token }
});

try {
  const { data } = await client.get(`/projects/${encodeURIComponent(projectId)}`);
  console.log(JSON.stringify({
    id: data.id,
    name: data.name,
    name_with_namespace: data.name_with_namespace,
    path_with_namespace: data.path_with_namespace,
    namespace: data.namespace,
    web_url: data.web_url
  }, null, 2));
} catch (err) {
  console.error("Failed to fetch project:", err?.response?.data || err.message);
  process.exit(1);
}
