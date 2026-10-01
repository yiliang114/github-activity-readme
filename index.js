const core = require("@actions/core");
const { getOctokit } = require("@actions/github");
const fs = require("fs");
const { spawn } = require("child_process");

// Get config
const GH_USERNAME = core.getInput("GH_USERNAME");
const COMMIT_NAME = core.getInput("COMMIT_NAME");
const COMMIT_EMAIL = core.getInput("COMMIT_EMAIL");
const COMMIT_MSG = core.getInput("COMMIT_MSG");
const MAX_LINES = parseInt(core.getInput("MAX_LINES"), 10);
const TARGET_FILE = core.getInput("TARGET_FILE");
const EMPTY_COMMIT_MSG = core.getInput("EMPTY_COMMIT_MSG");
const FILTER_EVENTS = core.getInput("FILTER_EVENTS");
const TIMEZONE = core.getInput("TIMEZONE");
const SUMMARY_DAYS = parseInt(core.getInput("SUMMARY_DAYS"), 10);
const DRY_RUN = core.getInput("DRY_RUN") === "true";

const START_MARKER = "<!--START_SECTION:activity-->";
const END_MARKER = "<!--END_SECTION:activity-->";
const TITLE_MAX_LENGTH = 72;

/**
 * Escapes characters that would break the markdown link/text
 * @param {String} str - the string
 *
 * @returns {String}
 */
