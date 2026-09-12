import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const rootDir = process.cwd();
const distDir = resolve(rootDir, 'dist');

test('Cloudflare Pages deployment artifact integrity', () => {
  assert.ok(existsSync(join(distDir, 'index.html')), 'dist/index.html must exist');
  assert.ok(existsSync(join(distDir, 'room.html')), 'dist/room.html must exist');
  assert.ok(existsSync(join(distDir, 'create/index.html')), 'dist/create/index.html must exist');
  assert.ok(existsSync(join(distDir, '_app')), 'dist/_app must exist');
  assert.ok(existsSync(join(distDir, '_redirects')), 'dist/_redirects must exist');
  assert.ok(existsSync(join(distDir, '_headers')), 'dist/_headers must exist');
  assert.ok(existsSync(join(distDir, 'vercel.json')), 'dist/vercel.json must exist');
  assert.ok(existsSync(join(distDir, 'robots.txt')), 'dist/robots.txt must exist');
});

test('dist/index.html delivers direct room application without marketing landing', () => {
  const indexHtml = readFileSync(join(distDir, 'index.html'), 'utf8');

  // Must mount SvelteKit application bundle
  assert.match(indexHtml, /\/_app\/immutable\/entry\/start/, 'dist/index.html must load SvelteKit client bundle');
  assert.match(indexHtml, /__sveltekit/, 'dist/index.html must initialize SvelteKit application');

  // Must NOT reference Astro landing assets
  assert.equal(indexHtml.includes('/_astro/'), false, 'dist/index.html must not contain legacy _astro assets');
});

test('Cloudflare Pages _redirects routing engine rules', () => {
  const redirects = readFileSync(join(distDir, '_redirects'), 'utf8');

  // Verify dynamic room rewrite
  assert.match(
    redirects,
    /\/room\/\*\s+\/room\.html\s+200/,
    '_redirects must rewrite /room/* to /room.html with status 200'
  );

  // Verify bare /room redirect to root
  assert.match(
    redirects,
    /\/room\s+\/\s+302/,
    '_redirects must redirect /room to / with status 302'
  );
});

test('Cloudflare Pages _headers edge security policies', () => {
  const headers = readFileSync(join(distDir, '_headers'), 'utf8');

  assert.ok(headers.includes('/create'), '_headers must configure /create');
  assert.ok(headers.includes('/room/*'), '_headers must configure /room/*');

  // Verify noindex, nofollow on root /, /create, and /room/*
  assert.match(
    headers,
    /\/\s*\n(\s+.*\n)*\s*X-Robots-Tag:\s*noindex,\s*nofollow/m,
    '_headers must set X-Robots-Tag: noindex, nofollow for root /'
  );
  assert.match(
    headers,
    /\/create\s*\n(\s+.*\n)*\s*X-Robots-Tag:\s*noindex,\s*nofollow/m,
    '_headers must set X-Robots-Tag: noindex, nofollow for /create'
  );
  assert.match(
    headers,
    /\/room\/\*\s*\n(\s+.*\n)*\s*X-Robots-Tag:\s*noindex,\s*nofollow/m,
    '_headers must set X-Robots-Tag: noindex, nofollow for /room/*'
  );

  // Verify Referrer-Policy: no-referrer on root /, /create, and /room/*
  assert.match(
    headers,
    /\/\s*\n(\s+.*\n)*\s*Referrer-Policy:\s*no-referrer/m,
    '_headers must set Referrer-Policy: no-referrer for root /'
  );
  assert.match(
    headers,
    /\/create\s*\n(\s+.*\n)*\s*Referrer-Policy:\s*no-referrer/m,
    '_headers must set Referrer-Policy: no-referrer for /create'
  );
  assert.match(
    headers,
    /\/room\/\*\s*\n(\s+.*\n)*\s*Referrer-Policy:\s*no-referrer/m,
    '_headers must set Referrer-Policy: no-referrer for /room/*'
  );

  // Verify immutable asset cache
  assert.match(
    headers,
    /\/_app\/\*\s*\n(\s+.*\n)*\s*Cache-Control:\s*public,\s*max-age=31536000,\s*immutable/m,
    '_headers must set immutable cache on /_app/*'
  );
});

test('robots.txt strictly disallows indexing on room endpoints', () => {
  const robots = readFileSync(join(distDir, 'robots.txt'), 'utf8');

  assert.match(robots, /Disallow:\s*\/room\//, 'robots.txt must disallow /room/');
  assert.match(robots, /Disallow:\s*\/create/, 'robots.txt must disallow /create');
});

test('Vercel vercel.json routing and edge security policies', () => {
  const vercel = JSON.parse(readFileSync(join(distDir, 'vercel.json'), 'utf8'));

  assert.equal(vercel.outputDirectory, 'dist');
  assert.equal(vercel.cleanUrls, true);

  // Rewrites
  assert.ok(
    vercel.rewrites.some((r) => r.source === '/room' && r.destination === '/'),
    'vercel.json must rewrite /room to /'
  );
  assert.ok(
    vercel.rewrites.some((r) => r.source === '/room/:path*' && r.destination === '/room.html'),
    'vercel.json must rewrite /room/:path* to /room.html'
  );

  // Headers
  assert.ok(
    vercel.headers.some(
      (h) =>
        h.source === '/' &&
        h.headers.some((v) => v.key === 'X-Robots-Tag' && v.value === 'noindex, nofollow')
    ),
    'vercel.json must configure noindex for root /'
  );
  assert.ok(
    vercel.headers.some(
      (h) =>
        h.source === '/create' &&
        h.headers.some((v) => v.key === 'X-Robots-Tag' && v.value === 'noindex, nofollow')
    ),
    'vercel.json must configure noindex for /create'
  );
  assert.ok(
    vercel.headers.some(
      (h) =>
        h.source === '/room/:path*' &&
        h.headers.some((v) => v.key === 'X-Robots-Tag' && v.value === 'noindex, nofollow')
    ),
    'vercel.json must configure noindex for /room/:path*'
  );
});
