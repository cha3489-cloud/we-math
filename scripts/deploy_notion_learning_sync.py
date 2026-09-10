#!/usr/bin/env python3
"""Deploy we-math Notion learning sync safely.

- Resolves TEST Notion data-source IDs from the dashboard instead of hardcoding them in browser code.
- Sets Supabase Edge Function secrets without printing secret values.
- Deploys the notion-learning-sync Edge Function.

Usage:
  python3 scripts/deploy_notion_learning_sync.py --dry-run
  SUPABASE_ACCESS_TOKEN=... python3 scripts/deploy_notion_learning_sync.py
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

PROJECT_REF = 'tcpitbsrfouwmfkkdqhg'
DASHBOARD_ID = '3d71bec4-97ad-81bd-9185-cfd9bd70541f'
DAILY_DB_TITLE = '[TEST] 11-일일 학습기록 — 시퀀스 수학'
QUEUE_DB_TITLE = '[TEST] 11-운영 작업큐 — 시퀀스 수학'
NOTION_VERSION = '2025-09-03'


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding='utf-8').splitlines():
        if not line.strip() or line.lstrip().startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def notion_request(path: str) -> dict:
    token = os.environ.get('NOTION_API_KEY') or os.environ.get('NOTION_API_TOKEN')
    if not token:
        raise RuntimeError('NOTION_API_KEY/NOTION_API_TOKEN is missing')
    req = urllib.request.Request(
        'https://api.notion.com/v1' + path,
        headers={
            'Authorization': 'Bearer ' + token,
            'Notion-Version': NOTION_VERSION,
            'Content-Type': 'application/json',
        },
        method='GET',
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.loads(response.read().decode() or '{}')
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors='replace')[:800]
        raise RuntimeError(f'Notion request failed {exc.code}: {body}') from exc


def resolve_child_database_data_source(title: str) -> tuple[str, str]:
    children = notion_request(f'/blocks/{DASHBOARD_ID}/children?page_size=100')
    for block in children.get('results', []):
        if block.get('type') != 'child_database':
            continue
        if block.get('child_database', {}).get('title') != title:
            continue
        database_id = block['id']
        db = notion_request('/databases/' + database_id)
        data_source_id = (db.get('data_sources') or [{}])[0].get('id')
        if not data_source_id:
            raise RuntimeError(f'Data source missing for {title}')
        return database_id, data_source_id
    raise RuntimeError(f'Child database not found: {title}')


def assert_safe_id(value: str, label: str) -> None:
    if not re.fullmatch(r'[0-9a-f-]{36}', value):
        raise RuntimeError(f'{label} does not look like a UUID')


def run(cmd: list[str], env: dict[str, str], dry_run: bool) -> None:
    printable = ' '.join(cmd)
    if 'secrets' in cmd:
        printable = 'npx supabase secrets set [REDACTED secrets] --project-ref ' + PROJECT_REF
    print('$', printable)
    if dry_run:
        return
    subprocess.run(cmd, cwd=Path(__file__).resolve().parents[1], env=env, check=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    load_env(Path('/opt/data/.hermes/.env'))

    daily_db, daily_ds = resolve_child_database_data_source(DAILY_DB_TITLE)
    queue_db, queue_ds = resolve_child_database_data_source(QUEUE_DB_TITLE)
    assert_safe_id(daily_ds, 'daily data source')
    assert_safe_id(queue_ds, 'queue data source')
    print('Resolved Notion TEST DBs: daily_db=yes queue_db=yes')

    env = os.environ.copy()
    token = env.get('SUPABASE_ACCESS_TOKEN')
    if not token and not args.dry_run:
        raise RuntimeError('SUPABASE_ACCESS_TOKEN is missing; cannot set secrets/deploy')

    notion_key = env.get('NOTION_API_KEY') or env.get('NOTION_API_TOKEN')
    if not notion_key:
        raise RuntimeError('NOTION_API_KEY is missing')

    run([
        'npx', 'supabase', 'secrets', 'set',
        f'NOTION_API_KEY={notion_key}',
        f'NOTION_LEARNING_DAILY_DATA_SOURCE_ID={daily_ds}',
        f'NOTION_LEARNING_QUEUE_DATA_SOURCE_ID={queue_ds}',
        '--project-ref', PROJECT_REF,
    ], env, args.dry_run)
    run(['npx', 'supabase', 'functions', 'deploy', 'notion-learning-sync', '--project-ref', PROJECT_REF], env, args.dry_run)
    print('Done')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f'ERROR: {exc}', file=sys.stderr)
        raise SystemExit(1)
