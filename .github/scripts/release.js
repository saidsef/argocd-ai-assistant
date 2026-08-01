const { execSync } = require('child_process');
const fs = require('fs');

const REPO = process.env.GITHUB_REPOSITORY || 'saidsef/argocd-ai-assistant';
const SEMVER_TAG = /^v\d+\.\d+\.\d+$/;
const DRY_RUN = process.env.DRY_RUN === '1';

// Field/record separators so multi-line commit bodies survive parsing
const FIELD = '\x1f';
const RECORD = '\x1e';

function git(command, fallback = '') {
  try {
    return execSync(command, { encoding: 'utf8' }).trim();
  } catch {
    return fallback;
  }
}

// Fetch all tags from the remote
if (!DRY_RUN) {
  execSync('git fetch --tags');
}

function getAllTags() {
  const output = git('git tag --list --sort=-v:refname');
  if (!output) return [];
  return output.split('\n').map(tag => tag.trim()).filter(tag => SEMVER_TAG.test(tag));
}

// Highest released version, not the nearest reachable tag. `git describe` can
// point at an older tag on a merged branch, which then produces a tag that
// already exists.
function getLatestTag(allTags) {
  return allTags.length > 0 ? allTags[0] : 'v0.0.0';
}

function incrementVersion(version, type) {
  let [major, minor, patch] = version.replace('v', '').split('.').map(Number);
  if (type === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (type === 'minor') {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `v${major}.${minor}.${patch}`;
}

function getCommitsSinceTag(lastTag) {
  const format = `--format=%H${FIELD}%an${FIELD}%ae${FIELD}%s${FIELD}%b${RECORD}`;
  const range = lastTag === 'v0.0.0' ? '' : `${lastTag}..HEAD `;
  const output = git(`git log ${range}${format}`);
  if (!output) return [];

  return output.split(RECORD)
    .map(record => record.trim())
    .filter(record => record)
    .map(record => {
      const [hash, author, email, subject, body = ''] = record.split(FIELD);
      // Squash merges append the PR number to the subject: strip it so the
      // rendered line does not carry the same reference twice.
      const prMatch = subject.match(/\s*\(#(\d+)\)\s*$/);
      return {
        hash: hash.substring(0, 7),
        fullHash: hash,
        author,
        email,
        subject: prMatch ? subject.slice(0, prMatch.index).trim() : subject.trim(),
        body: body.trim(),
        prNumber: prMatch ? prMatch[1] : null
      };
    });
}

// Only @-mention a handle we can trust. Deriving one from a vanity address
// (said@example.com -> @said) pings an unrelated GitHub account.
function attribution(commit) {
  const noreply = (commit.email || '').match(/^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i);
  return noreply ? `@${noreply[1]}` : commit.author;
}

function getNewContributors(commits, lastTag) {
  if (lastTag === 'v0.0.0') return [];

  const oldAuthorsOutput = git(`git log --format=%ae ${lastTag}`);
  const oldAuthors = new Set(oldAuthorsOutput.split('\n').map(e => e.trim()).filter(e => e));

  const newContributors = [];
  const seenEmails = new Set();

  for (const commit of commits) {
    if (!oldAuthors.has(commit.email) && !seenEmails.has(commit.email)) {
      seenEmails.add(commit.email);
      newContributors.push({ name: commit.author, credit: attribution(commit) });
    }
  }
  return newContributors;
}

function formatCommitsForRelease(commits) {
  return commits.map(commit => {
    let line = `- ${commit.subject}`;
    if (commit.prNumber) {
      line += ` ([#${commit.prNumber}](https://github.com/${REPO}/pull/${commit.prNumber}))`;
    }
    line += ` by ${attribution(commit)} (${commit.hash})`;
    return line;
  }).join('\n');
}

// Classify from conventional commit headers rather than raw diff lines. The
// diff heuristics matched every `--- a/package.json` header and every moved
// `export`, so routine dependency bumps were published as minor or major.
function classifyVersion(commits) {
  const override = (process.env.RELEASE_TYPE || '').toLowerCase();
  if (['major', 'minor', 'patch'].includes(override)) return override;

  let releaseType = 'patch';

  for (const commit of commits) {
    const header = commit.subject.match(/^([a-zA-Z]+)(\([^)]*\))?(!)?:/);
    const breakingHeader = Boolean(header && header[3]);
    const breakingBody = /^BREAKING[ -]CHANGE:/m.test(commit.body);

    if (breakingHeader || breakingBody) return 'major';
    if (header && header[1].toLowerCase() === 'feat') releaseType = 'minor';
  }

  return releaseType;
}

function createReleaseNotes(newTag, commits, lastTag, newContributors) {
  const date = new Date().toISOString().split('T')[0];
  const compareUrl = lastTag === 'v0.0.0'
    ? `https://github.com/${REPO}/commits/${newTag}`
    : `https://github.com/${REPO}/compare/${lastTag}...${newTag}`;

  let notes = `## Release ${newTag} - ${date}

### What Changed
${formatCommitsForRelease(commits)}
`;

  if (newContributors.length > 0) {
    notes += `\n### New Contributors\n`;
    newContributors.forEach(contributor => {
      notes += `- ${contributor.credit}\n`;
    });
  }

  notes += `\n**Full Changelog**: ${compareUrl}`;
  return notes;
}

function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

// Main execution
const allTags = getAllTags();
const allTagsSet = new Set(allTags);
const lastTag = getLatestTag(allTags);
const commits = getCommitsSinceTag(lastTag);

// Nothing new since the last tag - most often a second CI run completing on an
// already released commit. Publishing here duplicates the previous release.
if (commits.length === 0) {
  console.log(`No commits since ${lastTag} - skipping release`);
  setOutput('should_release', 'false');
  process.exit(0);
}

const releaseType = classifyVersion(commits);

let newTag = incrementVersion(lastTag, releaseType);
while (allTagsSet.has(newTag)) {
  console.log(`Tag ${newTag} already exists. Recalculating...`);
  newTag = incrementVersion(newTag, 'patch');
}

const newContributors = getNewContributors(commits, lastTag);

console.log(`Creating release ${newTag} from ${lastTag} (type: ${releaseType})`);
console.log(`Found ${commits.length} commits and ${newContributors.length} new contributors`);

const releaseNotes = createReleaseNotes(newTag, commits, lastTag, newContributors);

if (DRY_RUN) {
  console.log('DRY_RUN - no tag created, no files written');
  console.log('Release notes preview:');
  console.log(releaseNotes);
  process.exit(0);
}

// Write outputs for later steps
fs.writeFileSync('new-tag.txt', newTag);
setOutput('new_tag', newTag);
setOutput('should_release', 'true');

// Create annotated tag locally (do not push yet - build first)
execSync(`git tag -a ${newTag} -m "Release ${newTag}"`);

fs.writeFileSync('release-notes.md', releaseNotes);

console.log(`Tag ${newTag} created locally`);
console.log('Release notes preview:');
console.log(releaseNotes);
