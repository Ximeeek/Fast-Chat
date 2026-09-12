#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const rootDir = process.cwd();
const distDir = resolve(rootDir, 'dist');
const roomDir = resolve(rootDir, 'apps/room');

console.log('=== FastChat: Direct Room Application Build Pipeline ===\n');

// Ensure workspace dependencies are available before building
const hasRoomDeps = existsSync(join(roomDir, 'node_modules')) || existsSync(join(rootDir, 'node_modules/@sveltejs/kit'));
if (!hasRoomDeps) {
  console.log('Workspace dependencies missing. Running npm install across monorepo...');
  execSync('npm install', { cwd: rootDir, stdio: 'inherit' });
}

// 1. Build SvelteKit room client application
console.log('1. Building apps/room (SvelteKit SPA)...');
execSync('npm run build', { cwd: roomDir, stdio: 'inherit' });

// 2. Clean and prepare unified distribution directory
console.log('\n2. Preparing unified distribution directory: dist/...');
if (existsSync(distDir)) {
  rmSync(distDir, { recursive: true, force: true });
}
mkdirSync(distDir, { recursive: true });

// 3. Copy room distribution files to dist/
console.log('3. Merging room client static output (SvelteKit: / -> index.html, /create, /room/*, _app/)...');
const roomBuild = join(roomDir, 'build');

// Copy pre-rendered root page (index.html)
const roomIndexHtml = join(roomBuild, 'index.html');
if (existsSync(roomIndexHtml)) {
  cpSync(roomIndexHtml, join(distDir, 'index.html'));
} else {
  // Fallback to create.html if index.html is missing
  const fallbackCreate = join(roomBuild, 'create.html');
  if (existsSync(fallbackCreate)) {
    cpSync(fallbackCreate, join(distDir, 'index.html'));
  }
}

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

// Copy static assets (robots.txt, favicon.svg, og-image.svg)
for (const staticAsset of ['robots.txt', 'favicon.svg', 'og-image.svg']) {
  const assetPath = join(roomBuild, staticAsset);
  if (existsSync(assetPath)) {
    cpSync(assetPath, join(distDir, staticAsset));
  }
}

// 4. Generate Cloudflare Pages _redirects file
console.log('4. Emitting Cloudflare Pages _redirects configuration...');
const redirectsContent = `# FastChat Room: Cloudflare Pages Routing Engine
# Room creation page served at root / from dist/index.html
# Session dispatch page also served at /create from dist/create/index.html

# Route bare /room to root
/room                   /                       302

# Dynamic ephemeral room sessions (/room/0000-0000-0000#key)
# SPA rewrite rule returns room.html shell with HTTP 200 without altering browser URL
/room/*                 /room.html              200
`;
writeFileSync(join(distDir, '_redirects'), redirectsContent, 'utf8');

// 5. Ensure _headers is emitted to dist/_headers
console.log('5. Emitting Cloudflare Pages _headers edge security policies...');
const headersContent = `# Cloudflare Pages Edge Security Headers

# Strictly block search engine indexing and referrer leakage on root and ephemeral room endpoints
/
  X-Robots-Tag: noindex, nofollow
  Referrer-Policy: no-referrer

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
/_app/*
  Cache-Control: public, max-age=31536000, immutable

# Baseline security headers for all endpoints
/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
`;
writeFileSync(join(distDir, '_headers'), headersContent, 'utf8');

// Copy vercel.json deployment descriptor if present
const vercelConfig = join(rootDir, 'vercel.json');
if (existsSync(vercelConfig)) {
  console.log('Copying vercel.json deployment descriptor...');
  cpSync(vercelConfig, join(distDir, 'vercel.json'));
}

// 6. Verification of build distribution
console.log('\n6. Validating distribution integrity...');
const requiredArtifacts = [
  'index.html',
  '_app',
  'room.html',
  'create.html',
  'create/index.html',
  '_redirects',
  '_headers',
  'vercel.json',
  'robots.txt'
];

for (const artifact of requiredArtifacts) {
  const artifactPath = join(distDir, artifact);
  if (!existsSync(artifactPath)) {
    throw new Error(`Build verification failed: missing artifact ${artifact} in ${distDir}`);
  }
}

console.log('✓ Distribution build verified successfully!\n');
