#!/usr/bin/env node
// What changed in the reference projects of docs/watchlist.json since they were last reviewed.
//   node scripts/watchlist.mjs                 every project: new commits and releases since lastReviewed (GitHub API)
//   node scripts/watchlist.mjs <id>            one project, with up to 40 commit lines instead of 12
//   node scripts/watchlist.mjs --mark <id>     record that you reviewed the project's current head today (updates the file)
//   node scripts/watchlist.mjs --list          the projects, what was adopted and what is open, without any request
// GITHUB_TOKEN (optional) lifts the 60-requests-an-hour limit of anonymous calls. Nothing is cloned; 2-3 requests per project.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FILE = fileURLToPath(new URL('../docs/watchlist.json', import.meta.url));
const API = 'https://api.github.com';
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{7,40}$/;

export function loadWatchlist(path = FILE) {
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  if (doc.version !== 1 || !Array.isArray(doc.projects)) throw new Error('docs/watchlist.json has an unexpected shape');
  const ids = new Set();
  for (const project of doc.projects) {
    if (!project.id || ids.has(project.id)) throw new Error(`duplicate or missing id: ${project.id}`);
    ids.add(project.id);
    if (!REPO.test(project.repo ?? '') || project.url !== `https://github.com/${project.repo}`) throw new Error(`${project.id}: url and repo disagree`);
    const reviewed = project.lastReviewed;
    if (reviewed !== null && (!SHA.test(reviewed?.sha ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(reviewed?.date ?? ''))) throw new Error(`${project.id}: bad lastReviewed`);
  }
  return doc;
}

async function github(path, fetcher) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'crucix-watchlist' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetcher(`${API}${path}`, { headers });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path}${response.status === 403 ? ' (rate limit? set GITHUB_TOKEN)' : ''}`);
  return response.json();
}

/** The state of one project against its last review: { head, ahead, commits, releases, pushedAt }. */
export async function check(project, { fetcher = fetch, commitLines = 12 } = {}) {
  const meta = await github(`/repos/${project.repo}`, fetcher);
  const [latest] = await github(`/repos/${project.repo}/commits?sha=${encodeURIComponent(meta.default_branch)}&per_page=1`, fetcher);
  const head = { sha: latest.sha.slice(0, 7), date: latest.commit.committer.date.slice(0, 10), subject: latest.commit.message.split('\n')[0] };
  const reviewed = project.lastReviewed;
  let ahead = null, commits = [];
  if (reviewed) {
    const compare = await github(`/repos/${project.repo}/compare/${reviewed.sha}...${head.sha}`, fetcher);
    ahead = compare.ahead_by;
    commits = compare.commits.slice(-commitLines).reverse().map(item => `${item.sha.slice(0, 7)} ${item.commit.committer.date.slice(0, 10)} ${item.commit.message.split('\n')[0].slice(0, 110)}`);
  }
  const releases = (await github(`/repos/${project.repo}/releases?per_page=5`, fetcher)).filter(item => !reviewed || item.published_at.slice(0, 10) >= reviewed.date).map(item => `${item.tag_name} (${item.published_at.slice(0, 10)})`);
  return { head, ahead, commits, releases, pushedAt: meta.pushed_at };
}

function show(project) {
  console.log(`\n== ${project.name} (${project.url}) ${project.license}`);
  console.log(`   ${project.whyWatch}`);
  console.log(`   adopted: ${project.adopted.length ? project.adopted.map(item => `${item.release} ${item.what}`).join('; ') : 'nothing yet'}`);
  console.log(`   open/dropped: ${project.droppedOrOpen}`);
  console.log(`   last reviewed: ${project.lastReviewed ? `${project.lastReviewed.sha} on ${project.lastReviewed.date}` : 'never'}`);
}

async function main(args) {
  const doc = loadWatchlist();
  if (args[0] === '--list') { doc.projects.forEach(show); return; }
  if (args[0] === '--mark') {
    const project = doc.projects.find(item => item.id === args[1]);
    if (!project) throw new Error(`unknown id "${args[1]}"; known: ${doc.projects.map(item => item.id).join(', ')}`);
    const { head } = await check({ ...project, lastReviewed: null });
    project.lastReviewed = { sha: head.sha, date: new Date().toISOString().slice(0, 10), note: args.slice(2).join(' ') || 'Reviewed.' };
    writeFileSync(FILE, JSON.stringify(doc, null, 2) + '\n');
    console.log(`${project.id}: marked as reviewed at ${head.sha} (${head.date}).`);
    return;
  }
  const only = args[0] && !args[0].startsWith('--') ? args[0] : null;
  const projects = only ? doc.projects.filter(item => item.id === only) : doc.projects;
  if (!projects.length) throw new Error(`unknown id "${only}"`);
  for (const project of projects) {
    show(project);
    try {
      const state = await check(project, { commitLines: only ? 40 : 12 });
      if (state.ahead === null) console.log(`   NOT ANALYSED YET. Head: ${state.head.sha} (${state.head.date}) ${state.head.subject}`);
      else if (state.ahead === 0) console.log('   no new commits since the last review.');
      else {
        console.log(`   ${state.ahead} new commits since the review; head ${state.head.sha} (${state.head.date}). Newest first:`);
        state.commits.forEach(line => console.log(`     ${line}`));
      }
      if (state.releases.length) console.log(`   releases since the review: ${state.releases.join(', ')}`);
    } catch (error) {
      console.log(`   could not check: ${error.message}`);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
