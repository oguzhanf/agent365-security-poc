"""Create page contact sheets and report basic layout issues."""

import argparse
import json
from pathlib import Path


def inspect(source, output):
    import pymupdf

    source = Path(source).resolve(strict=True)
    output = Path(output).resolve()
    if output == source.parent:
        raise ValueError("Select a separate directory for review images.")
    output.mkdir(parents=True, exist_ok=True)
    issues = []
    with pymupdf.open(source) as document:
        for number, page in enumerate(document, 1):
            words = page.get_text("words")
            if not words:
                issues.append({"page": number, "issue": "The page contains no text."})
            for word in words:
                if word[0] < 5 or word[1] < 5 or word[2] > page.rect.width - 5 or word[3] > page.rect.height - 5:
                    issues.append({"page": number, "issue": "Text reaches the page edge.", "text": word[4]})
        for start in range(0, len(document), 20):
            with pymupdf.open() as sheet:
                count = min(20, len(document) - start)
                columns = 1 if count == 1 else min(4, count)
                cell_width = 640 if count == 1 else 300
                cell_height = 850 if count == 1 else 340
                rows = (count + columns - 1) // columns
                canvas = sheet.new_page(width=columns * cell_width, height=rows * cell_height)
                for slot, index in enumerate(range(start, start + count)):
                    x = (slot % columns) * cell_width
                    y = (slot // columns) * cell_height
                    canvas.insert_text((x + 12, y + 15), f"Page {index + 1}", fontsize=9)
                    canvas.show_pdf_page(pymupdf.Rect(x + 5, y + 22, x + cell_width - 5, y + cell_height - 5), document, index)
                canvas.get_pixmap().save(output / f"pages-{start + 1:03d}-{min(start + 20, len(document)):03d}.png")
        report = {"pages": len(document), "issues": issues}
    (output / "layout-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Inspect a locally generated PDF.")
    parser.add_argument("source")
    parser.add_argument("output")
    args = parser.parse_args()
    inspect(args.source, args.output)
