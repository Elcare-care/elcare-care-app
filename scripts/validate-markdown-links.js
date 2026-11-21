#!/usr/bin/env node

/**
 * markdown-link-validator.js
 *
 * Validates relative markdown links in operational guides.
 * Uses simple regex to find [text](relative/path.md) patterns
 * and checks if the target file exists.
 *
 * No network access required.
 */

const fs = require('fs');
const path = require('path');

// Files to validate (top-level operational guides)
const FILES_TO_CHECK = [
  'DEPLOYMENT.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'COMPATIBILITY.md',
  'OPERATIONAL_QUICK_REFERENCE.md',
  'docs/INCIDENT_RUNBOOK.md',
  'docs/financial-reconciliation-runbook.md',
  'docs/guides/contract-upgrade-runbook.md',
  'docs/guides/indexer-consumer-guide.md',
  'docs/reliability/grafana-dashboard-ownership.md',
  'docs/reliability/backup-retention-verification-report.md',
];

// Regex for relative markdown links: [text](./path.md or path.md)
const RELATIVE_LINK_REGEX = /\[[^\]]+\]\(\.?\/[^\s\]]+\.md\)/g;

/**
 * Extract relative markdown links from a file
 */
function extractLinks(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const links = new Set();
    let match;
    while ((match = RELATIVE_LINK_REGEX.exec(content)) !== null) {
      // Extract the link target from [text](target)
      const linkText = match[0];
      const targetMatch = linkText.match(/\(\.?\/[^\s\]]+\.md\)/);
      if (targetMatch) {
        const fullTarget = targetMatch[0];
        const cleanTarget = fullTarget.slice(2, -1); // Remove ( and )
        links.add(cleanTarget);
      }
    }
    return Array.from(links);
  } catch (err) {
    console.error(`Error reading ${filePath}: ${err.message}`);
    return [];
  }
}

/**
 * Resolve a relative link to an absolute path
 */
function resolveLink(baseDir, link) {
  // Remove leading ./ if present
  let cleanLink = link.startsWith('./') ? link.slice(2) : link;
  
  // Handle absolute-style links relative to docs/ (e.g., /runbooks/README.md -> docs/runbooks/README.md)
  if (cleanLink.startsWith('/')) {
    cleanLink = 'docs' + cleanLink;
  }
  
  return path.join(baseDir, cleanLink);
}

/**
 * Check if a link target exists
 */
function checkLink(baseDir, link) {
  const targetPath = resolveLink(baseDir, link);
  return fs.existsSync(targetPath);
}

/**
 * Main validation
 */
function main() {
  const baseDir = process.cwd();
  const errors = [];
  const checked = new Set();

  for (const file of FILES_TO_CHECK) {
    const filePath = path.join(baseDir, file);
    if (!fs.existsSync(filePath)) {
      console.warn(`Warning: File not found: ${file}`);
      continue;
    }

    const links = extractLinks(filePath);
    for (const link of links) {
      if (checked.has(link)) continue;
      checked.add(link);

      if (!checkLink(baseDir, link)) {
        errors.push({
          file,
          link,
          target: resolveLink(baseDir, link),
        });
      }
    }
  }

  if (errors.length > 0) {
    console.log('\nBroken relative markdown links found:');
    for (const err of errors) {
      console.log(`  ${err.file}: [${err.link}] -> ${err.target}`);
    }
    console.log(`\nTotal: ${errors.length} broken link(s)`);
    process.exit(1);
  }

  console.log('All checked relative markdown links are valid!');
  console.log(`Checked ${checked.size} unique links in ${FILES_TO_CHECK.length} files`);
}

main();
