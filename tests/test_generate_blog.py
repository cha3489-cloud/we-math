import copy
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "generate-blog.py"


def load_generator():
    spec = importlib.util.spec_from_file_location("generate_blog", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load generator: {SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


RECORD = {
    "date": "2026-08-07",
    "title": "분수 공부를 <안전하게> 이어가는 법",
    "description": "개념 & 풀이를 연결하는 방법입니다.",
    "category": "개념 학습",
    "slug": "fraction-learning",
    "article_markdown": "## 첫 단계\n\n<script>alert(1)</script> 대신 **개념**을 확인합니다.\n\n- 정의 읽기\n- 예제 풀기",
    "hashtags": ["분수", "수학공부"],
}

BLOG_INDEX = """<!doctype html><section class=\"blog-list\"><div class=\"wrap\">
<p class=\"eyebrow\">LATEST NOTE</p>
<p class=\"blog-empty-note\">새로운 교육 칼럼을 차례로 더해갈 예정입니다.</p>
</div></section>"""
VITE = """import { defineConfig } from 'vite';
import { resolve } from 'node:path';
export default defineConfig({ build: { rollupOptions: { input: { main: resolve(__dirname, 'index.html'), blog: resolve(__dirname, 'blog/index.html') } } } });
"""
SITEMAP = """<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">
  <url><loc>https://sequencemath.co.kr/blog/</loc><lastmod>2026-08-06</lastmod></url>
</urlset>
"""
RSS = """<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<rss version=\"2.0\" xmlns:atom=\"http://www.w3.org/2005/Atom\"><channel>
<title>시퀀스 수학 블로그</title><lastBuildDate>Thu, 06 Aug 2026 09:00:00 +0900</lastBuildDate>
<atom:link href=\"https://sequencemath.co.kr/rss.xml\" rel=\"self\" type=\"application/rss+xml\" />
</channel></rss>
"""


class GenerateBlogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "blog").mkdir()
        (self.root / "public").mkdir()
        (self.root / "blog/index.html").write_text(BLOG_INDEX, encoding="utf-8")
        (self.root / "vite.config.js").write_text(VITE, encoding="utf-8")
        (self.root / "public/sitemap.xml").write_text(SITEMAP, encoding="utf-8")
        (self.root / "public/rss.xml").write_text(RSS, encoding="utf-8")
        self.generator = load_generator()

    def tearDown(self):
        self.temp.cleanup()

    def snapshots(self):
        paths = [
            "blog/fraction-learning/index.html",
            "blog/index.html",
            "vite.config.js",
            "public/sitemap.xml",
            "public/rss.xml",
        ]
        return {path: (self.root / path).read_bytes() for path in paths}

    def test_generates_all_outputs_safely_and_idempotently(self):
        changed = self.generator.generate(self.root, copy.deepcopy(RECORD))
        self.assertEqual(
            changed,
            [
                "blog/fraction-learning/index.html",
                "blog/index.html",
                "vite.config.js",
                "public/sitemap.xml",
                "public/rss.xml",
            ],
        )
        article = (self.root / "blog/fraction-learning/index.html").read_text(encoding="utf-8")
        self.assertIn("분수 공부를 &lt;안전하게&gt; 이어가는 법", article)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", article)
        self.assertNotIn("<script>alert(1)</script>", article)
        self.assertIn('<h2>첫 단계</h2>', article)
        self.assertIn('<ul class="article-checklist">', article)
        self.assertIn('"@type": "BlogPosting"', article)
        self.assertIn("#분수 #수학공부", article)

        index = (self.root / "blog/index.html").read_text(encoding="utf-8")
        vite = (self.root / "vite.config.js").read_text(encoding="utf-8")
        sitemap = (self.root / "public/sitemap.xml").read_text(encoding="utf-8")
        rss = (self.root / "public/rss.xml").read_text(encoding="utf-8")
        self.assertEqual(index.count('href="/blog/fraction-learning/"'), 1)
        self.assertEqual(vite.count("'blog/fraction-learning/index.html'"), 1)
        syntax = subprocess.run(
            ["node", "--check", str(self.root / "vite.config.js")],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(syntax.returncode, 0, syntax.stderr)
        self.assertEqual(sitemap.count("<loc>https://sequencemath.co.kr/blog/fraction-learning/</loc>"), 1)
        self.assertEqual(rss.count("<link>https://sequencemath.co.kr/blog/fraction-learning/</link>"), 1)
        self.assertEqual(rss.count("<guid isPermaLink=\"true\">https://sequencemath.co.kr/blog/fraction-learning/</guid>"), 1)

        first = self.snapshots()
        self.assertEqual(self.generator.generate(self.root, copy.deepcopy(RECORD)), [])
        self.assertEqual(self.snapshots(), first)

        updated = copy.deepcopy(RECORD)
        updated["title"] = "수정된 분수 학습법"
        self.generator.generate(self.root, updated)
        self.assertIn("수정된 분수 학습법", (self.root / "blog/index.html").read_text(encoding="utf-8"))
        self.assertNotIn("분수 공부를 &lt;안전하게&gt; 이어가는 법", (self.root / "blog/index.html").read_text(encoding="utf-8"))

    def test_rejects_invalid_or_dangerous_records_without_writes(self):
        cases = []
        missing = copy.deepcopy(RECORD)
        del missing["title"]
        cases.append(missing)
        traversal = copy.deepcopy(RECORD)
        traversal["slug"] = "../../outside"
        cases.append(traversal)
        bad_date = copy.deepcopy(RECORD)
        bad_date["date"] = "2026-02-30"
        cases.append(bad_date)
        bad_tags = copy.deepcopy(RECORD)
        bad_tags["hashtags"] = "#분수"
        cases.append(bad_tags)

        originals = {path: (self.root / path).read_bytes() for path in ["blog/index.html", "vite.config.js", "public/sitemap.xml", "public/rss.xml"]}
        for record in cases:
            with self.subTest(record=record):
                with self.assertRaises(ValueError):
                    self.generator.generate(self.root, record)
        self.assertEqual(originals, {path: (self.root / path).read_bytes() for path in originals})
        self.assertFalse((self.root / "blog/fraction-learning").exists())

    def test_rejects_prelaunch_recruitment_phrases_in_any_text_field(self):
        for phrase in ["수강생 모집", "상담 예약", "등록 문의", "선착순", "수강료 안내", "지금 신청하세요"]:
            record = copy.deepcopy(RECORD)
            record["article_markdown"] += f"\n\n{phrase}"
            with self.subTest(phrase=phrase), self.assertRaisesRegex(ValueError, phrase):
                self.generator.generate(self.root, record)
        self.assertFalse((self.root / "blog/fraction-learning").exists())

    def test_cli_accepts_json_file_and_reports_changed_files(self):
        content = self.root / "content.json"
        content.write_text(json.dumps(RECORD, ensure_ascii=False), encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(SCRIPT), str(content), "--root", str(self.root)],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["changed"], [
            "blog/fraction-learning/index.html",
            "blog/index.html",
            "vite.config.js",
            "public/sitemap.xml",
            "public/rss.xml",
        ])


if __name__ == "__main__":
    unittest.main()
