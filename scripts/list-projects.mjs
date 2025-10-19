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

const client = axios.create({
  baseURL: "https://gitlab.com/api/v4",
  headers: { "PRIVATE-TOKEN": token }
});

const projects = [];
let page = 1;

try {
  while (true) {
    const params = {
      membership: true,
      per_page: 100,
      page
    };
    const res = await client.get("/projects", { params });
    const data = Array.isArray(res.data) ? res.data : [];
    if (!data.length) break;
    projects.push(...data);
    const next = res.headers["x-next-page"];
    if (!next || next === "0") break;
    page = Number(next);
  }

  if (!projects.length) {
    console.log("No projects returned.");
    process.exit(0);
  }

  for (const project of projects) {
    console.log(`${project.id}\t${project.name_with_namespace}`);
  }
} catch (err) {
  console.error("Failed to fetch projects:", err?.response?.data || err.message);
  process.exit(1);
}
