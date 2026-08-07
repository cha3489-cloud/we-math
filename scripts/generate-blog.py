#!/usr/bin/env python3
"""Generate and register a Sequence Math static blog article from JSON."""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import tempfile
from datetime import date
from pathlib import Path
from typing import Any

BASE_URL = "https://sequencemath.co.kr"
REQUIRED_FIELDS = {
    "date",
    "title",
    "description",
    "category",
    "slug",
    "article_markdown",
    "hashtags",
}
BANNED_PHRASES = (
    "수강생 모집",
    "상담 예약",
    "등록 문의",
    "선착순",
    "수강료 안내",
    "지금 신청하세요",
)
TEXT_FIELDS = ("date", "title", "description", "category", "slug", "article_markdown")
SLUG_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def validate_record(record: Any) -> dict[str, Any]:
    if not isinstance(record, dict):
        raise ValueError("content record must be a JSON object")
    missing = REQUIRED_FIELDS - record.keys()
    extra = record.keys() - REQUIRED_FIELDS
    if missing:
        raise ValueError(f"missing required fields: {', '.join(sorted(missing))}")
    if extra:
        raise ValueError(f"unexpected fields: {', '.join(sorted(extra))}")
    for field in TEXT_FIELDS:
        if not isinstance(record[field], str) or not record[field].strip():
            raise ValueError(f"{field} must be a non-empty string")
    try:
        date.fromisoformat(record["date"])
    except ValueError as error:
        raise ValueError("date must be a valid ISO date (YYYY-MM-DD)") from error
    if not SLUG_PATTERN.fullmatch(record["slug"]):
        raise ValueError("slug must contain only lowercase ASCII letters, numbers, and single hyphens")
    if not isinstance(record["hashtags"], list) or not record["hashtags"]:
        raise ValueError("hashtags must be a non-empty array of strings")
    if any(not isinstance(tag, str) or not tag.strip().lstrip("#") for tag in record["hashtags"]):
        raise ValueError("each hashtag must be a non-empty string")

    searchable = [record[field] for field in TEXT_FIELDS]
    searchable.extend(record["hashtags"])
    for phrase in BANNED_PHRASES:
        if any(phrase in value for value in searchable):
            raise ValueError(f"banned pre-launch phrase: {phrase}")

    clean = dict(record)
    clean.update({field: record[field].strip() for field in TEXT_FIELDS if field != "article_markdown"})
    clean["article_markdown"] = record["article_markdown"].strip()
    clean["hashtags"] = [tag.strip().lstrip("#") for tag in record["hashtags"]]
    return clean


def inline_markdown(value: str) -> str:
    safe = html.escape(value, quote=True)
    safe = re.sub(r"`([^`]+)`", r"<code>\1</code>", safe)
    safe = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", safe)
    safe = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", safe)
    return safe


def markdown_to_html(markdown: str) -> str:
    """Render a deliberately small, raw-HTML-free Markdown subset."""
    lines = markdown.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    output: list[str] = []
    paragraph: list[str] = []
    list_items: list[str] = []

    def flush_paragraph() -> None:
        if paragraph:
            output.append(f"      <p>{inline_markdown(' '.join(paragraph))}</p>")
            paragraph.clear()

    def flush_list() -> None:
        if list_items:
            output.append('      <ul class="article-checklist">')
            output.extend(f"        <li>{inline_markdown(item)}</li>" for item in list_items)
            output.append("      </ul>")
            list_items.clear()

    for line in lines:
        stripped = line.strip()
        heading = re.fullmatch(r"(#{2,3})\s+(.+)", stripped)
        item = re.fullmatch(r"[-*]\s+(.+)", stripped)
        if heading:
            flush_paragraph()
            flush_list()
            level = len(heading.group(1))
            output.append(f"      <h{level}>{inline_markdown(heading.group(2))}</h{level}>")
        elif item:
            flush_paragraph()
            list_items.append(item.group(1))
        elif stripped.startswith("> "):
            flush_paragraph()
            flush_list()
            output.append(f'      <div class="article-quote">{inline_markdown(stripped[2:])}</div>')
        elif not stripped:
            flush_paragraph()
            flush_list()
        else:
            flush_list()
            paragraph.append(stripped)
    flush_paragraph()
    flush_list()
    return "\n".join(output)


