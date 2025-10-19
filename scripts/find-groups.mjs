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

const query = process.argv[2] || "Aquarious Technology";

const client = axios.create({
  baseURL: "https://gitlab.com/api/v4",
  headers: { "PRIVATE-TOKEN": token }
});

try {
  const res = await client.get("/groups", {
    params: { search: query, per_page: 100 }
  });
  if (!Array.isArray(res.data) || !res.data.length) {
    console.log(`No groups found for search: ${query}`);
    process.exit(0);
  }
  for (const group of res.data) {
    console.log(`${group.id}\t${group.full_path}\t${group.name}`);
  }
} catch (err) {
  console.error("Failed to lookup groups:", err?.response?.data || err.message);
  process.exit(1);
}
