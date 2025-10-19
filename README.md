# GitLab -> Discord Daily Velocity Report
1) Add repo CI Variables: DISCORD_WEBHOOK_URL, GITLAB_TOKEN, GITLAB_PROJECT_IDS (and optional GitHub variables below).
2) Create a Schedule in CI/CD -> Schedules to run daily.
3) The job posts a formatted message to your Discord channel.

## Auto-Discovery

Set:

DISCOVER_MODE=group  
GROUP_IDS=<your group ids>  
INCLUDE_SUBGROUPS=true

Optional filters: ARCHIVED=false, VISIBILITY=, NAME_INCLUDE_REGEX=, NAME_EXCLUDE_REGEX=  
You can still force include/exclude via EXTRA_PROJECT_IDS / EXCLUDE_PROJECT_IDS.

**Aquarious Technology only**
- Set DISCOVER_MODE=user
- Set USER_ID=2054295
- Optionally pin to the namespace label with NAME_INCLUDE_REGEX=^Aquarious Technology /

### GitHub Auto-Discovery

Set:

GITHUB_TOKEN=<your github personal access token>  
GITHUB_DISCOVER_MODE=org  
GITHUB_ORGS=<org handles, optional>  
GITHUB_USER=<username when using user/mixed discovery>

You can also provide a static list via `GITHUB_REPOS=owner/repo,owner/repo`, and refine with `GITHUB_REPO_INCLUDE_REGEX`, `GITHUB_REPO_EXCLUDE_REGEX`, `GITHUB_EXTRA_REPOS`, and `GITHUB_EXCLUDE_REPOS`.

Add the GitHub variables alongside your GitLab secrets under **Settings -> CI/CD -> Variables**.

### How to get your Group ID (once)

In GitLab, open your Group -> Settings -> General -> you’ll see Group ID.  
Or API: GET /groups?search=<group_path> and read id.  
Set it once in CI/CD variables: GROUP_IDS=123456 (comma-separate if you have multiple top-level groups).

## Daily Schedule
The pipeline runs every day at **9:30 PM IST** and posts the summary for "today's" work to Discord.

GitLab schedule settings:
- **Cron:** 30 21 * * *
- **Time zone:** Asia/Kolkata
- **WINDOW_MODE:** TODAY
- **REPORT_TZ:** Asia/Kolkata

You can adjust this anytime under **CI/CD -> Schedules**.

### GitHub Actions (alternative scheduler)

If you prefer GitHub Actions to run the report:

1. Push the repo to GitHub, then open **Settings → Secrets and variables → Actions → New repository secret** and add the same variables listed above. Use `GITHUB_TOKEN_SECRET` for your PAT (GitHub reserves the name `GITHUB_TOKEN`).
2. The workflow in `.github/workflows/daily-report.yml` is already configured to run daily at 21:30 IST (`cron: "0 16 * * *"`).
3. You can trigger it manually from the **Actions** tab using the “Daily Velocity Report” workflow.

The workflow installs dependencies, writes `.env` from the secrets, and executes `npm run report`, delivering the Discord update automatically.