const escapeMarkdown = (str) => str.replace(/([\\`*_[\]<>|])/g, "\\$1");

/**
 * Shortens long titles so each entry stays on one line
 * @param {String} title - the title
 *
 * @returns {String}
 */
const truncate = (title) =>
  title.length > TITLE_MAX_LENGTH
    ? `${title.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…`
    : title;

/**
 * Formats a timestamp as `MM-DD HH:mm` in the configured timezone
 * @param {String} iso - ISO timestamp
 *
 * @returns {String}
 */
const formatTime = (iso) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TIMEZONE,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(iso))
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
};

/**
 * Returns a markdown link to the repo, labelled without the owner
 * @param {String} fullName - e.g. QwenLM/qwen-code
 *
 * @returns {String}
 */
const repoLink = (fullName) =>
  `[${fullName.split("/")[1]}](https://github.com/${fullName})`;

/**
 * Execute shell command
 * @param {String} cmd - root command
 * @param {String[]} args - args to be passed along with
 *
 * @returns {Promise<void>}
 */

const exec = (cmd, args = []) =>
  new Promise((resolve, reject) => {
    const app = spawn(cmd, args);

    let stdout = "";
    if (app.stdout) {
      app.stdout.on("data", (data) => {
        stdout += data.toString();
      });
    }

    let stderr = "";
    if (app.stderr) {
      app.stderr.on("data", (data) => {
        stderr += data.toString();
      });
    }

    app.on("close", (code) => {
      if (code !== 0 && !stdout.includes("nothing to commit")) {
        return reject(new Error(`Exit code: ${code}\n${stdout}`));
      }
      return resolve(stdout);
    });

    app.on("error", () => reject(new Error(`Exit code: ${code}\n${stderr}`)));
  });

/**
 * Make a commit
 *
 * @returns {Promise<void>}
 */

const commitFile = async (emptyCommit = false) => {
  await exec("git", ["config", "--global", "user.email", COMMIT_EMAIL]);
  await exec("git", ["config", "--global", "user.name", COMMIT_NAME]);
  if (emptyCommit) {
    await exec("git", ["commit", "--allow-empty", "-m", EMPTY_COMMIT_MSG]);
  } else {
    await exec("git", ["add", TARGET_FILE]);
    await exec("git", ["commit", "-m", COMMIT_MSG]);
  }
  await exec("git", ["push"]);
};

/**
 * Creates an empty commit if no activity has been detected for over 50 days
 * @returns {Promise<void>}
 * */
const createEmptyCommit = async () => {
  const lastCommitDate = await exec("git", [
    "--no-pager",
    "log",
    "-1",
    "--format=%ct",
  ]);

  const commitDate = new Date(parseInt(lastCommitDate, 10) * 1000);
  const diffInDays = Math.round(
    (new Date() - commitDate) / (1000 * 60 * 60 * 24),
  );

  core.debug(`Last commit date: ${commitDate}`);
  core.debug(`Difference in days: ${diffInDays}`);

  if (diffInDays > 50) {
    core.info("Create empty commit to keep workflow active");
    await commitFile(true);
    return "Empty commit pushed";
  }

  return "No matching events found. Leaving README unchanged with previous activity";
};

// Emoji and verb per event state; states not listed here are skipped
const STATES = {
  "PullRequestEvent:opened": ["🔀", "Opened PR"],
  "PullRequestEvent:reopened": ["🔀", "Reopened PR"],
  "PullRequestEvent:merged": ["🟣", "Merged PR"],
  "IssuesEvent:opened": ["📝", "Opened issue"],
  "IssuesEvent:reopened": ["🔓", "Reopened issue"],
  "IssuesEvent:closed": ["✅", "Closed issue"],
  "IssueCommentEvent:created": ["💬", "Commented on"],
  "ReleaseEvent:published": ["🚀", "Released"],
};

/**
 * Normalises an event into { key, state, number, url, title, repo, time },
 * fetching the PR when the event payload lacks its title or merge state
 * @param {Object} octokit
 * @param {Object} event
 *
 * @returns {Promise<Object | null>}
 */
const toEntry = async (octokit, event) => {
  const { payload, repo } = event;
  const [owner, name] = repo.name.split("/");
  let action = payload.action;
  let number, url, title;

  if (event.type === "PullRequestEvent") {
    number = payload.pull_request.number;
    url = `https://github.com/${repo.name}/pull/${number}`;
    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo: name,
      pull_number: number,
    });
    title = pr.title;
    if (action === "closed" && pr.merged_at) action = "merged";
  } else if (event.type === "ReleaseEvent") {
    number = payload.release.tag_name;
    url = payload.release.html_url;
    title = payload.release.name || payload.release.tag_name;
  } else {
    number = payload.issue.number;
    url = payload.comment ? payload.comment.html_url : payload.issue.html_url;
    title = payload.issue.title;
  }

  const state = STATES[`${event.type}:${action}`];
  if (!state) return null;

  return {
    key: `${repo.name}#${number}`,
    state,
    number,
    url,
    title,
    repo: repo.name,
    time: event.created_at,
  };
};

/**
 * Renders one activity line
 * @param {Object} entry
 *
 * @returns {String}
 */
const serialize = ({ state, number, url, title, repo, time }) => {
  const [emoji, verb] = state;
  const label = typeof number === "number" ? `#${number}` : number;
  return `${emoji} ${verb} [${label}](${url}) ${escapeMarkdown(
    truncate(title),
  )} · ${repoLink(repo)} · \`${formatTime(time)}\``;
};

/**
 * Builds the per-repo summary of PRs merged in the last SUMMARY_DAYS days
 * @param {Object} octokit
 *
 * @returns {Promise<String | null>}
 */
const buildSummary = async (octokit) => {
  if (!SUMMARY_DAYS) return null;

  const since = new Date(Date.now() - SUMMARY_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const items = await octokit.paginate(
    octokit.rest.search.issuesAndPullRequests,
    {
      q: `author:${GH_USERNAME} is:pr is:merged is:public merged:>=${since}`,
      per_page: 100,
    },
  );
  if (!items.length) return null;

  const counts = {};
  for (const { repository_url } of items) {
    const fullName = repository_url.split("/repos/")[1];
    counts[fullName] = (counts[fullName] || 0) + 1;
  }
  const repos = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([fullName, count]) => `${repoLink(fullName)} ${count}`)
    .join(" · ");

  return `> 🟣 **${items.length}** PRs merged in the last ${SUMMARY_DAYS} days — ${repos}`;
};

const run = async () => {
  try {
    const token = process.env.GITHUB_TOKEN;

    if (!token) {
      core.setFailed("GITHUB_TOKEN is required to fetch activity.");
      return;
    }

    const octokit = getOctokit(token);
    const allowed = FILTER_EVENTS.split(",").map((type) => type.trim());

    // The events API returns at most 300 events, newest first
    core.debug(`Getting activity for ${GH_USERNAME}`);
    const events = await octokit.paginate(
      octokit.rest.activity.listPublicEventsForUser,
      { username: GH_USERNAME, per_page: 100 },
    );
    core.debug(`Activity for ${GH_USERNAME}, ${events.length} events found.`);

    // Keep only the latest state of each PR/issue
    const seen = new Set();
    const entries = [];
    for (const event of events) {
      if (entries.length >= MAX_LINES) break;
      if (!allowed.includes(event.type)) continue;
      const entry = await toEntry(octokit, event);
      if (!entry || seen.has(entry.key)) continue;
      seen.add(entry.key);
      entries.push(entry);
    }

    const readmeContent = fs.readFileSync(`./${TARGET_FILE}`, "utf-8");
    const startIdx = readmeContent.indexOf(START_MARKER);
    const endIdx = readmeContent.indexOf(END_MARKER);

    if (startIdx === -1) {
      core.setFailed(`Couldn't find the ${START_MARKER} comment. Exiting!`);
      return;
    }

    if (entries.length === 0) {
      core.info("Found no activity.");

      try {
        const message = await createEmptyCommit();
        core.info(message);
      } catch (err) {
        core.setFailed(err.message);
      }
      return;
    }

    const summary = await buildSummary(octokit);
    const lines = entries.map(
      (entry, idx) => `${idx + 1}. ${serialize(entry)}`,
    );
    const section = [summary, summary && "", ...lines]
      .filter((line) => line !== null)
      .join("\n");

    const before = readmeContent.slice(0, startIdx + START_MARKER.length);
    const after =
      endIdx === -1
        ? `\n${END_MARKER}\n${readmeContent.slice(startIdx + START_MARKER.length)}`
        : readmeContent.slice(endIdx);
    const updated = `${before}\n\n${section}\n\n${after.trimStart()}`;

    if (updated === readmeContent) {
      core.info("No changes detected");
      return;
    }

    fs.writeFileSync(`./${TARGET_FILE}`, updated);
    core.info(`Updated ${TARGET_FILE} with the recent activity`);

    if (DRY_RUN) {
      core.info("DRY_RUN is set, skipping commit");
      return;
    }

    // Commit to the remote repository
    try {
      await commitFile();
    } catch (err) {
      core.setFailed(err.message);
      return;
    }
    core.info("Pushed to remote repository");
  } catch (error) {
    core.setFailed(error.message);
  }
};

run();
