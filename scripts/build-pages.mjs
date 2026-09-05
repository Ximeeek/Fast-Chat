#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const rootDir = process.cwd();
const distDir = resolve(rootDir, 'dist');
const landingDir = resolve(rootDir, 'apps/landing');
const roomDir = resolve(rootDir, 'apps/room');

console.log('=== FastChat Monorepo: Unified Cloudflare Pages Build Pipeline ===\n');

// 1. Build Astro static landing application
console.log('1. Building apps/landing (Astro SSG)...');
execSync('npm run build', { cwd: landingDir, stdio: 'inherit' });

// 2. Build SvelteKit room client application
console.log('\n2. Building apps/room (SvelteKit SPA)...');
execSync('npm run build', { cwd: roomDir, stdio: 'inherit' });

// 3. Clean and prepare unified distribution directory
console.log('\n3. Preparing unified distribution directory: dist/...');
if (existsSync(distDir)) {
  rmSync(distDir, { recursive: true, force: true });
}
mkdirSync(distDir, { recursive: true });

// 4. Copy landing distribution files to dist/
console.log('4. Merging landing static output (Astro: / -> index.html, _astro/)...');
const landingDist = join(landingDir, 'dist');
cpSync(landingDist, distDir, { recursive: true });

// 5. Copy room distribution files to dist/
console.log('5. Merging room client static output (SvelteKit: /create, /room/*, _app/)...');
const roomBuild = join(roomDir, 'build');

// Copy SvelteKit assets (_app/)
const roomAppDir = join(roomBuild, '_app');
if (existsSync(roomAppDir)) {
  cpSync(roomAppDir, join(distDir, '_app'), { recursive: true });
}

// Copy room.html fallback shell for /room/* rewrite
const roomFallbackHtml = join(roomBuild, 'room.html');
if (existsSync(roomFallbackHtml)) {
  cpSync(roomFallbackHtml, join(distDir, 'room.html'));
}

// Copy create.html and place both create.html and create/index.html for static routing
const createHtml = join(roomBuild, 'create.html');
if (existsSync(createHtml)) {
  cpSync(createHtml, join(distDir, 'create.html'));
  const createSubdir = join(distDir, 'create');
  mkdirSync(createSubdir, { recursive: true });
  cpSync(createHtml, join(createSubdir, 'index.html'));
}

// 6. Generate Cloudflare Pages _redirects file
console.log('6. Emitting Cloudflare Pages _redirects configuration...');
const redirectsContent = `# FastChat Room: Cloudflare Pages Routing Engine
# Static landing page served at root / from dist/index.html
# Session dispatch page served at /create from dist/create/index.html

# Route bare /room to room creator
/room                   /create                 302

# Dynamic ephemeral room sessions (/room/0000-0000-0000#key)
# SPA rewrite rule returns room.html shell with HTTP 200 without altering browser URL
/room/*                 /room.html              200
`;
writeFileSync(join(distDir, '_redirects'), redirectsContent, 'utf8');

// 7. Ensure _headers is emitted to dist/_headers
console.log('7. Emitting Cloudflare Pages _headers edge security policies...');
const headersSource = join(landingDir, 'public/_headers');
if (existsSync(headersSource)) {
  cpSync(headersSource, join(distDir, '_headers'));
} else {
  const headersContent = `# Cloudflare Pages Edge Security Headers

# Strictly block search engine indexing and referrer leakage on ephemeral room endpoints
/create
  X-Robots-Tag: noindex, nofollow
  Referrer-Policy: no-referrer

/create/*
  X-Robots-Tag: noindex, nofollow
  Referrer-Policy: no-referrer

/room/*
  X-Robots-Tag: noindex, nofollow
  Referrer-Policy: no-referrer

# Long-term immutable caching for content-hashed assets
/_astro/*
  Cache-Control: public, max-age=31536000, immutable

/_app/*
  Cache-Control: public, max-age=31536000, immutable

# Baseline security headers for all endpoints
/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
`;
  writeFileSync(join(distDir, '_headers'), headersContent, 'utf8');
}

// 8. Verification of build distribution
console.log('\n8. Validating unified distribution integrity...');
const requiredArtifacts = [
  'index.html',
  '_astro',
  '_app',
  'room.html',
  'create.html',
  'create/index.html',
  '_redirects',
  '_headers'
];

for (const artifact of requiredArtifacts) {
  const artifactPath = join(distDir, artifact);
  if (!existsSync(artifactPath)) {
    throw new Error(`Build verification failed: missing artifact ${artifact} in ${distDir}`);
  }
}

console.log('✓ Unified distribution build verified successfully!\n');
