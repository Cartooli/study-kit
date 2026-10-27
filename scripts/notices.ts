// Third-party notices for every production package, shipped with both editions (MIT/ISC/Apache require it).
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function thirdPartyNotices(): string {
  const pkgs = (JSON.parse(execSync('npm query ".prod"', { encoding: 'utf8' })) as { name: string; version: string; license?: string; path: string; location: string }[])
    .filter(p => p.location) // skip the root package
    .sort((a, b) => a.name.localeCompare(b.name));
  const parts = pkgs.map(p => {
    const file = existsSync(p.path) ? readdirSync(p.path).find(f => /^(licen[cs]e|copying|notice)/i.test(f)) : undefined;
    const text = file ? readFileSync(join(p.path, file), 'utf8').trim() : `License: ${p.license}`;
    return `${'='.repeat(72)}\n${p.name}@${p.version} (${p.license})\n${'='.repeat(72)}\n\n${text}\n`;
  });
  return `Study Kit includes the following third-party software.\n\n${parts.join('\n')}`;
}
