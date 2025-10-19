import axios from "axios";
import dotenv from "dotenv";
import dayjsBase from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dotenv.config();
const dayjs = dayjsBase.extend(utc).extend(timezone);

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const GITLAB_TOKEN = process.env.GITLAB_TOKEN;

if (!DISCORD_WEBHOOK_URL || !GITLAB_TOKEN) {
  console.error("Missing DISCORD_WEBHOOK_URL or GITLAB_TOKEN.");
  process.exit(1);
}

const REPORT_TZ = process.env.REPORT_TZ || "Asia/Kolkata";
const WINDOW_MODE = (process.env.WINDOW_MODE || "DAILY").toUpperCase(); // DAILY | TODAY | LAST24H
const REPORT_TITLE = process.env.REPORT_TITLE || "GitLab Engineering Team Velocity";
const ORG_LABEL_INTERNAL = process.env.ORG_LABEL_INTERNAL || "Internal";
const ORG_LABEL_CLIENT = process.env.ORG_LABEL_CLIENT || "Client";
const CLIENT_PROJECT_IDS = (process.env.CLIENT_PROJECT_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const CLIENT_PROJECT_ID_SET = new Set(
  CLIENT_PROJECT_IDS.map(id => id.toLowerCase())
);

function computeWindow() {
  const now = dayjs().tz(REPORT_TZ);
  if (WINDOW_MODE === "LAST24H") {
    return { since: now.subtract(24, "hour").toDate(), until: now.toDate(), label: "Last 24h" };
  }
  if (WINDOW_MODE === "TODAY") {
    const s = now.startOf("day"), u = now.endOf("day");
    return { since: s.toDate(), until: u.toDate(), label: s.format("MMMM D, YYYY") };
  }
  const s = now.subtract(1, "day").startOf("day");
  const u = now.subtract(1, "day").endOf("day");
  return { since: s.toDate(), until: u.toDate(), label: s.format("MMMM D, YYYY") };
}

const gitlab = axios.create({
  baseURL: "https://gitlab.com/api/v4",
  headers: { "PRIVATE-TOKEN": GITLAB_TOKEN }
});

const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || "").trim();
const github = GITHUB_TOKEN
  ? axios.create({
      baseURL: "https://api.github.com",
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        "User-Agent": "aquarious-velocity-bot",
        Accept: "application/vnd.github+json"
      }
    })
  : null;

const projectCache = new Map();
const githubRepoCache = new Map();

async function getProjectInfo(projectId) {
  const key = String(projectId);
  if (projectCache.has(key)) return projectCache.get(key);
  try {
    const { data } = await gitlab.get(`/projects/${encodeURIComponent(projectId)}`);
    projectCache.set(key, data);
    return data;
  } catch (err) {
    console.warn(`Unable to fetch project ${projectId}: ${err?.response?.status || err.message}`);
    projectCache.set(key, null);
    return null;
  }
}