def safe_json_script(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def render_article(record: dict[str, Any]) -> str:
    title = html.escape(record["title"], quote=True)
    description = html.escape(record["description"], quote=True)
    category = html.escape(record["category"], quote=True)
    slug = record["slug"]
    url = f"{BASE_URL}/blog/{slug}/"
    display_date = record["date"].replace("-", ".")
    word_count = len(re.findall(r"\S+", record["article_markdown"]))
    read_minutes = max(1, (word_count + 199) // 200)
    tags = " ".join(f"#{html.escape(tag)}" for tag in record["hashtags"])
    schema = safe_json_script({
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        "headline": record["title"],
        "description": record["description"],
        "datePublished": record["date"],
        "dateModified": record["date"],
        "inLanguage": "ko-KR",
        "mainEntityOfPage": url,
        "author": {"@type": "Organization", "name": "시퀀스 수학"},
        "publisher": {"@type": "Organization", "name": "시퀀스 수학", "url": f"{BASE_URL}/"},
        "keywords": record["hashtags"],
    })
    body = markdown_to_html(record["article_markdown"])
    return f'''<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{title} | 시퀀스 수학</title>
  <meta name="description" content="{description}" />
  <meta name="robots" content="index, follow" />
  <link rel="canonical" href="{url}" />
  <meta property="og:type" content="article" />
  <meta property="og:url" content="{url}" />
  <meta property="og:site_name" content="시퀀스 수학" />
  <meta property="og:title" content="{title}" />
  <meta property="og:description" content="{description}" />
  <link rel="icon" type="image/x-icon" href="/img/favicon.ico" />
  <link rel="apple-touch-icon" href="/img/symbol.png" />
  <meta name="theme-color" content="#16181B" />
  <link rel="stylesheet" href="/src/style.css" />
  <script type="application/ld+json">
{schema}
  </script>
  <script type="module" src="/src/analytics.js"></script>
</head>
<body class="blog-page">
  <header class="blog-topbar">
    <a class="blog-brand" href="/" aria-label="시퀀스 수학 홈페이지로 이동">
      <strong>시퀀스 수학</strong>
      <span>Sequence Math</span>
    </a>
    <a class="blog-home-link" href="/blog/">블로그 목록 →</a>
  </header>
  <main>
    <header class="article-header grid-bg">
      <div class="wrap">
        <p class="article-kicker">{category}</p>
        <h1>{title}</h1>
        <p class="article-deck">{description}</p>
        <p class="article-meta"><time datetime="{record['date']}">{display_date}</time> · 읽는 시간 약 {read_minutes}분</p>
      </div>
    </header>
    <article class="article-body">
{body}
      <p class="article-tags">{tags}</p>
      <a class="article-back" href="/blog/">← 블로그 목록으로</a>
    </article>
  </main>
</body>
</html>
'''


def replace_generated(text: str, kind: str, slug: str, block: str, fallback_pattern: str | None, insertion_pattern: str) -> str:
    if kind == "vite-input":
        start = f"// generated-{kind}:{slug}:start"
        end = f"// generated-{kind}:{slug}:end"
    else:
        start = f"<!-- generated-{kind}:{slug}:start -->"
        end = f"<!-- generated-{kind}:{slug}:end -->"
    marked = re.compile(rf"{re.escape(start)}.*?{re.escape(end)}", re.DOTALL)
    wrapped = f"{start}\n{block}\n{end}"
    if marked.search(text):
        return marked.sub(lambda _match: wrapped, text)
    if fallback_pattern:
        text = re.sub(fallback_pattern, "", text, flags=re.DOTALL)
    match = re.search(insertion_pattern, text)
    if not match:
        raise ValueError(f"could not find insertion point for {kind}")
    return text[:match.end()] + "\n" + wrapped + "\n" + text[match.end():]


def update_blog_index(text: str, record: dict[str, Any]) -> str:
    slug = record["slug"]
    card = f'''        <a class="blog-card" href="/blog/{slug}/">
          <div class="blog-card-meta">{record['date'].replace('-', '.')}<br>{html.escape(record['category'])}</div>
          <div>
            <h2>{html.escape(record['title'])}</h2>
            <p>{html.escape(record['description'])}</p>
          </div>
          <span class="blog-card-arrow" aria-hidden="true">→</span>
        </a>'''
    fallback = rf'\s*<a class="blog-card" href="/blog/{re.escape(slug)}/">.*?</a>\s*'
    return replace_generated(text, "blog-card", slug, card, fallback, r'<p class="eyebrow">LATEST NOTE</p>')


def vite_key(slug: str) -> str:
    return "blog" + "".join(part.capitalize() for part in slug.split("-"))


def update_vite(text: str, record: dict[str, Any]) -> str:
    slug = record["slug"]
    key = vite_key(slug)
    entry = f"{key}: resolve(__dirname, 'blog/{slug}/index.html'),"
    fallback = rf"\s*{re.escape(key)}\s*:\s*resolve\(__dirname,\s*['\"]blog/{re.escape(slug)}/index\.html['\"]\),?"
    return replace_generated(text, "vite-input", slug, entry, fallback, r"input\s*:\s*\{")


def update_sitemap(text: str, record: dict[str, Any]) -> str:
    slug = record["slug"]
    url = f"{BASE_URL}/blog/{slug}/"
    block = f'''  <url>
    <loc>{url}</loc>
    <lastmod>{record['date']}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>'''
    fallback = rf"\s*<url>\s*<loc>{re.escape(url)}</loc>.*?</url>\s*"
    return replace_generated(text, "sitemap-url", slug, block, fallback, r"(?=</urlset>)")


def update_rss(text: str, record: dict[str, Any]) -> str:
    slug = record["slug"]
    url = f"{BASE_URL}/blog/{slug}/"
    parsed = date.fromisoformat(record["date"])
    pub_date = parsed.strftime("%a, %d %b %Y 09:00:00 +0900")
    block = f'''    <item>
      <title>{html.escape(record['title'])}</title>
      <link>{url}</link>
      <guid isPermaLink="true">{url}</guid>
      <description>{html.escape(record['description'])}</description>
      <pubDate>{pub_date}</pubDate>
    </item>'''
    fallback = rf"\s*<item>.*?<link>{re.escape(url)}</link>.*?</item>\s*"
    return replace_generated(text, "rss-item", slug, block, fallback, r'<atom:link\b[^>]*/>')


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            handle.write(content)
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def generate(root: Path | str, raw_record: Any) -> list[str]:
    root = Path(root).resolve()
    record = validate_record(raw_record)
    relative_paths = [
        f"blog/{record['slug']}/index.html",
        "blog/index.html",
        "vite.config.js",
        "public/sitemap.xml",
        "public/rss.xml",
    ]
    source_paths = relative_paths[1:]
    sources: dict[str, str] = {}
    for relative in source_paths:
        path = root / relative
        if not path.is_file():
            raise ValueError(f"required project file not found: {relative}")
        sources[relative] = path.read_text(encoding="utf-8")

    outputs = {
        relative_paths[0]: render_article(record),
        "blog/index.html": update_blog_index(sources["blog/index.html"], record),
        "vite.config.js": update_vite(sources["vite.config.js"], record),
        "public/sitemap.xml": update_sitemap(sources["public/sitemap.xml"], record),
        "public/rss.xml": update_rss(sources["public/rss.xml"], record),
    }
    changed = []
    for relative in relative_paths:
        path = root / relative
        if not path.exists() or path.read_text(encoding="utf-8") != outputs[relative]:
            changed.append(relative)
    for relative in changed:
        atomic_write(root / relative, outputs[relative])
    return changed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("content", type=Path, help="JSON content record")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1], help="site repository root")
    args = parser.parse_args()
    try:
        record = json.loads(args.content.read_text(encoding="utf-8"))
        changed = generate(args.root, record)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        parser.exit(1, f"error: {error}\n")
    print(json.dumps({"changed": changed}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
