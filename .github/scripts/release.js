const { execSync } = require('child_process');
const fs = require('fs');

// Fetch all tags from the remote
execSync('git fetch --tags');

function getLatestTag() {
  try {
    return execSync('git describe --tags --abbrev=0', { encoding: 'utf8' }).trim();
  } catch {
    return 'v0.0.0';
  }
}

function getAllTags() {
  try {
    const tags = execSync('git tag', { encoding: 'utf8' }).trim().split('\n');
    return tags.filter(tag => tag.match(/^v\d+\.\d+\.\d+$/));
  } catch {
    return [];
  }
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
  const command = lastTag === 'v0.0.0'
    ? 'git log --oneline --format="%H|%an|%ae|%s"'
    : `git log ${lastTag}..HEAD --oneline --format="%H|%an|%ae|%s"`;
  try {
    const output = execSync(command, { encoding: 'utf8' }).trim();
    if (!output) return [];

    return output.split('\n').map(line => {
      const [hash, author, email, ...messageParts] = line.split('|');
      const message = messageParts.join('|');
      const prMatch = message.match(/#(\d+)/);
      return {
        hash: hash.substring(0, 7),
        fullHash: hash,
        author,
        email,
        message,
        prNumber: prMatch ? prMatch[1] : null
      };
    });
  } catch {
    return [];
  }
}

function getNewContributors(commits, lastTag) {
  try {
    const oldAuthorsCommand = lastTag === 'v0.0.0'
      ? 'echo ""'
      : `git log --format="%ae" ${lastTag}`;
    const oldAuthorsOutput = execSync(oldAuthorsCommand, { encoding: 'utf8' }).trim();
    const oldAuthors = new Set(oldAuthorsOutput.split('\n').filter(e => e));

    const newAuthors = [];
    const seenEmails = new Set();

    for (const commit of commits) {
      if (!oldAuthors.has(commit.email) && !seenEmails.has(commit.email)) {
        seenEmails.add(commit.email);
        let username = commit.email.split('@')[0];
        const plusIndex = username.indexOf('+');
        if (plusIndex !== -1) {
          username = username.substring(plusIndex + 1);
        }
        newAuthors.push({ name: commit.author, username, email: commit.email });
      }
    }
    return newAuthors;
  } catch {
    return [];
  }
}

function formatCommitsForRelease(commits) {
  if (commits.length === 0) return '- Initial release';
  return commits.map(commit => {
    let username = commit.email.split('@')[0];
    const plusIndex = username.indexOf('+');
    if (plusIndex !== -1) {
      username = username.substring(plusIndex + 1);
    }
    let line = `- ${commit.message} (${commit.hash})`;
    if (commit.prNumber) {
      line += ` ([#${commit.prNumber}](https://github.com/${process.env.GITHUB_REPOSITORY}/pull/${commit.prNumber}))`;
    }
    line += ` by @${username}`;
    return line;
  }).join('\n');
}

function getDiffSinceTag(lastTag) {
  const command = lastTag === 'v0.0.0'
    ? 'git diff $(git hash-object -t tree /dev/null)..HEAD'
    : `git diff ${lastTag}..HEAD`;
  try {
    return execSync(command, { encoding: 'utf8' });
  } catch {
    return '';
  }
}

function classifyVersion(diff) {
  const lines = diff.split('\n');
  let hasMajorChange = false;
  let hasMinorChange = false;

  for (const line of lines) {
    const trimmedLine = line.trim();

    // MAJOR: Breaking changes
    if (line.startsWith('-resource "')) {
      hasMajorChange = true;
    }
    if (line.includes('def ') && line.startsWith('-')) {
      hasMajorChange = true;
    }
    if (line.includes('class ') && line.startsWith('-')) {
      hasMajorChange = true;
    }
    if (trimmedLine.includes('"main":') && line.startsWith('-')) {
      hasMajorChange = true;
    }
    if (trimmedLine.includes('"exports":') && line.startsWith('-')) {
      hasMajorChange = true;
    }
    if (line.includes('export ') && line.startsWith('-')) {
      hasMajorChange = true;
    }
    if (trimmedLine.includes('destroy') && line.startsWith('-')) {
      hasMajorChange = true;
    }

    // MINOR: New features
    if (line.startsWith('+resource "') || line.startsWith('+variable "') || line.startsWith('+output "')) {
      hasMinorChange = true;
    }
    if ((line.includes('def ') || line.includes('class ')) && line.startsWith('+')) {
      hasMinorChange = true;
    }
    if (line.includes('export ') && line.startsWith('+')) {
      hasMinorChange = true;
    }
    if (trimmedLine.includes('"dependencies":') && line.startsWith('+')) {
      hasMinorChange = true;
    }
    if (line.includes('package.json') || (line.startsWith('+') && trimmedLine.match(/"[^"]+": "[\^~]?\d+\.\d+\.\d+"/))) {
      hasMinorChange = true;
    }
  }

  if (hasMajorChange) return 'major';
  if (hasMinorChange) return 'minor';
  return 'patch';
}

function createReleaseNotes(newTag, commits, lastTag, newContributors) {
  const date = new Date().toISOString().split('T')[0];
  const compareUrl = lastTag === 'v0.0.0'
    ? `https://github.com/${process.env.GITHUB_REPOSITORY}/commits/${newTag}`
    : `https://github.com/${process.env.GITHUB_REPOSITORY}/compare/${lastTag}...${newTag}`;

  const formattedCommits = formatCommitsForRelease(commits);
  let notes = `## Release ${newTag} - ${date}

### What Changed
${formattedCommits}
`;

  if (newContributors.length > 0) {
    notes += `\n### New Contributors\n`;
    newContributors.forEach(contributor => {
      notes += `- @${contributor.username}\n`;
    });
  }

  notes += `\n**Full Changelog**: ${compareUrl}`;
  return notes;
}

// Main execution
const lastTag = getLatestTag();
const allTags = getAllTags();
const allTagsSet = new Set(allTags);

const diff = getDiffSinceTag(lastTag);
const releaseType = classifyVersion(diff);

let newTag = incrementVersion(lastTag, releaseType);

while (allTagsSet.has(newTag)) {
  console.log(`Tag ${newTag} already exists. Recalculating...`);
  const highestTag = allTags.sort((a, b) => {
    const aParts = a.replace('v', '').split('.').map(Number);
    const bParts = b.replace('v', '').split('.').map(Number);
    if (aParts[0] !== bParts[0]) return bParts[0] - aParts[0];
    if (aParts[1] !== bParts[1]) return bParts[1] - aParts[1];
    return bParts[2] - aParts[2];
  })[0];
  newTag = incrementVersion(highestTag, releaseType);
}

const commits = getCommitsSinceTag(lastTag);
const newContributors = getNewContributors(commits, lastTag);

console.log(`Creating release ${newTag} from ${lastTag} (type: ${releaseType})`);
console.log(`Found ${commits.length} commits and ${newContributors.length} new contributors`);

// Write outputs for later steps
fs.writeFileSync('new-tag.txt', newTag);
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `new_tag=${newTag}\n`);
}

// Create annotated tag locally (do not push yet — build first)
execSync(`git tag -a ${newTag} -m "Release ${newTag}"`);

// Generate release notes
const releaseNotes = createReleaseNotes(newTag, commits, lastTag, newContributors);
fs.writeFileSync('release-notes.md', releaseNotes);

console.log(`Tag ${newTag} created locally`);
console.log('Release notes preview:');
console.log(releaseNotes);