function parseCsv(env) {
  return (process.env[env] || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

async function fetchAllPaged(url, params = {}) {
  const out = [];
  let page = 1;
  while (true) {
    const { data, headers } = await gitlab.get(url, { params: { per_page: 100, page, ...params } });
    out.push(...data);
    const next = headers["x-next-page"];
    if (!next || next === "0") break;
    page = Number(next);
  }
  return out;
}

function normalizeRepoName(name) {
  return (name || "").trim().toLowerCase();
}

async function fetchGithubPaged(path, params = {}, { stop } = {}) {
  if (!github) return [];
  const results = [];
  let page = 1;
  while (true) {
    const { data, headers } = await github.get(path, { params: { per_page: 100, page, ...params } });
    if (!Array.isArray(data) || data.length === 0) break;
    results.push(...data);
    if (typeof stop === "function" && stop(data)) break;
    const link = headers.link || headers.Link;
    if (!link || !link.includes('rel="next"')) break;
    page += 1;
  }
  return results;
}

async function discoverGithubRepos() {
  if (!github) return [];
  const mode = (process.env.GITHUB_DISCOVER_MODE || "org").toLowerCase(); // org | user | mixed
  const orgs = parseCsv("GITHUB_ORGS");
  const username = process.env.GITHUB_USER;
  const includeRegex = process.env.GITHUB_REPO_INCLUDE_REGEX ? new RegExp(process.env.GITHUB_REPO_INCLUDE_REGEX) : null;
  const excludeRegex = process.env.GITHUB_REPO_EXCLUDE_REGEX ? new RegExp(process.env.GITHUB_REPO_EXCLUDE_REGEX) : null;
  const extras = parseCsv("GITHUB_EXTRA_REPOS");
  const excludes = new Set(parseCsv("GITHUB_EXCLUDE_REPOS").map(normalizeRepoName));

  const repoMap = new Map();

  const includeRepo = repo => {
    if (!repo || !repo.full_name) return;
    const fullName = repo.full_name;
    const normalized = normalizeRepoName(fullName);
    if (excludes.has(normalized)) return;
    if (includeRegex && !includeRegex.test(fullName) && !includeRegex.test(repo.name)) return;
    if (excludeRegex && (excludeRegex.test(fullName) || excludeRegex.test(repo.name))) return;
    repoMap.set(normalized, fullName);
    githubRepoCache.set(normalized, repo);
  };

  if ((mode === "org" || mode === "mixed") && orgs.length) {
    for (const org of orgs) {
      try {
        const repos = await fetchGithubPaged(`/orgs/${org}/repos`, { type: "all", sort: "updated" });
        repos.forEach(includeRepo);
      } catch (err) {
        console.warn(`Unable to fetch GitHub org repos for ${org}:`, err?.response?.status || err.message);
      }
    }
  }

  if (mode === "user" || mode === "mixed") {
    try {
      if (username) {
        const repos = await fetchGithubPaged(`/users/${username}/repos`, { type: "all", sort: "updated" });
        repos.forEach(includeRepo);
      } else {
        const repos = await fetchGithubPaged("/user/repos", {
          affiliation: "owner,collaborator,organization_member",
          sort: "updated",
          direction: "desc"
        });
        repos.forEach(includeRepo);
      }
    } catch (err) {
      console.warn("Unable to fetch GitHub user repos:", err?.response?.status || err.message);
    }
  }

  for (const extra of extras) {
    const normalized = normalizeRepoName(extra);
    if (!extra || excludes.has(normalized)) continue;
    repoMap.set(normalized, extra);
  }

  for (const excluded of excludes) {
    repoMap.delete(excluded);
    githubRepoCache.delete(excluded);
  }

  return [...repoMap.values()];
}

async function discoverProjects() {
  const mode = (process.env.DISCOVER_MODE || "group").toLowerCase(); // group | user | mixed
  const includeSubgroups = String(process.env.INCLUDE_SUBGROUPS || "true").toLowerCase() === "true";
  const archived = (process.env.ARCHIVED || "false").toLowerCase() === "true";
  const visibility = (process.env.VISIBILITY || "").toLowerCase(); // '', 'public', 'internal', 'private'
  const nameInc = process.env.NAME_INCLUDE_REGEX ? new RegExp(process.env.NAME_INCLUDE_REGEX) : null;
  const nameExc = process.env.NAME_EXCLUDE_REGEX ? new RegExp(process.env.NAME_EXCLUDE_REGEX) : null;

  const groupIds = parseCsv("GROUP_IDS");
  const userId = process.env.USER_ID;

  let projects = [];

  if (mode === "group" || mode === "mixed") {
    for (const gid of groupIds) {
      const gp = await fetchAllPaged(`/groups/${encodeURIComponent(gid)}/projects`, {
        include_subgroups: includeSubgroups,
        archived,
        simple: true,
        ...(visibility ? { visibility } : {})
      });
      projects.push(...gp);
    }
  }

  if ((mode === "user" || mode === "mixed") && userId) {
    const up = await fetchAllPaged(`/users/${encodeURIComponent(userId)}/projects`, {
      membership: true,
      archived,
      simple: true,
      ...(visibility ? { visibility } : {})
    });
    projects.push(...up);
  }

  let uniq = new Map();
  for (const p of projects) uniq.set(p.id, p);

  const filtered = [...uniq.values()].filter(p => {
    const nameTarget = p.name_with_namespace || p.path_with_namespace || "";
    const pathTarget = p.path_with_namespace || "";
    if (nameInc && !nameInc.test(nameTarget) && !nameInc.test(pathTarget)) return false;
    if (nameExc && (nameExc.test(nameTarget) || nameExc.test(pathTarget))) return false;
    return true;
  });

  uniq = new Map(filtered.map(p => [p.id, p]));
  for (const p of uniq.values()) {
    projectCache.set(String(p.id), p);
  }
  const extras = parseCsv("EXTRA_PROJECT_IDS").map(Number);
  const excludes = new Set(parseCsv("EXCLUDE_PROJECT_IDS").map(Number));
  for (const id of extras) if (!excludes.has(id)) uniq.set(id, { id });
  for (const id of excludes) uniq.delete(id);

  return [...uniq.keys()].map(String);
}

function resolveAuthorName(entry) {
  if (!entry) return "Unknown";
  return entry.author?.name ||
    entry.author?.username ||
    entry.author_name ||
    entry.author_email ||
    entry.author?.email ||
    "Unknown";
}

function groupItemsByAuthor(items) {
  const map = new Map();
  for (const item of items) {
    const key = resolveAuthorName(item);
    map.set(key, (map.get(key) || 0) + 1);
  }
  return map;
}

function groupCommitsByAuthor(commits) {
  return [...groupItemsByAuthor(commits).entries()].sort((a, b) => b[1] - a[1]);
}

function isGithubProjectId(id) {
  return String(id).includes("/");
}

function formatCount(n) {
  const num = Number(n) || 0;
  return num.toLocaleString("en-US");
}

function formatTable(rows) {
  if (!rows.length) return "";
  const widths = [];
  rows.forEach(row => {
    row.forEach((cell, idx) => {
      const text = String(cell);
      widths[idx] = Math.max(widths[idx] || 0, text.length);
    });
  });
  const lines = rows.map(row =>
    row.map((cell, idx) => {
      const text = String(cell);
      if (idx === row.length - 1) return text;
      const pad = widths[idx] - text.length;
      return text + " ".repeat(pad + 2);
    }).join("")
  );
  return `\`\`\`text\n${lines.join("\n")}\n\`\`\``;
}

function formatTeamMetrics({
  organizationSummary,
  totalMRMerged,
  totalMROpened,
  totalCommits,
  totalIssuesOpened,
  totalIssuesClosed,
  totalIssuesOpenedMonth,
  totalIssuesClosedMonth,
  activeRepos,
  contributors
}) {
  const rows = [
    ["Organizations", organizationSummary],
    ["PRs Merged", formatCount(totalMRMerged)],
    ["PRs Opened", formatCount(totalMROpened)],
    ["Commits", formatCount(totalCommits)],
    ["Issues Opened (day)", formatCount(totalIssuesOpened)],
    ["Issues Closed (day)", formatCount(totalIssuesClosed)],
    ["Issues Opened (month)", formatCount(totalIssuesOpenedMonth)],
    ["Issues Closed (month)", formatCount(totalIssuesClosedMonth)],
    ["Active Repos", formatCount(activeRepos)],
    ["Contributors", formatCount(contributors)]
  ];
  return [
    "**⚙️ Team Metrics**",
    "_Totals combine GitLab + GitHub repositories_",
    formatTable(rows)
  ].join("\n");
}

function buildMemberSummaries({ commits, mrsMerged, mrsOpened, issuesOpened, issuesClosed }) {
  const totalCommits = commits.length;
  const members = new Map();

  const ensure = name => {
    if (!members.has(name)) {
      members.set(name, {
        name,
        commits: 0,
        commitPct: 0,
        mergedMrs: 0,
        openedMrs: 0,
        issuesOpened: 0,
        issuesClosed: 0
      });
    }
    return members.get(name);
  };

  for (const commit of commits) {
    const name = resolveAuthorName(commit);
    const entry = ensure(name);
    entry.commits += 1;
  }

  for (const mr of mrsMerged) {
    const name = resolveAuthorName(mr);
    const entry = ensure(name);
    entry.mergedMrs += 1;
  }

  for (const mr of mrsOpened) {
    const name = resolveAuthorName(mr);
    const entry = ensure(name);
    entry.openedMrs += 1;
  }

  for (const issue of issuesOpened) {
    const name = resolveAuthorName(issue);
    const entry = ensure(name);
    entry.issuesOpened += 1;
  }

  for (const issue of issuesClosed) {
    const name = resolveAuthorName(issue);
    const entry = ensure(name);
    entry.issuesClosed += 1;
  }

  const summaries = [...members.values()];
  summaries.forEach(entry => {
    entry.commitPct = totalCommits ? Math.round((entry.commits / totalCommits) * 100) : 0;
  });

  return summaries.sort((a, b) => {
    if (b.mergedMrs !== a.mergedMrs) return b.mergedMrs - a.mergedMrs;
    if (b.commits !== a.commits) return b.commits - a.commits;
    if (b.issuesClosed !== a.issuesClosed) return b.issuesClosed - a.issuesClosed;
    return a.name.localeCompare(b.name);
  });
}

function formatTeamMembers(members, heading = "**Team Members**") {
  const lines = [];
  if (heading) lines.push(heading);
  if (!members.length) {
    lines.push("_No member activity captured in this window._");
    return lines.join("\n");
  }
  lines.push("*Active Today*");
  const top = members.slice(0, 5);
  for (const member of top) {
    const parts = [];
    if (member.commits) {
      const pct = member.commitPct ? ` (${member.commitPct}%)` : "";
      parts.push(`🧾 ${formatCount(member.commits)} commit${member.commits === 1 ? "" : "s"}${pct}`);
    }
    if (member.openedMrs) {
      parts.push(`📝 ${formatCount(member.openedMrs)} PR${member.openedMrs === 1 ? "" : "s"} opened`);
    }
    if (member.mergedMrs) {
      parts.push(`✅ ${formatCount(member.mergedMrs)} PR${member.mergedMrs === 1 ? "" : "s"} merged`);
    }
    if (member.issuesOpened) {
      parts.push(`➕ ${formatCount(member.issuesOpened)} issue${member.issuesOpened === 1 ? "" : "s"} opened`);
    }
    if (member.issuesClosed) {
      parts.push(`✔️ ${formatCount(member.issuesClosed)} issue${member.issuesClosed === 1 ? "" : "s"} closed`);
    }
    if (!parts.length) parts.push("MR participation");
    lines.push(`• **${member.name}** — ${parts.join(" | ")}`);
  }
  if (members.length > top.length) {
    const remaining = members.length - top.length;
    lines.push(`• ...and ${remaining} more active contributor${remaining === 1 ? "" : "s"}`);
  }
  return lines.join("\n");
}

function formatOrgSummary(label, projects) {
  if (!projects.length) return null;
  const lines = [`**📂 ${label}**`];
  const sorted = [...projects].sort((a, b) => {
    if (b.mrsMerged.length !== a.mrsMerged.length) return b.mrsMerged.length - a.mrsMerged.length;
    if (b.commits.length !== a.commits.length) return b.commits.length - a.commits.length;
    return a.projectName.localeCompare(b.projectName);
  });
  const display = sorted.slice(0, 3);
  for (const project of display) {
    const merged = project.mrsMerged.length;
    const commits = project.commits.length;
    const issuesOpened = project.issuesOpened.length;
    const issuesClosed = project.issuesClosed.length;
    const parts = [];
    if (merged) parts.push(`PRs: ${formatCount(merged)}`);
    if (commits) parts.push(`Commits: ${formatCount(commits)}`);
    if (issuesOpened || issuesClosed) parts.push(`Issues: +${formatCount(issuesOpened)}/-${formatCount(issuesClosed)}`);
    const summary = parts.length ? parts.join(" • ") : "No activity recorded";
    const displayName = project.projectName || project.projectPath || String(project.projectId);
    const icon = isGithubProjectId(project.projectId) ? "🐙" : "🦊";
    lines.push(`${icon} ${displayName} — ${summary}`);
  }
  if (sorted.length > display.length) {
    const remaining = sorted.length - display.length;
    lines.push(`…and ${remaining} more active repo${remaining === 1 ? "" : "s"}.`);
  }
  return lines.join("\n");
}
function formatMajorFeatures(mrs) {
  if (!mrs.length) return null;
  const sorted = [...mrs].sort((a, b) => {
    const aTime = a.merged_at || a.updated_at || a.created_at;
    const bTime = b.merged_at || b.updated_at || b.created_at;
    return dayjs(bTime).valueOf() - dayjs(aTime).valueOf();
  });
  const top = sorted.slice(0, 5);
  const lines = ["**✨ Major Features Shipped**"];
  for (const mr of top) {
    const title = mr.title || `Merge Request #${mr.iid || mr.id || "?"}`;
    const mrLink = mr.web_url ? `[${title}](${mr.web_url})` : title;
    const project = mr.projectName ? ` (${mr.projectName})` : "";
    lines.push(`• ${mrLink}${project}`);
  }
  return lines.join("\n");
}

function formatBugActivity(issuesOpened, issuesClosed) {
  const sameDay = issuesClosed.filter(issue => {
    if (!issue.closed_at || !issue.created_at) return false;
    const diffHours = dayjs(issue.closed_at).diff(dayjs(issue.created_at), "hour", true);
    return diffHours <= 24;
  }).length;

  const fixedCount = issuesClosed.length;
  const openedCount = issuesOpened.length;
  const sameDayValue = fixedCount
    ? `${formatCount(sameDay)}/${formatCount(fixedCount)}`
    : "0";

  const rows = [
    ["Fixed", `${formatCount(fixedCount)} issue${fixedCount === 1 ? "" : "s"}`],
    ["Same-day fixes", sameDayValue],
    ["Opened", `${formatCount(openedCount)} issue${openedCount === 1 ? "" : "s"}`]
  ];

  const lines = ["**🐛 Bug Activity**", formatTable(rows)];

  const highlights = issuesClosed.slice(0, 3);
  if (highlights.length) {
    lines.push("**Highlights**");
    highlights.forEach(issue => {
      const title = issue.title || `Issue #${issue.iid || issue.id || "?"}`;
      lines.push(`• ${title}`);
    });
  } else if (!fixedCount && !openedCount) {
    lines.push("_No bug activity recorded in this window._");
  }
  return lines.join("\n");
}

function formatVelocityHighlights({
  totalMRMerged,
  totalMROpened,
  totalCommits,
  totalIssuesClosed,
  mrsMerged,
  hasMultiOrg
}) {
  if (!totalMRMerged && !totalCommits && !totalIssuesClosed) return null;
  const lines = ["**🚀 Velocity Highlights**"];
  const denominator = totalMROpened || totalMRMerged || 1;
  const mergeRate = Math.round((totalMRMerged / denominator) * 100);
  lines.push(`• Merge rate: ${mergeRate}%`);
  if (totalCommits) lines.push(`• Commits: ${formatCount(totalCommits)}`);
  if (totalIssuesClosed) lines.push(`• Issues closed: ${formatCount(totalIssuesClosed)}`);
  if (hasMultiOrg) lines.push("• Multi-org delivery 💼");

  const durations = mrsMerged
    .filter(mr => mr.merged_at && mr.created_at)
    .map(mr => Math.abs(dayjs(mr.merged_at).diff(dayjs(mr.created_at), "hour", true)))
    .sort((a, b) => a - b);
  if (durations.length) {
    const mid = Math.floor(durations.length / 2);
    const median = durations.length % 2 ? durations[mid] : (durations[mid - 1] + durations[mid]) / 2;
    const label = median <= 24 ? "Fast turnaround" : "Median merge time";
    const hours = median.toFixed(1);
    lines.push(`• ${label}: ${hours}h`);
  }

  return lines.join("\n");
}

function formatCommitBreakdown(members, totalCommits) {
  if (!totalCommits) return null;
  const rows = [
    ["Contributor", "Commits", "%"],
    ["-----------", "-------", "--"]
  ];
  const top = members.filter(m => m.commits).slice(0, 8);
  for (const member of top) {
    const pct = member.commitPct ? `${member.commitPct}%` : "0%";
    rows.push([member.name, String(member.commits), pct]);
  }
  rows.push(["TOTAL", String(totalCommits), "100%"]);
  return ["**Commit Breakdown**", formatTable(rows)].join("\n");
}

function formatRepoTable(projects, totals) {
  if (!projects.length) return null;
  const rows = [
    ["Repo", "PRs", "Commits"],
    ["----", "---", "-------"]
  ];
  const sorted = [...projects].sort((a, b) => {
    if (b.mrsMerged.length !== a.mrsMerged.length) return b.mrsMerged.length - a.mrsMerged.length;
    if (b.commits.length !== a.commits.length) return b.commits.length - a.commits.length;
    return a.projectName.localeCompare(b.projectName);
  });
  for (const project of sorted.slice(0, 10)) {
    rows.push([
      project.projectName,
      String(project.mrsMerged.length),
      String(project.commits.length)
    ]);
  }
  rows.push(["TOTAL", String(totals.totalMRMerged), String(totals.totalCommits)]);
  return ["**📊 By Repository (Top 10)**", formatTable(rows)].join("\n");
}

function formatInactiveSummary(projects) {
  if (!projects.length) return null;
  return `_ℹ️ No tracked activity in ${projects.length} repo${projects.length === 1 ? "" : "s"} this window._`;
}

function chunkMessage(text, limit = 1800) {
  const chunks = [];
  if (!text) {
    return chunks;
  }
  const lines = text.split("\n");
  let current = "";
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = "";
    }
    if (line.length <= limit) {
      current = line;
    } else {
      let index = 0;
      while (index < line.length) {
        chunks.push(line.slice(index, index + limit));
        index += limit;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function postMessageBlocks(blocks) {
  const content = blocks.filter(Boolean).join("\n\n").trim();
  if (!content) return;
  const chunks = chunkMessage(content);
  for (const chunk of chunks) {
    if (chunk.trim()) {
      await axios.post(DISCORD_WEBHOOK_URL, { content: chunk });
    }
  }
}

async function collectForProject(projectId, since, until, monthStart) {
  const sinceISO = dayjs(since).toISOString();
  const untilISO = dayjs(until).toISOString();
  const monthStartISO = dayjs(monthStart).toISOString();
  const monthStartMoment = dayjs(monthStart);
  const sinceMoment = dayjs(since);
  const untilMoment = dayjs(until);

  const commits = await fetchAllPaged(`/projects/${encodeURIComponent(projectId)}/repository/commits`, {
    since: sinceISO,
    until: untilISO,
    all: true // include commits across all branches
  });

  const mrsUpdated = await fetchAllPaged(`/projects/${encodeURIComponent(projectId)}/merge_requests`, {
    updated_after: sinceISO, scope: "all"
  });
  const mrsOpened = mrsUpdated.filter(mr =>
    dayjs(mr.created_at).isAfter(dayjs(since)) &&
    dayjs(mr.created_at).isBefore(dayjs(until))
  );
  const mrsMerged = mrsUpdated.filter(mr =>
    mr.state === "merged" && mr.merged_at &&
    dayjs(mr.merged_at).isAfter(sinceMoment) &&
    dayjs(mr.merged_at).isBefore(untilMoment)
  );

  const issuesUpdated = await fetchAllPaged(`/projects/${encodeURIComponent(projectId)}/issues`, {
    updated_after: monthStartISO, scope: "all"
  });
  const issuesOpened = issuesUpdated.filter(iss =>
    dayjs(iss.created_at).isAfter(sinceMoment) &&
    dayjs(iss.created_at).isBefore(untilMoment)
  );
  const issuesClosed = issuesUpdated.filter(iss =>
    iss.closed_at &&
    dayjs(iss.closed_at).isAfter(sinceMoment) &&
    dayjs(iss.closed_at).isBefore(untilMoment)
  );

  const monthIssuesOpened = issuesUpdated.filter(iss =>
    !dayjs(iss.created_at).isBefore(monthStartMoment) &&
    dayjs(iss.created_at).isBefore(untilMoment)
  );
  const monthIssuesClosed = issuesUpdated.filter(iss =>
    iss.closed_at &&
    !dayjs(iss.closed_at).isBefore(monthStartMoment) &&
    dayjs(iss.closed_at).isBefore(untilMoment)
  );

  const projectInfo = await getProjectInfo(projectId);
  const projectName = projectInfo?.name || String(projectId);
  const projectPath = projectInfo?.path_with_namespace || projectName;
  const projectWebUrl = projectInfo?.web_url || null;

  const simplifyCommit = commit => ({
    id: commit.id,
    short_id: commit.short_id,
    title: commit.title,
    author_name: commit.author_name,
    author_email: commit.author_email,
    author: commit.author,
    created_at: commit.created_at,
    projectId,
    projectName,
    projectPath,
    projectWebUrl
  });

  const simplifyMr = mr => ({
    id: mr.id,
    iid: mr.iid,
    title: mr.title,
    author: mr.author,
    created_at: mr.created_at,
    updated_at: mr.updated_at,
    merged_at: mr.merged_at,
    web_url: mr.web_url,
    projectId,
    projectName,
    projectPath,
    projectWebUrl
  });

  const simplifyIssue = issue => ({
    id: issue.id,
    iid: issue.iid,
    title: issue.title,
    created_at: issue.created_at,
    closed_at: issue.closed_at,
    web_url: issue.web_url,
    projectId,
    projectName,
    projectPath,
    projectWebUrl
  });

  return {
    projectId,
    projectName,
    projectPath,
    projectWebUrl,
    projectInfo,
    commits: commits.map(simplifyCommit),
    mrsOpened: mrsOpened.map(simplifyMr),
    mrsMerged: mrsMerged.map(simplifyMr),
    issuesOpened: issuesOpened.map(simplifyIssue),
    issuesClosed: issuesClosed.map(simplifyIssue),
    monthIssuesOpened: monthIssuesOpened.map(simplifyIssue),
    monthIssuesClosed: monthIssuesClosed.map(simplifyIssue)
  };
}

async function fetchGithubCommits(owner, repo, sinceISO, untilISO) {
  if (!github) return [];
  const commits = [];
  let page = 1;
  while (true) {
    const { data, headers } = await github.get(`/repos/${owner}/${repo}/commits`, {
      params: { since: sinceISO, until: untilISO, per_page: 100, page }
    });
    if (!Array.isArray(data) || data.length === 0) break;
    commits.push(...data);
    const link = headers.link || headers.Link;
    if (!link || !link.includes('rel="next"')) break;
    page += 1;
  }
  return commits;
}

async function fetchGithubPulls(owner, repo, sinceMoment) {
  if (!github) return [];
  const pulls = [];
  let page = 1;
  const cutoff = dayjs(sinceMoment).valueOf();
  while (true) {
    const { data, headers } = await github.get(`/repos/${owner}/${repo}/pulls`, {
      params: { state: "all", sort: "updated", direction: "desc", per_page: 100, page }
    });
    if (!Array.isArray(data) || data.length === 0) break;
    pulls.push(...data);
    const link = headers.link || headers.Link;
    const last = data[data.length - 1];
    const lastUpdated = last ? dayjs(last.updated_at).valueOf() : null;
    if (!link || !link.includes('rel="next"')) break;
    if (lastUpdated !== null && lastUpdated < cutoff) break;
    page += 1;
  }
  return pulls;
}

async function fetchGithubIssues(owner, repo, sinceISO) {
  if (!github) return [];
  const issues = [];
  let page = 1;
  while (true) {
    const { data, headers } = await github.get(`/repos/${owner}/${repo}/issues`, {
      params: { state: "all", since: sinceISO, per_page: 100, page }
    });
    if (!Array.isArray(data) || data.length === 0) break;
    issues.push(...data.filter(item => !item.pull_request));
    const link = headers.link || headers.Link;
    if (!link || !link.includes('rel="next"')) break;
    page += 1;
  }
  return issues;
}

async function collectForGithubRepo(fullName, since, until, monthStart) {
  if (!github) return null;
  const normalized = normalizeRepoName(fullName);
  let repoInfo = githubRepoCache.get(normalized);
  if (!repoInfo) {
    try {
      const { data } = await github.get(`/repos/${fullName}`);
      repoInfo = data;
      githubRepoCache.set(normalized, data);
    } catch (err) {
      console.warn(`Unable to fetch GitHub repo ${fullName}:`, err?.response?.status || err.message);
      repoInfo = null;
    }
  }

  const [owner, repo] = fullName.split("/");
  const projectName = repoInfo?.name || repo || fullName;
  const projectPath = repoInfo?.full_name || fullName;
  const projectWebUrl = repoInfo?.html_url || `https://github.com/${fullName}`;

  const sinceISO = dayjs(since).toISOString();
  const untilISO = dayjs(until).toISOString();
  const monthStartISO = dayjs(monthStart).toISOString();
  const sinceMoment = dayjs(since);
  const untilMoment = dayjs(until);
  const monthStartMoment = dayjs(monthStart);

  const [commitsRaw, pullsRaw, issuesRaw] = await Promise.all([
    fetchGithubCommits(owner, repo, sinceISO, untilISO),
    fetchGithubPulls(owner, repo, sinceMoment),
    fetchGithubIssues(owner, repo, monthStartISO)
  ]);

  const commits = commitsRaw
    .filter(commit => {
      const date = commit.commit?.author?.date || commit.commit?.committer?.date;
      if (!date) return false;
      const ts = dayjs(date);
      return ts.isAfter(sinceMoment) && ts.isBefore(untilMoment);
    })
    .map(commit => {
      const sha = commit.sha || commit.id;
      const message = commit.commit?.message || "";
      const title = message.split("\n")[0] || message;
      const authorName =
        commit.commit?.author?.name ||
        commit.author?.login ||
        commit.commit?.committer?.name ||
        null;
      const authorEmail = commit.commit?.author?.email || commit.commit?.committer?.email || null;
      const author =
        commit.author?.login
          ? { name: commit.author.login, username: commit.author.login }
          : authorName
          ? { name: authorName, username: authorName }
          : null;
      return {
        id: sha,
        short_id: sha ? sha.substring(0, 8) : undefined,
        title,
        author_name: authorName,
        author_email: authorEmail,
        author,
        created_at: commit.commit?.author?.date || commit.commit?.committer?.date,
        projectId: projectPath,
        projectName,
        projectPath,
        projectWebUrl
      };
    });

  const pulls = pullsRaw.map(pull => {
    const author =
      pull.user?.login ? { name: pull.user.login, username: pull.user.login } : null;
    return {
      id: pull.id,
      iid: pull.number,
      title: pull.title,
      author,
      created_at: pull.created_at,
      updated_at: pull.updated_at,
      merged_at: pull.merged_at,
      web_url: pull.html_url,
      projectId: projectPath,
      projectName,
      projectPath,
      projectWebUrl
    };
  });

  const mrsOpened = pulls.filter(pull =>
    pull.created_at &&
    dayjs(pull.created_at).isAfter(sinceMoment) &&
    dayjs(pull.created_at).isBefore(untilMoment)
  );

  const mrsMerged = pulls.filter(pull =>
    pull.merged_at &&
    dayjs(pull.merged_at).isAfter(sinceMoment) &&
    dayjs(pull.merged_at).isBefore(untilMoment)
  );

  const issues = issuesRaw.map(issue => {
    const author =
      issue.user?.login ? { name: issue.user.login, username: issue.user.login } : null;
    return {
      id: issue.id,
      iid: issue.number,
      title: issue.title,
      created_at: issue.created_at,
      closed_at: issue.closed_at,
      web_url: issue.html_url,
      author,
      projectId: projectPath,
      projectName,
      projectPath,
      projectWebUrl
    };
  });

  const issuesOpened = issues.filter(issue =>
    issue.created_at &&
    dayjs(issue.created_at).isAfter(sinceMoment) &&
    dayjs(issue.created_at).isBefore(untilMoment)
  );

  const issuesClosed = issues.filter(issue =>
    issue.closed_at &&
    dayjs(issue.closed_at).isAfter(sinceMoment) &&
    dayjs(issue.closed_at).isBefore(untilMoment)
  );

  const monthIssuesOpened = issues.filter(issue =>
    issue.created_at &&
    !dayjs(issue.created_at).isBefore(monthStartMoment) &&
    dayjs(issue.created_at).isBefore(untilMoment)
  );

  const monthIssuesClosed = issues.filter(issue =>
    issue.closed_at &&
    !dayjs(issue.closed_at).isBefore(monthStartMoment) &&
    dayjs(issue.closed_at).isBefore(untilMoment)
  );

  return {
    projectId: projectPath,
    projectName,
    projectPath,
    projectWebUrl,
    projectInfo: repoInfo,
    commits,
    mrsOpened,
    mrsMerged,
    issuesOpened,
    issuesClosed,
    monthIssuesOpened,
    monthIssuesClosed
  };
}

async function main() {
  const { since, until, label } = computeWindow();
  const monthStart = dayjs().tz(REPORT_TZ).startOf("month");
  const staticGitlabIds = parseCsv("GITLAB_PROJECT_IDS");
  let gitlabProjectIds = staticGitlabIds;
  if (gitlabProjectIds.length === 0) {
    gitlabProjectIds = await discoverProjects();
  }

  const gitlabResults = gitlabProjectIds.length
    ? await Promise.all(gitlabProjectIds.map(pid => collectForProject(pid, since, until, monthStart)))
    : [];

  let githubRepos = parseCsv("GITHUB_REPOS");
  if ((!githubRepos.length) && github) {
    githubRepos = await discoverGithubRepos();
  }

  const githubResults = githubRepos.length && github
    ? (await Promise.all(
        githubRepos.map(repo => collectForGithubRepo(repo, since, until, monthStart))
      )).filter(Boolean)
    : [];

  if (!gitlabResults.length && !githubResults.length) {
    console.error("No projects discovered. Configure GitLab (GROUP_IDS/USER_ID or GITLAB_PROJECT_IDS) or GitHub (GITHUB_TOKEN with repositories).");
    process.exit(1);
  }

  const results = [...gitlabResults, ...githubResults];

  const hasActivity = project =>
    project.commits.length ||
    project.mrsOpened.length ||
    project.mrsMerged.length ||
    project.issuesOpened.length ||
    project.issuesClosed.length;

  const activeResults = results.filter(hasActivity);
  const inactiveResults = results.filter(project => !hasActivity(project));

  const totalCommits = activeResults.reduce((sum, project) => sum + project.commits.length, 0);
  const totalMROpened = activeResults.reduce((sum, project) => sum + project.mrsOpened.length, 0);
  const totalMRMerged = activeResults.reduce((sum, project) => sum + project.mrsMerged.length, 0);
  const totalIssuesOpened = activeResults.reduce((sum, project) => sum + project.issuesOpened.length, 0);
  const totalIssuesClosed = activeResults.reduce((sum, project) => sum + project.issuesClosed.length, 0);

  const allCommits = activeResults.flatMap(project => project.commits);
  const allMrsOpened = activeResults.flatMap(project => project.mrsOpened);
  const allMrsMerged = activeResults.flatMap(project => project.mrsMerged);
  const allIssuesOpened = activeResults.flatMap(project => project.issuesOpened);
  const allIssuesClosed = activeResults.flatMap(project => project.issuesClosed);
  const totalMonthIssuesOpened = results.reduce((sum, project) => sum + (project.monthIssuesOpened ? project.monthIssuesOpened.length : 0), 0);
  const totalMonthIssuesClosed = results.reduce((sum, project) => sum + (project.monthIssuesClosed ? project.monthIssuesClosed.length : 0), 0);

  const contributors = new Set(allCommits.map(resolveAuthorName));

  const isClientProject = project => CLIENT_PROJECT_ID_SET.has(String(project.projectId).toLowerCase());
  const internal = results.filter(project => !isClientProject(project));
  const client = results.filter(isClientProject);
  const internalActive = activeResults.filter(project => !isClientProject(project));
  const clientActive = activeResults.filter(isClientProject);

  const activeOrgLabels = [];
  if (internalActive.length) activeOrgLabels.push(ORG_LABEL_INTERNAL);
  if (clientActive.length) activeOrgLabels.push(ORG_LABEL_CLIENT);
  const organizationSummary = activeOrgLabels.length
    ? `${activeOrgLabels.length} (${activeOrgLabels.join(" + ")})`
    : "0 (no active orgs)";

  const summaryLine = activeResults.length
    ? `${totalMRMerged} PR${totalMRMerged === 1 ? "" : "s"} merged | ${totalCommits} commit${totalCommits === 1 ? "" : "s"} | ${totalIssuesClosed} issue${totalIssuesClosed === 1 ? "" : "s"} closed`
    : "No activity recorded in the selected window.";

  const memberSummaries = buildMemberSummaries({
    commits: allCommits,
    mrsMerged: allMrsMerged,
    mrsOpened: allMrsOpened,
    issuesOpened: allIssuesOpened,
    issuesClosed: allIssuesClosed
  });

  const teamMetricsBlock = formatTeamMetrics({
    organizationSummary,
    totalMRMerged,
    totalMROpened,
    totalCommits,
    totalIssuesOpened,
    totalIssuesClosed,
    totalIssuesOpenedMonth: totalMonthIssuesOpened,
    totalIssuesClosedMonth: totalMonthIssuesClosed,
    activeRepos: activeResults.length,
    contributors: contributors.size
  });

  const teamMembersBlock = formatTeamMembers(memberSummaries, "**Team Members Metrics**");
  const internalBlock = formatOrgSummary(ORG_LABEL_INTERNAL, internalActive);
  const clientBlock = formatOrgSummary(ORG_LABEL_CLIENT, clientActive);
  const majorFeaturesBlock = formatMajorFeatures(allMrsMerged);
  const bugActivityBlock = formatBugActivity(allIssuesOpened, allIssuesClosed);
  const velocityHighlightBlock = formatVelocityHighlights({
    totalMRMerged,
    totalMROpened,
    totalCommits,
    totalIssuesClosed,
    mrsMerged: allMrsMerged,
    hasMultiOrg: internalActive.length > 0 && clientActive.length > 0
  });
  const commitBreakdownBlock = formatCommitBreakdown(memberSummaries, totalCommits);
  const repoTableBlock = formatRepoTable(
    activeResults.length ? activeResults : results.slice(0, 8),
    { totalMRMerged, totalCommits }
  );
  const inactiveSummaryBlock = formatInactiveSummary(inactiveResults);

  const organizationalBlocks = [
    `📊 **${REPORT_TITLE} – ${label}**`,
    summaryLine,
    teamMetricsBlock,
    velocityHighlightBlock,
    bugActivityBlock
  ].filter(Boolean);

  const projectBlocks = [
    "**Project Metrics**",
    internalBlock,
    clientBlock,
    majorFeaturesBlock,
    repoTableBlock,
    inactiveSummaryBlock
  ].filter(Boolean);

  const teamBlocks = [
    teamMembersBlock,
    commitBreakdownBlock,
    `_Posted automatically by Aquarious Velocity Bot_`
  ].filter(Boolean);

  const messages = [organizationalBlocks, projectBlocks, teamBlocks].filter(blocks => blocks.length);

  if (process.env.VELOCITY_DRY_RUN === "1") {
    const summary = {
      window: label,
      totalProjects: results.length,
      projects: results.map(project => ({
        id: project.projectId,
        name: project.projectName,
        commits: project.commits.length,
        prsOpened: project.mrsOpened.length,
        prsMerged: project.mrsMerged.length,
        issuesOpened: project.issuesOpened.length,
        issuesClosed: project.issuesClosed.length,
        sampleCommits: project.commits.slice(0, 5).map(commit => ({
          id: commit.id,
          short: commit.short_id,
          author: resolveAuthorName(commit),
          created_at: commit.created_at,
          title: commit.title
        }))
      }))
    };
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  for (const blocks of messages) {
    await postMessageBlocks(blocks);
  }

  console.log(`Report posted in ${messages.length} message${messages.length === 1 ? "" : "s"}.`);
}

main().catch(err => {
  console.error("Failed:", err?.response?.data || err.message);
  process.exit(1);
});
