#!/usr/bin/env python3
"""Generate deterministic 1200×630 Open Graph images for Sequence Math blog posts."""
from pathlib import Path
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "img" / "blog"
FONT = Path(os.environ.get(
    "SEQUENCE_KR_FONT",
    "/opt/data/sequence_math_blog_automation/fonts/NotoSansKR.ttf",
))

POSTS = [
    {
        "slug": "choosing-math-academy",
        "label": "학습 환경 · 수학교습소 선택",
        "title": ["수학교습소 선택 기준,", "학원과 무엇이 다를까요?"],
        "subtitle": "규모보다 학생에게 맞는 학습 구조를 먼저 봅니다",
    },
    {
        "slug": "homework-routine-recovery",
        "label": "학습 루틴 · 숙제 관리",
        "title": ["수학 숙제를 안 하는 아이,", "어떻게 해야 할까요?"],
        "subtitle": "의지보다 시작을 막는 원인을 먼저 확인합니다",
    },
]


def font(size: int) -> ImageFont.FreeTypeFont:
    if not FONT.exists():
        raise FileNotFoundError(f"Korean font not found: {FONT}")
    return ImageFont.truetype(str(FONT), size=size)


def create(post: dict) -> Path:
    image = Image.new("RGB", (1200, 630), "#16181B")
    draw = ImageDraw.Draw(image)

    # Quiet graph-paper texture matching the website.
    for x in range(0, 1200, 48):
        draw.line((x, 0, x, 630), fill="#202328", width=1)
    for y in range(0, 630, 48):
        draw.line((0, y, 1200, y), fill="#202328", width=1)

    draw.rectangle((0, 0, 13, 630), fill="#C84B31")
    draw.rounded_rectangle((76, 65, 1124, 565), radius=18, fill="#FAFAFB")
    draw.text((126, 116), post["label"], font=font(24), fill="#C84B31")

    y = 190
    title_font = font(55)
    for line in post["title"]:
        draw.text((126, y), line, font=title_font, fill="#16181B")
        y += 82

    draw.line((126, 386, 1072, 386), fill="#D4D6DA", width=2)
    draw.text((126, 422), post["subtitle"], font=font(28), fill="#4F5459")
    draw.text((126, 503), "시퀀스 수학", font=font(25), fill="#16181B")
    draw.text((921, 507), "SEQUENCE NOTE", font=font(16), fill="#74787E")

    output = OUT / f"{post['slug']}-og.png"
    output.parent.mkdir(parents=True, exist_ok=True)
    image.save(output, format="PNG", optimize=True)
    return output


def main() -> None:
    for post in POSTS:
        print(create(post))


if __name__ == "__main__":
    main()
