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
  assert.ok(existsSync(join(distDir, '_astro')), 'dist/_astro must exist');
  assert.ok(existsSync(join(distDir, '_app')), 'dist/_app must exist');
  assert.ok(existsSync(join(distDir, '_redirects')), 'dist/_redirects must exist');
  assert.ok(existsSync(join(distDir, '_headers')), 'dist/_headers must exist');
  assert.ok(existsSync(join(distDir, 'sitemap.xml')), 'dist/sitemap.xml must exist');
  assert.ok(existsSync(join(distDir, 'robots.txt')), 'dist/robots.txt must exist');
});

test('Cloudflare Pages _redirects routing engine rules', () => {
  const redirects = readFileSync(join(distDir, '_redirects'), 'utf8');

  // Verify dynamic room rewrite
  assert.match(
    redirects,
    /\/room\/\*\s+\/room\.html\s+200/,
    '_redirects must rewrite /room/* to /room.html with status 200'
  );

  // Verify bare /room redirect
  assert.match(
    redirects,
    /\/room\s+\/create\s+302/,
    '_redirects must redirect /room to /create with status 302'
  );
});

test('Cloudflare Pages _headers edge security policies', () => {
  const headers = readFileSync(join(distDir, '_headers'), 'utf8');

  // Extract blocks or check rule patterns
  assert.ok(headers.includes('/create'), '_headers must configure /create');
  assert.ok(headers.includes('/room/*'), '_headers must configure /room/*');

  // Verify noindex, nofollow on /create and /room/*
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

  // Verify Referrer-Policy: no-referrer on /create and /room/*
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
    /\/_astro\/\*\s*\n(\s+.*\n)*\s*Cache-Control:\s*public,\s*max-age=31536000,\s*immutable/m,
    '_headers must set immutable cache on /_astro/*'
  );
  assert.match(
    headers,
    /\/_app\/\*\s*\n(\s+.*\n)*\s*Cache-Control:\s*public,\s*max-age=31536000,\s*immutable/m,
    '_headers must set immutable cache on /_app/*'
  );
});

test('sitemap.xml strictly isolates landing page and excludes rooms', () => {
  const sitemap = readFileSync(join(distDir, 'sitemap.xml'), 'utf8');

  // Must contain canonical landing URL
  assert.match(
    sitemap,
    /<loc>https:\/\/fastchat\.room\/?<\/loc>/,
    'sitemap.xml must include canonical landing URL'
  );

  // Must NOT contain /create or /room
  assert.equal(
    sitemap.includes('/create'),
    false,
    'sitemap.xml must NEVER contain /create'
  );
  assert.equal(
    sitemap.includes('/room'),
    false,
    'sitemap.xml must NEVER contain /room'
  );
});

test('robots.txt allows landing and strictly disallows room paths', () => {
  const robots = readFileSync(join(distDir, 'robots.txt'), 'utf8');

  assert.match(robots, /Disallow:\s*\/room\//, 'robots.txt must disallow /room/');
  assert.match(robots, /Disallow:\s*\/create/, 'robots.txt must disallow /create');
  assert.match(
    robots,
    /Sitemap:\s*https:\/\/fastchat\.room\/sitemap\.xml/,
    'robots.txt must declare sitemap location'
  );
});
