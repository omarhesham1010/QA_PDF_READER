import fitz
import json
import sys

def analyze_pdf(pdf_path):
    with open("analyze_output.txt", "w", encoding="utf-8") as f:
        f.write(f"Analyzing {pdf_path}...\n")
        try:
            doc = fitz.open(pdf_path)
        except Exception as e:
            f.write(f"Failed to open PDF: {e}\n")
            return

        for page_num in range(min(5, len(doc))):
            page = doc[page_num]
            text_dict = page.get_text("dict")
            blocks = text_dict.get("blocks", [])
            for block in blocks:
                if "lines" not in block: continue
                for line in block["lines"]:
                    for span in line["spans"]:
                        text = span["text"]
                        if any(x in text for x in ["أك", "المعطيات", "ي", "الخميس"]):
                            f.write(f"--- PAGE {page_num + 1} MATCH ---\n")
                            f.write(f"Text: '{text}'\n")
                            f.write(f"Font: {span['font']}\n")
                            f.write(f"Size: {span['size']}\n")
                            f.write(f"Raw Unicode: {[hex(ord(c)) for c in text]}\n")

if __name__ == "__main__":
    analyze_pdf("test.pdf")
